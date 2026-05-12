# voice-bench — per-GPU configs

This directory mirrors `packages/inference/configs/gpu/` for the benchmark
harness. The four matrix entries in `matrix.json` map a `voice-bench`
invocation to a (GPU, bundle, ctx_size) triple.

The actual llama-server flag set comes from
`packages/inference/configs/gpu/<gpu>.json` via the `gpu-autotune.ts`
helper in `@elizaos/app-core`. We do not duplicate that data here — only
the bench-runner-specific knobs (turns, warmup, fixtures) live here.
