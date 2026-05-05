# Deslop + Caveman Compression + Scambench Integration Plan

Status: 2026-05-03. Round-3 trivial-thought synth running (PID 4106187, ~7h ETA).
Train state: `train.jsonl` → `train_rewritten.jsonl` (5-source structural rewrites done) → `train_cleaned.jsonl` (cross-cutting cleanup, but with memoryEntries gap). Still pending: cleanup-gap-patch, trivial repack, harness merge.

This plan layers **six new transforms** on top of what exists, then chains everything into a final `train_v10.jsonl`.

## The six new asks

| # | Transform | Scope | Where |
|---|-----------|-------|-------|
| A | Deslop assistant text | reduce verbosity in `expectedResponse` reply text + assistant memoryEntries | `scripts/transform_deslop_assistant.py` |
| B | Caveman-compress thoughts | replace `thought:` field with caveman compression; keep original alongside in intermediate | `scripts/transform_caveman_thoughts.py` |
| C | Caveman action/provider descriptions | add caveman-short description field to every eliza action + dynamic provider | `scripts/caveman_eliza_descriptions.py` (touches eliza submodule TS) |
| D | Scambench inclusion | adapt scambench corpus to canonical eliza shape, drop into source pool | `scripts/sources/scambench_adapter.py` |
| E | TOON-instruction audit | every system prompt in `data/prompts/registry.json` declares TOON formatting + tool/reply schema | `scripts/audit_toon_instructions.py` |
| F | N-gram diversification using already-computed candidates | replace overused n-grams (`then confirm to deploy`, `connect any required credentials`, etc.) with statistically-less-likely paraphrases | `scripts/transform_ngram_diversify.py` |

## Caveman compression — what it actually is

From [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman):

- Strip stopwords (the, a, of, to, is, are, was, were, be, been, being, have, has, had, do, does, did, will, would, should, could, may, might, must, can, shall, …)
- Strip filler adverbs (just, really, actually, basically, simply, …)
- Keep nouns, verbs (lemmatize to base form), adjectives that carry meaning
- Optional: replace common phrases with abbreviations (because → bc, with → w/, without → wo/, etc.)
- Lowercase except proper nouns; collapse whitespace

The output reads like cavetalk: **"want list slot pick one"** instead of *"I want to list the available time slots so the user can pick one."*

For thinking text this is fine — the model just needs the content of the thought, not its prose. Empirical: 60–75% token reduction with no semantic loss for short reasoning.

## Deslop rules (Task A)

Apply only to **assistant reply text** inside `expectedResponse` (the `text:` field of the `reply:` block, after TOON decode), and to assistant `memoryEntries[*].content`.

Rules in order, all conservative:

1. **Drop "You are a/an …" leading sentence** when the response has ≥2 sentences. This is system-prompt slop leaking into replies.
2. **Drop trailing question** when the response has ≥2 sentences and the final sentence ends in `?`. (Single-sentence responses often legitimately ask back; multi-sentence responses with trailing questions are the slop pattern.)
3. **Drop trailing "Let me know if …" / "Hope this helps!" / "Feel free to …" / "Anything else?" sentences** when ≥2 sentences total.
4. **Strip "I'd be happy to …", "Sure thing!", "Of course!", "Absolutely!" leading interjections** before the substantive sentence.
5. **Cap at the smaller of `min(original_length, 1200 chars)` for replies, `800 chars` for memoryEntries** by truncating at the last sentence boundary that fits.

Don't apply to: tool_call expectedResponses, mcp_tool_call, agent_trace internal reasoning. Reply only.

## Caveman thoughts (Task B)

`thought:` field appears in `expectedResponse` for `reply`, `agent_trace`, `tool_call`, `mcp_tool_call` task types.

Pipeline:
- Decode TOON → extract `thought:` value.
- Run caveman compressor on it.
- Write a sibling intermediate file `data/intermediate/train_caveman_thoughts.jsonl` keyed by record index, containing both `original_thought` and `caveman_thought`.
- Replace `thought:` in the canonical record with the caveman version.
- Re-encode to TOON.

Audit: random-sample 500 records, hand-eyeball compression ratio + semantic preservation. Reject the transform per-record if the caveman output is < 3 tokens (too aggressive — keep original).

