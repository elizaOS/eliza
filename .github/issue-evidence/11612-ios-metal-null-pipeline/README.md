# Issue #11612 - iOS Metal Nil Pipeline Guard

Captured on 2026-07-02 from `/home/shaw/eliza-worktrees/11612-ios-metal-null-pipeline`
after branching from `origin/develop`.

## What changed

- Updated the `plugins/plugin-local-inference/native/llama.cpp` submodule from
  `2bdcef890ef7c153b9c021076814162ca2caa340` to
  `299d5b78bcf936f817872d78986b8b011ffaf215`.
- The submodule patch guards both known Metal compute-pipeline dereference
  points:
  - `ggml_metal_pipeline_max_theads_per_threadgroup`
  - `ggml_metal_encoder_set_pipeline`
- A nil Metal pipeline now emits an explicit `nil Metal compute pipeline`
  backend failure instead of dereferencing `pipeline.pipeline->obj`.

Submodule PR: https://github.com/elizaOS/llama.cpp/pull/39

## Validation run here

- PASS: `git diff --check` inside
  `plugins/plugin-local-inference/native/llama.cpp`
- PASS: parent pointer diff reviewed with
  `git diff --submodule=log -- plugins/plugin-local-inference/native/llama.cpp`

## Apple Metal regression proof (added from a macOS host)

`mac-metal-regression/` builds the guarded submodule commit `299d5b78b` with the
Apple Metal toolchain (macOS 26.2, M4 Max) and runs a real eliza-1 0.8B GGUF
fully offloaded to the Metal GPU (`layer N assigned to device MTL0`). Generation
completes correctly (`… is **Paris**.`) with no `nil Metal compute pipeline`
abort — proving the two new nil-checks are inert on the healthy Metal path and
only change behaviour when a pipeline is genuinely nil. See that directory's
`README.md`. This is the regression risk a submodule bump introduces, verified
on the one platform a Linux host could not.

## Hardware-gated evidence not captured here

- N/A here: iPhone 16 Pro Max / A18 Pro runtime verification. The original
  capture host is Linux and cannot build or run Apple Metal or reproduce the
  device-only `llama_decode` crash. (The desktop Apple Metal regression above
  narrows this to the A18-Pro-specific kernel-selection root cause.)
- Required before closing #11612: build the app with llama.cpp PR #39, run the
  same on-device local-generation path on the affected iPhone, and attach the
  crash-free run logs or the new explicit backend failure plus the device
  syslog/`.ips` evidence.

## Residual

This is the defensive stop-the-NULL-deref fix. The root cause for why the A18
Pro `mul_mat` pipeline is nil still needs real-device Metal diagnostics and a
kernel selection/compilation fix.
