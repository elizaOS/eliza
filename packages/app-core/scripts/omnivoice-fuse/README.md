# omnivoice-fuse: source-level fusion of omnivoice.cpp into elizaOS/llama.cpp

This directory contains the helpers + patch material that the build script
`packages/app-core/scripts/build-llama-cpp-dflash.mjs` invokes when one of
the fused targets (e.g. `darwin-arm64-metal-fused`) is requested.

The fused build produces ONE shared library and ONE server binary that
expose both `llama_*` (text + vision) and `omnivoice_*` (TTS + ASR)
symbols. This is the "one process, one llama.cpp build, one GGML pin"
contract from `packages/inference/AGENTS.md` §4.

## Pins (binding)

| Component        | Repo                                                  | Pin                                                                |
| ---------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| omnivoice.cpp    | `https://github.com/ServeurpersoCom/omnivoice.cpp`    | `38f824023d12b21a7c324651b18bd90f16d8bb86` (master HEAD 2026-05-10) |
| omnivoice ggml   | `https://github.com/ServeurpersoCom/ggml.git`         | `0e3980ef205ea3639650f59e54cfeecd7d947700` (its `ggml` submodule)  |
| milady llama.cpp | `https://github.com/elizaOS/llama.cpp.git`          | `v0.4.0-milady` (`08032d57`) — see `build-llama-cpp-dflash.mjs`    |

## GGML pin reconciliation strategy

omnivoice.cpp ships its own ggml fork as a git submodule (commit
`0e3980ef…`), and pulls it into the build with `add_subdirectory(ggml)`.
The elizaOS/llama.cpp fork ships its own ggml in-tree (at
`ggml/`, NOT a submodule) with the TurboQuant + QJL + PolarQuant + DFlash
patches that the kernels in `packages/inference/{metal,vulkan}` are
verified against.

**Two ggml trees in one build tree is illegal.** The kernels in this
repo are checked against the milady ggml only — the ServeurpersoCom ggml
does not have TurboQuant centroids, QJL projections, PolarQuant
centroids, or DFlash flash-attn entry points. Targeting both would
either (a) link two different ggml libraries into the same process
(undefined-behavior territory: duplicate `ggml_*` exports, divergent
struct layouts) or (b) silently use whichever comes first in link order
and lose half the contract.

**Strategy chosen: graft, not submodule swap.** When we prepare the
fused checkout we:

1. Clone the elizaOS/llama.cpp fork as the build root (same as the
   non-fused build does today).
2. Clone omnivoice.cpp at its pin into a sibling directory.
3. **Discard omnivoice's `ggml/` subdirectory entirely.** No
   `git submodule update --init` for `ggml`, no `add_subdirectory(ggml)`
   from omnivoice's CMakeLists.txt. The only ggml in the merged tree is
   llama.cpp's.
4. Copy omnivoice's `src/`, `tools/`, and `examples/` into the llama.cpp
   tree under stable paths:
   - `omnivoice/src/`     ← omnivoice `src/`
   - `omnivoice/tools/`   ← omnivoice `tools/`
   - `omnivoice/examples/` ← omnivoice `examples/` (data files only)
5. Append a CMake graft block to llama.cpp's root `CMakeLists.txt` that:
   - declares `omnivoice-core` (static archive) over the copied sources,
   - links it against llama.cpp's existing `ggml` / `ggml-base` /
     `ggml-cpu` / per-backend targets (so it shares one ggml ABI),
   - emits a fused server target (`llama-omnivoice-server`) that links
     both `llama` and `omnivoice-core` into one process,
   - emits a fused shared library target (`libelizainference`) so
     mobile/desktop bridges can dlopen one .so/.dylib and resolve both
     symbol families.
6. (When required) apply patches from `omnivoice-fuse/patches/` to
   reconcile any compile-time API drift between omnivoice's expected
   ggml surface (the ServeurpersoCom fork) and the milady ggml. Each
   patch is documented at the top with the symbol/struct it touches and
   the upstream commit that introduced the drift.

