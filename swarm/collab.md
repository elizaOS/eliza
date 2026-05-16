2026-05-16 HF consolidation note:
- Authenticated HF review with org access shows the live public canonical repos are `elizaos/eliza-1` and `elizaos/eliza-1-training`.
- Direct authenticated probes for split repos such as `elizaos/eliza-1-2b`, `elizaos/eliza-1-27b-fp8`, `elizaos/eliza-1-pipeline`, and `elizaos/eliza-1-evals` return 404, so there was nothing to delete there.
- Published the training pipeline into `elizaos/eliza-1-training` under `pipeline/`; remote dataset now has `pipeline/`, `evals/`, `sft/`, and `synthesized/`.
- Local worktree currently has unrelated conflict markers in cloud frontend/UI stories files. I did not resolve or revert those as part of the HF consolidation pass.
