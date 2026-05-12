# Schema-constrained decoding for eliza-1 tool calls

Status: survey + recommendations (2026-05-11). Inference/harness side is read-only here
(active "voice swarm" territory). The training-pipeline angle is owned by this doc and a
small helper has been added (`packages/training/scripts/emit_native_grammar.py`).

The eliza-1 local models are fine-tuned to emit the `eliza_native_v1` planner envelope —
`{"thought": "...", "toolCalls": [{"id"?, "name", "args"}], "messageToUser"?}` — and the
*catalog of available actions and their argument schemas is known at inference time*
(`packages/core/src/generated/action-docs.ts`; the per-turn exposed set is narrower).
That makes the tool-call portion of every turn almost entirely schema-determined: the
JSON scaffold, the key names, the `name` enum, the required-arg keys, and any enum-valued
args are all *forced by the schema, not chosen by the model*. This document assesses how
to exploit that for throughput (fewer rejected/resampled tokens, fewer forward passes) and
quality (no invalid action names, no malformed args).

## A. What exists today

### Grammar production (`@elizaos/core`)

`packages/core/src/runtime/response-grammar.ts` already builds per-turn GBNF:

- **Stage-1 envelope** (`buildResponseGrammar`): a precise GBNF for the HANDLE_RESPONSE
  flat envelope, including the one constraint a flat span model can't express — `contexts`
  is an *array whose elements are drawn from the available-context-id enum*. Single-value
  field-evaluator enums lower to literals (zero tokens). Cached per
  (channel × context-id set × action set × field-registry signature).
- **Stage-2 planner** (`buildPlannerActionGrammar`): a GBNF for the `PLAN_ACTIONS` tool-call
  *args* — `{"action": <enum of exposed action names>, "parameters": <json object>,
  "thought": <json string>}` — plus `actionSchemas`, a map of action name → normalized
  parameter JSON schema, intended for a *second* constrained pass on `parameters` once
  `action` is sampled. Returns `null` when no actions are exposed.
- A `ResponseSkeleton` (engine-neutral span list) accompanies each grammar; W4 compiles it
  to a *lazy* GBNF (`grammar_lazy` + `grammar_triggers`) so prose `replyText` free-runs and
  the grammar only kicks in at the JSON envelope boundary.

### Harness consumption (`@elizaos/app-core`)

`packages/app-core/src/services/local-inference/structured-output.ts` mirrors the W3
`GenerateTextParams` extensions (`prefill`, `responseSkeleton`, `grammar`,
`streamStructured`), compiles a `ResponseSkeleton` → lazy GBNF, and
`resolveGrammarForParams` picks the explicit `grammar` over a compiled skeleton.
`dflash-server.ts` → `buildChatCompletionBody` folds the result into the llama-server
request body as `grammar` / `grammar_lazy` / `grammar_triggers` and threads `prefill`
(trailing partial assistant message + `continue_final_message`).

### The fork's `llama-server`

`packages/inference/llama.cpp` (`elizaOS/llama.cpp` at `v1.0.0-eliza`): `server-task.cpp`
accepts `grammar`, `json_schema` (auto-converts via `json_schema_to_grammar`),
`grammar_lazy`, and `grammar_triggers` on both `/v1/chat/completions` and `/completion`.
`common/json-schema-to-grammar.cpp` exists. node-llama-cpp 3.18.1 also exposes GBNF +
JSON-schema-to-grammar wrappers. So the **plumbing for grammar-constrained sampling exists
end to end**.

### `eliza_native_v1` training rows

`packages/training/scripts/lib/native_record.py`: `native_tool_call_record` writes
`response.text = json.dumps({"thought","toolCalls":[{"id","name","args"}],
"messageToUser"?}, separators=(",",":"))` — compact, key order fixed (`thought`,
`toolCalls`, then optional `messageToUser`). `request.tools` carries the AI-SDK tool
specs. `format_for_training.py` passes `tools` through to `apply_chat_template`; the legacy
flat path appends `"Available actions: <names>"` to the system prompt and `toolSpecs` JSON.

