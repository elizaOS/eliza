# CLAUDE.md — packages/training

Read [`AGENTS.md`](AGENTS.md) first. It is the canonical contract for
this directory and binds every agent (Claude or otherwise) working on
the Eliza-1 training, quantization, eval, and HF-publishing pipeline.

Claude-specific notes:

- The repo-wide `CLAUDE.md` at the workspace root applies on top of
  this file. Read both. The "review-first file writes" and "scope
  discipline" rules there apply to scripts under this directory too.
- When in doubt about runtime mandates (mandatory optimizations,
  bundle layout, manifest schema, three-mode product shape), consult
  [`packages/inference/AGENTS.md`](../inference/AGENTS.md). Do not
  duplicate or paraphrase those rules into training scripts — read
  them, apply them.
- When asked to "skip the eval gate" or "publish anyway", push back.
  AGENTS.md §6 is explicit: green eval, green kernels, then publish.
- The privacy filter is mandatory on every trajectory write path. The
  repo-wide CLAUDE.md says so; this file confirms it.
- New transform scripts (`transform_*.py`, `synthesize_*.py`) MUST run
  through `validate_corpus.py` before being included in a training
  run. No raw output → fine-tune in one step.
