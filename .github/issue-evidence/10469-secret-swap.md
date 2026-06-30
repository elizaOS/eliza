# Issue #10469 Secret Swap Foundation

Date: 2026-06-30
Branch: `fix/10469-secret-prompt-swap`

## Scope

Foundational opt-in secret/PII swap layer in `@elizaos/core`:

- Adds `SecretSwapSession` with deterministic placeholders, reversible restore, and fail-loud unresolved-placeholder errors.
- Enables model-boundary substitution when `ELIZA_SECRET_SWAP_ENABLED` is true.
- Substitutes model params before provider execution, again after `pre_model` hooks, and before model-input logs/trajectory prompt snapshots.
- Keeps streamed chunks and post-model output on placeholders if a raw sensitive value appears.
- Leaves execution-boundary reinsertion as an exported API for the next wiring slice.

This is not the full issue-closing PR. Connector/exec/signed-transaction reinsertion and live-model trajectory proof remain required before #10469 can close.

## Validation

```bash
bun run install:light
bun run --cwd packages/core prebuild
bunx @biomejs/biome check packages/core/src/security/secret-swap.ts packages/core/src/security/secret-swap.test.ts packages/core/src/runtime/__tests__/secret-swap-use-model.test.ts packages/core/src/security/index.ts packages/core/src/index.node.ts packages/core/src/runtime.ts
bun test packages/core/src/security/secret-swap.test.ts packages/core/src/runtime/__tests__/secret-swap-use-model.test.ts --reporter=dot
bun run --cwd packages/core typecheck
bun run --cwd packages/core build:node
```

Results:

- Biome check: passed.
- Focused tests: 6 passed, 0 failed, 18 assertions.
- `packages/core` typecheck: passed.
- `packages/core` Node build: passed.

## Evidence Matrix

- Prompt/provider input contains placeholders: covered by `secret-swap-use-model.test.ts`.
- Raw secret absent from model-visible params with swap enabled: covered by `secret-swap-use-model.test.ts`.
- Raw secret preserved when swap disabled: covered by `secret-swap-use-model.test.ts`.
- `pre_model` hook-added secrets swapped before provider execution: covered by `secret-swap-use-model.test.ts`.
- Deterministic placeholder restore and unresolved-placeholder failure: covered by `secret-swap.test.ts`.
- Live model trajectory: N/A for this draft foundation slice; required for the final issue-closing PR.
- Real connector/command execution with rehydrated secret: N/A for this draft foundation slice; required for the next execution-boundary wiring slice.
