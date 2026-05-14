# Windows Performance Optimization Audit — `C:\Users\Administrator\Documents\eliza`

**Hardware probed (this VM):** QEMU/KVM Windows 11 Pro 26200, AMD EPYC 9684X exposed as 12 vCPU / 12 logical (no SMT exposed), 32 GiB RAM, **no discrete or integrated GPU** (`Microsoft Basic Display Adapter`, `AdapterRAM = 0`). This is a CPU-only target — every CUDA/Vulkan/DirectML recommendation below assumes a separate non-VM Windows host; on *this* machine the wins are all in CPU intrinsics, threading, OpenMP, and KV-cache quant.

Ordered by impact-per-effort (highest first).

---

## 1. Turbo build runs serially on a 12-core machine — `package.json:78`
**Current:** `"build": "turbo run build --concurrency=1 && ..."` — and `typecheck` (line 89) and `verify` (line 91) also pin `--concurrency=1`. The Bash `clean` target uses `--concurrency=100%`, proving the codebase has no real anti-parallel constraint.
**Proposed:** Drop to `--concurrency=$(nproc)` or `--concurrency=75%` for `build`/`typecheck`/`verify`. Keep `=1` only for tasks that legitimately fight (none identified).
**Expected gain:** ~3–6× faster full builds on this 12 vCPU host (turbo has heavy fan-out — see the dependency tree in `turbo.json` lines 11–284). This is the single biggest dev-loop win.
**Risk:** Low. Memory pressure if every tsc shard peaks near `--max-old-space-size=8192` (line 89) — cap concurrency to 6 if OOMs appear. Turbo already topo-sorts so dependents wait.

---

## 2. `@elizaos/core#build` produces unminified bundles — `packages/core/build.ts:73`
**Current:** `createElizaBuildConfig` defaults `sourcemap = false, minify = false`. No call site passes `minify: true`. The `vite build` for `packages/app` does minify by default, but every workspace `.dist/` shipped to the Electrobun runtime bundle (copied via `runtimeBundleDistDir`, `electrobun.config.ts:118`) is unminified ESM.
**Proposed:** In `build.ts`, default `minify: process.env.NODE_ENV !== "development"` and enable `treeShaking`. The Bun bundler has a 5–10× ratio on TS-heavy code.
**Expected gain:** 30–50% drop in `dist/node_modules` size that Electrobun ships, ~150–400 ms faster cold module parse in the bun shell process on Windows (CEF loads renderer separately).
**Risk:** Source maps must remain for crash-report symbolication; emit them as `external`. Verify the `__bundle_safety_*` arrays the codebase relies on for tree-shake protection still survive (e.g. `plugin-aosp-local-inference/src/index.ts:38`).

---

## 3. llama.cpp Windows CPU build disables OpenMP — `packages/app-core/scripts/build-llama-cpp-dflash.mjs:1479, 1492`
**Current:** `"windows-x64-cpu"` and `"windows-arm64-cpu"` push `-DGGML_OPENMP=OFF`. Comment says "OpenMP isn't usable from the mingw cross-toolchain without an extra runtime." On this AMD EPYC host (Zen4, AVX-512 capable on bare-metal; QEMU exposes AVX2/FMA/F16C reliably), ggml falls back to its `std::thread` pool which is meaningfully slower for prompt-prefill on >8 threads.
**Proposed:** When *building on Windows host with MSVC* (the common case for desktop release), enable `-DGGML_OPENMP=ON` — MSVC ships OpenMP. Only keep `OFF` for cross-builds from Linux mingw. Gate on `process.platform === "win32" && !process.env.MINGW_TOOLCHAIN_FILE`.
**Expected gain:** 15–35% prompt-prefill throughput, 5–15% decode throughput on 8+ thread CPU inference on this 12-core box.
**Risk:** Low if you also bundle `vcomp140.dll` (auto-included with MSVC redist). The mingw-cross path stays unchanged.

---

## 4. AVX-512 / AVX-VNNI not enabled on Windows x64 — `build-llama-cpp-dflash.mjs:1472–1476`
**Current:** Windows x64 CPU build sets only `-DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON`. Linux x64 (line 1415) adds `-DGGML_AVX_VNNI=ON`. Zen4 EPYC supports **AVX-512, VNNI, BF16** — none enabled for Windows.
**Proposed:** Add a Windows-host detection (probe via `wmic cpu get Caption,Description` or, better, gate on `__AVX512F__` at compile time with a fork-build flag) and push `-DGGML_AVX512=ON -DGGML_AVX512_VBMI=ON -DGGML_AVX512_VNNI=ON -DGGML_AVX_VNNI=ON`. Provide an `ELIZA_DFLASH_TARGET_BASELINE=zen4|skylake_x|haswell` env to pick the safe baseline for distribution.
**Expected gain:** 20–40% faster decode for Q4_K_M / Q5_K_M / Q8_0 on Zen4 / Sapphire Rapids / Granite Rapids / recent Intel. The QJL `qjl_score_qk_i8_avxvnni` path becomes available.
**Risk:** Distribution baseline. Ship two binaries (`-avx2` + `-avx512`) and pick at startup.

