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

# Eliza-1 0.6B SFT dataset

Historical supervised fine-tuning data for Qwen3-0.6B. This dataset card describes
these stored splits, not the current Eliza-1 model lineup.

`train.jsonl`, `val.jsonl`, and `test.jsonl` contain chat-message rows with task,
provenance, and tag metadata. See `manifest.json` for the recorded distribution.
Preserve complete messages and provenance when loading or converting rows.
There is no standalone build or test package; use the training package's
[setup and tests](../../README.md).