## B. Gaps and the wins on the table

### B1. The Stage-2 grammar targets the wrong envelope (correctness gap)

`buildPlannerActionGrammar` constrains the **`PLAN_ACTIONS` tool-call args**
(`{action, parameters, thought}` — *one* action per call). But the eliza-1 model is fine-
tuned to emit the **`eliza_native_v1` planner envelope** as text (`response.text` in the
training rows) — `{thought, toolCalls:[{id,name,args}], messageToUser?}` — possibly with
*multiple* tool calls. `parsePlannerOutput` handles both, but the **grammar that gets
attached to the local-inference call does not match the format the local model was trained
to produce**. On the cloud/AI-SDK path (where the provider emits native `PLAN_ACTIONS`
tool calls) it is fine; on the local path it can actively *fight* the model. This is the
single highest-value item: either (a) add a `buildNativeEnvelopeGrammar` that constrains
`{thought, toolCalls:[{id,name(enum),args(per-action)}], messageToUser?}` for the local
engine, or (b) decide the local model emits PLAN_ACTIONS-style tool calls and align the
*training rows* to that. Recommendation: (a) — the `eliza_native_v1` envelope is the
documented canonical shape (`CANONICAL_RECORD.md`); the grammar should follow it. The
`emit_native_grammar.py` helper added by this doc produces exactly that GBNF as a reference.

### B2. The per-action second pass is produced but never consumed

`buildPlannerActionGrammar` returns `actionSchemas` and `planner-loop.ts` stuffs it on
`providerOptions.eliza.plannerActionSchemas` — but **nothing reads it**. So `args` /
`parameters` are currently a free JSON object: the model can still emit an arg key that
isn't in the schema, or skip a required key. Implementing the second pass (or, better, a
single grammar with `name`-conditioned `args` — see B3) closes the "malformed args" half of
the quality story. Estimated quality benefit: eliminates the residual arg-shape error
class entirely (today's mitigation is `validate-tool-args.ts` *after* generation, which
costs a re-plan round trip on failure).

### B3. Grammar-constrained sampling — the throughput counter-intuition

llama.cpp's grammar sampler masks invalid tokens *at sample time*: when the grammar admits
only a small token set (e.g. right after `"name": "` the only legal next tokens are the
prefixes of the available action names), sampling is **faster**, not slower — the softmax is
the same, but the candidate set the sampler walks is tiny, and there is zero risk of an
out-of-grammar token that has to be detected and resampled. For a turn that's ~30 forced
scaffold tokens + a short `name` enum + a couple of required arg keys, a precise grammar
removes essentially all "model picked something invalid → re-plan" rounds. Net: **strictly
faster and strictly higher-quality** vs. unconstrained, with no downside other than the
grammar-compile cost (already cached per turn-shape). This is the table-stakes win and the
plumbing is done — B1/B2 are what's missing to make it *correct* for the local path.

### B4. Jump-ahead / fast-forward decoding of the forced tokens (the real `tg` win)

When the grammar admits **exactly one continuation token** (or a known short literal),
there is no need for a forward pass — emit it and advance the grammar state. For an
eliza-1 tool call the forced run is substantial: `{"thought":` (then free), `"toolCalls":[{`
`"id":"call_`, `"name":"`, then the action name (forced once enough prefix pins it to one
candidate), `"args":{`, then a required key `"foo":` (forced), … — easily 10-30 tokens per
call that are *schema-deterministic*. Outlines, XGrammar, llguidance, and SGLang all do
this ("fast-forward" / "jump-forward decoding"); on a 0.6B/1.7B local model skipping 20
forward passes per turn is a real latency saving (each skipped pass ≈ one `tg` token of
wall time). **The fork does not do this today.** `src/llama-grammar.cpp` has
`llama_grammar_accept` / `llama_grammar_accept_str` (advance state given a piece) but no
"if the grammar's reachable terminal set is a single token, return it without sampling"
shortcut, and neither `common/sampling.cpp` nor the server loop calls anything like it.
node-llama-cpp 3.18.1 has no flag for it either. This is a **fork punch-list item**: in the
sampler, before the forward pass, check whether the grammar (intersected with the model
vocab) has a unique legal next token — if so, emit it, run `llama_grammar_accept`, and skip
the decode. The cheap 80%-version: detect literal runs in the GBNF at compile time and emit
them as a chunked "forced span" the server splices in (this is roughly what the
`ResponseSkeleton` already encodes — `splitSkeletonAtFirstFree` exists; the missing piece is
the server-side "accept this literal without decoding" path). Estimated benefit: 15-40% off
per-turn tool-call latency on the small tiers, more for multi-tool-call turns.

