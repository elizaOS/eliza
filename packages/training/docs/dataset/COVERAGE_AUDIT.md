# Corpus coverage audit — task_type → runtime phase

Companion to `RUNTIME_PHASES.md`. The runtime has exactly four LLM calls
per turn (`should_respond`, `response`, `action`, `evaluation`). This doc
maps every `task_type` value the corpus has ever emitted to one of those
phases, flags the records that don't fit, and prescribes the transform
or drop for each.

> The objective is **100% phase coverage** with **zero out-of-band
> records.** A record that doesn't match a runtime phase is teaching the
> model a behavior the runtime never invokes.

---

## Master mapping

| task_type                       | Phase | Source(s)                                  | Action |
|---------------------------------|-------|--------------------------------------------|--------|
| `should_respond`                | 1     | scambench, synthesize_should_respond_routing, synthesize_routing, scam-defense | KEEP |
| `should_respond_with_context`   | 1     | scambench, synthesize_routing               | KEEP |
| `dialogue_routing`              | 1     | synthesize_routing, multiparty               | KEEP — collapse onto `should_respond` shape |
| `should_mute_room`              | 1     | synthesize_core_prompts                     | KEEP |
| `should_unmute_room`            | 1     | synthesize_core_prompts                     | KEEP |
| `should_follow_room`            | 1     | synthesize_core_prompts                     | KEEP |
| `should_unfollow_room`          | 1     | synthesize_core_prompts                     | KEEP |
| `multiparty_should_respond`     | 1     | synthesize_multiparty_routing               | KEEP |
| `message_handler`               | 2     | synthesize_action_planner, nubilio          | KEEP — canonical phase-2 label |
| `agent_trace`                   | 2     | nubilio, agent-trove, toucan, hermes        | KEEP — alias of `message_handler` |
| `reply`                         | 2     | most adapters (default)                     | KEEP — slim phase-2 plan (REPLY-only) |
| `casual_reply`                  | 2     | rewrites/casual_reply_shorten               | KEEP — slim phase-2 plan |
| `tool_call`                     | 2     | hermes-fc, glaive, bitagent, toucan         | KEEP — phase-2 plan whose action[0]=TASK_CALL |
| `mcp_tool_call`                 | 2     | mcp-agent, mcp-routing                      | KEEP |
| `mcp_routing`                   | 2     | mcp-routing                                 | TRANSFORM — wrap `{server,tool,arguments}` into the phase-2 envelope under `tool_calls[0].params` |
| `shell_command`                 | 2     | nemotron-terminal, agent-trove (shell)      | KEEP — phase-2 plan whose action[0]=SHELL |
| `mobile_action`                 | 2     | mobile traces                               | KEEP — phase-2 plan |
| `scam_defense`                  | 2     | scambench, scam-defense-corpus              | KEEP — phase-2 plan |
| `n8n_workflow_generation`       | 2*    | n8n-workflow                                | DROP from main mix; route to a separate fine-tune. The runtime never emits an n8n workflow as part of a phase-2 plan. |
| `add_contact`                   | 3     | synthesize_core_prompts                     | KEEP |
| `choose_option`                 | 3     | synthesize_core_prompts                     | KEEP |
| `extract_secrets`               | 3     | synthesize_core_prompts                     | KEEP |
| `multi_step_decision`           | 3     | synthesize_core_prompts                     | RECLASS — it's the multistep planner template, which is phase-2-multistep, not phase-3. Move to Phase 2. |
| `message_classifier`            | 3     | synthesize_core_prompts                     | KEEP — classifier-only routing variant |
| `reflection`                    | 4     | synthesize_core_prompts                     | KEEP |
| `reflection_evaluator`          | 4     | synthesize_core_prompts                     | KEEP |
| `reasoning_cot`                 | OOB   | kimi, glm, opus, deepseek, qwen reasoning   | DROP — see "Out-of-band" below |
| `claude_distill`                | OOB   | Kassadin88/Claude-Distills                  | TRANSFORM — see "Claude distill" below |
| `abliteration_harmful`          | OOB   | abliteration corpus                         | KEEP for separate Heretic gate; do NOT mix with main SFT |
| `abliteration_harmless`         | OOB   | abliteration corpus                         | KEEP for separate Heretic gate; do NOT mix with main SFT |
| `dataset`                       | OOB   | synthesize_targets generic placeholder       | DROP — placeholder label, no semantic meaning |
| `prompt_entry`                  | OOB   | build_prompts metadata                       | DROP — internal build artifact |

