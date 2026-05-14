# OmniVoice readiness — "100% ready to go" checklist

What's wired, what still needs operator action, and what still needs
code. Pair this with [`omnivoice-binaries.md`](omnivoice-binaries.md)
(how to get `libomnivoice`), [`omnivoice-cli.md`](omnivoice-cli.md)
(how to stage GGUFs), and
[`packages/inference/llama.cpp-omnivoice-merge/READY.md`](../../packages/inference/llama.cpp-omnivoice-merge/READY.md)
(merge-into-llama.cpp status).

Legend:

- **DONE** — committed; running it works without further changes.
- **NEEDS-OPERATOR** — code is in place; a human has to click / push /
  upload / wait. No more PRs required to enable.
- **NEEDS-CODE** — there is still authoring work before this is
  reachable, regardless of how many buttons an operator clicks.

The honest summary at the top:

- The **plugin** half of the stack (TS source, FFI, streaming, auto-detect,
  shutdown hooks, conversion script, both workflows) is **DONE** in this
  branch.
- The **native** half is **partial**: patch 0001 (cmake flag) is applied
  locally but not pushed; patches 0002 (vendor tree) and 0003 (backend
  wedge) are NEEDS-CODE.
- A user with a prebuilt `libomnivoice` and a converted GGUF pair on disk
  can already talk to an Eliza agent through this plugin today; the gap
  is "we ship both for them out of the box".

---

## (a) C++ build — `libomnivoice` + merge into `llama.cpp`

| Item                                                                | Status          | Reference                                                                                                                                          |
| ------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan + audit of `omnivoice.cpp` source tree                         | DONE            | [`packages/inference/llama.cpp-omnivoice-merge/PLAN.md`](../../packages/inference/llama.cpp-omnivoice-merge/PLAN.md)                               |
| Live merge-status log (which patches landed where)                  | DONE            | [`packages/inference/llama.cpp-omnivoice-merge/STATUS.md`](../../packages/inference/llama.cpp-omnivoice-merge/STATUS.md)                           |
| Patch 0001 — `LLAMA_BUILD_OMNIVOICE` cmake flag (example)           | DONE            | [`0001-add-omnivoice-build-option.example.patch`](../../packages/inference/llama.cpp-omnivoice-merge/0001-add-omnivoice-build-option.example.patch) |
| Patch 0001 applied to submodule branch `eliza/omnivoice-build-flag` | DONE (a4f51f33) | submodule commit `fc722d397`                                                                                                                       |
| Patch 0001 pushed to `elizaOS/llama.cpp` fork                       | NEEDS-OPERATOR  | `git -C packages/inference/llama.cpp push origin eliza/omnivoice-build-flag` (write access to fork required)                                       |
| Parent-repo gitlink bumped to the new submodule SHA                 | NEEDS-OPERATOR  | Once 0001 lands on the fork, bump `.gitmodules` / submodule pointer in parent repo                                                                 |
| Patch 0002 — vendor `tools/omnivoice/` subtree (example)            | DONE (example)  | [`0002-vendor-omnivoice-tree.example.patch`](../../packages/inference/llama.cpp-omnivoice-merge/0002-vendor-omnivoice-tree.example.patch)          |
| Patch 0002 applied (real, on fork branch)                           | NEEDS-CODE      | G1 retry agent currently attempting; STATUS.md says NOT STARTED at branch time                                                                     |
| Patch 0003 — replace omnivoice backend wedge (example)              | DONE (example)  | [`0003-replace-backend-wedge.example.patch`](../../packages/inference/llama.cpp-omnivoice-merge/0003-replace-backend-wedge.example.patch)          |
| Patch 0003 applied                                                  | NEEDS-CODE      | Awaits 0002; rewrites `tools/omnivoice/src/backend.h` to consume the llama_context backend pair                                                    |
| `libomnivoice.{dylib,so}` builds on macOS arm64 + Linux x64         | NEEDS-OPERATOR  | After 0002 + 0003 land, `cmake -DLLAMA_BUILD_OMNIVOICE=ON --build` from the workspace                                                              |

## (b) elizaOS plugin — FFI + streaming + auto-detect + shutdown