---

## 5. `BACKEND_DL=OFF` on Windows blocks Vulkan auto-fallback — `build-llama-cpp-dflash.mjs:1500`
**Current:** All Windows targets force `-DGGML_BACKEND_DL=OFF` (statically links a single backend). The build matrix then has to produce `windows-x64-cpu`, `windows-x64-cuda`, `windows-x64-vulkan` as *separate* binaries, and the launcher must pick one.
**Proposed:** Keep `BACKEND_DL=OFF` for the CPU-only ship variant (avoids the missing-export bug the comment documents), but for the GPU variants build with `=ON` so a single `llama-server.exe` can dlopen `ggml-vulkan.dll` and gracefully fall back to `ggml-cpu.dll` when no GPU is present. Vendor both DLLs.
**Expected gain:** Mostly bundle simplification and faster onboarding. On systems with both an iGPU and dGPU, Vulkan dlopen makes runtime device selection viable.
**Risk:** Mediated by the `ggml_backend_cpu_init` naming bug already documented — fix or work around upstream before flipping.

---

## 6. KV cache stays at fp16 by default for Windows CPU tiers
**Current:** `applyCatalogDefaults` (`active-model.ts:343–347`) only sets `cacheTypeK/V` if catalog declares it. The Vast/GPU profile uses `--cache-type-k q4_0 --cache-type-v q4_0`, but there's no Windows-CPU profile pushing the same. The fork ships extended types: `qjl1_256, tbq3_0, tbq4_0, q4_polar, q8_0`.
**Proposed:** Add a Windows-CPU device-tier policy in `device-tier.ts` / catalog defaults pushing `cacheTypeK="q8_0", cacheTypeV="q8_0"` for `OKAY`/`GOOD` tiers (no flash-attn requirement on CPU), and `qjl1_256/tbq3_0` for `MAX` with CPU-only when long-context. Also set `flashAttention=false` for CPU-only paths.
**Expected gain:** ~2× longer max context for the same RAM (16k → 32k at 7B fits ~2 GiB→1 GiB KV), small (~5–8%) speedup from memory-bandwidth savings on Zen4 (memory-bound on inference).
**Risk:** Quality regression at extreme contexts; ship a quick perplexity gate.

---

## 7. Vite renderer chunking — main bundle is 5 MB pre-gzip — `packages/app/vite.config.ts:589–617, 1264`
**Current:** `chunkSizeWarningLimit: 5500` (intentionally hides the warning). `assets/main-BZ9nzVAj.js` is **5.0 MiB** on disk; `vendor-three` 1.5 MiB; `vendor-react` 380 KiB. The `manualChunks` only carves out three/react/vrm.
**Proposed:** Add route-level dynamic imports and chunk-by-feature:
- Split xterm (336 KiB) into its own chunk
- Move `pglite-CBEH8-yn.wasm` (8.4 MiB) and `pglite-C1kGHlHe.data` (5.1 MiB) behind a deferred `import('@elizaos/plugin-sql/browser')` boundary — they're loaded eagerly today but local SQL is not on the cold path for most users.
- Add `build.rollupOptions.output.experimentalMinChunkSize: 20000` to coalesce tiny chunks.
**Expected gain:** ~30% TTI improvement on cold electrobun launch. Renderer initial parse drops from ~5 MB JS to ~1.8 MB JS for the splash path.
**Risk:** Suspense boundaries; verify the PGlite init path tolerates async load.

---

## 8. CEF bundle on Windows (~150 MB) instead of native WebView2 — `electrobun.config.ts:445–457`
**Current:** `win: { bundleCEF: true, bundleWGPU: true, defaultRenderer: "cef" }`. Plus `no-sandbox: true`, `in-process-gpu: true`, `disable-gpu-sandbox: true` — security relaxations made because CEF on Windows historically wasn't friendly to sandboxing.
**Proposed:** Add an alt build variant `win: { defaultRenderer: "webview2" }` (Edge WebView2 is preinstalled on Win10 19H2+ and Win11). Keep CEF as the WebGPU/native-renderer power-user option. WebView2 cuts ~120 MB from the installer and shaves ~600 ms off cold start.
**Expected gain:** Installer 200 MB → ~80 MB; cold launch 1.8 s → ~1.1 s. WebGPU is unavailable in WebView2 (Chromium-stable channel), so only switch users who don't need the VRM/three-WebGPU rendering path.
**Risk:** Feature delta — VRM avatars rely on WebGPU in the renderer. Gate on `appConfig.web.requiresWebGPU`.

---

## 9. Renderer ships duplicate splash image (3.3 MB JPG + 2.9 MB PNG) — `packages/app/dist/splash-bg.{jpg,png}`
**Current:** Both files emitted (`3,424,190` + `3,021,226` bytes).
**Proposed:** Keep only the WebP/AVIF; if compat is needed, JPG-only at quality 78. Convert via `sharp` in `packages/app/scripts/build.mjs`. Same treatment for `og-image.png` (44 KB) and the 21 MB `vrms/` (probably model files but they are static assets shipped every install).
**Expected gain:** ~5 MB off every install; renderer first-paint ~150 ms faster.
**Risk:** None for the splash; for VRMs verify the bundle ships an offline fallback model.

