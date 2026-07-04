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
so adapter PRs must record the exact dataset revision and row count used.

| Subset | HF rows | GitHub sample count | Audio source | Task type | Evaluator family | elizaOS status | P0 action |
| --- | ---: | ---: | --- | --- | --- | --- | --- |
| `alpacaeval` | 199 | 199 | Google TTS | open-ended QA | `open` + judge model | Not integrated on `develop`; candidate for `voicebench_quality` parity smoke. | Add downloaded-eval adapter row with real STT/provider metadata. |
| `alpacaeval_full` | 636 | 636 | Google TTS | open-ended QA | `open` + judge model | Not integrated on `develop`; intended leaderboard subset per upstream README. | Prefer this over `alpacaeval` for publishable quality score. |
| `alpacaeval_speaker` | 7k | not listed | Human/crowd speaker variant per HF naming | open-ended QA / speaker robustness | likely `open` + judge model; verify upstream | Not integrated on `develop`; new since README table. | Document as skipped until subset schema and license details are rechecked. |
| `bbh` | 1k | 1,000 | Human | reasoning | `bbh` exact/structured | Not integrated on `develop`. | Add after exact-answer scorer is wired; no judge-only fallback. |
| `commoneval` | 200 | 200 | Human | open-ended QA | `open` + judge model | Not integrated on `develop`. | Good small real-human-audio smoke once STT path is staged. |
| `ifeval` | 345 | 345 | Google TTS | instruction following | `ifeval` | Not integrated on `develop`. | Add deterministic instruction-following scorer before publishable run. |
| `mmsu` | 3.07k | 3,074 | Google TTS | multiple-choice QA | `mcq` | Not integrated on `develop`. | Add MCQ scorer row with answer normalization. |
| `mtbench` | 46 | 46 | Google TTS | multi-turn QA | upstream evaluator not listed in README final-results bullets | Not integrated on `develop`. | Skip for P0 unless multi-turn output schema is confirmed. |
| `openbookqa` | 455 | 455 | Google TTS | multiple-choice QA | `mcq` | Not integrated on `develop`. | Add MCQ smoke after `mmsu` scorer path exists. |
| `sd-qa` | 6.08k | 553 | Human | reference-based QA | `qa` + judge model | Not integrated on `develop`; row-count mismatch requires revision pin. | Skip publishable support until region splits and row counts are pinned. |
| `wildvoice` | 1k | 1,000 | Human crowd-sourced diverse accents | open-ended QA | `open` + judge model | Not integrated on `develop`. | P0 human-audio coverage after STT and manual review artifacts are available. |
| `advbench` | 520 | 520 | Google TTS | safety | `harm` | Not integrated on `develop`. | Keep skipped by default unless safety review approves evaluator prompts and storage. |

## Support Status

Current `develop` repo inspection for this PR did not find a checked-in
VoiceBench adapter or registry entry by name:

```bash
rg -n "voicebench|voicebench_quality|VoiceBench" packages/benchmarks packages/training packages/scenario-runner -g '!node_modules' -g '!dist'
```

The issue text and #13352 matrix work refer to existing `voicebench` /
`voicebench_quality` registry entries. If those land separately, this table
should be updated by the adapter PR to point at the exact registry IDs,
commands, and score parser.

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

1. Add registry metadata for `alpacaeval_full`, `commoneval`, `wildvoice`,
   `ifeval`, `mmsu`, `openbookqa`, and `bbh` with runtime download only.
2. Add `sd-qa` only after the dataset revision and region split row counts are
   pinned.
3. Keep `advbench` opt-in until safety review approves the evaluator and
   artifact-retention policy.
4. Keep `alpacaeval_speaker` skipped until its schema and evaluator mapping are
   verified against the Hugging Face revision used by the runner.
5. Attach a real non-mock run report before claiming #13360 complete.

## Evidence Still Required

This coverage table closes the inventory/documentation gap only. The issue's
publishable run evidence still needs a real VoiceBench adapter/run that records
audio/STT provider, assistant model, judge model where applicable, score JSON,
and manually reviewed outputs.