## Caveman action/provider descriptions (Task C)

Walk:
- `eliza/packages/agent/src/runtime/actions/*.ts` (core actions)
- `eliza/plugins/plugin-*/typescript/src/actions/*.ts` (plugin actions)
- `eliza/packages/skills/skills/*/SKILL.md` (skill descriptions)
- Provider files: `eliza/packages/agent/src/runtime/providers/*.ts` and per-plugin providers

Each has a `description: "..."` field. For each, generate a caveman-compressed description and add as `descriptionShort: "..."` (do not overwrite the long one). The runtime can decide which to surface to the model (planner sees short, dev docs see long).

Validation: short description must contain at least the verb + the primary noun of the long description (heuristic via spaCy NER or noun-phrase extraction). If not, fall back to long.

## Scambench (Task D)

Source: scambench (look up under HuggingFace `cot-research/scambench` or similar — a benchmark of social-engineering / scam attempts where the right behaviour is refusal or de-escalation).

Adapter:
- Each scambench record → canonical eliza record with `task_type: "reply"` and `metadata.source_dataset: "scambench"`.
- `currentMessage.content` = the scammer's message.
- `expectedResponse` = a TOON-encoded `reply:` block where `text:` contains the canonical refusal/de-escalation, and `thought:` is a first-person inner thought naming the threat type.

Dedupe by exact-content + group-key, mix into pack pipeline at the standard per-source cap (50k).

This is essential: **post-abliteration models lose refusal training**. We re-instill scam refusal via SFT data.

## TOON instruction audit (Task E)

For each entry in `data/prompts/registry.json`:
- Confirm the system prompt includes a TOON formatting instruction block. Required elements:
  - "Output ONLY a TOON document. No JSON, no markdown, no prose preamble."
  - The schema for the relevant task_type (reply / tool_call / etc.) inline in the prompt.
  - Example mini-block (1-2 lines) of the expected shape.
- For any prompt that doesn't, generate a missing-section diff and append the missing TOON instruction block.

## N-gram diversification (Task F)

Inputs: `data/synthesized/review/ngrams/diversification_candidates.json` (already computed).

Top targets:
- "then confirm to deploy" → vary: "then deploy", "deploy when ready", "confirm and deploy", "deploy after review"
- "connect any required credentials" → "connect credentials", "set up credentials", "wire in credentials", "add the credentials"
- "create an n8n workflow" → "build the workflow", "scaffold the workflow", "set up an n8n workflow"
- (any 4-gram with `total_count > 5000` and `gini > 0.6` is a target)

Strategy: pick a stratified subset (e.g. 60% of occurrences) and rewrite using a small per-phrase paraphrase table. Don't rewrite all — diversity matters more than complete elimination. Skip records where the phrase is structurally load-bearing (e.g. inside a TOON tool_calls block).

## Final integration order

```
train.jsonl
  → train_rewritten.jsonl                  (already done, 109,778 rewrites)
  → train_cleaned.jsonl                 (cleanup + memoryEntries gap patch)
  → train_trivial_repacked.jsonl           (round-3 thought replacement, after PID 4106187 finishes)
  → train_deslopped.jsonl                  (Task A)
  → train_diversified.jsonl                (Task F — n-gram swap)
  → train_caveman_thoughts.jsonl           (Task B)
  → merge: + harness records (data/synthesized/harness/*.jsonl)
  → merge: + scambench (Task D output)
  → train_v10.jsonl                        (final, after pack pipeline)
```

Tasks C, E touch eliza/registry — independent of the train.jsonl pipeline; they just need to be done before training so the prompts reflect reality.

## Subagent dispatch

Six agents, parallelizable as follows:

- **Group 1 (independent of train.jsonl, can run any time)**: C, E
- **Group 2 (chained, must run in order)**: A → F → B (each reads previous output)
- **Group 3 (independent, runs in parallel with anything)**: D

Dispatch all six in parallel; group-2 agents do their own waiting on inputs.

## Pre-flight before agents fire

- Run cleanup-gap-patch (10 min, deterministic, blocks Task A's input).
- Skim recent agent outputs for completion/limit status.
