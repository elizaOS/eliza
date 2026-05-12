# CUDA setup & graceful degradation for eliza-1 on Windows / Linux

Scope: what an NVIDIA-GPU user on Windows or Linux actually needs to run the
eliza-1 local models *well* (i.e. on CUDA, not the ~14× slower Vulkan prefill
path), how Milady detects hardware today, what degrades silently, and the
concrete plan to close the gaps. macOS (Metal) and Android (Vulkan) are out of
scope here.

## 1. CUDA dependency reality: driver vs. toolkit

There are two distinct CUDA artifacts and they get conflated constantly:

- **The NVIDIA display driver** ships the CUDA *driver* runtime: `libcuda.so.1`
  (Linux) / `nvcuda.dll` (Windows) plus the kernel module. This is the *only*
  thing required to *run* CUDA code. On Linux it comes from the distro's
  `nvidia-driver-NNN` package (or NVIDIA's `.run`); on Windows it's the Game
  Ready / Studio driver from nvidia.com or Windows Update. A recent-enough
  driver is needed for the CUDA toolkit version a binary was compiled against
  (CUDA 12.x needs driver ≥ 525 on Linux / ≥ 527 on Windows; newer minor
  versions bump the floor — CUDA 12.8, which adds Blackwell `sm_100`/`sm_120`,
  wants ≥ 570).

- **The CUDA toolkit** (`nvcc`, `libcudart`, headers) is a *build-time*
  dependency. node-llama-cpp's CUDA prebuilt **statically bundles libcudart**, so
  *running* the node binding never needs the toolkit. Likewise our fork's CUDA
  build links `cudart_static` — once the `.so`/`.dll` exists, only the driver is
  needed at runtime.

**So: a Windows/Linux user needs the NVIDIA driver, not the CUDA toolkit — *if*
the CUDA binary already exists on their machine.** The catch is the second
clause. node-llama-cpp's CUDA prebuilt downloads automatically on `npm install`
of the binding (it's in `app-core`'s deps, `node-llama-cpp@3.18.1`,
trusted-dependency flagged). But eliza-1's GGUFs use the custom GGML types
(`QJL1_256` / `Q4_POLAR` / `TBQ3_*`) and `--spec-type dflash`, so the catalog
marks every tier `preferredBackend: "llama-server"` with
`requiresKernel: [...]` — they **must** route to the fork's `llama-server`, not
node-llama-cpp. The fork is built by `packages/app-core/scripts/build-llama-cpp-dflash.mjs`:
`detectBackend()` returns `"cuda"` only when `nvcc` *or* `nvidia-smi` is on PATH,
and the `linux-x64-cuda` / `windows-x64-cuda` targets pass `-DGGML_CUDA=ON`
which **requires `nvcc` on the build host**. There is no prebuilt-CUDA-fork
download path in the runtime — `resolveDflashBinary()` only looks at
`ELIZA_DFLASH_LLAMA_SERVER`, the fused build dir, the managed
`<root>/local-inference/bin/dflash/<platform>-<arch>-<backend>/llama-server`
path, and `$PATH`. The CI matrix (`.github/workflows/local-inference-matrix.yml`)
*does* build `linux-x64-cuda` and uploads it as a smoke artifact, but it's
`continue-on-error`, gated behind a `gpu`-labelled self-hosted runner, and not
wired into any release-distribution pipeline. `release-electrobun.yml` ships
nothing inference-related. So on a fresh desktop install **nothing builds or
downloads the CUDA fork for the user** — they'd need `nvcc` (i.e. the full CUDA
toolkit, ~3 GB) installed *and* a manual `bun run local-inference:dflash:build`.

Net for a fresh install:

