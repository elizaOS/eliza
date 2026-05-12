# omnivoice → llama.cpp merge plan

**Status:** PLAN ONLY. This directory documents the merge approach.
No changes to the `packages/inference/llama.cpp` submodule have been
made — those will happen on a feature branch of the elizaOS/llama.cpp
fork once this plan is reviewed.

**Owner of follow-up:** Phase E follow-up task (see RESEARCH.md
"Open follow-ups" #4 in `plugins/plugin-omnivoice/`).

## Why merge

`omnivoice.cpp` and `llama.cpp` both consume GGML. Today our shippable
inference fork (`packages/inference/llama.cpp`, branch `eliza/main`)
contains the elizaOS kernels + DFlash drafter; `omnivoice.cpp` lives
as a parallel CMake project under `packages/inference/omnivoice.cpp`
with its own GGML submodule. Two consequences:

1. The user must build two GGML copies — twice the compile time,
   twice the cached-shader cost, double the GPU memory footprint
   when both libs are loaded into one Bun process.
2. New GGML kernels we land in our fork (TBQ, PolarQuant) are
   invisible to omnivoice. Singing-quality wins from PolarQuant on
   the Qwen3 backbone are silently lost.

Merging puts omnivoice's pipeline files (`pipeline-tts`,
`pipeline-codec`, `voice-design`, `prompt-tts`, `text-chunker`, the
RVQ/DAC/HuBERT modules) **inside** the unified llama.cpp tree, sharing
its GGML, its backend selection, and its build matrix.

## Audit of omnivoice src/

GGML-independent files (port wholesale, just relocate):

- `audio-io.h`, `audio-resample.h`, `audio-postproc.h`,
  `audio-postproc-stream.h` — WAV I/O + DSP. Pure C++, no GGML.
- `bpe.h`, `lang-map.h` — tokenizer / language ID lookups.
- `philox.h` — seedable PRNG.
- `text-chunker.h`, `text-chunker-stream.h` — punctuation-aware
  splitter. No GGML.
- `voice-design.h`, `prompt-tts.h` — instruct grammar.
- `ov-error.h`, `debug.h` — diagnostics.

Files that need the GGML wedge (depend on backend.h + ggml types):

- `backend.h` — currently picks the GGML backend (CPU/Metal/CUDA/
  Vulkan) for omnivoice. **Drop entirely** in the merged tree;
  callers reuse `llama_backend_init` and the unified backend pair.
- `gguf-weights.h` — GGUF tensor loader. Replace with llama.cpp's
  `gguf.cpp` helpers (same surface).
- `omnivoice-llm.h`, `qwen3-enc.h`, `semantic-enc.h`, `hubert-enc.h`,
  `dac-decoder.h`, `dac-encoder.h`, `rvq-codec.h`, `maskgit-tts.h`,
  `duration-estimator.h` — model graphs. Each builds a
  `ggml_cgraph` and runs `ggml_backend_graph_compute`. **These
  need the wedge** — same GGML APIs, but loaded against the shared
  backend pair owned by llama.cpp's `llama_context`.

Tools to merge: `tools/omnivoice-tts.cpp`, `tools/omnivoice-codec.cpp`,
`tools/quantize.cpp`. The `quantize.cpp` policy already matches
acestep — it can collapse into llama.cpp's `tools/quantize/`.

## Namespacing

Every public symbol omnivoice exports starts with `ov_` (the public
ABI) or `pipeline_` / `backend_` (internal). All three are unique
versus llama.cpp's `llama_` / `ggml_` / `common_` namespaces — no
collisions, no renames required.

Header include paths shift from `omnivoice/...` to
`omnivoice/...` under llama.cpp's `tools/omnivoice/` and
`include/omnivoice.h`.

## Proposed CMake target structure

Add a new opt-in subtree under llama.cpp:

```
llama.cpp/
  tools/
    omnivoice/
      CMakeLists.txt        # NEW
      src/
        omnivoice.cpp
        pipeline-codec.cpp
        pipeline-tts.cpp
        ...                 # everything from omnivoice.cpp/src/*
      tools/
        omnivoice-tts.cpp
        omnivoice-codec.cpp
      include/
        omnivoice.h         # public ABI, copied verbatim
```

Top-level `CMakeLists.txt` gains:

```cmake
option(LLAMA_BUILD_OMNIVOICE "Build the omnivoice TTS lib + tools" OFF)
if (LLAMA_BUILD_OMNIVOICE)
    add_subdirectory(tools/omnivoice)
endif()
```

`tools/omnivoice/CMakeLists.txt` defines:

- `omnivoice_lib` (STATIC) — every `src/*.cpp`. Links against
  `llama` (transitively gets GGML + backends).
- `omnivoice` (SHARED, opt-in via `-DOMNIVOICE_SHARED=ON`) — same
  source set, hidden visibility, exports only `ov_*` symbols.
- `omnivoice-tts` (executable) — links `omnivoice_lib + llama`.
- `omnivoice-codec` (executable) — same.

This collapses the two GGML compiles into one. Backend flags
(`GGML_METAL`, `GGML_CUDA`, …) are set once at the llama.cpp level
and inherited.

## Patch series

Three example wedge patches showing the shape (NOT yet applied):

- `0001-add-omnivoice-build-option.patch` — adds the
  `LLAMA_BUILD_OMNIVOICE` option + add_subdirectory hook to the
  llama.cpp root CMakeLists.txt.
- `0002-vendor-omnivoice-tree.patch` — vendors `omnivoice.cpp/src/*`,
  `omnivoice.cpp/tools/*`, and the public header into
  `llama.cpp/tools/omnivoice/`.
- `0003-replace-backend-wedge.patch` — rewrites
  `tools/omnivoice/src/backend.h` to consume the llama.cpp backend
  pair from a `llama_context` instead of allocating its own. This
  is the only invasive change — the rest is mechanical.

Each patch will be created as a real `git format-patch` output once
this plan is approved and the feature branch on the fork exists. The
goal is a series small enough to rebase against `eliza/main` weekly
without conflict noise.

## Test strategy

The merged tree must keep both test surfaces green:

1. **llama.cpp regression** — every existing `test-*` target plus our
   `packages/inference/verify/` matrix (`metal_verify`, `vulkan_verify`,
   kernel-contract). No drift in numerical kernels.
2. **omnivoice ABI** — the bundled `tests/abi-c.c` smoke (already in
   omnivoice.cpp) runs as-is, just from the merged path.
3. **End-to-end** — a new CI job builds with
   `-DLLAMA_BUILD_OMNIVOICE=ON` and runs `omnivoice-tts` against the
   Q8_0 GGUFs in CI cache, compares against a checked-in WAV hash.
4. **Plugin smoke** — `plugins/plugin-omnivoice` runs its FFI shape
   tests against the merged `libomnivoice.so`. The shared library
   exports the same `ov_*` symbols (proven by the abi-c test).

## Out-of-scope for this phase

- The actual `git mv` / patch generation — happens on the fork.
- Sub-target naming for the singing model (it's a model swap, not a
  build-system change).
- Wedging omnivoice into the `eliza/main` runtime drafter pipeline
  (`dflash`) — that's a separate optimization track.