---

## 10. No speculative decoding draft model wired for Windows desktop
**Current:** DFlash speculative decoding is the headline feature of the fork and Vast cloud deployment uses `--n-gpu-layers-draft auto` + draft KV cache (`cloud/services/vast-pyworker/onstart.sh:283`). The desktop active-model path in `services/active-model.ts` does not appear to set draft model overrides for CPU tiers.
**Proposed:** Pair the primary local model (e.g. eliza-1-8B-Q4_K_M) with a 0.5B–1B draft at Q4_K_S or IQ3_XXS on Windows CPU GOOD tier. Wire `--draft-min-prob 0.4` and `--n-draft 4` through the engine.
**Expected gain:** 1.5–2.2× decode speedup on CPU (DFlash claims 2.4× on Q4_K_M @ Zen4).
**Risk:** +2–3 GB RAM. Gate on tier=`GOOD`+ in `device-tier.ts`.

---

## 11. `vite optimizeDeps` includes oversized libs — `vite.config.ts:1143–1255`
**Current:** Three.js plus 5 example modules are eagerly pre-bundled. `zod` excluded due to invalidation bug. `@elizaos/plugin-local-inference` excluded — good.
**Proposed:** Move `three/examples/jsm/loaders/FBXLoader.js` and `DRACOLoader.js` out of `include` — they only fire on VRM asset load. Reduces dev cold-start dep-optimize by ~15%.
**Expected gain:** 1–3 s faster `vite dev` cold start; modest prod gains.
**Risk:** First VRM load incurs an extra chunk fetch (acceptable).

---

## 12. tsdown / tsup not configured for `drop: ['console']` in prod
**Current:** No tsdown.config or tsup.config found at the package level (build is driven by inline `build.ts` per package or `bun --bun tsdown`). Production debug-logging stays in shipped JS.
**Proposed:** In `build.ts` accept `dropDebug = process.env.NODE_ENV === "production"` and pass to bun's `drop: ["console.debug", "console.trace"]` (or `define: { 'process.env.LOG_LEVEL': '"warn"' }` to dead-code-eliminate logger blocks).
**Expected gain:** 5–10% bundle size; small CPU win in steady state from skipped string formatting.
**Risk:** Loss of in-field debug logs; keep `console.error`.

---

## 13. Model selection — recommend IQ4_XS over Q4_K_M for 32 GB CPU-only Windows
**Current:** Catalog defaults visible per `device-tier.ts:43–73` choose by RAM but don't bias quant. Q4_K_M is the typical default.
**Proposed:** For `GOOD` tier CPU-only (`x86CpuOnlyMinTotalGb: 32` — this VM) bias to `IQ4_XS` or `Q4_K_S`: ~12% smaller, ~5–10% faster decode on AVX2/AVX-512 hosts, quality delta < 1% on llmleaderboard. For `OKAY` use `IQ3_XXS`.
**Expected gain:** Faster cold load (smaller mmap), more headroom for context.
**Risk:** Quality; ship a perplexity smoke in `local-inference-ablation.mjs`.

---

## 14. `--ignore-scripts` install pattern blocks postinstall — `scripts/build-win.mjs:74`
**Current:** `bun install --ignore-scripts` is run inside `appDir` during the build. Combined with the huge root `postinstall` chain in `package.json:21` (`fix-windows-bun-stub.mjs && patch-nested-core-dist.mjs && ...`), this can leave native bindings stale on Windows.
**Proposed:** Restrict `--ignore-scripts` only to install steps that don't need binaries; explicitly invoke `node scripts/fix-windows-bun-stub.mjs` afterwards. Document the contract.
**Risk:** Already a documented Windows-specific stub fix.

---

## Items investigated and dismissed
- **Capacitor on Windows:** `packages/app/capacitor.config.ts` is mobile-only (iOS/Android); the desktop path is Electrobun. No Windows-relevant tuning there.
- **Electrobun preload size:** Already minified (`build-electrobun-preload.mjs:103: --minify`), IIFE, browser-target. Fine.
- **Vulkan/CUDA on this VM:** Not applicable — no GPU. Recommendations 4–6 still relevant for distributable builds.
- **mmap on Windows:** Default `true` in adapter (`aosp-llama-adapter.ts:938`). Correct; do not change.
- **Flash-attention on CPU:** Default `undefined` (catalog-driven). Correct — `docs/ELIZA_1_DEVICE_PERF_READINESS_2026-05-12.md:102` already warns against blanket-on.

## Top 3 quickest wins to ship
1. **Drop `--concurrency=1` in package.json:78,89,91** — one-line, immediate 3–6× dev loop.
2. **Default `minify: true` in `packages/core/build.ts:73`** — five-line change, 30%+ dist shrink.
3. **Enable `-DGGML_OPENMP=ON` for Windows MSVC host builds** (`build-llama-cpp-dflash.mjs:1479`) — guarded by `process.platform === "win32"`, ~20% inference speedup on this 12-thread VM.
