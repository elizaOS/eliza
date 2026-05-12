# omnivoice -> llama.cpp merge: running status

Track which patches in the 3-patch series have actually landed (vs. still
being example/plan only). Updated by Phase E follow-up agents.

## Patch 0001 — `LLAMA_BUILD_OMNIVOICE` cmake flag

**Status:** applied locally on submodule branch `eliza/omnivoice-build-flag`, NOT pushed.

- **Submodule:** `packages/inference/llama.cpp`
- **Branch (in submodule):** `eliza/omnivoice-build-flag`
- **Base:** `milady/main` (the submodule's current default branch on this checkout;
  the `.gitmodules` `branch = eliza/main` is the upstream-tracked branch but the
  working tree is on `milady/main`. Branched off the current HEAD, which is the
  rebrand merge commit `11f645f0e`).
- **Commit SHA:** `fc722d397884572a3db91718dc23c3f2d2925312`
- **Commit message:** `build: add LLAMA_BUILD_OMNIVOICE option (no-op until vendor tree lands)`
- **Files touched:** `CMakeLists.txt` (+19 lines)
  - Adds `option(LLAMA_BUILD_OMNIVOICE ...)` and `option(OMNIVOICE_SHARED ...)`,
    both default OFF, next to the existing `LLAMA_BUILD_*` options block.
  - Adds a guarded `add_subdirectory(tools/omnivoice)` block at the bottom that
    fails fast with a `FATAL_ERROR` ("OMNIVOICE_VENDOR_DIR not yet wired
    (patch 0002)") when ON without the vendored subtree.

### Verification

Ran from the workspace root:

```
cmake -B /tmp/test-omni-merge    -S packages/inference/llama.cpp \
      -DLLAMA_CURL=OFF -DLLAMA_BUILD_OMNIVOICE=OFF \
      -DGGML_METAL=OFF -DGGML_BLAS=OFF
```

Result: `Configuring done (12.6s)` / `Generating done (0.9s)` / `Build files have been written to: /tmp/test-omni-merge`. PASS.

```
cmake -B /tmp/test-omni-merge-on -S packages/inference/llama.cpp \
      -DLLAMA_CURL=OFF -DLLAMA_BUILD_OMNIVOICE=ON \
      -DGGML_METAL=OFF -DGGML_BLAS=OFF
```

Result:

```
CMake Error at CMakeLists.txt:229 (message):
  LLAMA_BUILD_OMNIVOICE=ON but OMNIVOICE_VENDOR_DIR not yet wired (patch
  0002).  Vendor tools/omnivoice/ from packages/inference/omnivoice.cpp
  first, then re-run cmake.
```

That is the intended failure: the flag exists, default is harmless, ON is a
loud hard-stop instead of a silent "missing subdirectory" cmake parse error.
PASS.

CMake version used: `cmake version 4.0.3` (Homebrew, darwin/arm64).

`-DGGML_METAL=OFF -DGGML_BLAS=OFF` were passed only to keep the configure step
fast and platform-portable for the verification — they have no relationship to
the omnivoice flag itself.

### Required to push (NOT done by this agent)

This branch lives only in the local submodule clone. To make it available to
other workstations / CI:

```
git -C packages/inference/llama.cpp push origin eliza/omnivoice-build-flag
```

The submodule remote is `https://github.com/elizaOS/llama.cpp.git` (see
`.gitmodules`). Pushing requires write access to that fork.

### Parent-repo gitlink

The submodule HEAD has moved off the gitlink recorded in the parent repo.
This agent intentionally did NOT `git add packages/inference/llama.cpp` or
commit at the parent level — the orchestrator owns parent-repo commits.
`git status` in the parent will show the submodule as having "new commits".

## Patch 0002 — vendor omnivoice subtree

**Status:** applied locally on submodule branch `eliza/omnivoice-build-flag`,
NOT pushed. cmake configure verified (no build). Parent gitlink bumped.

Three submodule commits stacked on patch 0001 (`fc722d397`):

- `1c5e595e6` — `omnivoice: vendor src/, tools/, public header into tools/omnivoice/`
- `059962fec` — `omnivoice: vendor tests/abi-c.c into tools/omnivoice/tests/`
- `5b82434d7` — `omnivoice: wire tools/omnivoice/ into LLAMA_BUILD_OMNIVOICE build`

`tools/omnivoice/CMakeLists.txt` defines `omnivoice_lib` (STATIC), opt-in
`omnivoice` (SHARED, gated on `OMNIVOICE_SHARED`), `omnivoice-tts`,
`omnivoice-codec`, and `omnivoice-test-abi-c`. Top-level CMakeLists +
`tools/CMakeLists.txt` both wire `add_subdirectory(omnivoice)` when
`LLAMA_BUILD_OMNIVOICE=ON` — the FATAL_ERROR from patch 0001 was replaced
with the live add_subdirectory wiring.

### Verification — configure only (no build)

```
cmake -B /tmp/g1-omni-vendor-cfg-final -S packages/inference/llama.cpp \
      -DLLAMA_CURL=OFF -DLLAMA_BUILD_OMNIVOICE=ON \
      -DLLAMA_METAL=OFF -DGGML_METAL=OFF -DLLAMA_NATIVE=OFF
```

Result: `Configuring done (16.4s)` / `Generating done (0.7s)` / `Build files
written`. All four omnivoice targets have generated Makefiles. **PASS.**

**NOTE:** `cmake --build` was intentionally NOT run — compiling the
GGML kernels uses many GB of RAM (operator OOM'd earlier in the session).
The real build verification belongs in CI
(`.github/workflows/build-omnivoice.yml`) once patch 0003 lands and the
submodule branch is pushed.

### Aside — submodule has unrelated merge debt

The submodule's `milady/main` carries an unresolved upstream merge
(e.g. `<<<<<<<` markers in `ggml/CMakeLists.txt`). Independent of the
omnivoice work and visible at session start. Does not block patches
0002/0003: the omnivoice branch is rooted on the rebrand merge commit
`11f645f0e`, before the conflicted upstream merge.

## Patch 0003 — replace omnivoice backend wedge

**Status:** NOT STARTED. Still example-only at
`0003-replace-backend-wedge.example.patch`.

Scope: rewrite `tools/omnivoice/src/backend.h` to consume the llama.cpp
backend pair from a `llama_context` instead of allocating its own. This is
the only invasive change in the merge — see PLAN.md "Audit of omnivoice src/"
for the full file inventory.
