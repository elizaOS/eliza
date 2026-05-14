# Lunar Lake Vulkan dispatch capture

Issue: elizaOS/eliza#7638.

This note is for hardware owners with Intel Arc 140V / Lunar Lake iGPU
access. Do not turn it into a catalog or recommender gate until there is
hardware evidence from at least Qwen2.5-14B Q4_K_M and one second 12B-14B
Q4_K_M model.

## What needs proving

The open hypothesis is that Qwen2.5-14B's attention / GQA shape routes
some hot Q4_K_M matmuls through generic ggml-vulkan pipelines instead of
the subgroup / Q8_1 path that smaller models hit on the same Arc 140V
driver stack.

The useful evidence is a side-by-side dispatch log:

- baseline: Llama-3.1-8B Q4_K_M, same prompt and decode settings.
- candidate: Qwen2.5-14B Q4_K_M.
- optional missing-n: Phi-4-14B or Mistral-Nemo-12B Q4_K_M.

If the second 14B-class model also falls off the subgroup path, this is
probably a 14B shape class problem. If only Qwen2.5-14B falls off, keep
the fix scoped to the exact shape / kernel-selection heuristic.

## Build and capture

The fork's Vulkan dispatch logging is compile-time gated. Build a Vulkan
binary with:

```sh
ELIZA_DFLASH_CMAKE_FLAGS="-DGGML_VULKAN_DEBUG=ON" \
  bun packages/app-core/scripts/build-llama-cpp-dflash.mjs \
  --target linux-x64-vulkan
```

Then run the same llama.cpp command for each model, redirecting stderr:

```sh
GGML_VK_DEBUG_MARKERS=1 \
  ./path/to/llama-cli \
  -m /models/Llama-3.1-8B-Q4_K_M.gguf \
  -p "Write one paragraph about local inference." \
  -n 128 -ngl 999 \
  2> /tmp/llama31-8b-vulkan.log

GGML_VK_DEBUG_MARKERS=1 \
  ./path/to/llama-cli \
  -m /models/Qwen2.5-14B-Q4_K_M.gguf \
  -p "Write one paragraph about local inference." \
  -n 128 -ngl 999 \
  2> /tmp/qwen25-14b-vulkan.log
```

Capture `vulkaninfo --summary`, Mesa / ANV version, kernel version, RAM
speed if known, llama.cpp fork commit, and the exact model filenames.
Run `intel_gpu_top` or VTune during the candidate run if available.

## Offline log diff

Use the analyzer added for #7638:

```sh
node packages/app-core/scripts/kernel-patches/vulkan-dispatch-log.mjs \
  /tmp/llama31-8b-vulkan.log \
  /tmp/qwen25-14b-vulkan.log
```

The key counters are:

- `dispatches.matmul.subgroup`: should stay high for the fast path.
- `dispatches.matmul.q8_1`: confirms the quantized RHS path is selected.
- `dispatches.matmul.generic`: rising here is the suspected cliff.
- `top_pipelines`: pipeline names to paste into the issue.

Post the analyzer output plus the raw logs or compressed artifacts. Do
not claim an eliza-side recommender fix from a single Qwen2.5-14B run:
the current Eliza-1 catalog has no 14B default tier, and the likely fix
space is ggml-vulkan kernel selection unless cross-model data proves a
broader platform class problem.
