# 10818 Runtime Settings Precedence Evidence

Issue: https://github.com/elizaOS/eliza/issues/10818

## What Was Verified

- A fresh constructor `settings` value overrides a stale DB-persisted agent setting on restart.
- The same override works when the stale DB value was persisted through `agents.settings.secrets` or `agents.secrets`.
- Explicit character-file settings still override constructor settings, preserving per-agent character configuration precedence.

## Commands Run

```bash
bunx @biomejs/biome check packages/core/src/runtime.ts packages/core/src/__tests__/runtime-settings.test.ts .github/issue-evidence/10818-runtime-settings-precedence.md
bun run --cwd packages/core typecheck
bun run --cwd packages/core test -- runtime-settings.test.ts
bun run --cwd packages/core build:node
bun run verify
```

## Results Reviewed

- Biome on touched files: passed with no fixes applied.
- `packages/core` typecheck: passed.
- `runtime-settings.test.ts`: 6 tests passed.
- `packages/core` Node-only build: passed and emitted declarations successfully.
- Root `bun run verify`: blocked before package checks by the current repo-wide
  type-safety ratchet, unrelated to this change:
  - `as unknown as`: 109 current > 77 baseline
  - `?? 0` in core/agent/app-core: 384 current > 380 baseline

## Evidence N/A

- UI screenshots/video: N/A, this is a backend runtime settings-resolution fix with no rendered UI.
- Frontend logs/network: N/A, no frontend request path is involved.
- Real-LLM trajectory: N/A, no model call or agent action routing is involved; the bug is deterministic initialization and `getSetting()` behavior.
- Domain artifacts: covered by the in-memory adapter regression that seeds and reuses an existing agent row with persisted settings/secrets.
