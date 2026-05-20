# E1 RTL Model Evaluation Plan

This plan defines a blocked, dry-run-first path for evaluating RTL generation
models against small E1-style tasks. Generated RTL is an artifact only: it is
not committed, it does not enter source automatically, and it is not release
evidence.

## Scope

Candidate sources are tracked in
`research/alpha_chip_macro_placement/01_sources/ai_eda_source_inventory.yaml`.
Initial model and benchmark references are RTL-Coder, OpenLLM-RTL,
ChipCraftX RTLGen 7B, CircuitMind/TC-Bench, QiMeng-CodeV-R1, QiMeng-CRUX,
QiMeng-SALV, and related RTL-LLM assets after license review.

The first task set is intentionally small:

- AXI-Lite read-only register block.
- Descriptor FIFO status counter.
- NPU saturating arithmetic helper.

## Required Evaluation Record

Each executed evaluation must archive:

- Exact model ID, model revision, license status, and invocation backend.
- Model-card, base-model, reward-definition, and checkpoint disposition where
  applicable.
- Prompt text hash and prompt template revision.
- Retrieval/RAG trace hash and benchmark-overlap disposition where the source
  uses external examples or benchmark-derived tasks.
- Generated artifact hash and output path under `build/ai_eda/`.
- Lint, simulation, and synthesis commands and logs.
- Human review status and reviewer notes.

## Evidence Gates

Release use is blocked until all of the following are true:

- Per-model and per-dataset license review is recorded.
- Generated RTL passes the relevant `make rtl-check`, simulation, and
  `make synth` gates.
- A human reviewer accepts the generated artifact for a named source change.
- The accepted source change is committed separately from generated artifacts.

The dry-run command is:

```sh
python3 scripts/ai_eda/evaluate_rtl_model.py --dry-run --run-id validation
```
