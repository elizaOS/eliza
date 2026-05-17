"""End-of-turn (EOT) LoRA training pipeline for eliza-1 chat models.

End-to-end recipe for producing a tiny LoRA adapter that hot-swaps onto
the already-loaded eliza-1 chat model at runtime. Reads the next-token
distribution after the partial user transcript and uses
P(`<|im_end|>`) as the turn-completion probability — same signal the
LiveKit ONNX turn-detector provides, but at zero extra RAM and zero
extra download (the chat model is loaded anyway for conversation).

Entry points:

  - DATASETS.md       — dataset audit (local repo + public corpora + HF).
  - prep_eot_corpus.py — read conversations, emit (transcript, eot) pairs.
  - train_eot_lora.py  — LoRA training (rank 8, alpha 16) on eliza-1.
  - eval_eot_lora.py   — vs LiveKit GGUF baseline + Heuristic baseline.
  - RUNBOOK.md         — operator runbook.

Gates: `packages/training/benchmarks/eot_gates.md` (AUROC, ECE, latency).

Architecture: this pipeline produces a runtime-hot-swappable adapter.
The runtime path lives in
`plugins/plugin-local-inference/src/services/voice/eot-classifier-ggml.ts`
and is documented in that file's "Future: LoRA hot-swap path" section.

This pipeline is the canonical replacement for the
@huggingface/transformers ONNX turn-detector path that was removed
during the transformers.js yank. The LiveKit GGUF binding (J1.d) is
the baseline this LoRA must match or beat per the publish gates.
"""