*`n8n_workflow_generation` is structurally phase-2 (it ships under the
planner envelope) but the workflow JSON is never something the runtime
asks the agent to emit during a normal turn. It's a separate skill the
runtime would invoke as a tool, not as a top-level reply. Train it as a
standalone fine-tune or fold it into a `tool_call` example whose tool is
`n8n.create_workflow`.

---

## Out-of-band records

Records whose `task_type` is **OOB** above are the largest leakage path.
They train the model to emit shapes the runtime never asks for.

### `reasoning_cot` — drop or transform into phase-2

Volume: ~1.0M records (kimi-k25, glm-51, opus-47-thinking, deepseek-v4-distill,
qwen35-reasoning, regularizer-reasoning-tool).

What it currently teaches: long `<think>...</think>` math/code reasoning
followed by a final answer. The runtime's phase-2 output is `thought` (one
line) + `actions` + `text`. There is no place in the runtime where a
multi-paragraph chain-of-thought is emitted directly to the user.

**Transform options** (pick one — do not keep the raw shape):

1. **Drop entirely.** Cleanest. The reasoning quality the model needs at
   inference comes from in-distribution agent traces, not isolated math
   problems. ~1M records dropped.
2. **Reshape into phase-2 with `simple: true`**:
   - take the upstream user prompt → `currentMessage`
   - take the `<think>` body → `expectedResponse.thought` (collapsed to ≤ 240 chars)
   - take the final answer → `expectedResponse.text`
   - actions: `[{name: REPLY, params: {}}]`, providers: empty, simple: true
   This converts a math-question into a phase-2 reply. Useful only if we
   want to retain the reasoning ability; otherwise drop.
3. **Move to a separate stage-1 reasoning warmup**: train a small fraction
   on the raw `<think>` envelope in a curriculum step BEFORE the eliza
   SFT, then never see it again.

Decision (2026-05-04): **option 1 (drop)** for the main eliza-1 SFT mix.
Reasoning-only data dilutes phase coverage. Re-enable later as a
standalone DPO or RLAIF reward signal if desired.

### `claude_distill` — transform into phase-2 reply

Volume: ~129k records.

What it currently teaches: literal `<think>...</think>final-answer`
envelope from Claude Sonnet/Opus. Useful for thinking-mode shape but
NOT for runtime alignment — the runtime emits `thought` as a native JSON field,
not a `<think>` XML block.

**Transform**:
- `currentMessage` = user turn from the chat
- `memoryEntries` = system + prior turns (system prompt as system
  channel, prior user/assistant turns interleaved)
- `expectedResponse.thought` = the `<think>...</think>` body, trimmed to
  one line
- `expectedResponse.text` = the final answer
- `expectedResponse.actions` = `[{name: REPLY, params: {}}]`
- `expectedResponse.simple` = true
- `task_type` = `reply`

This rescues the reasoning quality from Claude while putting it in the
shape the runtime expects.

### `abliteration_*` — separate concern

Volume: small, fixed.

These are the harmful/harmless prompt pairs that drive Heretic ablation
direction discovery. They should never be mixed into the main SFT mix —
they are consumed by `scripts/quantization/heretic_*.py` to compute the
refusal direction, not by `train_local.py`.

**Action**: enforce a packing-time guard in `pack_dataset.py` that
excludes any record whose `task_type` starts with `abliteration_`.

### `dataset`, `prompt_entry` — drop

These are placeholder labels emitted by build/synthesis tooling. They
have no runtime mapping. Drop unconditionally.

---

## Per-phase coverage assessment (post-transform)

After applying the master mapping above:

| Phase           | Estimated records (post-transform) | Distribution target | Action |
|-----------------|------------------------------------|---------------------|--------|
| 1 should_respond| ~120k (scambench + synthesized)    | 25%                 | Synthesize ~30k more `should_respond_with_context` to reach target |
| 2 response      | ~600k after Tier-cap + reasoning_cot drop | 50%        | Already heavy. Cap further if needed. |
| 3 action        | ~30k (synthesized core_prompts)    | 15%                 | **Synthesize the missing ~6 action templates** (see below) |
| 4 evaluation    | ~5k (reflection only)              | 10%                 | **Largest gap — synthesize 5 evaluator types** (see below) |

