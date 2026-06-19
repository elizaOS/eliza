---
license: apache-2.0
language:
  - en
task_categories:
  - text-generation
tags:
  - elizaos
  - eliza-1
  - on-device
  - agent
  - tool-use
  - sft
pretty_name: Eliza-1 0.6B SFT
configs:
  - config_name: default
    data_files:
      - split: train
        path: train.jsonl
      - split: validation
        path: val.jsonl
      - split: test
        path: test.jsonl
---

# Eliza-1 0.6B — Supervised Fine-Tuning Dataset

Benchmark-aligned SFT data for the **`eliza-1-0_6b`** base (upstream
`Qwen/Qwen3-0.6B`; Qwen2/Qwen3 ChatML template; vocab 151,936; 4096-token
training window). Built by
`packages/training/scripts/build_eliza1_sft_0_6b.py` from in-repo benchmark
sources, augmented and repaired with Cerebras `gpt-oss-120b`
(OpenAI-compatible API).

## Format

ChatML JSONL — one row per line:

```json
{"messages": [{"role": "system|user|assistant", "content": "..."}, ...],
 "task": "action_selection|tool_use|personality|assistant|structured_decode|voice_emotion",
 "provenance": "benchmark:<file>#<id> | synthetic:<task> | cerebras:<task>",
 "tags": ["..."]}
```

The `messages` array matches the 0.6b's chat template; the splitter and
`packages/training/scripts/train_local.py` ingest it directly via
`--train-file` / `--val-file` (the `chat_messages` shape understood by
`scripts/format_for_training.py`). `task` / `provenance` / `tags` are dropped
at format time — they are metadata for stratified sampling and audits.

## Task mix

| task | rows | source |
|---|---:|---|
| `action_selection` | ~68 | `packages/app-core/test/benchmarks/action-selection-cases.ts` — user turn → the action the agent should pick (or a plain reply for `expectedAction: null`), rendered as `ACTION: NAME {params}` + a short confirmation. 1:1 with the action-selection benchmark case ids. |
| `tool_use` | ~730 | Cerebras-generated agent-loop turns over the canonical action catalog (`OWNER_TODOS`, `CALENDAR`, `MESSAGE`, `BLOCK`, …, `REPLY`): more domain/phrasing variety, ambiguous cases, negative (no-action) cases. |
| `personality` | ~37 | `packages/benchmarks/personality-bench/tests/calibration/{hand-graded,adversarial}.jsonl` — PASS-graded trajectories for the five rubrics (`shut_up`, `hold_style`, `note_trait_unrelated`, `escalation`, `scope_global_vs_user`). Silence-on-demand rows are truncated to the last trainable assistant turn. |
| `assistant` | ~370 | Cerebras-generated general assistant turns (concise factual Q&A, explanations of speculative decoding / quantization / VAD / on-device inference — the topics the `eliza1_eval_suite` held-out text-eval corpus probes), plus polite refusals (`cerebras:refusal`) and short multi-turn exchanges (`cerebras:multiturn`). |
| `structured_decode` | ~250 | Stage-1 response-envelope turns: the W3 flat **JSON** envelope `@elizaos/core` `buildResponseGrammar` constrains — `{"shouldRespond":"RESPOND\|IGNORE\|STOP","thought":...,"replyText":...,"contexts":[...],"contextSlices":[...],"candidateActions":[...],"parentActionHints":[...],"requiresTool":<bool>,"extract":{...}}` (`shouldRespond` dropped on direct DM/voice/API channels). Key order matches `packages/core/src/runtime/response-grammar.ts::STAGE1_ENVELOPE_KEYS`. Deterministic seed rows (`synthetic:stage1-envelope#{direct,full}`) + Cerebras augmentation (`cerebras:stage1-envelope`). This is what makes `format_ok` measure a real target instead of 0%. (On-wire form is JSON, not "TOON" — it matches the runtime model call.) |
| `voice_emotion` | ~245 | Spoken replies carrying omnivoice-singing inline expressive tags in `replyText` — `[happy] [sad] [angry] [nervous] [calm] [excited] [whisper] [singing]` plus the preserved non-verbals `[laughter] [sigh]`, scoped until the next tag or end of phrase. Deterministic seed rows (`synthetic:voice-emotion-tags`) + Cerebras augmentation (`cerebras:voice-emotion-tags`). The parse/generate/interpret schema the TTS emotion controls consume. |

## Eval alignment

This dataset is shaped to move the **text** metrics of
`packages/training/scripts/eval/eliza1_eval_suite.py` and the structural
`format_ok` gate in `packages/training/benchmarks/eliza1_gates.yaml`:

- **`text_eval`** (held-out perplexity → 0..1; `0_6b` threshold 0.55): the
  `assistant` rows mirror the topic distribution of the suite's
  `DEFAULT_TEXT_EVAL_CORPUS` (capital cities, speculative decoding, on-device
  assistants, quantization, voice-activity detection).
- **`format_ok`** (parsable-output rate; floor 0.70): the `action_selection`
  and `tool_use` rows teach the `ACTION: NAME {json-params}` + short-reply
  structured surface; the `structured_decode` rows teach the W3 flat JSON
  response envelope `buildResponseGrammar` constrains (the Stage-1
  message-handler document) — without those rows the smoke task mix never
  emitted the envelope and `format_pct` measured 0%.
- **personality-bench**: the `personality` rows are PASS-graded exemplars of
  silence on demand, style stickiness, trait respect, escalation, and per-user
  vs global scope.

This is a focused, high-signal mix-in — it is **not** the full 67k-row
`data/final` corpus the larger eliza-1 tiers train on. For the 0.6b it can be
used standalone (whole train→quant→bench stack runs < 1 h on a 16 GB GPU) or
concatenated ahead of the broader corpus.

## Provenance & privacy

- Every row carries a `provenance` field. Benchmark-derived rows are
  `benchmark:<file>#<id>`; Cerebras-generated rows are `cerebras:<task>`.
- **No real user trajectory data is consumed** by the builder — the in-repo
  benchmark sources are synthetic test fixtures, and the build hosts carry no
  populated `trajectories` export. The final splits are nonetheless run
  through the canonical inline privacy filter
  (`packages/training/scripts/privacy_filter_trajectories.py::redact_value` —
  the same filter `format_for_training.format_record` applies) as
  defense-in-depth (API keys / bearer tokens / emails / phones / geo).

## Reproduce

```bash
cd packages/training
CEREBRAS_API_KEY=<key> uv run python scripts/build_eliza1_sft_0_6b.py
# converted-only (no API key):
uv run python scripts/build_eliza1_sft_0_6b.py --no-augment
```

Counts, per-task breakdown, token histogram, and the privacy-filter pass are
recorded in `manifest.json` alongside the splits.
