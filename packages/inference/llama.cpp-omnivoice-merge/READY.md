# omnivoice merge — cross-reference one-pager

The merge of `omnivoice.cpp` into `packages/inference/llama.cpp` is the
load-bearing native work for `@elizaos/plugin-omnivoice`. Three patches,
two workflows, one plugin, one conversion script, three docs pages. This
file links them all so a new contributor can see the full surface at a
glance.

Pair this with [`PLAN.md`](PLAN.md) (the why + the audit), [`STATUS.md`](STATUS.md)
(which patch landed where), and
[`docs/inference/omnivoice-readiness.md`](../../../docs/inference/omnivoice-readiness.md)
(the operator checklist for getting to a speaking agent).

---

## Patches (in this directory)

| File                                                                                       | What it does                                                                                                                                                  | Current state                                                                                                                                            |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`0001-add-omnivoice-build-option.example.patch`](0001-add-omnivoice-build-option.example.patch) | Adds `option(LLAMA_BUILD_OMNIVOICE …)` + `option(OMNIVOICE_SHARED …)` to `llama.cpp/CMakeLists.txt`; guarded `add_subdirectory(tools/omnivoice)` block.       | Applied locally as submodule commit `fc722d397` on branch `eliza/omnivoice-build-flag`. NOT pushed to fork yet. Configure ON fails-loud; OFF is a no-op. |
| [`0002-vendor-omnivoice-tree.example.patch`](0002-vendor-omnivoice-tree.example.patch)     | Vendors `omnivoice.cpp/src/*` into `llama.cpp/tools/omnivoice/`; adds `tools/omnivoice/CMakeLists.txt` defining `omnivoice_lib`, `omnivoice`, `omnivoice-tts`, `omnivoice-codec`. | Example only. G1 retry agent in flight at branch time.                                                                                                  |
| [`0003-replace-backend-wedge.example.patch`](0003-replace-backend-wedge.example.patch)     | Rewrites `tools/omnivoice/src/backend.h` to consume the `llama_context` backend pair instead of allocating its own. The one invasive change in the merge.    | Example only. Blocked on 0002.                                                                                                                          |

## Plan + status (this directory)

| File                       | What it does                                                            | Current state                                                                |
| -------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`PLAN.md`](PLAN.md)       | Merge rationale, full audit of `omnivoice.cpp/src/` files, patch order. | Accurate as of branch HEAD. Re-read before authoring patch 0002 / 0003.       |
| [`STATUS.md`](STATUS.md)   | Live log of which patches have landed and where.                        | Reflects 0001-applied-locally / 0002-not-started / 0003-not-started.          |
| [`READY.md`](READY.md)     | This cross-reference page.                                              | DONE (you are here).                                                          |

## Build tooling

| File                                                                                                  | What it does                                                                                                                                                                          | Current state                                                                              |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [`.github/workflows/build-omnivoice.yml`](../../../.github/workflows/build-omnivoice.yml)             | Matrix-builds `libomnivoice.{dylib,so}` for `darwin-arm64-metal`, `linux-x64-cpu`, and (opt-in) `linux-x64-cuda` on tag pushes / `workflow_dispatch`. Uploads artifacts.               | DONE in commit `0a5d4271`. First green run blocked on 0002 + 0003 landing in the submodule. |
| [`.github/workflows/convert-omnivoice-singing.yml`](../../../.github/workflows/convert-omnivoice-singing.yml) | Manual-dispatch workflow that pulls `ModelsLab/omnivoice-singing` from HF, runs the conversion + quantization, optionally uploads to a HF mirror.                                     | DONE in commit `b2f1010a`. Needs `HUGGINGFACE_HUB_TOKEN` secret to run.                    |

## Plugin (elizaOS side)