---

## Phase 3 — missing action templates

`synthesized/core_prompts/*.jsonl` currently covers ~6 of the runtime's
~12 action-handler LLM calls. Missing:

| Action                    | Template                             | Synthesizer needed |
|---------------------------|--------------------------------------|--------------------|
| `REPLY`                   | `replyTemplate`                      | YES — extract from nubilio reply traces, re-shape input as the replyTemplate prompt |
| `REMOVE_CONTACT`          | `removeContactTemplate`              | YES — mirror of add_contact synthesizer |
| `EXTRACT_OPTION`          | `optionExtractionTemplate`           | YES — like choose_option but extracts from free text |
| `EXTRACT_SECRET_OPERATION`| `extractSecretOperationTemplate`     | YES |
| `EXTRACT_SECRET_REQUEST`  | `extractSecretRequestTemplate`       | YES |
| `IMAGE_DESCRIPTION`       | `imageDescriptionTemplate`           | LATER — needs vision data, defer |
| `IMAGE_GENERATION`        | `imageGenerationTemplate`            | LATER |
| `POST_CREATION`           | `postCreationTemplate`               | YES |
| `POST_ACTION_DECISION`    | `postActionDecisionTemplate`         | YES |
| `AUTONOMY_*` (4 variants) | `autonomy*Template`                  | YES — autonomy plugin |

Concrete next step: extend `scripts/synthesize_core_prompts.py` to emit
these missing files. Each follows the same pattern — read the template
from `eliza/packages/core/src/prompts.ts`, generate ~5k synthetic input
contexts per template, feed through a teacher model (Opus 4.7), native JSON-
encode the output, write to `data/synthesized/core_prompts/<action>.jsonl`.

---

## Phase 4 — evaluation gap (the largest hole)

Current state: only `reflection` and `reflection_evaluator` files exist
(~5k records). The runtime has **7 evaluator handlers** that each make an
LLM call.

| Evaluator                | Template                          | Synthesizer needed |
|--------------------------|-----------------------------------|--------------------|
| `REFLECTION`             | `reflectionEvaluatorTemplate`     | EXISTS |
| `REFLECT`                | `reflectionTemplate`              | EXISTS |
| `FACT_EXTRACTOR`         | `factExtractionTemplate`          | **MISSING** |
| `RELATIONSHIP_EXTRACTION`| `reflectionEvaluatorTemplate` (relationships sub-output) | **MISSING (separate single-task synth)** |
| `SKILL_EXTRACTION`       | (advanced-capabilities)           | **MISSING** |
| `SKILL_REFINEMENT`       | (advanced-capabilities)           | **MISSING** |
| `LONG_TERM_EXTRACTION`   | `longTermExtractionTemplate`      | **MISSING** |
| `SUMMARIZATION`          | `initialSummarizationTemplate`    | **MISSING** |

Concrete next step: add `scripts/synthesize_evaluator_prompts.py` that
emits one JSONL per evaluator template. For each:

1. Read template body from `eliza/packages/core/src/prompts.ts`.
2. Generate ~3k synthetic recent-message-window inputs (varying length,
   topic, named entities).
3. Render the template with the input context.
4. Run a teacher model (Opus 4.7) to produce the structured output.
5. Wrap as canonical `ElizaRecord` with `task_type=<evaluator_name>` and
   `expectedResponse` = JSON-or-native JSON output of the template.

Output target: ~3k × 7 = **~21k phase-4 records**, lifting evaluation
coverage from <0.1% to ~3% of corpus, sufficient for the model to learn
the shapes.

See the synthesizer spec in `docs/dataset/EVALUATOR_SYNTHESIS.md`.

---

## Validation

A new validator (`scripts/classify_records_by_phase.py`) walks the packed
corpus and tags each record with `runtime_phase ∈ {1,2,3,4,OOB}`. It
emits:

- `previews/PHASE_COVERAGE.md` — per-task_type and per-source phase
  distribution.
- `previews/OUT_OF_BAND_SAMPLES.jsonl` — first 200 OOB records by source
  for human review before drop/transform.

Acceptance gate (run before each pack):

- 0 records with `runtime_phase = OOB` in the final pack
- Phase distribution within ±5% of the targets above
- No `task_type = dataset` or `task_type = prompt_entry` in the final
  pack
- No `task_type` starting with `abliteration_` in the final pack