### B5. Training-format alignment (do this in the training pipeline now)

If the grammar will be applied at inference, the model should be trained on *exactly* what
the grammar enforces, so it never spends probability mass on a continuation the grammar will
reject (which wastes the constrained-decoding speedup and, on a lazy grammar, can still
produce a mid-stream stall). Concretely:

- **Key order must match the grammar's literal order.** `native_record.py` already emits
  `{thought, toolCalls, messageToUser?}` and `{id, name, args}` in fixed order with
  `separators=(",",":")` (no spaces). The grammar must use the *same* order and the *same*
  whitespace policy (compact). The `emit_native_grammar.py` helper does — and its test
  asserts the emitted GBNF accepts a sample of real `response.text` envelopes from the
  corpus, so any drift between the two is caught in CI.
- **`messageToUser` optionality.** Training rows include it iff non-null; the grammar must
  make it optional (`( ,"messageToUser": <jsonstring> )?`) — matched.
- **The `name` enum should be the *exposed* set, not the full catalog.** Training rows that
  set `availableActions` / `request.tools` to the turn's exposed set already do this; the
  grammar's enum is built from the same exposed set in `buildPlannerActionGrammar`. Keep
  them sourced from one place.
- **`args` per-action.** If B2/B3 land (per-action arg constraint), training rows must only
  ever contain arg keys that appear in that action's schema (and required keys must be
  present). `audit_pipeline_shapes.py` / `validate_eliza1_trajectory_dataset.py` are the
  natural places to add that check. Recommendation: add an "args-conform-to-action-schema"
  gate to the corpus validator once the inference side commits to the per-action grammar.

### B6. The model already sees the schemas — make the presentation token-efficient

The planner prompt (`packages/core/src/prompts/planner.ts`) does *not* itself list the
actions — it references `available_actions` "in the conversation", and the actual action
names + parameter schemas are rendered into the conversation context (the planner-rendering
path; AI-SDK `tools` for cloud). `action-docs.ts` already carries `descriptionCompressed` /
`compressedDescription` per action and per parameter — good. Two cheap improvements:

- **Drop `description` and examples from the in-context schema when a grammar is active.**
  If the grammar guarantees the `name` enum and arg keys, the model needs the *names* and
  the *enum values* of enum args, not prose. A compact form — `ACTION_NAME(req_key, ...,
  opt_key?: "a"|"b")` one line per action — is a fraction of the JSON-schema token cost and
  is all the model needs when the grammar backs it up. (Keep the full JSON-schema form for
  cloud providers that lack grammar support.)
- **Sort the enum + keys deterministically** (already done in `buildPlannerActionGrammar` —
  `names.sort()`) so the in-context presentation, the grammar, and the training rows agree
  byte-for-byte, which maximizes prompt-cache hits.

With the schemas visible *and* a grammar enforcing them, the model rarely needs correcting:
no `validate-tool-args.ts` re-plan rounds, no "invented compound action name" failures (a
known prompt-rule today: *"never invent compound names"* — a grammar makes that rule
unnecessary).

## C. Punch list

### Harness / inference-team work

