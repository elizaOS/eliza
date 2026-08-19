# `@elizaos/test-corpus`

Repository-wide scenario definitions consumed by
`@elizaos/scenario-runner`. This is a private data/test workspace, not a runtime,
mock server, utility package, or source of production exports.

Repository-wide engineering and evidence requirements are inherited from the
root [`CLAUDE.md`](../../CLAUDE.md).

## Ownership boundary

Keep a scenario here when it spans packages, certifies a cross-product
contract, or has no single product owner. New product-specific scenarios belong
beside the package or plugin that owns the behavior. Runtime construction and
deterministic model helpers belong in `@elizaos/core/testing`; external-service
recordings and scenario-runner mocks belong under
`packages/scenario-runner/test/mocks`; cloud integration infrastructure belongs
under `packages/cloud`.

Do not add exports or production dependencies. Scenarios import the real
elizaOS runtime and explicitly select the model-provider plugin they require.

## Layout

- `scenarios/connector-contracts/` covers simulated connector capability, disconnect,
  authorization, retry, and degradation contracts.
- `scenarios/cross-cutting/` covers planner, safety, action selection, memory,
  concurrency, language, and multi-action behavior shared across products.
- `scenarios/convo/`, `gateway/`, `messaging.*`, and `payments/` group shared
  behavioral and transport scenarios by domain.
- `scenarios/personality/` is the generated/distributed personality corpus;
  preserve its index and distribution metadata when changing cases.
- `_fixtures/` and `_factory.ts` files support scenarios but are not scenarios
  themselves.

## Scenario rules

- Name executable definitions `*.scenario.ts` so discovery and validation can
  find them.
- Assert observable outcomes, tool calls, state changes, and failure behavior;
  do not pass by matching only a friendly response string.
- Keep live-model requirements explicit. A deterministic proxy can test harness
  plumbing but is not evidence for changed agent behavior.
- Cover negative, missing-input, permission, stale-state, retry, and
  idempotency cases when the contract supports them.
- Reuse shared factories only for setup. Keep the acceptance criteria visible
  in each scenario file.

## Commands

```bash
bun run --cwd packages/test test         # discover and validate every scenario
bun run --cwd packages/test typecheck    # typecheck the scenario corpus
bun run --cwd packages/test format:check
```

This workspace participates in the root server test lane through
`elizaos.scripts.testLanes` in `package.json`.

## Package completion evidence

For corpus changes, run validation and typecheck, then execute every changed
behavioral scenario against the real runtime. When the scenario judges model
behavior, use a live model and inspect the generated trajectory and domain
artifacts rather than treating schema validation as proof.