| File / dir                                                                                              | What it does                                                                                                                                                  | Current state                                                                                            |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [`plugins/plugin-omnivoice/`](../../../plugins/plugin-omnivoice)                                        | The `@elizaos/plugin-omnivoice` package: `bun:ffi` binding, voice design, singing pipeline, shutdown hooks, browser stub.                                     | DONE (scaffold in `9b1fecfc`, hardened across `1c4e2962` / `8014997e` / `87dd5278` / `f9b266f5`).        |
| [`plugins/plugin-omnivoice/src/ffi.ts`](../../../plugins/plugin-omnivoice/src/ffi.ts)                   | ABI mirror of `omnivoice.h`, `dlopen` wrap, `OmnivoiceContext` class with streaming JSCallback.                                                                | DONE; `OV_ABI_VERSION` must stay in lock-step with the C header.                                         |
| [`plugins/plugin-omnivoice/src/discover.ts`](../../../plugins/plugin-omnivoice/src/discover.ts)         | Filesystem auto-detect of `speech/` + `singing/` GGUF pairs under the per-user state dir.                                                                     | DONE in `f9b266f5`.                                                                                       |
| [`plugins/plugin-omnivoice/src/shutdown.ts`](../../../plugins/plugin-omnivoice/src/shutdown.ts)         | Process-lifecycle teardown for cached speech + singing contexts; idempotent.                                                                                  | DONE in `8014997e`.                                                                                       |
| [`plugins/plugin-omnivoice/src/synth.ts`](../../../plugins/plugin-omnivoice/src/synth.ts)               | Speech synthesis path; PCM → WAV serialization; real streaming via `bun:ffi` JSCallback.                                                                       | DONE in `87dd5278`.                                                                                       |
| [`plugins/plugin-omnivoice/src/singing.ts`](../../../plugins/plugin-omnivoice/src/singing.ts)           | Separate singing-model context + synthesis entry.                                                                                                              | DONE.                                                                                                     |
| [`plugins/plugin-omnivoice/RESEARCH.md`](../../../plugins/plugin-omnivoice/RESEARCH.md)                 | Internal research notes for follow-up Phase E agents.                                                                                                          | DONE.                                                                                                     |

## Models + conversion

| File                                                                                                | What it does                                                                                                                                                | Current state                                                              |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [`scripts/inference/convert-omnivoice-singing.mjs`](../../../scripts/inference/convert-omnivoice-singing.mjs) | Probes Python deps + `huggingface-cli`, downloads `ModelsLab/omnivoice-singing`, runs `omnivoice.cpp/convert.py`, optionally quantizes, emits sha256 manifest. | DONE in `739fca4b`. `--dry-run` plans without touching disk.               |
| [`scripts/inference/omnivoice-fetch.mjs`](../../../scripts/inference/omnivoice-fetch.mjs)            | User-facing wrapper CLI for staging GGUFs into `<state-dir>/models/omnivoice/{speech,singing}/`.                                                            | DONE in `f9b266f5`.                                                        |
| [`scripts/inference/omnivoice-smoke.mjs`](../../../scripts/inference/omnivoice-smoke.mjs)            | Passive end-to-end wiring check — never loads native lib, never imports plugin. Pair with this checklist before declaring "ready".                          | DONE (this branch — G5).                                                   |

## Documentation

| File                                                                                                        | What it does                                                                       | Current state |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------- |
| [`docs/inference/omnivoice-binaries.md`](../../../docs/inference/omnivoice-binaries.md)                     | Where `libomnivoice` artifacts come from + how to drop them into place.            | DONE.         |
| [`docs/inference/omnivoice-cli.md`](../../../docs/inference/omnivoice-cli.md)                               | User-facing `omnivoice-fetch` CLI docs.                                            | DONE.         |
| [`docs/inference/omnivoice-singing.md`](../../../docs/inference/omnivoice-singing.md)                       | Singing-model conversion pipeline + mirror plan + license notes.                   | DONE.         |
| [`docs/inference/omnivoice-readiness.md`](../../../docs/inference/omnivoice-readiness.md)                   | Operator checklist + DONE / NEEDS-OPERATOR / NEEDS-CODE breakdown.                 | DONE (this branch — G5). |

---

## At a glance: what is still NEEDS-CODE

1. **Patch 0002** — vendor `omnivoice.cpp/src/*` into `llama.cpp/tools/omnivoice/`. G1 retry in flight at branch time.
2. **Patch 0003** — replace `tools/omnivoice/src/backend.h` so it consumes the `llama_context` backend pair (single invasive change; only file still touching internals).
3. **Live FFI / live model integration tests** — once 0002 + 0003 land and a `libomnivoice` exists, add `*.real.test.ts` files under `plugins/plugin-omnivoice/__tests__/` so `TEST_LANE=post-merge` exercises them.

Everything else on this page is DONE in-tree or is a NEEDS-OPERATOR
button-push (push the submodule branch, set HF secrets, run the build
workflow, run the convert workflow).