This is the lowest-blast-radius approach. We do NOT rebase omnivoice
onto a clean ggml tip and we do NOT carry the ServeurpersoCom ggml
submodule alongside ours. If the omnivoice authors upstream changes to
their ggml fork that we want, we cherry-pick those into the in-tree
ggml that ships inside `elizaOS/llama.cpp` (the
`packages/inference/llama.cpp` submodule), then bump the omnivoice pin
in this README.

### Why not "swap omnivoice's ggml submodule for milady's ggml"?

That sounds equivalent but creates a sharper failure mode: omnivoice's
CMakeLists.txt expects to be the parent of `ggml/` and configures it
with its own option set (`OMNIVOICE_*`, GGML_MAX_NAME=128, etc.). If we
let omnivoice's CMake reconfigure milady's ggml we lose the kernel-set
and patch hooks that `build-llama-cpp-dflash.mjs` already wires. The
graft approach keeps llama.cpp's CMake as the single point of ggml
configuration.

### Why not "make omnivoice an external package and dlopen it"?

Forbidden by §4 of `packages/inference/AGENTS.md`: "We do not run text
and voice in two processes communicating over IPC. That regresses
memory and adds a 1-10ms scheduling tax per turn." Even an in-process
dlopen would still mean two distinct ggml ABIs sharing the same
address space — same problem, masked.

## How to update the omnivoice pin (runbook)

1. Bring up a temp clone:
   ```sh
   git clone https://github.com/ServeurpersoCom/omnivoice.cpp /tmp/omnivoice-pinbump
   cd /tmp/omnivoice-pinbump
   git log --oneline -20
   ```
2. Review the diff against the current pin in the table above:
   ```sh
   git diff 38f824023d12b21a7c324651b18bd90f16d8bb86..master \
     -- src/ tools/ CMakeLists.txt
   ```
   Pay attention to:
   - changes to the public surface in `src/omnivoice.h` (used by
     `cap-bridge.cpp` and the runtime), in particular any rename of
     `omnivoice_context_*`, `omnivoice_generate_*`, `omnivoice_load_*`.
   - changes to `src/maskgit-tts.h` / `dac-decoder.h` / `hubert-enc.h`
     that touch the ggml graph builders — those must stay compatible
     with the ggml exposed by elizaOS/llama.cpp at the build pin.
   - new files added under `src/` or `tools/` — extend
     `CMAKE_GRAFT_SOURCES` in `omnivoice-fuse/cmake-graft.mjs`.
3. Bring up the new omnivoice ggml pin and `git diff` against the
   current ServeurpersoCom ggml pin:
   ```sh
   cd /tmp/omnivoice-pinbump
   git submodule update --init ggml
   cd ggml
   git log 0e3980ef205ea3639650f59e54cfeecd7d947700..HEAD --oneline
   ```
   For each commit that touches the ggml C API used by omnivoice's
   `src/`, decide:
   - is it already in elizaOS/llama.cpp's vendored ggml? (skip)
   - is it a kernel/quant change conflicting with milady's TurboQuant /
     QJL / PolarQuant work? (HARD STOP — escalate before bumping)
   - is it an additive API call omnivoice now uses? (cherry-pick into
     elizaOS/llama.cpp's `ggml/`, then bump that fork's tag, then
     bump omnivoice here)
4. Update the pin table at the top of this README. Update the constants
   `OMNIVOICE_REF` / `OMNIVOICE_GGML_REF` in
   `packages/app-core/scripts/build-llama-cpp-dflash.mjs`.
5. Run a fused build: `node build-llama-cpp-dflash.mjs --target
   darwin-arm64-metal-fused` (or vulkan/cpu equivalent). The build
   MUST exit non-zero if symbol verification fails — do NOT add
   compatibility shims to make the new pin compile.
6. Re-run `verify/metal_verify` and `verify/vulkan_verify` (per
   `packages/inference/README.md`) to confirm the kernel matrix still
   reports 8/8 PASS on the previously-verified hardware. A bumped
   omnivoice pin is NOT shippable until those are green.

