# Issue #8801 - keyless per-plugin harness CI

Branch: `fix/8801-keyless-plugin-harness-ci`

## What changed

The existing `keyless-harness-e2e.yml` workflow already ran the central deterministic mock-LLM and recorded-fixture self-suite. This slice adds a representative model-provider and connector adoption proof to the same keyless PR lane:

- `bun run --cwd plugins/plugin-anthropic test:harness`
- `bun run --cwd plugins/plugin-discord test:harness`

All provider credentials remain blanked by the workflow env.

## Evidence

```bash
bun run --cwd plugins/plugin-anthropic test:harness
```

Result: 1 file passed, 2 tests passed.

```bash
bun run --cwd plugins/plugin-discord test:harness
```

Result: 1 file passed, 1 test passed.

```bash
bunx vitest run --config test/mocks/vitest.config.ts test/mocks/__tests__/
```

Result: run from `packages/`; 3 files passed, 57 tests passed.

## Scope note

This intentionally wires a minimal non-live plugin harness slice into PR CI. Broader per-plugin adoption and corpus widening remain separate ratchet work.