| Item                                                              | Status          | Reference                                                                                                                                  |
| ----------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `@elizaos/plugin-omnivoice` package scaffold                      | DONE (9b1fecfc) | [`plugins/plugin-omnivoice/package.json`](../../plugins/plugin-omnivoice/package.json) + [`src/`](../../plugins/plugin-omnivoice/src)      |
| `bun:ffi` binding + ABI mirror of `omnivoice.h`                   | DONE            | [`plugins/plugin-omnivoice/src/ffi.ts`](../../plugins/plugin-omnivoice/src/ffi.ts)                                                         |
| `OmnivoiceNotInstalled` dlopen-wrap (graceful "lib not found")    | DONE (1c4e2962) | [`plugins/plugin-omnivoice/src/errors.ts`](../../plugins/plugin-omnivoice/src/errors.ts) + ffi.ts                                          |
| Real streaming via `bun:ffi` JSCallback                           | DONE (87dd5278) | [`plugins/plugin-omnivoice/src/synth.ts`](../../plugins/plugin-omnivoice/src/synth.ts), `__tests__/streaming.test.ts`                      |
| Singing + speech context shutdown hooks                           | DONE (8014997e) | [`plugins/plugin-omnivoice/src/shutdown.ts`](../../plugins/plugin-omnivoice/src/shutdown.ts) + `__tests__/shutdown.test.ts`                |
| Filesystem auto-detect of GGUFs under `~/.milady/models/omnivoice/` | DONE (f9b266f5) | [`plugins/plugin-omnivoice/src/discover.ts`](../../plugins/plugin-omnivoice/src/discover.ts) + `__tests__/discover.test.ts`                |
| `ModelType.TEXT_TO_SPEECH` handler (speech + singing)             | DONE            | [`plugins/plugin-omnivoice/src/index.ts`](../../plugins/plugin-omnivoice/src/index.ts)                                                     |
| `ModelType.TRANSCRIPTION` typed stub (omnivoice has no ASR)       | DONE            | `OmnivoiceTranscriptionNotSupported` in `src/index.ts` (line ~202)                                                                         |
| Auto-enable logic — opt-in via env / settings                     | DONE (1c4e2962) | `loadSettings()` + dead `autoEnable` path removed in `auto-enable.ts`                                                                      |
| Browser entry point (no native lib)                               | DONE            | [`plugins/plugin-omnivoice/src/index.browser.ts`](../../plugins/plugin-omnivoice/src/index.browser.ts)                                     |
| Wire-up to streaming pipeline (`text-streaming.ts` bridge)        | DONE (9ef480f7) | Phase B commit                                                                                                                             |
| Plugin registered in default plugin set                           | NEEDS-OPERATOR  | Plugin is opt-in by design (heavy native lib + GGUFs). Operator either sets `OMNIVOICE_MODEL_PATH` / `OMNIVOICE_CODEC_PATH` or sets `features.localTts = true` and ensures the discovery dir is populated. |

## (c) Models — singing GGUF + conversion script + mirror

| Item                                                                  | Status          | Reference                                                                                                                                              |
| --------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One-command conversion script `convert-omnivoice-singing.mjs`         | DONE (739fca4b) | [`scripts/inference/convert-omnivoice-singing.mjs`](../../scripts/inference/convert-omnivoice-singing.mjs)                                            |
| `omnivoice-fetch.mjs` user-facing wrapper CLI                         | DONE (f9b266f5) | [`scripts/inference/omnivoice-fetch.mjs`](../../scripts/inference/omnivoice-fetch.mjs)                                                                |
| Singing-conversion + mirror plan docs                                 | DONE            | [`docs/inference/omnivoice-singing.md`](omnivoice-singing.md), [`omnivoice-cli.md`](omnivoice-cli.md)                                                  |
| Python deps (`transformers`, `gguf`, `safetensors`, `numpy`)          | NEEDS-OPERATOR  | Conversion script probes them and prints a `pip install …` line — not auto-installed by design                                                         |
| `huggingface-cli` (or `hf`) login                                     | NEEDS-OPERATOR  | `huggingface-cli login`, or `HUGGINGFACE_HUB_TOKEN` in env                                                                                             |
| Speech-variant `omnivoice-base-*.gguf` + tokenizer pair on disk       | NEEDS-OPERATOR  | Manual staging path documented in [`omnivoice-cli.md`](omnivoice-cli.md) ("Speech variant") — no upstream HF release for the speech split yet           |
| Singing-variant `omnivoice-singing-base-*.gguf` + tokenizer pair      | NEEDS-OPERATOR  | Run conversion locally or trigger the `Convert OmniVoice singing -> GGUF` workflow                                                                      |
| Milady-hosted HF mirror repo for converted GGUFs                      | NEEDS-OPERATOR  | Provision repo on HF, add `HF_WRITE_TOKEN` secret to GH org, set `target_hf_repo` workflow input                                                       |

