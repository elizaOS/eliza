# @elizaos/plugin-promptopt roadmap

**Why this file at package root:** npm and GitHub show the package README first; a short roadmap here scopes **shipping and integration** work without duplicating the full optimizer phase list.

## Authoritative deep dive

Pipeline phases, GEPA/ACE follow-ups, signals, and retention live in **[`src/optimization/ROADMAP.md`](src/optimization/ROADMAP.md)** — that file is the source of truth for *what the optimizer does next*.

Cross-cutting behavior (core DPE, hooks contract, trajectory union types) is tracked in **`@elizaos/core`**: [`../typescript/ROADMAP.md`](../typescript/ROADMAP.md) and [`../typescript/docs/PROMPT_OPTIMIZATION.md`](../typescript/docs/PROMPT_OPTIMIZATION.md).

## Near term — package ergonomics

- **Publish metadata:** Ensure `README.md` / `ROADMAP.md` ship in npm `files` so registry pages stay useful.
- **Optional split of “neuro-only” vs “full disk opt”** if demand appears for quality signals without `OPTIMIZATION_DIR` writes (would be a breaking or additive export, not silent).

## Medium term — operations

- **CLI or documented one-shot** `OptimizationRunner.run()` entry (also listed under core roadmap) so operators do not need N harness messages to reproduce a run.
- **Trace rotation / caps** for `history.jsonl` with explicit policy (size, age, or both).

## Longer term — product

- **DB-backed artifact index** with files as source of truth (see core roadmap “longer term”).
- **Richer training context** for Ax stages (today constrained partly by `templateHash` / context text choices).

## What we are not doing without demand

- Automatic multi-tenant isolation inside a single `OPTIMIZATION_DIR` (operators should use separate roots or external ACLs).
- Rewiring every finalizer path through hooks when only DPE ↔ core was the coupling point worth abstracting first.
