# Contributing to Kairos

Thanks for considering a contribution — issues and PRs are welcome.

## Ground rules

- **Zero runtime dependencies is a design goal, not an accident.** Kairos is built entirely
  on the Node.js stdlib. Please don't add a package to `dependencies` unless there's a very
  strong reason and it's been discussed in an issue first.
- **Security-sensitive code gets extra scrutiny.** Changes to `src/keystore.js`,
  `src/security.js`, or anything touching the vault, sandboxing, or command policy will be
  reviewed carefully. Explain your threat model in the PR description.
- **Keep it dependency-free and cross-platform.** Code should run on macOS, Linux, and
  Windows without extra native builds.

## Getting set up

```bash
git clone https://github.com/adamyasingh-05/kairos.git
cd kairos/cli
node bin/kairos.js
```

No `npm install` step — there's nothing to install.

## Making a change

1. Fork the repo and create a branch off `main`.
2. Make your change. Keep commits focused and messages descriptive.
3. Run the CLI locally and exercise the paths you touched (`node bin/kairos.js`).
4. Open a pull request describing what changed and why.

## Reporting bugs

Open an issue with:

- What you expected to happen
- What actually happened
- Your OS and Node.js version (`node -v`)
- Steps to reproduce

## Reporting security issues

Please **do not** open a public issue for security vulnerabilities. See
[SECURITY.md](./SECURITY.md) for how to report privately.

## Code style

- Plain modern JavaScript (ES modules), matching the existing style in `src/`.
- No build step, no transpilation — what you write is what runs.