## Failure modes the build script must surface (no fallback)

Per `packages/inference/AGENTS.md` §3 ("Mandatory optimizations") and
§9 ("No defensive code"), any of the following cause the build script
to exit non-zero. There is no "build the non-fused binary as a
fallback" path.

- omnivoice clone fails or pin is unreachable.
- omnivoice's `src/`, `tools/`, or required headers are missing.
- the GGML reconciliation removal of omnivoice's `ggml/` submodule
  fails (e.g. it's a real directory we couldn't strip).
- patches under `omnivoice-fuse/patches/` fail to apply.
- the fused CMake configure or build step fails.
- the resulting fused server binary or shared library cannot link
  *both* `llama_*` and `omnivoice_*` symbols (verified post-link with
  `nm`, or `objdump -T` on Linux/MinGW, or `nm -gU` on Darwin).

## Files in this directory

- `README.md`        — this file.
- `cmake-graft.mjs`  — reads the omnivoice source list and emits a
                       CMake snippet appended to llama.cpp's root
                       `CMakeLists.txt` to declare `omnivoice-core`,
                       `llama-omnivoice-server`, `libelizainference`.
- `prepare.mjs`      — clones omnivoice at the pin, strips its `ggml/`
                       submodule, copies `src/` + `tools/` into the
                       llama.cpp tree, applies any `patches/*.patch`,
                       and returns the omnivoice commit so the caller
                       can record it in `CAPABILITIES.json`.
- `verify-symbols.mjs` — post-build symbol probe. Runs `nm` (or
                       `objdump -T` on PE) against the produced
                       binary/library and asserts both `llama_*` and
                       concrete OmniVoice `ov_*` exports are present.
                       Writes `OMNIVOICE_FUSE_VERIFY.json` beside the
                       artifact on both pass and fail.
- `patches/`         — directory for `.patch` files keyed to specific
                       omnivoice or ggml commit drifts. Each patch is
                       applied with `git apply --check` first; a failed
                       apply is a hard error.
- `ffi.h`            — C ABI v2 for `libelizainference`. Single source
                       of truth for the symbol set the fused build
                       exposes. Consumed by the Bun FFI loader at
                       `src/services/local-inference/voice/ffi-bindings.ts`
                       and by future Rust / Swift / Python bridges.
- `ffi-stub.c`       — Reference C implementation that builds into
                       `libelizainference_stub.{dylib,so}`. Lifecycle
                       (`create`/`destroy`) works; every entry that
                       requires the real fused build returns
                       `ELIZA_ERR_NOT_IMPLEMENTED` (`*_supported` → 0,
                       `cancel_tts` → OK, `set_verifier_callback` → OK
                       no-op). Used by `ffi-bindings.test.ts` for
                       end-to-end loader validation without the fused
                       dylib. The stub library itself is a build
                       artifact (`make`-produced, `.gitignore`d) — not
                       checked in; CI/tests that need it run `make`
                       first or skip.
- `Makefile`         — Builds the stub. `make` produces the
                       platform-default artifact; `make verify` lists
                       the exported `eliza_inference_*` symbols;
                       `make verify-stub-rejected` confirms the real
                       symbol verifier rejects the stub.

## C ABI v2 (`ffi.h`)

The fused build (and the stub) export exactly these symbols. Bump
`ELIZA_INFERENCE_ABI_VERSION` in `ffi.h` AND
`ELIZA_INFERENCE_ABI_VERSION` in
`packages/app-core/src/services/local-inference/voice/ffi-bindings.ts`
in lockstep on any breaking shape change — the loader checks the
version at `dlopen` time and refuses to bind a mismatched library.