## (d) CI / CD

| Item                                                                                  | Status          | Reference                                                                                                                       |
| ------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `Build libomnivoice` workflow (matrix: darwin-arm64-metal, linux-x64-cpu, +cuda opt)  | DONE (0a5d4271) | [`.github/workflows/build-omnivoice.yml`](../../.github/workflows/build-omnivoice.yml)                                          |
| `Convert OmniVoice singing -> GGUF` workflow                                          | DONE (b2f1010a) | [`.github/workflows/convert-omnivoice-singing.yml`](../../.github/workflows/convert-omnivoice-singing.yml)                      |
| Build workflow first green run                                                        | NEEDS-OPERATOR  | Won't pass until patches 0002 + 0003 land on the submodule fork (today: configure ON is a deliberate FATAL_ERROR)               |
| Convert workflow first green run                                                      | NEEDS-OPERATOR  | Dispatch with `quantize=Q8_0` after `HUGGINGFACE_HUB_TOKEN` is set on the repo                                                  |
| `HUGGINGFACE_HUB_TOKEN` repo secret (read scope)                                      | NEEDS-OPERATOR  | Required by the convert workflow's HF download step                                                                             |
| `HF_WRITE_TOKEN` repo secret (write scope, scoped to mirror repo)                     | NEEDS-OPERATOR  | Only needed when `upload_to_hf=true`                                                                                            |
| Self-hosted `gpu,cuda` runner online for the CUDA leg                                 | NEEDS-OPERATOR  | Optional — `continue-on-error: true` so workflow stays green when offline                                                       |

## (e) Tests

| Item                                                              | Status          | Reference                                                                                                                              |
| ----------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `discover.test.ts` — auto-detection unit tests                    | DONE            | [`plugins/plugin-omnivoice/__tests__/discover.test.ts`](../../plugins/plugin-omnivoice/__tests__/discover.test.ts)                    |
| `ffi-shape.test.ts` — ABI mirror layout assertions                | DONE            | [`plugins/plugin-omnivoice/__tests__/ffi-shape.test.ts`](../../plugins/plugin-omnivoice/__tests__/ffi-shape.test.ts)                  |
| `shutdown.test.ts` — process-lifecycle teardown                   | DONE            | [`plugins/plugin-omnivoice/__tests__/shutdown.test.ts`](../../plugins/plugin-omnivoice/__tests__/shutdown.test.ts)                    |
| `streaming.test.ts` — JSCallback streaming path                   | DONE            | [`plugins/plugin-omnivoice/__tests__/streaming.test.ts`](../../plugins/plugin-omnivoice/__tests__/streaming.test.ts)                  |
| `synth-options.test.ts` — voice design + emotion grammar          | DONE            | [`plugins/plugin-omnivoice/__tests__/synth-options.test.ts`](../../plugins/plugin-omnivoice/__tests__/synth-options.test.ts)          |
| `core-test-mock.ts` — `@elizaos/core` test stub                   | DONE            | [`plugins/plugin-omnivoice/__tests__/core-test-mock.ts`](../../plugins/plugin-omnivoice/__tests__/core-test-mock.ts)                  |
| Passive end-to-end smoke (no native loads)                        | DONE            | [`scripts/inference/omnivoice-smoke.mjs`](../../scripts/inference/omnivoice-smoke.mjs)                                                |
| Live FFI smoke (loads `libomnivoice`, allocates context, frees)   | NEEDS-CODE      | Out of scope for this branch; should be a `*.real.test.ts` so `TEST_LANE=post-merge` gates it                                          |
| Live model-load smoke (loads a real GGUF, ~3s)                    | NEEDS-CODE      | Same — post-merge lane only                                                                                                            |
| End-to-end "agent speaks" integration test                        | NEEDS-CODE      | Pending live FFI + model smokes; should belong in `packages/app-core/__tests__/integration/`                                          |

## (f) Documentation