| | Windows | Linux |
|---|---|---|
| NVIDIA driver | user installs (nvidia.com / Windows Update) | user installs (`nvidia-driver-NNN` or `.run`) — see `packages/inference/reports/porting/2026-05-11/cuda-bringup-operator-steps.md` for a worked example of a half-installed driver |
| CUDA toolkit (`nvcc`) | only needed if *building* the fork; not shipped, not auto-installed | same |
| node-llama-cpp CUDA prebuilt | auto-downloads with `app-core` deps | auto-downloads with `app-core` deps |
| eliza-1 fork CUDA build (`llama-server`) | **not built, not downloaded** today | **not built, not downloaded** today |
| What runs eliza-1 today | Vulkan fork build if present (CI smoke artifact), else CPU fork, else node-llama-cpp (which can't load the custom GGML types → load error) | same |

## 2. Detection — what exists

- **`probeHardware()`** (`local-inference/hardware.ts`) is the only real GPU
  probe. It `import()`s `node-llama-cpp`, calls `getLlama({ gpu: "auto" })`, and
  reads `llama.gpu` (`"cuda" | "metal" | "vulkan" | false`) plus
  `getVramState()`. It feeds `recommendBucket()` (small/mid/large/xl from
  effective VRAM/RAM) and `deviceCapsFromProbe()` (which backends a bundle may
  install). Exposed at `GET /api/local-inference/hardware`. **It does not run
  `nvidia-smi`** and there is no driver-presence / driver-version check. If the
  binding's prebuilt is missing it returns `source: "os-fallback"` with
  `gpu: null` — i.e. it cannot tell "no GPU" from "GPU present, binding not
  installed".
- **The fork backend selector** (`dflash-server.ts` `platformKey()` /
  `fusedBackendKey()`) was the real gap: it picked `cuda` *only* when
  `CUDA_VISIBLE_DEVICES` was set and not `-1`. That env var is essentially never
  set on a desktop launch, so the runtime always keyed `…-cpu` and would run the
  CPU fork build *even with a CUDA fork build sitting in the managed bin dir*.
  **Fixed in this change** (see §5): when no `*_VISIBLE_DEVICES`/`ELIZA_DFLASH_BACKEND`
  override is present, the selector now probes `<root>/bin/dflash/<plat>-<arch>-{cuda,vulkan,rocm}[-fused]/llama-server` on disk and prefers the first that exists. So a downloaded/built CUDA fork artifact is now actually used.
- **Backend dispatch** (`backend.ts` `decideBackend()`): chooses node-llama-cpp
  vs. llama-server purely from catalog metadata (`requiresKernel`,
  `runtime.dflash`, `preferredBackend`) + `ELIZA_LOCAL_BACKEND`. It is *not*
  GPU-aware — within `llama-server` the cuda-vs-vulkan-vs-cpu choice is the
  build-dir selection above, not a dispatcher decision. There is **no
  "detected RTX 4090, using CUDA" message surfaced anywhere** — the hardware
  probe data is available via the API but nothing renders a confirmation.

## 3. Graceful degradation — what the chain actually is

For eliza-1 (kernel-required tiers), the de-facto fallback is:

1. fused CUDA fork build → 2. stock CUDA fork build → 3. fused Vulkan → 4. stock
Vulkan → 5. fused CPU → 6. stock CPU fork → 7. node-llama-cpp (which **cannot
load** the custom GGML types — it errors).

What the dispatcher actually walks: `BackendDispatcher.load()` picks
`llama-server` (kernel-required) and calls `dflashLlamaServer.load(plan)`.
`engine.ts` only falls back to node-llama-cpp when the decision reason is the
*soft* `"preferred-backend"` and `!dflashRequired()` — kernel-required loads
**do not** fall back; the error propagates. That's correct (a node-llama-cpp
fallback would fail to load the GGUF anyway). The within-`llama-server` walk
(cuda→vulkan→cpu) is the new `accelBackendKey()` disk probe — but there is no
"warn the user we degraded from CUDA to CPU" message; it just runs slow.

Failure modes and what the user sees today:

- **No fork build at all for the platform** → `resolveDflashBinary()` returns
  null → `getDflashRuntimeStatus()` reports `enabled: false, reason: "No
  compatible llama-server found. Set ELIZA_DFLASH_LLAMA_SERVER or run
  packages/app-core/scripts/build-llama-cpp-dflash.mjs."` and (with eliza-1
  loaded) `BackendDispatcher.load()` throws `unsatisfiedKernels` /
  "rebuild the fork" — clear error, but it points at a dev script, not a
  user action. `runDflashDoctor()` exposes this via the doctor report
  (`llama-server-binary` check → `fail`).
- **GPU has too little VRAM** → `assessFit()` returns `tight`/`wontfit` and
  `recommendBucket()` downsizes the tier; this is surfaced in the catalog UI.
  But if a too-big tier is force-loaded, `llama-server` either OOMs the GPU
  (CUDA OOM, hard crash of the child) or — with `gpuLayers: "auto"` — spills to
  CPU silently and runs slow. No proactive warning.
- **Driver too old / absent** → `getLlama({ gpu: "auto" })` falls back to
  `gpu: false`; `probeHardware()` reports `gpu: null`. If a CUDA fork build is
  on disk, launching it against a missing/old `libcuda.so.1` fails at
  `dlopen`/`LoadLibrary` time — `llama-server` exits non-zero, the engine
  surfaces the spawn failure, but **there is no "your NVIDIA driver is missing
  or too old, install ≥ 12.x" message** mapping the cryptic loader error to an
  actionable fix.

## 4. Installer integration — the plan

The installer (desktop first-run / `bun install` postinstall) should:

**(a) Detect the GPU.** Run `nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader` (Linux + Windows both ship it with the driver). Parse name, VRAM, and driver version. This is cheaper and more honest than spinning up the node-llama-cpp binding, and it tells us the driver version (which the binding does not). Fall back to `probeHardware()` for non-NVIDIA.