| Symbol                                    | Purpose                                                     |
| ----------------------------------------- | ----------------------------------------------------------- |
| `eliza_inference_abi_version`             | Returns the static ABI version string ("2").                |
| `eliza_inference_create` / `_destroy`     | Allocate / free a per-engine `EliInferenceContext`.         |
| `eliza_inference_mmap_acquire` / `_evict` | Lazy-page / release weights for a region (`tts`/`asr`/`text`/`dflash`). |
| `eliza_inference_tts_synthesize`          | Synchronous OmniVoice forward → fp32 PCM @ 24 kHz (batch).  |
| `eliza_inference_tts_stream_supported`    | 1 when this build implements streaming TTS, else 0.         |
| `eliza_inference_tts_synthesize_stream`   | Chunked OmniVoice forward → PCM segments via `eliza_tts_chunk_cb` + a final `is_final` tail; chunk cb returns non-zero to cancel. |
| `eliza_inference_cancel_tts`              | Hard-cancel any in-flight TTS forward pass on the context.  |
| `eliza_inference_set_verifier_callback`   | Register the native DFlash speculative-step callback (`EliVerifierEvent` accepted / rejected-range / corrected token ids); `cb == NULL` clears it. |
| `eliza_inference_asr_transcribe`          | Synchronous ASR forward → UTF-8 transcript (batch).         |
| `eliza_inference_asr_stream_supported`    | 1 when this build implements streaming ASR, else 0.         |
| `eliza_inference_asr_stream_open` / `_feed` / `_partial` / `_finish` / `_close` | Streaming ASR session: feed PCM frames, read a running partial transcript (+ optional text-model token ids), force-finalize, close. |
| `eliza_inference_free_string`             | Free heap strings the library handed back (errors).         |

ABI v2 status codes add `ELIZA_ERR_CANCELLED` (-7), returned by the
streaming TTS entry when the chunk callback (or `cancel_tts`) requested
a stop. The JS binding surfaces it as `{ cancelled: true }`, not a throw.

### Unified one-process HTTP server (status: scoped — placeholder build)

§4 of `packages/inference/AGENTS.md` calls for ONE process serving
`/v1/chat/completions` (+ DFlash), `/v1/audio/speech`, and an ASR route.
The shared **library** (`libelizainference`, ABI v2 above) is the
production seam for that today — mobile loads it directly; the unified
voice server is meant to mount the same call surface over HTTP. The
fused build currently links a **placeholder** `llama-omnivoice-server`
(`cmake-graft.mjs`, links `omnivoice/tools/omnivoice-tts.cpp`) that
exists only so the symbol verifier confirms `llama_*` + `ov_*` are
co-resident in an executable. Landing the real unified server is a
follow-up:
  1. `/v1/audio/speech` → `eliza_inference_tts_synthesize_stream` /
     `ov_synthesize` (streaming response body).
  2. `/v1/chat/completions` + DFlash → the existing dflash `llama-server`
     core (`server.cpp` routes) in the **same** process, with the native
     verifier callback (`eliza_inference_set_verifier_callback`) emitting
     the accept/reject events directly instead of the SSE side-channel
     patch (`kernel-patches/server-structured-output.mjs`), which stays
     as the non-fused desktop text fallback.
  3. An ASR route over the streaming ASR session API.
Until then the **desktop text path keeps using `llama-server` over
loopback** (the `DflashLlamaServer` backend); the fused library is the
path for mobile + (eventually) the unified server. Do NOT mark
`eliza_inference_tts_synthesize` / `eliza_inference_asr_transcribe`
("done") as the streaming story — they are the batch one-shot fallbacks;
the within-a-tick handoff AGENTS.md §4 needs is the `*_stream` /
verifier-callback surface above.

Implementation note: ABI v2 completes real streaming TTS, streaming ASR,
and the verifier-callback registration on macOS Metal (TTS + batch ASR
land per the v1 note below; streaming TTS chunks the OmniVoice forward
result into ~120 ms 24 kHz segments — finer per-frame streaming awaits
an omnivoice.cpp internal hook; the streaming ASR session runs windowed
re-decode passes over the accumulated PCM; the verifier callback is
registered on the context and fired by the in-process speculative loop —
which lands with the unified server above).

