// The Kairos agent loop: plan -> tools -> diff approval -> answer.
import { chat } from "./client.js";
import { buildTools } from "./tools.js";
import { c, spinner, log, rule } from "./ui.js";
import { redact } from "./security.js";

export const SYSTEM_PROMPT = (cwd, tools) => `You are Kairos, a precise terminal coding agent working inside ${cwd}.

Operating rules:
- Investigate before editing: list, search and read the relevant files first.
- Make the smallest correct change. Prefer edit_file over write_file.
- Every edit is shown to the human as a diff and needs their approval. If a change
  is declined, stop and ask what they want instead — never retry the same edit.
- Never read, print, echo, or commit credentials, .env files, or keys.
- After changing code, verify it (typecheck, tests, or a build) with run_command when practical.
- Keep prose short. Use plain sentences, no filler, no emoji.
- When you are done, reply with a brief summary of what changed and what to do next.

Available tools: ${tools.map((t) => t.name).join(", ")}.`;

export async function runAgent({ session, provider, model, apiKey, settings, approve, cp, signal }) {
  const tools = buildTools({ approve, cp, settings, session });
  const system = SYSTEM_PROMPT(session.cwd, tools);
  let steps = 0;

  while (steps++ < settings.maxSteps) {
    let streamed = false;
    const spin = spinner(`${provider.name} · ${model} thinking…`);

    let result;
    try {
      result = await chat({
        provider,
        model,
        apiKey,
        system,
        messages: session.messages,
        tools,
        temperature: settings.temperature,
        signal,
        onDelta: (delta) => {
          if (!streamed) {
            spin.stop();
            process.stdout.write(`${c.violet("◆")} `);
            streamed = true;
          }
          process.stdout.write(redact(delta));
        },
      });
    } catch (err) {
      spin.stop();
      throw err;
    }
    spin.stop();
    if (streamed) log("\n");

    const { text, toolCalls } = result;

    session.messages.push({
      role: "assistant",
      content: text,
      ...(toolCalls.length
        ? {
            tool_calls: toolCalls.map((t) => ({
              id: t.id,
              type: "function",
              function: { name: t.name, arguments: JSON.stringify(t.args) },
            })),
          }
        : {}),
    });

    if (!toolCalls.length) return { text, steps };

    for (const call of toolCalls) {
      const tool = tools.find((t) => t.name === call.name);
      if (!tool) {
        session.messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: `Unknown tool ${call.name}` });
        continue;
      }
      log(rule(`${c.cyan("⚙")} ${tool.summary(call.args)}`));
      const runSpin = spinner(`${tool.name}…`);
      let output;
      try {
        output = await tool.run(call.args);
      } catch (err) {
        output = `error: ${redact(err.message)}`;
      }
      runSpin.stop();
      const preview = String(output).split("\n").slice(0, 3).join(" ").slice(0, 160);
      log(`${c.gray("  ↳")} ${c.gray(preview)}`);
      session.messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: String(output).slice(0, 100_000) });
    }
  }
  return { text: "Reached the step limit for this turn. Ask me to continue.", steps };
}