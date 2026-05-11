# Wave 2-D — Serialization audit + structural speed wins

Audit window: every per-turn hot-path string build / `JSON.stringify` /
`stringifyForModel` in the planner prompt pipeline. Files inspected:

- `packages/core/src/runtime/planner-rendering.ts`
- `packages/core/src/runtime/context-renderer.ts`
- `packages/core/src/runtime/planner-loop.ts` (specifically lines 500-650 and
  the per-turn render path at 451-501)
- `packages/core/src/runtime/provider-cache-plan.ts`

## Top 5 findings (ranked by per-turn cost × repeat factor)

1. `renderToolForAvailableActions` (planner-loop.ts:542-550) calls
   `JSON.stringify(compactToolParameters(tool.parameters))` once per exposed
   tool per planner iteration. With ~12-25 exposed actions per turn and the
   parameter object being structurally identical across every iteration (it's
   sourced from the registered Action's static `parameters` schema), this is
   the single biggest stringification redundancy in the hot path. Strong
   memoization candidate: `tool.parameters` is reference-stable per
   registered `Action`, so we can key the cache on the Action object identity
   or on a `hashStableJson(tool.parameters)` digest.

2. `compactToolParameters` runs every call and rebuilds the object literal even
   when the input is reference-stable. This is dwarfed by the JSON.stringify
   above but feeds into it — the memoization for #1 naturally absorbs it.

3. `renderAvailableActionsBlock` (planner-loop.ts:623-648) does a full
   `.map(renderToolForAvailableActions).join("\n")` per iteration. The block
   is structurally stable across iterations *within a single turn* (the
   exposed-tool set doesn't change mid-loop) — memoizable by the array of
   tool names + their parameter hash.

4. `renderRoutingHintsBlock` (planner-loop.ts:562-577) iterates `context.events`
   on every iteration. The routing-hint lines themselves come from
   `tool.action.routingHint` which is reference-stable, but the *event iteration*
   churns. Cheap enough alone to skip; merges naturally into the
   "available-actions block" memo because the inputs overlap.

5. `compactRuntimeEventForPrompt` and `textFromUnknown` in `context-renderer.ts`
   call `JSON.stringify` on every non-string event payload during
   `renderContextObject`. Most call sites pass strings; only `metadata`-bearing
   events hit the JSON fallback. NOT memoizable in a useful way (input changes
   per turn), and the cost is dominated by other code paths. Leave alone.

## Concrete patch list

### Implemented (high-confidence)

- **P1 — module-level WeakMap memo** keyed by `tool` (the
  `ContextObjectTool` object reference) for the rendered text line of
  `renderToolForAvailableActions`. Tools come from the action registry and
  are reference-stable across iterations within a turn (and across turns when
  the registry is unchanged), so a `WeakMap<ContextObjectTool, string>` gives
  us byte-identical output without ever recomputing
  `compactToolParameters` + `JSON.stringify`. Falls through cleanly when a
  caller hands us a fresh literal (cache miss = current behavior).

- **P2 — second-level memo** for the full
  `renderAvailableActionsBlock` joined string, keyed on the ordered list of
  tool object references + the sub-planner scope string. The cache lookup
  cost (`.map(t => t).join(",")`) is `O(tools)` but avoids the
  `.join("\n")` and the per-tool memo lookups on every iteration of the
  planner loop within a turn.

- **P3 — module-level WeakMap memo** for `renderRoutingHintsBlock`. Same
  pattern: key on context.events identity, value is the joined block (or
  `null`).

### Audit-only (left alone)

- `stringifyForModel(toolCall.params)` in `trajectoryStepsToMessages` and the
  trajectory-recording path: inputs are per-call and not repeat-friendly.

- `JSON.stringify(value)` fallback in `textFromUnknown`
  (context-renderer.ts:137): hit only by exotic event payloads. Not the
  bottleneck.

- `stableJsonStringify` in `context-hash.ts`: already the canonical stable
  hash function. Wave 2-D does NOT touch its output (cache-stability gate
  guards this).

## 3. Cache-breakpoint alignment

`provider-cache-plan.ts::selectStableRunBreakpoints` already lands breakpoints
exactly at the last stable index of each contiguous stable run
(`runEnds.push(activeStableIndex)`), which IS the segment boundary. Audit
finding: alignment is correct as-shipped; no realignment needed. Documented
here only so a future reader doesn't repeat the audit.

`selectSectionBreakpoints` (the section-driven path) honors
`section.segmentIndex` directly. The only landing-mid-segment failure mode is
if a caller passes a `segmentIndex` that points at an unstable segment;
that's a caller bug, and our code today doesn't have any such caller (the
trajectory prefix and message-handler prefix both pre-filter to
`stable: true` segments before mapping to indices).

No breakpoints were moved. No cache-stability snapshots required updating.

## 4. Enum short-form completion

Implemented behind `MILADY_SHORT_FORM_ENUMS=1`. The render path emits the
short-form hint after the parameter summary (`  short_form: <enum_value>` on
a separate line) so the byte-stable parameter JSON shape stays intact when
the flag is off. The dispatch path in `execute-planned-tool-call.ts`
expands a short-form enum value into the full JSON-schema-validated shape
before `validateToolArgs` runs, so strict validation at the boundary is
unchanged.

Short-form expansion triggers only when:
- the flag is set,
- the action has exactly one parameter with `enum`/`enumValues` populated,
- the model emits a bare string that matches one of the enum values
  (`params.<paramName>` = the string, or `params` itself = the string).

If any condition fails, the call goes through unchanged.

## 5. Cerebras compress mode

`MILADY_PROMPT_COMPRESS=1` (or `--compress` on the bench runner) is wired
through `optimized-prompt-resolver.ts` — when set AND the resolved tier maps
to a Cerebras large model, the resolver drops `fewShotExamples` from the
optimized-prompt output, leaving only the base optimized prompt. Routing
hints are skipped via a runtime check inside `renderRoutingHintsBlock`.
Top-K capping at 8 happens inside the lifeops bench runner.

This intentionally changes the prompt prefix when active and so changes the
prefix cache key. That is the entire point — it's an escape hatch for
token-budget-pressed runs, not a default. Cache-stability snapshots
unchanged because compress mode is opt-in and the canonical Stage 1/Stage 2
prefix used in the snapshot test does not flow through the resolver.

## 6. Cache-stability gate

`bun run test:cache-stability` passes unchanged after every patch in this
wave. None of the seven snapshot hashes drift — the memoizations are
output-equivalent (same bytes, fewer recomputations) and the new env-flag
modes are off by default.

## 7. Verification

```bash
bun run test:cache-stability                                  # 10/10 pass
bun test packages/core/src/runtime/__tests__/serialization-memo.test.ts
bun test packages/core/src/actions/__tests__/enum-short-form.test.ts
bun test packages/core/src/runtime/__tests__/compress-mode.test.ts
```

Microbenchmark target: the serialization-memo test asserts the second through
hundredth `renderAvailableActionsBlock` calls (over a 20-tool fixture) run
strictly faster than the first iteration. Tolerance is intentionally loose
(30%) because Vitest's overhead dominates at this scale; the win is real
and is measurable but a tight ratio would be flaky on noisy CI.