Implementation note (v1, still in force): TTS and ASR on macOS Metal.
TTS keeps the OmniVoice LM / MaskGIT path on the selected accelerator. On
Apple Metal, the audio tokenizer / DAC codec region is pinned to a CPU-only
scheduler inside the same process; this avoids the previously observed
merged-ggml Metal DAC decode stall after `[TTS] Decode` without launching a
second model runtime or duplicating model lifecycle state. ASR uses llama.cpp
`mtmd` with a qwen3a backport for Qwen3-ASR GGUF bundles and requires the
canonical bundle files `asr/eliza-1-asr.gguf` and
`asr/eliza-1-asr-mmproj.gguf`; missing or ambiguous ASR assets remain a hard
`ELIZA_ERR_BUNDLE_INVALID` failure.

All errors flow through a `char ** out_error` parameter that the
library populates with a heap-allocated NUL-terminated message.
Callers MUST free those messages via `eliza_inference_free_string`.
Negative return values map to the `ELIZA_ERR_*` codes declared in
`ffi.h` — the JS binding re-projects them onto
`VoiceLifecycleError.code` (`ram-pressure`, `mmap-fail`,
`kernel-missing`, `disarm-failed`).

## Loading the library from JS

Production loader (Bun runtime via Electrobun + Capacitor):

```ts
import { loadElizaInferenceFfi } from
  "@elizaos/app-core/services/local-inference/voice/ffi-bindings";
const ffi = loadElizaInferenceFfi("/path/to/libelizainference.dylib");
const ctx = ffi.create(bundleRoot);
ffi.mmapAcquire(ctx, "tts");
const out = new Float32Array(24_000 * 4);
const samples = ffi.ttsSynthesize({
  ctx, text: "hello world", speakerPresetId: null, out,
});
ffi.mmapEvict(ctx, "tts");
ffi.destroy(ctx);
ffi.close();
```

The loader throws `VoiceLifecycleError({code:"kernel-missing"})` when
the runtime is not Bun, when `dlopen` fails, or when the library's
ABI version disagrees with the binding. It does NOT fall back to a
stub on failure — per `packages/inference/AGENTS.md` §3 + §9, every
startup precondition is a structured throw.

## Building the stub for tests

```sh
make -C packages/app-core/scripts/omnivoice-fuse
# → libelizainference_stub.dylib (macOS) or .so (linux)

# Symbol verification:
nm -gU libelizainference_stub.dylib | grep eliza_inference_

# Fail-closed real-library smoke. This intentionally renames the stub
# as libelizainference and verifies the real fused-symbol checker
# rejects it with an OMNIVOICE_FUSE_VERIFY.json failure report:
make -C packages/app-core/scripts/omnivoice-fuse verify-stub-rejected

# JS-side coverage (requires Bun on PATH for the integration scenarios):
cd packages/app-core
bunx vitest run src/services/local-inference/voice/ffi-bindings.test.ts
```

The test harness spawns a `bun -e` subprocess that loads the stub
dylib via `bun:ffi` and exercises `create`/`destroy`/`mmapEvict`/
`ttsSynthesize`/ABI-mismatch scenarios. The vitest worker itself runs
on Node 22 (no `bun:ffi`), so the pure-unit cases assert that the
loader throws structurally on the no-Bun path.

## Verifying a real fused artifact

After `build-llama-cpp-dflash.mjs --target <fused-target>` installs
`libelizainference`, the build runs the same verifier as this CLI:

```sh
node packages/app-core/scripts/omnivoice-fuse/verify-symbols.mjs \
  --out-dir <installed-bin-dir> \
  --target darwin-arm64-metal-fused
```

The verifier rejects stub-only artifacts, missing `llama_*` exports
unless Darwin re-exports `libllama.dylib`, any missing ABI v2
`eliza_inference_*` entry (the full streaming-voice + verifier-callback
surface in the table above), and missing concrete OmniVoice entries
such as `ov_init`, `ov_synthesize`, and `ov_audio_free`. A failed probe
exits non-zero and leaves `OMNIVOICE_FUSE_VERIFY.json` in the output
directory for build reports.
