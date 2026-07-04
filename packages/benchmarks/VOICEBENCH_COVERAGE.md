# VoiceBench Coverage Closeout

Issue: #13360

This document maps the current public VoiceBench subsets to elizaOS support
status and evidence requirements. It is a coverage contract, not a score report:
no raw VoiceBench rows, audio, generated outputs, or mock scores are committed
here.

Source review date: 2026-07-04.

Primary sources:

- VoiceBench GitHub: https://github.com/matthewcym/voicebench
- VoiceBench dataset: https://huggingface.co/datasets/hlt-lab/voicebench

## Public Subsets

The Hugging Face dataset page currently lists 12 subsets and 20,554 total rows
under Apache-2.0. The GitHub README documents the benchmark command shape,
subset table, and evaluator families. Public metadata differs for `sd-qa`: the
GitHub README lists 553 samples while Hugging Face currently lists 6.08k rows,
so publishable runs must record the exact dataset revision and row count used.

Current `develop` already has two related benchmark entries:

- `voicebench`: a TypeScript end-to-end voice latency benchmark over local
  manifests/audio fixtures.
- `voicebench_quality`: a Python VoiceBench-quality harness registered for
  eight upstream suite IDs (`alpacaeval`, `commoneval`, `sd-qa`, `ifeval`,
  `advbench`, `openbookqa`, `mmsu`, `bbh`). It can use bundled JSONL fixtures,
  local synthesized audio, or Hugging Face rows. Mock/fixture results are
  rejected by the scorer.

| Subset | HF rows | GitHub sample count | Audio source | Task type | Evaluator family | elizaOS status | P0 action |
| --- | ---: | ---: | --- | --- | --- | --- | --- |
| `alpacaeval` | 199 | 199 | Google TTS | open-ended QA | `open` + judge model | Registered in `voicebench_quality`; publishable HF run evidence not checked in. | Run non-mock HF row with real STT/provider, assistant, judge model, and reviewed outputs. |
| `alpacaeval_full` | 636 | 636 | Google TTS | open-ended QA | `open` + judge model | Not registered in current `voicebench_quality` suite list; intended leaderboard subset per upstream README. | Add suite support or document why `alpacaeval` remains the supported small subset. |
| `alpacaeval_speaker` | 7k | not listed | Human/crowd speaker variant per HF naming | open-ended QA / speaker robustness | likely `open` + judge model; verify upstream | Not integrated on `develop`; new since README table. | Document as skipped until subset schema and license details are rechecked. |
| `bbh` | 1k | 1,000 | Human | reasoning | `bbh` exact/structured | Registered in `voicebench_quality` as judge-scored reasoning; publishable HF run evidence not checked in. | Run non-mock HF row and confirm judge rubric/score JSON against upstream. |
| `commoneval` | 200 | 200 | Human | open-ended QA | `open` + judge model | Registered in `voicebench_quality`; publishable HF run evidence not checked in. | Good small real-human-audio smoke once STT/provider credentials are available. |
| `ifeval` | 345 | 345 | Google TTS | instruction following | `ifeval` | Registered in `voicebench_quality` with deterministic scoring; publishable HF run evidence not checked in. | Run non-mock HF row and record instruction-checker output. |
| `mmsu` | 3.07k | 3,074 | Google TTS | multiple-choice QA | `mcq` | Registered in `voicebench_quality` with MCQ scoring; publishable HF run evidence not checked in. | Run non-mock HF row with answer-normalization evidence. |
| `mtbench` | 46 | 46 | Google TTS | multi-turn QA | upstream evaluator not listed in README final-results bullets | Not integrated on `develop`. | Skip for P0 unless multi-turn output schema is confirmed. |
| `openbookqa` | 455 | 455 | Google TTS | multiple-choice QA | `mcq` | Registered in `voicebench_quality` with MCQ scoring; publishable HF run evidence not checked in. | Run non-mock HF row after `mmsu` scoring evidence is captured. |
| `sd-qa` | 6.08k | 553 | Human | reference-based QA | `qa` + judge model | Registered in `voicebench_quality`; row-count mismatch requires revision pin before publishable claim. | Skip publishable support until region splits and row counts are pinned. |
| `wildvoice` | 1k | 1,000 | Human crowd-sourced diverse accents | open-ended QA | `open` + judge model | Not integrated on `develop`. | P0 human-audio coverage after STT and manual review artifacts are available. |
| `advbench` | 520 | 520 | Google TTS | safety | `harm` | Registered in `voicebench_quality` with refusal scoring; publishable safety run still needs review. | Keep skipped by default unless safety review approves evaluator prompts and storage. |

## Support Status

Current `develop` repo inspection for this PR found checked-in VoiceBench
packages and registry entries:

```bash
rg -n "voicebench|voicebench_quality|VoiceBench" packages/benchmarks packages/training packages/scenario-runner -g '!node_modules' -g '!dist'
```

Key local anchors:

- `packages/benchmarks/registry/commands.py` registers `voicebench` and
  `voicebench_quality`.
- `packages/benchmarks/voicebench/` is the TypeScript latency benchmark.
- `packages/benchmarks/voicebench-quality/` is the Python quality benchmark.
- `packages/benchmarks/registry/scores.py` rejects mock/fixture results for
  both scorers.

This table should be updated by any future adapter PR that adds the four
currently unsupported public subsets (`alpacaeval_full`, `alpacaeval_speaker`,
`mtbench`, `wildvoice`) or changes the supported suite IDs.

## Mock-Result Rejection

No VoiceBench result is publishable unless the run report records:

- dataset source URL and immutable revision/hash,
- subset name and row count,
- audio/STT provider and model,
- assistant provider/model,
- judge model for `open` / `qa` families,
- score JSON path,
- manually reviewed sample outputs,
- a flag showing the run was non-mock and non-fixture.

Any smoke runner may use a tiny fixture to test plumbing, but the report must be
marked `publishable: false` unless it includes the real provider/model metadata
above. A mock STT, mock assistant, fixture-only rows, or missing judge metadata
must fail the publishable gate.

## P0 Implementation Order

1. Capture a small non-mock `voicebench_quality` HF run for already registered
   suites (`commoneval`, `ifeval`, `mmsu`, `openbookqa`, `bbh`, and one judged
   open-ended suite), with real STT/provider metadata and manually reviewed
   outputs.
2. Add `alpacaeval_full`, `wildvoice`, and `mtbench` only after suite schema,
   evaluator mapping, and runner support are confirmed.
3. Treat `sd-qa` as registered but not publishable until the dataset revision
   and region split row counts are pinned.
4. Keep `advbench` opt-in until safety review approves the evaluator and
   artifact-retention policy.
5. Keep `alpacaeval_speaker` skipped until its schema and evaluator mapping are
   verified against the Hugging Face revision used by the runner.
6. Attach a real non-mock run report before claiming #13360 complete.

## Evidence Still Required

This coverage table closes the inventory/documentation gap only. The issue's
publishable run evidence still needs a real VoiceBench adapter/run that records
audio/STT provider, assistant model, judge model where applicable, score JSON,
and manually reviewed outputs.
