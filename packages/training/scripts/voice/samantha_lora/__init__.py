"""Samantha LoRA training pipeline.

End-to-end recipe for producing a Kokoro voice adapter trained on
operator-supplied Samantha audio. Entry points:

  - collect_audio.md  — audio collection guide.
  - prep_corpus.py    — resample + segment + phonemize + privacy filter.
  - train_lora.py     — LoRA training with APOLLO optimizer.
  - export_adapter.py — adapter merge / export.
  - eval_voice.py     — MOS proxy + speaker similarity + WER gates.
  - publish_samantha.sh — gated HF push.
  - RUNBOOK.md        — operator runbook.

This pipeline is the one allowed exception to the voice-frozen rule
(packages/training/AGENTS.md §4) per the operator's standing call.
"""
