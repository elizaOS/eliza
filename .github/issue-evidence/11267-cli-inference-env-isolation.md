# Issue #11267 — plugin-cli-inference rotation env isolation

Date: 2026-07-02
Branch: `fix/11267-cli-inference-rotation-env`

## What was verified

- `withAccountRotation` no longer mutates the parent `process.env` when a pooled account is selected after a subscription-limit error.
- The selected account env is passed only to the SDK subprocess boundary:
  - Claude SDK: `query({ options: { env } })`
  - Codex SDK: `new Codex({ env })`
- The selected subprocess env is retained per rotation session key so later turns continue using the selected account without leaking its token into the parent process.

## Commands run

```bash
cd plugins/plugin-cli-inference
bun run lint:check
bun run typecheck
bun run build
bun run test
```

Results after rebasing onto `origin/develop`:

- `bun run lint:check` passed: Biome checked 19 files, no fixes applied.
- `bun run typecheck` passed: `tsgo --noEmit`.
- `bun run build` passed: Node build, browser build, and declarations completed.
- `bun run test` passed: 6 test files, 88 tests.

## Manual review

Reviewed the focused tests:

- `__tests__/account-rotation.test.ts` asserts `CLAUDE_CODE_OAUTH_TOKEN` remains `ambient-token` in `process.env` while the retry receives `tok-b` in the subprocess env.
- `__tests__/claude-sdk-session.test.ts` asserts the rotated env is present in the Claude SDK query options.
- `__tests__/codex-sdk-session.test.ts` asserts the rotated env is present in the Codex SDK constructor options.

## Evidence not applicable

- Live multi-account LLM trajectory: N/A. The proof target is credential-boundary isolation, and this MacBook does not have two linked pooled Claude/Codex subscription accounts to force a real rotation. The regression is covered at the exact boundary that leaked: parent env unchanged, SDK subprocess env receives the selected account env.
- Screenshots/video/audio: N/A. This is a backend provider-env isolation fix with no UI or audio surface.