**(b) Get the right fork build onto disk.** Building the CUDA fork needs `nvcc` — pulling a ~3 GB CUDA toolkit on every install is unacceptable. The correct call is the same one node-llama-cpp made: **ship prebuilt CUDA fork binaries as release artifacts** (per `windows-x64-cuda`, `linux-x64-cuda`, plus the `-fused` variants), and have the installer download the matching one into `<root>/local-inference/bin/dflash/<plat>-<arch>-<backend>/`. The build matrix already produces these (`build-llama-cpp-dflash.mjs --target linux-x64-cuda` etc., with `CAPABILITIES.json` emitted next to the binary) — they're just not promoted to a downloadable release today. Concretely: add a `dflash-binaries` release job (parallel to `release-electrobun.yml`) that runs the existing build script for `{linux,windows}-x64-{cpu,vulkan,cuda}` (+ `-fused`) on the `gpu`-labelled self-hosted runner for the CUDA legs, uploads each `<target>/` dir (binary + `CAPABILITIES.json`) as a GH release asset, and a small `local-inference:fetch-binary` resolver in the runtime that, when `resolveDflashBinary()` finds nothing, downloads the asset for `accelBackendKey()` (CUDA if `nvidia-smi` succeeds, else Vulkan, else CPU). Keep `build-llama-cpp-dflash.mjs` as the from-source path for devs and the `MILADY_ELIZA_SOURCE=local` workflow.

**(c) Warn on missing/old driver.** If `nvidia-smi` fails (driver absent) or reports `driver_version` below the CUDA-12.x floor, show a one-time card: "An NVIDIA GPU was detected but the driver is missing/outdated. eliza-1 will run on CPU (≈14× slower) until you install the driver: `https://www.nvidia.com/Download/index.aspx` (Windows) / `sudo ubuntu-drivers install` or your distro's `nvidia-driver-NNN` (Linux)." Map the `llama-server` `dlopen`/`LoadLibrary` failure to the same message. Link to `docs/.../cuda-bringup-operator-steps.md`-style guidance.

**(d) Pick model + context for the detected VRAM.** Already mostly there: `recommendBucket()` → `eliza-1-{0_6b,1_7b,9b,27b,...}`. Tighten it so the first-run default respects `nvidia-smi` VRAM directly (the current heuristic weights `max(vram*1.25, ram*0.5)` which over-estimates on a 6 GB laptop dGPU + 32 GB RAM box). Surface the choice: "Detected RTX 4090 (24 GB) → using eliza-1-9b on CUDA" in onboarding.

**Windows flow:** `nvidia-smi` → if OK and driver ≥ 12.x floor: download `windows-x64-cuda[-fused]` fork build → pick tier from VRAM → "using CUDA" confirmation. If `nvidia-smi` fails: download `windows-x64-vulkan` (all of NVIDIA/AMD/Intel ARC expose Vulkan 1.3) + show driver-install card → still works, just slower. If no Vulkan-capable GPU: `windows-x64-cpu`. node-llama-cpp's own CUDA/Vulkan prebuilts come down with `app-core` deps regardless (used for the hardware probe + any stock GGUF).

**Linux flow:** identical, with `linux-x64-{cuda,vulkan,cpu}` and the driver-install hint pointing at `ubuntu-drivers` / distro package. The `cuda-bringup-operator-steps.md` report shows a real `dpkg --configure -a` half-install recovery worth linking from the warning.

## 5. Changes made in this commit

`packages/app-core/src/services/local-inference/dflash-server.ts`: replaced the
two near-duplicate `platformKey()` / `fusedBackendKey()` env-only backend
selectors with a single `accelBackendKey(suffix)` helper. Precedence is now:
`ELIZA_DFLASH_BACKEND` override → `darwin`→`metal` → `HIP_/ROCR_VISIBLE_DEVICES`→`rocm`
→ `CUDA_VISIBLE_DEVICES`→`cuda` → **disk probe** for an installed
`…-{cuda,vulkan,rocm}[-fused]/llama-server` (cuda preferred) → `cpu`. This is
the smallest fix that makes a present-on-disk CUDA fork build actually get used
without the operator having to set `CUDA_VISIBLE_DEVICES` by hand. `platformKey()`
and `fusedBackendKey()` are now thin wrappers, so all existing callers
(`managedDflashBinaryPath`, `managedFusedDflashDir`, `managedDflashCapabilitiesPath`)
pick it up. Typecheck clean; `dflash-server.test.ts` 27/27 pass.

Not done here (recommended, larger): the `nvidia-smi`-based detector, the
prebuilt-CUDA-fork release job + runtime downloader, the missing/old-driver
warning card, and the VRAM-aware first-run tier pick. Those are §4 above.
