# voice-bench — per-GPU configs

This directory mirrors `plugins/plugin-local-inference/native/configs/gpu/` for the benchmark
harness. The four matrix entries in `matrix.json` map a `voice-bench`
invocation to a (GPU, bundle, ctx_size) triple.

The actual llama-server flag set comes from
`plugins/plugin-local-inference/native/configs/gpu/<gpu>.json` via the `gpu-autotune.ts`
helper in `@elizaos/plugin-local-inference`. We do not duplicate that data here — only
the bench-runner-specific knobs (turns, warmup, fixtures) live here.
