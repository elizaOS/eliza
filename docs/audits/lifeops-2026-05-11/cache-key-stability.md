# Cache-Key Stability CI Gate

## What this is

`packages/core/src/runtime/__tests__/cache-key-stability.test.ts` is a vitest
snapshot test that pins the byte-identity of the inputs the Anthropic adapter
hashes into the prompt-cache key:

- the **Stage 1 stable-prefix hash** — the hash of the stable prompt segments
  flowing into the `HANDLE_RESPONSE` (Stage 1) request,
- the **Stage 2 stable-prefix hash** — the hash of the stable prompt segments
  flowing into the `PLAN_ACTIONS` (Stage 2) planner-loop request,
- the **`STABLE_PLANNER_TOOLS` envelope hash** — the canonical fixed tool
  array sent to the LLM on every planner request,
- the **`HANDLE_RESPONSE` tool envelope hashes** — both the full
  (RESPOND/IGNORE/STOP) and direct-message variants,
- the **`PLAN_ACTIONS` tool envelope hash**.

A companion `churn detector` block asserts the inverse: appending dynamic /
non-stable suffix segments (current user message, conversation history) does
**not** change the prefix hash. The negative-control test confirms that
mutating a stable segment **does** churn the hash, so the assertion is real.

The test is wired into a dedicated workflow,
`.github/workflows/cache-key-stability.yml`, which runs on every PR touching
`packages/core/**`, `plugins/app-lifeops/**`, or `packages/prompts/**`.

Local equivalent:

```bash
bun run test:cache-stability
```

Runs in ~2s. Required on every PR.

## Why this matters

The Anthropic adapter uses ephemeral cache breakpoints anchored at the end of
the stable prefix. If the prefix bytes drift between PRs, the cache key
changes, the cached prefix is invalidated, and every subsequent PR pays
roughly 80% extra tokens on Anthropic calls until someone notices. Drift is
silent — there is no runtime error, just a slow, expensive degradation.

This test fails loud when the prefix changes.

## How to update the snapshot when the change is intentional

You ARE allowed to change the cache-key prefix. The CI gate exists so the
change is **deliberate**, not a side-effect of a typo or reordered import.

1. Run the test locally:

   ```bash
   bun run test:cache-stability
   ```

   It will fail with a diff like:

   ```
   Expected: "e3ec3d90577182cc5c430080e9373665c9b68d0380caae091239ae58632c9f0c"
   Received: "<new hex hash>"
   ```

2. Confirm the change is intentional. Common legitimate reasons:
   - You altered the canonical content of a stable prompt segment in the test
     fixture (e.g. the agent identity string in
     `STAGE_1_CANONICAL_SEGMENTS`).
   - You changed the schema of `HANDLE_RESPONSE` or `PLAN_ACTIONS` in
     `packages/core/src/actions/to-tool.ts`.
   - You modified the `computePrefixHashes` algorithm itself in
     `packages/core/src/runtime/context-hash.ts`.
   - You changed `cachePrefixSegments` or `normalizePromptSegments` in
     `packages/core/src/runtime/context-renderer.ts`.

3. Update the literal hash in
   `packages/core/src/runtime/__tests__/cache-key-stability.test.ts` with the
   value from the `Received:` line.

4. Append a one-line entry to this document under "Snapshot history" so the
   audit trail records who churned the cache, when, and why.

5. Commit. Mention "intentional cache-key change" in the commit message so
   reviewers know to expect the bump.

## Provenance

- **Wave:** Wave 1-D of the 2026-05-11 LifeOps benchmark pipeline rebuild.
- **Initial landing commit:** `dced8e359c` (commit subject is mislabeled
  because parallel waves co-staged files; the cache-key stability test +
  workflow + this doc + `package.json` `test:cache-stability` script are
  the Wave 1-D portion of that commit).

## Snapshot history

| Date       | Hashes updated | Reason |
|------------|----------------|--------|
| 2026-05-11 | initial baseline (Stage 1, Stage 2, STABLE_PLANNER_TOOLS, HANDLE_RESPONSE full + DM, PLAN_ACTIONS) | First commit of the cache-key stability gate. |

## Common causes of unintentional churn

Watch for these — every one of them has shipped at least once and silently
busted the cached prefix before being reverted:

- **Trailing-whitespace edits** in prompt templates under
  `packages/prompts/src/` or in the inline strings in
  `packages/core/src/actions/to-tool.ts`. A single appended space at the end
  of a description string is enough to invalidate the cache.
- **Reordered action arrays.** `STABLE_PLANNER_TOOLS` is a fixed tuple
  precisely because reordering or adding entries shifts the JSON
  serialization that feeds the tool-envelope hash. Do not append new tools
  to that array without going through the explicit cache-key bump process.
- **Environment-dependent strings** leaking into stable prompt segments —
  e.g. interpolating `process.env.NODE_ENV`, the user's display name, the
  current date, a random correlation id, or a UUID. The fixture
  `STAGE_1_CANONICAL_SEGMENTS` deliberately uses none of these, so a runtime
  regression that adds one will be caught the moment its hash is wired into
  this test.
- **Schema property reordering.** The hash function `hashStableJson` sorts
  object keys, so renames matter but reorderings within an object do not.
  Renames in `HANDLE_RESPONSE_SCHEMA` or `PLAN_ACTIONS_TOOL.parameters`
  WILL churn the hash — that is the intent.
- **New stable prompt segments inserted in the middle.** Appending a new
  stable segment to the prefix is a legitimate but cache-busting change.
  Confirm the intent, then update this baseline.
- **Adding `stable: true` to a previously dynamic segment** (or vice
  versa). Either direction churns. Audit the segment first — if it is
  legitimately dynamic (per-turn user message, retrieval result), it must
  stay `stable: false`.

## Cross-references

- Runtime cache-key construction:
  `packages/core/src/runtime/provider-cache-plan.ts` —
  `buildProviderCachePlan`, `cacheProviderOptions`.
- Stable-prefix helper:
  `packages/core/src/runtime/context-renderer.ts` — `cachePrefixSegments`.
- Hash primitives:
  `packages/core/src/runtime/context-hash.ts` —
  `computePrefixHashes`, `hashStableJson`, `hashString`.
- Live cache-key wiring:
  `packages/core/src/services/message.ts` — the Stage 1
  `cacheProviderOptions({ prefixHash, segmentHashes, promptSegments,
  conversationId })` call.
- Fixed tool list:
  `packages/core/src/actions/to-tool.ts` — `STABLE_PLANNER_TOOLS`,
  `HANDLE_RESPONSE_TOOL`, `PLAN_ACTIONS_TOOL`.