1. **B1 — local-path native-envelope grammar.** Add `buildNativeEnvelopeGrammar` (or fix
   `buildPlannerActionGrammar`'s consumer) so the GBNF attached to local-inference planner
   calls constrains the `eliza_native_v1` envelope (`{thought, toolCalls:[{id?,name(enum),
   args}], messageToUser?}`), not the `PLAN_ACTIONS` tool-args shape. Cross-check against
   `emit_native_grammar.py`'s output. **Highest priority — current grammar can fight the
   local model.**
2. **B2/B3 — per-action `args` constraint.** Either implement the second constrained pass
   that consumes `providerOptions.eliza.plannerActionSchemas`, or (preferred) emit one
   grammar where `args` is `name`-conditioned (`args` rule branches on the chosen action's
   key/enum set). Removes the post-hoc `validate-tool-args.ts` re-plan round.
3. **B4 — jump-ahead / fast-forward.** Fork punch-list: in the sampler, when the grammar
   (∩ vocab) has a unique legal next token, emit it and `llama_grammar_accept` without a
   forward pass. Cheap interim: server-side "accept this literal span without decoding"
   driven by the `ResponseSkeleton` literal runs. 15-40% per-turn `tg` saving on small tiers.
4. **B6 — compact in-context schema.** When a grammar is active for the call, render actions
   as compact one-liners (`NAME(req, opt?: "a"|"b")`) instead of full JSON Schema; keep the
   full form for non-grammar (cloud) providers. Deterministic sort for cache stability.
5. Confirm whether the local model emits the native envelope as `response.text` or as
   `PLAN_ACTIONS` native tool calls — this decides B1's exact shape. (Training rows say
   `response.text` envelope; verify the runtime path matches.)

### Training-pipeline work (done / do now)

- **Done:** `packages/training/scripts/emit_native_grammar.py` — generates the canonical
  GBNF for the `eliza_native_v1` planner envelope from a list of action names (and optional
  per-action arg specs / arg enums, e.g. parsed from `action-docs.ts` or
  `data/prompts/actions-catalog.json`). `--names a,b,c` or `--action-docs <path>` or
  `--catalog <path>`; `--with-args` adds per-action arg-key constraints. Writes GBNF to
  stdout or `--out`. This is the reference the harness team should diff their local-path
  grammar against.
- **Done:** `packages/training/scripts/test_emit_native_grammar.py` — asserts the emitted
  GBNF (a) parses, (b) accepts a sample of real `eliza_native_v1` `response.text` envelopes
  drawn from the corpus / synth fixtures, (c) rejects an envelope using an action name not
  in the enum. This catches any drift between the training row format and what a grammar
  would enforce.
- **Recommended next (blocked on inference-side B2 decision):** add an
  "args-conform-to-exposed-action-schema" gate to `validate_eliza1_trajectory_dataset.py` /
  `audit_pipeline_shapes.py` so corpus rows never contain arg keys outside the action's
  schema (and required keys are present) — only worth doing once the inference side commits
  to enforcing per-action arg grammars.
- **Recommended:** when `format_for_training.py` (or the planner-rendering producer) gains
  the compact-schema mode (B6), regenerate the affected synth datasets so the in-context
  action presentation in training rows matches what inference will show. Track in
  `huggingface-todo.md`.

## Bottom line

The grammar plumbing is built and the fork accepts `grammar`/`json_schema`/`grammar_lazy`.
Two correctness gaps make it not yet useful on the *local* path (the Stage-2 grammar targets
the wrong envelope; the per-action arg constraint is produced but unused). Closing those is
"strictly faster + strictly higher quality, no downside". The bigger latency lever —
jump-ahead decoding of the ~10-30 schema-forced tokens per tool call — does not exist in the
fork and is a worthwhile inference-team punch-list item. On the training side, the row
format already matches a sane grammar (compact JSON, fixed key order); the new
`emit_native_grammar.py` + test pin that down so it stays aligned, and the per-action arg
gate is the one remaining corpus-validator item, gated on the inference-side decision.
