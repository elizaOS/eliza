# Eliza-harness guided structured decoding — design + prefill-plan format

Wave-6 / eliza-1 swarm, 2026-05-11. Scope: when the model's job is to emit a
*structured* response (action selection / tool call / typed object), don't make
it generate the JSON scaffolding or the long human-readable names of things we
already know — force the JSON-schema structure in the decode loop, and where a
run of tokens is deterministically implied by the schema + the known
enum/action-name set, fill those tokens in directly (no forward pass) and
advance the decoder to the next free parameter.

## Have / need / missing (state at start of wave)

**Have** (already in tree — this work builds on it, does not duplicate):
- `@elizaos/core` `ResponseSkeleton` / `ResponseSkeletonSpan` (`packages/core/src/types/model.ts`)
  — the engine-neutral structure-forcing description; `literal` spans are zero
  sampled tokens, `enum` spans pin a closed set, `free-string`/`free-json` are
  sampled normally.
- `@elizaos/core` `buildResponseGrammar` / `buildPlannerActionGrammar` /
  `buildPlannerParamsSkeleton` (`packages/core/src/runtime/response-grammar.ts`)
  — the producer side: walks the registered actions + Stage-1 field evaluators
  + context ids and emits a `ResponseSkeleton` **plus** a precise GBNF string
  (the `contexts` array-of-enum can't be expressed in a flat span list). Already
  wired: `message.ts` (Stage 1) and `planner-loop.ts` (Stage 2) set
  `responseSkeleton` / `grammar` / `providerOptions.eliza.plannerActionSchemas`
  on the model call. The action-catalog `normalizeActionName` results
  (`SEND_MESSAGE`, `IGNORE`, …) are already the canonical short ids used on the
  wire.
- `packages/app-core/src/services/local-inference/structured-output.ts` — the
  local-engine mirror: `compileSkeletonToGbnf` (lazy GBNF, single-value enums
  collapse to literals), `resolveGrammarForParams` (precedence), `grammarRequestFields`.
- `dflash-server.ts` `buildChatCompletionBody` — already folds `grammar` /
  `grammar_lazy` / `grammar_triggers` and an assistant-turn `prefill` onto the
  llama-server request; `engine.ts` does the node-llama-cpp equivalent.
- The fork pin already carries `grammar_lazy` / `json_schema` / `response_format`
  / `prefill_assistant` (AGENTS.md header); `server-structured-output.mjs` is the
  tolerant build-time reporter for those.

**Need / missing** (this wave):
1. The **deterministic-token prefill plan** — metadata derived from the skeleton
   describing which byte runs are *fully determined* once a branch is chosen, so
   a constrained-decode server can splice their token ids without a forward pass
   and advance the cursor to the next free param. The skeleton already *carries*
   the literal spans; what was missing is the compact, wire-shippable plan + the
   server contract for it + the runtime wiring + the off-by-default switch.
2. A single place that bundles skeleton + grammar + prefill plan + the short/long
   name maps into one engine-facing descriptor — the **eliza harness schema**.
3. The off-by-default request flag (so unguided generation is untouched).
4. A token-savings benchmark.

## What was implemented

### 1. Eliza harness schema + prefill plan (`structured-output.ts`)

`ElizaHarnessSchema` = `{ skeleton, grammar?, prefillPlan, longNames, id }` —
the compact descriptor the agent loop hands the engine.
`elizaHarnessSchemaFromSkeleton({ skeleton, grammar?, longNames? })` is the
single place the prefill plan is derived.

`compilePrefillPlan(skeleton)` → `ElizaPrefillPlan | null`:
- Runs `collapseSkeleton` first (single-value enums → literals — the model
  samples nothing for a one-action turn).
- Walks the spans, **merging consecutive `literal` spans into one deterministic
  byte run** and counting the free spans.
- Returns `{ prefix, runs, freeCount, id }` where `runs` is the ordered list of
  deterministic byte runs **alternating with the free spans**, anchored by
  *position* rather than absolute byte offset (sampled spans have unknown length
  at plan time):

  ```
  run(afterFreeSpan=-1)  free[0]  run(afterFreeSpan=0)  free[1]  …  run(afterFreeSpan=n-1)
  ```

  `afterFreeSpan = -1` is the leading run (seeded as an assistant-turn prefill);
  `afterFreeSpan = k` is the deterministic run that follows free span `k`; the
  last run (`afterFreeSpan = freeCount-1`) is the tail scaffold (closing braces)
  after the final free span. `prefix` is the leading run's text when the
  skeleton opens with a literal, `""` otherwise.

**Correctness invariant** (asserted by the tests): concatenating the runs
interleaved with the (eventually-sampled) free-span values reproduces a
byte-identical JSON document to what the lazy GBNF from `compileSkeletonToGbnf`
would have produced. The plan is *purely a speedup hint* — a server that ignores
it produces the identical output because the grammar already forces the same
bytes; a server that honours it produces it faster.

`prefillPlanRequestFields(plan)` → `{ eliza_prefill_plan: { prefix, runs:
[{ after_free_span, text }], free_count, id } }` (or `{}` when null) — the
request-body fragment.

`resolveGuidedDecodeForParams(params)` → `{ grammar, prefillPlan, prefill }` —
the single resolver: when `params.elizaSchema` is present, returns the schema's
grammar (or compiles the skeleton), its prefill plan, and the plan's leading run
as the assistant-turn prefill (unless the caller already supplied an explicit
`prefill`, which wins). When absent, returns just the bare-`grammar`/`responseSkeleton`
grammar with **no prefill plan** — i.e. guided decode is off.

### 2. Short ↔ long name wiring

`expandShortName(schema, shortId)` / `canonicalizeShortName(schema, name)` —
round-trip a decoded canonical short id to a display label and back, using
`schema.longNames` (sourced from the action catalog). The canonical action ids
(`normalizeActionName` results) are *already* the on-wire/decoded form, so this
is identity unless a producer registered a separate display label — the helpers
exist so the contract is in one place and a future label map plugs in without
touching the decode loop.

### 3. Engine wiring (off by default)

- `dflash-server.ts` `buildChatCompletionBody` — now resolves via
  `resolveGuidedDecodeForParams`: emits the grammar (+ `grammar_lazy` /
  `grammar_triggers`), the leading-run assistant prefill (+ `continue_final_message`),
  and **`eliza_prefill_plan`** — only when an `elizaSchema` carried a plan. A bare
  `responseSkeleton` still gets the grammar (constrained decode) but no prefill
  plan and no prefill (verified by test). `generateWithUsage` re-prepends the
  resolved prefill to the streamed/returned tail via the same helper so the two
  never diverge.
- `engine.ts` (node-llama-cpp path) — same grammar resolution + prefill seeding
  via `resolveGuidedDecodeForParams`; the prefill plan is ignored there (no
  token-splice API), but the leading literal run is still seeded as a prompt
  prefix.
- `ensure-local-inference-handler.ts` — `elizaHarnessSchemaFromParams(params)`
  builds the `ElizaHarnessSchema` from `params.responseSkeleton` (+ `params.grammar`)
  **only when guided decode was requested**: either
  `providerOptions.eliza.guidedDecode === true` (the planner/message service
  sets this when it built a forced skeleton) or `MILADY_LOCAL_GUIDED_DECODE=1`
  (`ELIZA_LOCAL_GUIDED_DECODE=1`). No flag → no `elizaSchema` → guided decode off.

### 4. Build-time reporter (`server-structured-output.mjs`)

`eliza_prefill_plan` added to the tolerant feature-report list (item 7). It is an
elizaOS-fork extension, not upstream — absent in today's pin, so the reporter
warns; the runtime sends the field unconditionally when guided decode is on and
degrades to the grammar-only path. **No submodule edit** — a future fork build
that consumes the field is a `kernel-patches/` addition, per the contract. The
runtime is correct either way.

### 5. Benchmark — `packages/inference/verify/guided_decode_token_bench.mjs`

Two modes, like the other `verify/` harnesses:
- **static** (always runs, no model): for each representative skeleton —
  8-action planner select, single-action select, Stage-1 envelope, a typed
  SETTINGS object — reports the deterministic-run bytes/estimated-tokens (the
  tokens the model *never generates*, independent of which words it picks for
  free spans) vs. the total envelope. `--bpt N` overrides the ~3.6 bytes/token
  estimate.
- **live** (`--bin PATH --model PATH`): runs each prompt unguided vs. with the
  harness schema on the request, reports `completion_tokens` and wall-time
  delta. Today's fork ignores `eliza_prefill_plan`, so the live delta is the
  *grammar-only* saving (scaffold still generated, but constrained); the
  prefill-plan saving lands when a fork build consumes the field — the static
  mode is that floor. Writes `status: "skipped"` + exits 0 when no binary/model
  — does NOT fabricate numbers (AGENTS.md §3 / §8).

## Measured token savings (static, this machine, bpt=3.6)

```
planner-action-select (8 actions)        free-spans=3   forced≈10 tok  free≈37 tok  → 21% fewer generated
planner-action-select (single action)    free-spans=2   forced≈12 tok  free≈33 tok  → 27% fewer generated   (action id also forced — 0 tokens spent on it)
stage1-response-envelope                  free-spans=6   forced≈23 tok  free≈70 tok  → 25% fewer generated
typed-fields-object (SETTINGS)            free-spans=4   forced≈15 tok  free≈11 tok  → 58% fewer generated
AGGREGATE                                 60/211 tokens forced ≈ 28% reduction
```

Report JSON: `packages/inference/verify/bench_results/guided_decode_<date>.json`.
Caveats: the "free" byte counts are deliberately conservative point estimates
(thought ~80 B, replyText ~120 B, parameters ~40 B) — for a terse action turn
with a short `thought` the prefill-plan share is materially higher; for a long
free-form `replyText` it's lower. The forced share is *exact* (it's the literal
spans + collapsed enums). The single-action case is the headline: the model
generates **zero** tokens for the action id and the JSON scaffold — only its
`parameters` and `thought`. The grammar already constrains the multi-action enum
to the closed action-id set; the prefill plan additionally removes the
deterministic scaffold from the forward-pass count.

