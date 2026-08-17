// Provider adapters. One internal shape, three wire protocols.
// Keys are sent to the provider's own HTTPS endpoint and nowhere else.
import { redact, trackSecret } from "./security.js";

async function* sse(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() || "";
    for (const part of parts) {
      for (const line of part.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          yield JSON.parse(data);
        } catch {
          /* keep-alive or partial frame */
        }
      }
    }
  }
}

async function assertOk(res, providerName) {
  if (res.ok) return;
  const body = redact(await res.text().catch(() => ""));
  const hint =
    res.status === 401 || res.status === 403
      ? "Your API key was rejected. Run /login to store a new one."
      : res.status === 429
        ? "Rate limited or out of credits at the provider."
        : "";
  throw new Error(`${providerName} returned ${res.status}. ${hint}\n${body.slice(0, 600)}`);
}

const toOpenAITools = (tools) =>
  tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

export async function chat({ provider, model, apiKey, system, messages, tools, onDelta, signal, temperature = 0.2 }) {
  trackSecret(apiKey);
  if (provider.kind === "anthropic") return anthropicChat(...arguments);
  if (provider.kind === "gemini") return geminiChat(...arguments);
  return openaiChat(...arguments);
}

async function openaiChat({ provider, model, apiKey, system, messages, tools, onDelta, signal, temperature }) {
  const res = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "http-referer": "https://github.com/kairos-cli",
      "x-title": "Kairos CLI",
    },
    body: JSON.stringify({
      model,
      temperature,
      stream: true,
      messages: [{ role: "system", content: system }, ...messages],
      ...(tools?.length ? { tools: toOpenAITools(tools), tool_choice: "auto" } : {}),
    }),
  });
  await assertOk(res, provider.name);

  let text = "";
  const calls = new Map();
  for await (const evt of sse(res)) {
    const d = evt.choices?.[0]?.delta;
    if (!d) continue;
    if (d.content) {
      text += d.content;
      onDelta?.(d.content);
    }
    for (const tc of d.tool_calls || []) {
      const slot = calls.get(tc.index) || { id: tc.id, name: "", args: "" };
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name += tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
      calls.set(tc.index, slot);
    }
  }
  return { text, toolCalls: [...calls.values()].map(normalizeCall) };
}

async function anthropicChat({ provider, model, apiKey, system, messages, tools, onDelta, signal, temperature }) {
  const res = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/messages`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      temperature,
      stream: true,
      system,
      messages: toAnthropicMessages(messages),
      ...(tools?.length
        ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) }
        : {}),
    }),
  });
  await assertOk(res, provider.name);

  let text = "";
  const blocks = [];
  for await (const evt of sse(res)) {
    if (evt.type === "content_block_start") blocks[evt.index] = { ...evt.content_block, args: "" };
    if (evt.type === "content_block_delta") {
      if (evt.delta.type === "text_delta") {
        text += evt.delta.text;
        onDelta?.(evt.delta.text);
      }
      if (evt.delta.type === "input_json_delta") blocks[evt.index].args += evt.delta.partial_json;
    }
  }
  const toolCalls = blocks
    .filter((b) => b?.type === "tool_use")
    .map((b) => normalizeCall({ id: b.id, name: b.name, args: b.args || "{}" }));
  return { text, toolCalls };
}

function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "tool") {
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: String(m.content) }],
      });
    } else if (m.role === "assistant" && m.tool_calls?.length) {
      const content = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls)
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: safeJson(tc.function.arguments),
        });
      out.push({ role: "assistant", content });
    } else {
      out.push({ role: m.role, content: String(m.content || "") });
    }
  }
  return out;
}

async function geminiChat({ provider, model, apiKey, system, messages, tools, onDelta, signal, temperature }) {
  const url = `${provider.baseUrl.replace(/\/$/, "")}/models/${model}:streamGenerateContent?alt=sse`;
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: toGeminiContents(messages),
      generationConfig: { temperature },
      ...(tools?.length
        ? {
            tools: [
              {
                functionDeclarations: tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters,
                })),
              },
            ],
          }
        : {}),
    }),
  });
  await assertOk(res, provider.name);

  let text = "";
  const toolCalls = [];
  for await (const evt of sse(res)) {
    for (const part of evt.candidates?.[0]?.content?.parts || []) {
      if (part.text) {
        text += part.text;
        onDelta?.(part.text);
      }
      if (part.functionCall)
        toolCalls.push(
          normalizeCall({
            id: `call_${toolCalls.length}_${part.functionCall.name}`,
            name: part.functionCall.name,
            args: JSON.stringify(part.functionCall.args || {}),
          }),
        );
    }
  }
  return { text, toolCalls };
}

function toGeminiContents(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "tool") {
      out.push({
        role: "user",
        parts: [{ functionResponse: { name: m.name, response: { result: String(m.content) } } }],
      });
    } else if (m.role === "assistant" && m.tool_calls?.length) {
      out.push({
        role: "model",
        parts: [
          ...(m.content ? [{ text: m.content }] : []),
          ...m.tool_calls.map((tc) => ({
            functionCall: { name: tc.function.name, args: safeJson(tc.function.arguments) },
          })),
        ],
      });
    } else {
      out.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.content || "") }] });
    }
  }
  return out;
}

const safeJson = (s) => {
  try {
    return typeof s === "string" ? JSON.parse(s || "{}") : s || {};
  } catch {
    return {};
  }
};

const normalizeCall = (c) => ({ id: c.id || `call_${Math.random().toString(36).slice(2)}`, name: c.name, args: safeJson(c.args) });

export async function verifyKey(provider, apiKey) {
  trackSecret(apiKey);
  const model = provider.models[provider.models.length - 1] || provider.models[0];
  await chat({
    provider,
    model,
    apiKey,
    system: "reply with ok",
    messages: [{ role: "user", content: "ok" }],
    tools: [],
    temperature: 0,
  });
  return true;
}