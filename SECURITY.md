# Security Policy

Kairos handles API keys and executes commands on your machine, so we take security
reports seriously.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, report privately via GitHub's [private vulnerability reporting](https://github.com/adamyasingh-05/kairos/security/advisories/new)
feature on this repository, or reach out to the maintainer directly.

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce
- Any relevant logs, screenshots, or proof-of-concept code

## What's in scope

- The encrypted key vault (`src/keystore.js`)
- Command sandboxing and the deny-list (`src/security.js`)
- Prompt/output redaction of secrets
- Any way a malicious repo or file could get Kairos to exfiltrate keys or run
  unintended commands

## Supported versions

Only the latest published version on npm is supported with security fixes.

## Our commitment

We'll acknowledge reports promptly and keep you updated as we work on a fix.
Credit will be given in the release notes unless you'd prefer to stay anonymous.