## Tests

- `packages/app-core/src/services/local-inference/structured-output.test.ts` —
  `compilePrefillPlan` (literal merging, free-span count, tail run, null when no
  deterministic runs), `prefillPlanRequestFields`, `elizaHarnessSchemaFromSkeleton`,
  `resolveGuidedDecodeForParams` (grammar precedence, prefill precedence,
  off-by-default), short↔long round-trip.
- `packages/app-core/src/services/local-inference/dflash-structured.test.ts` —
  prefill-plan extraction on a planner skeleton, single-value-enum collapse into
  the deterministic run, the byte-for-byte reassembly invariant (runs + sampled
  values → valid JSON identical to the GBNF output), `buildChatCompletionBody`
  emits grammar + `eliza_prefill_plan` + assistant prefill for an `elizaSchema`,
  does **not** for a bare `responseSkeleton` (off by default), explicit prefill
  wins over the plan's leading run.

`bunx vitest run` on the two files: 33 passed. `tsc -p packages/app-core`: exit 0.

## What's still gated

- **The forward-pass skip itself — fork-side, not yet landed.** The fork pin
  (`packages/inference/llama.cpp`) doesn't consume `eliza_prefill_plan` yet. The
  design is in `.swarm/plans/cluster-4.md` §A.2 (two complementary mechanisms:
  (1) parse `eliza_prefill_plan` in `tools/server/server-task.cpp`, store the
  cached-by-`id` run token-ids on the slot, and after each free span splice the
  next run's tokens into the sequence + advance `n_past` + advance the grammar
  stacks — zero forward passes for forced runs; (2) a general
  `llama_grammar_next_forced_run(grammar, vocab)` in `src/llama-grammar.{h,cpp}`
  that derives the forced run when the allowed-token mask narrows to a singleton
  chain — works for any GBNF). The DFlash composition: forced runs = 0 drafter
  calls + 0 target passes; the drafter only fires at free spans. This is a
  **structural fork commit** (not a regex `kernel-patches/` patch) + a submodule
  bump — must land on a fork branch+tag coordinated with the build-matrix owner
  (WS-2 / `eliza/main`). The fork-level equivalence test (real model, plan vs
  no-plan → byte-identical output + fewer `decode()` calls) must pass before the
  fast-forward ships. The runtime sends the field today and degrades to
  grammar-only / byte-identical output when the server doesn't consume it —
  correctness is unaffected, latency is the grammar-only saving until then.
- **`MILADY_LOCAL_GUIDED_DECODE` default — DONE.** The Stage-1 response handler
  (`packages/core/src/services/message.ts`) and the Stage-2 planner
  (`packages/core/src/runtime/planner-loop.ts`) now set
  `providerOptions.eliza.guidedDecode = true` next to the `responseSkeleton`
  assignment via `withGuidedDecodeProviderOptions()`
  (`packages/core/src/runtime/response-grammar.ts`) — guided decode is **on by
  default** for the two calls that always carry a forced skeleton. Operator
  opt-out: `MILADY_LOCAL_GUIDED_DECODE=0` (or `ELIZA_LOCAL_GUIDED_DECODE=0` /
  `false` / `off` / `no`). Cloud adapters ignore the flag. Tests:
  `packages/core/src/runtime/__tests__/response-grammar.test.ts` (`withGuidedDecodeProviderOptions`
  — default-on, sibling preservation, env opt-out, idempotent merge).
- **Display-label map.** `longNames` is plumbed end-to-end but empty unless a
  producer fills it; the action catalog's `normalizeActionName` ids are already
  the wire form, so this is a no-op until a separate label surface exists.
