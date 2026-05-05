# Training — Agent Routing

Short routing doc for common training-side tasks. For background, layout,
sidecar formats, and the full DO-NOT list, read `training/CLAUDE.md` first.

The runtime resolver `eliza/packages/app-core/src/runtime/local-model-resolver.ts`
must stay in lockstep with `scripts/training/model_registry.py` — every
registry change is a two-file commit.

## "I want to train a new size"

Add the registry entry first. Open `scripts/training/model_registry.py` and
add a new key (e.g. `qwen3.6-14b`) with base model id, micro-batch,
grad-accum, sequence length, and the cloud profile (which Vast preset to
target). Pick the existing size whose hyperparameters are closest and copy
forward; do not invent new schedules. Then update
`eliza/packages/app-core/src/runtime/local-model-resolver.ts` so the runtime
can resolve the new eliza-1 name. Smoke-train locally if it fits, otherwise
launch with `bash scripts/train_vast.sh --registry-key <new-key>`. Vast.ai
is the only canonical cloud — do not add Nebius, RunPod, or Lambda variants.
File: `scripts/training/model_registry.py`.

## "I want to add a new quant scheme"

Quant lives entirely under `scripts/quantization/`. Each scheme owns a
driver script that loads the bf16 checkpoint, applies the transform, writes
quantized tensors next to the checkpoint, and emits a sidecar JSON (see
sidecar formats in `training/CLAUDE.md`). The sidecar is the contract with
inference: `serve_vllm.py` reads the sidecar to decide which kernel path to
load, so add the reader at the same time as the writer. Every new scheme
needs a smoke benchmark dir under `benchmarks/` proving load + generate +
perplexity sanity. No smoke test, no merge. If the new scheme is copyleft
(like Heretic / AGPL), do not wire it into `serve_vllm.py` defaults until
licensing posture is decided. Files: `scripts/quantization/`,
`scripts/inference/serve_vllm.py`.

## "I want to add a new benchmark"

Benchmarks live under `scripts/benchmark/` and consume a running
`serve_vllm.py` endpoint over HTTP. Add the new bench as a module that
takes a base URL and an output directory; do not hardcode ports or
checkpoint paths. Register it in the orchestrator's suite map so
`run_pipeline.py` picks it up. Output goes under
`benchmarks/<run-id>-<profile>/<bench-name>/` and feeds the SQLite results
DB consumed by the viewer at `eliza/packages/benchmarks/`. If the bench
needs a new endpoint shape from vLLM (logprobs, structured output, etc.),
add the request to the bench, not to `serve_vllm.py`. Files:
`scripts/benchmark/`, `eliza/packages/benchmarks/`.

## "vLLM serve isn't returning structured output"

Structured output comes from vLLM's guided decoding path. First check the
launch profile in `scripts/inference/serve_vllm.py` — DFlash and EAGLE-3
are mutually exclusive, and one of them being on can suppress guided
decoding. If `MILADY_VLLM_DFLASH=1` is set, drop it for the test. Second,
confirm APC is not silently on without the safety gate: APC requires
`MILADY_APC_DRAFTER_VERIFIED=1` because of upstream omlx#825, and an
unverified APC path can drop tool-call tokens. Third, check the request:
guided JSON / regex / grammar must be passed in the request body, not
inferred. The Entropix logits processor does not block guided decoding,
but if temperatures look wrong, disable Entropix and re-test. File:
`scripts/inference/serve_vllm.py`.

## "A run failed and I need to clean up"

Do not delete the checkpoint directory. Add a `STATUS.md` at the
checkpoint root saying "FAILED RUN — no usable weights. Do not consume.
Kept for forensic reference." with the date, then move on. Downstream
tooling skips any directory with a FAILED `STATUS.md`. Currently flagged:
`checkpoints/qwen35-08b-smoke/`, `checkpoints/qwen3-06b-eliza-toon-v2/`,
`checkpoints/qwen35-eliza-toon-v3/`.

## "I need to do RL"

RL is designed in `training/RL_STRATEGY.md`: DPO stage 1 via TRL, then
GRPO stage 2 via verl. It is **not yet implemented**. A parallel agent owns
implementation; do not start a competing implementation. Do not promote
`training-babylon/` as the canonical path — it is a research scaffold
using mock trajectories. File: `training/RL_STRATEGY.md`.

## Canonical entrypoints (cheat sheet)

- Local pipeline: `uv run python scripts/run_pipeline.py --registry-key qwen3.5-2b`
- Cloud SFT: `bash scripts/train_vast.sh --registry-key qwen3.5-9b`
- Serve: `python scripts/inference/serve_vllm.py --checkpoint <dir> --profile h200`
- Bench: `python scripts/benchmark/run.py --base-url <url> --suite full --out benchmarks/<id>/`