| Item                                                              | Status          | Reference                                                                                                |
| ----------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------- |
| Conversion + mirror docs                                          | DONE (739fca4b) | [`docs/inference/omnivoice-singing.md`](omnivoice-singing.md)                                            |
| Binary distribution docs                                          | DONE            | [`docs/inference/omnivoice-binaries.md`](omnivoice-binaries.md)                                          |
| User-facing CLI docs                                              | DONE (f9b266f5) | [`docs/inference/omnivoice-cli.md`](omnivoice-cli.md)                                                    |
| Plugin internal research notes                                    | DONE            | [`plugins/plugin-omnivoice/RESEARCH.md`](../../plugins/plugin-omnivoice/RESEARCH.md)                     |
| Merge plan + status                                               | DONE            | [PLAN.md](../../packages/inference/llama.cpp-omnivoice-merge/PLAN.md) + [STATUS.md](../../packages/inference/llama.cpp-omnivoice-merge/STATUS.md) |
| This readiness checklist                                          | DONE            | (you are here)                                                                                           |
| Merge cross-reference one-pager                                   | DONE            | [`packages/inference/llama.cpp-omnivoice-merge/READY.md`](../../packages/inference/llama.cpp-omnivoice-merge/READY.md) |
| License compliance notes                                          | DONE (739fca4b) | See `docs/inference/omnivoice-singing.md` "License" section                                              |

---

## Critical-path sketch (clone → speaking agent)

```
git clone elizaOS/eliza
   │
   ▼
bun install                                       (TS + plugin scaffolds ready)
   │
   ▼  ┌─────────────────────────────────────────────────────────────────┐
   │  │ NEEDS-OPERATOR fork (or NEEDS-CODE if patches 0002+0003 not yet │
   │  │  merged): build libomnivoice from llama.cpp + LLAMA_BUILD_      │
   │  │  OMNIVOICE=ON, OR download a release artifact from              │
   │  │  build-omnivoice.yml.                                           │
   │  └─────────────────────────────────────────────────────────────────┘
   ▼
libomnivoice.{dylib|so} present at OMNIVOICE_LIB_PATH (or default path)
   │
   ▼  ┌─────────────────────────────────────────────────────────────────┐
   │  │ Stage GGUF pairs into                                           │
   │  │   ~/.milady/models/omnivoice/{speech,singing}/                  │
   │  │ either by:                                                       │
   │  │   - `node scripts/inference/omnivoice-fetch.mjs --singing`,     │
   │  │   - or downloading the workflow artifact, or                    │
   │  │   - hand-converting via convert-omnivoice-singing.mjs.          │
   │  └─────────────────────────────────────────────────────────────────┘
   ▼
plugin-omnivoice auto-detects GGUFs at agent boot (discover.ts)
   │
   ▼
ModelType.TEXT_TO_SPEECH returns a WAV Buffer for any input text
   │
   ▼
Agent speaks. ✓
```

---

## 6-step operator checklist (gets to a speaking agent)

1. **Push patch 0001 to the fork.** `git -C packages/inference/llama.cpp push origin eliza/omnivoice-build-flag`. Then bump the parent-repo submodule gitlink and PR it. (NEEDS-OPERATOR.)
2. **Land patches 0002 + 0003.** G1 is in flight; once green, merge into `elizaOS/llama.cpp:eliza/main`. (NEEDS-CODE today.)
3. **Tag `omnivoice-YYYY-MM-DD` to trigger the build workflow.** Download the `darwin-arm64-metal` and `linux-x64-cpu` artifacts from `build-omnivoice.yml` and either ship them with the desktop bundle or host them where the user can fetch them.
4. **Set `HUGGINGFACE_HUB_TOKEN` on the repo secrets.** Optional `HF_WRITE_TOKEN` if you want CI to upload converted GGUFs to a mirror.
5. **Run the convert workflow once.** `Actions → Convert OmniVoice singing -> GGUF → Run workflow` with `quantize=Q8_0` and optional `upload_to_hf=true`. Download the resulting artifact (or use the mirror).
6. **Hand the user a one-liner.** `OMNIVOICE_LIB_PATH=/path/to/libomnivoice.dylib node scripts/inference/omnivoice-fetch.mjs --singing` — this runs the conversion locally if the mirror isn't reachable, drops the GGUFs into `~/.milady/models/omnivoice/singing/`, and the plugin will discover them at boot. After step 6 the agent speaks.

---

## How to re-check this with one command

```
node scripts/inference/omnivoice-smoke.mjs
```

The smoke script is **passive** — it never loads the native library and
never invokes a model. It prints which wiring is present, exits `0` if
all pieces are in place (binary + GGUFs may still be unfetched, that's
fine), `2` if partial, `1` if wiring itself is broken. See
[`scripts/inference/omnivoice-smoke.mjs`](../../scripts/inference/omnivoice-smoke.mjs).
