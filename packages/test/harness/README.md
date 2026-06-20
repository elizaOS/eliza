# `@elizaos/test-harness`

The zero-cost end-to-end test substrate. One import gives a plugin author a real
PGLite-backed `AgentRuntime` driven by a **deterministic mock LLM** — no provider
key, no network, no external cost — with **correct *and* incorrect** response
fixtures.

This is the stable, documented entrypoint for the assets that previously lived
behind deep relative reaches into `packages/test/mocks/helpers/*`.

## Install

The package is `private` and test-only. Add it to a plugin's `devDependencies`:

```jsonc
"devDependencies": { "@elizaos/test-harness": "workspace:*" }
```

## `withMockLlmRuntime()`

```ts
import { ModelType } from "@elizaos/core";
import { withMockLlmRuntime } from "@elizaos/test-harness";

const harness = await withMockLlmRuntime({
  plugins: [myPlugin],
  fixtures: [
    { name: "small", match: { modelType: ModelType.TEXT_SMALL }, response: "ok" },
  ],
});
try {
  const out = await harness.runtime.useModel(ModelType.TEXT_SMALL, { prompt: "hi" });
  // ...exercise your action / provider / service against `harness.runtime`...
  harness.assertFixturesConsumed();
} finally {
  await harness.cleanup();
}
```

It wraps `@elizaos/core/testing`'s `createRealTestRuntime` (PGLite + a real
runtime) and registers `createDeterministicLlmProxyPlugin` at `priority: 1000`
so the proxy wins dispatch for every text `ModelType` plus `TEXT_EMBEDDING`
(zero-vector). `strict` defaults to `true`: every model call must match a
declared fixture or the proxy throws with full diagnostics.

Returns `{ runtime, fixtures, assertFixturesConsumed, getFixtureDiagnostics,
pgliteDir, cleanup }`.

## The correct / incorrect response contract

Each plugin e2e should declare both paths:

| Path | How | Module |
| --- | --- | --- |
| **Correct** | exact Stage-1 routing + tool-call, validated | `strictActionRouteFixtures()` — `@elizaos/test-harness` |
| **Incorrect** | malformed JSON, wrong tool, hallucinated tool, empty, truncated — `validateResponse: false` so it reaches the runtime | `adversarialActionRouteFixtures()` — `@elizaos/test-harness/negative-fixtures` |

```ts
import { adversarialActionRouteFixtures, ADVERSARIAL_KINDS } from "@elizaos/test-harness/negative-fixtures";

for (const kind of ADVERSARIAL_KINDS) {
  const harness = await withMockLlmRuntime({
    plugins: [myPlugin],
    fixtures: adversarialActionRouteFixtures(kind, { input: "do it", intendedAction: "DO_IT" }),
  });
  // assert the turn surfaces an error / retries / falls back — never a silent success
  await harness.cleanup();
}
```

`ADVERSARIAL_KINDS`: `malformed-json`, `wrong-tool`, `hallucinated-tool`,
`empty`, `truncated`. See `ADVERSARIAL_KIND_DESCRIPTIONS` for what each models.

## Exports

| Subpath | Provides |
| --- | --- |
| `@elizaos/test-harness` | `withMockLlmRuntime`, the action-route fixture template, the negative-pack helpers, and the proxy factory/types |
| `@elizaos/test-harness/llm-proxy` | `createDeterministicLlmProxyPlugin` and its types directly |
| `@elizaos/test-harness/negative-fixtures` | the adversarial fixture pack |

## Relationship to scenarios

For a full **message-turn** flow (inbound message → routing → action → outbound),
prefer a deterministic `.scenario.ts` run through `SCENARIO_USE_LLM_PROXY`. This
helper is for **action / provider / service**-level e2e where you drive the unit
directly against a real runtime and a deterministic model. Both run keyless in
the PR `zero-key` lane.
