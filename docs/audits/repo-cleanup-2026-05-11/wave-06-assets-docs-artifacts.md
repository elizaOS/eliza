# Wave 6 - Assets, Docs, and Artifacts Dry-Run Manifest

Date: 2026-05-11
Worker: Wave 6
Scope: tracked assets, binaries, data/training files, model-like files, images, generated docs, and archive/docs markdown policy.
Mode: dry run only. No source, config, test, asset, or generated artifact files were modified.

## Constraints

- Only this report is created in this wave.
- All cleanup actions below are recommendations only.
- Every delete, move, rename, chmod, Git LFS migration, or generated-doc policy change needs owner approval and a separate implementation PR.
- Sizes are from tracked files in the current worktree using `git ls-files` plus `stat`; symlink sizes are link sizes where relevant.
- The workspace was already dirty before this report. Do not treat unrelated modified files as Wave 6 changes.

## Repository Snapshot

| Metric | Value |
| --- | ---: |
| Tracked files | 19,096 |
| Tracked worktree payload | 540.77 MiB |
| Images (`png`, `jpg`, `jpeg`, `webp`, `gif`, `svg`, `ico`, `icns`, `avif`) | 482 files, 218.64 MiB |
| 3D/model-like assets (`vrm`, `glb`, `fbx`) | 83 files, 64.38 MiB |
| Fonts (`otf`, `ttf`, `woff`, `woff2`) | 7 files, 41.03 MiB |
| Binary/runtime artifacts sampled (`dylib`, `wasm`, `jar`, `o`, `spv`, native helpers/benches) | 34 files, 21.50 MiB |
| Data/training tabular files (`jsonl`, `csv`, `tsv`) | 131 files, 8.96 MiB |
| PDF/HTML docs and fixtures | 72 files, 5.08 MiB |
| Markdown/MDX docs | 2,412 files, 13.12 MiB |

Relevant pre-existing worktree status:

- `packages/benchmarks/benchmark_results/latest/*.json` and `packages/benchmarks/benchmark_results/latest/index.json` are modified.
- `packages/prompts/specs/actions/plugins.generated.json` and `packages/core/src/generated/action-docs.ts` are modified generated surfaces.
- Several docs are modified, including `docs/application-updates.md`, `docs/desktop/build-variants.md`, `docs/audits/response-handler-and-evaluator-systems-2026-05-11.html`, `packages/docs/rest/update.md`, and `packages/docs/self-updates.mdx`.
- `packages/inference/llama.cpp` is a modified submodule in the parent status.
- `packages/training/vendor/llama.cpp` is a tracked submodule entry but is not initialized in this worktree.
- `docs/audits/repo-cleanup-2026-05-11/` was already untracked before this report.

## Executive Recommendations

1. Do not bulk-delete public assets. `cloud/apps/frontend/public`, `packages/app/public`, `plugins/app-companion/public`, and mobile icon/splash assets contain served files with runtime references.
2. Prioritize dedupe and storage policy over deletion. The largest savings are from exact duplicates, executable bit cleanup, moving source-only asset originals out of the release path, and moving raw generated reports to artifact storage.
3. Treat `plugins/app-companion` as the highest-value asset review. It tracks both source VRM/FBX/GLB assets and compressed public assets, totaling about 91 MiB across the main source/public groups.
4. Resolve the SF Pro font policy. Seven OTF files total 41.03 MiB, are tracked executable, and only four weights are referenced in CSS.
5. Replace vendored tool binaries with pinned download/build steps where practical. The `shellcheck` binary alone is 14.93 MiB.
6. Separate reproducibility data from live source. Training datasets and benchmark fixtures should stay tracked only when they are small, reviewed, privacy-cleared, and actively used by tests or reproducibility docs.
7. Establish a generated-doc retention policy before pruning `docs/audits` and `reports/porting`. Several docs link to raw reports by path, so raw report deletion must first update summaries and references.

## Candidate Directory Manifest

| Candidate | Tracked size/status | Recommendation | Risk |
| --- | ---: | --- | --- |
| `cloud/apps/frontend/public` | 137.69 MiB, 137 files, tracked | Retain served assets for now. Optimize/compress large images and review CDN/external hosting for sample galleries. | High |
| `cloud/apps/frontend/public/fonts/sf-pro` | 41.03 MiB, 7 OTF files, tracked executable | Owner decision: license approval, keep only referenced weights, normalize mode to non-executable, consider webfont/subsetting. | Medium |
| `cloud/apps/frontend/public/avatars` | 35.07 MiB, 14 files, tracked | Retain if profile/landing assets are live. Optimize oversized PNGs or convert to WebP/AVIF after visual QA. | Medium |
| `cloud/apps/frontend/public/images/blog` | 23.64 MiB, 3 files, tracked | Retain if blog pages still publish these images. Optimize `intro_blog_1.png` and `intro_blog_2.png`. | Medium |
| `cloud/apps/frontend/public/cloud-agent-samples` | 19.95 MiB, 46 WebP files, tracked | Owner decision: keep only curated samples in Git, move bulk samples to CDN/object storage. | Medium |
| `cloud/apps/frontend/public/cloud-avatars` | 8.85 MiB, 35 files, tracked | Retain if selectable avatars. Consider sprite/gallery manifest and image optimization. | Low |
| `cloud/apps/frontend/public/agents` | 5.82 MiB, 3 PNG files, tracked | Retain; referenced by landing components. Optimize only. | Low |
| `packages/app-core/platforms/ios/App/App/Assets.xcassets/Splash.imageset` | 38.67 MiB, 4 files, tracked | Three identical 12.89 MiB PNGs. Dedupe only if Xcode asset catalog still validates on iOS after changing `Contents.json` or asset slots. | Medium |
| `packages/app-core/platforms/electrobun/assets/appIcon.iconset` | 1.65 MiB, 10 files, tracked | Retain; expected app icon set. Verify no duplicate template copy can be generated. | Low |
| `packages/app/public` | 14.16 MiB, 39 files, tracked | Retain served desktop/mobile web assets. Optimize `splash-bg.*` and app hero images after visual QA. | Medium |
| `packages/app/public/app-heroes` | 7.57 MiB, 8 PNG files, tracked | Retain if app pages depend on these. Consider WebP/AVIF and screenshot regeneration script. | Low |
| `packages/homepage/public` | 5.29 MiB, 10 files, tracked | Retain. Review `models/iphone.glb` for model compression. | Low |
| `packages/homepage/public/models` | 2.95 MiB, 1 GLB file, tracked | Retain if homepage 3D scene uses it. Consider Draco/Meshopt compression. | Medium |
| `packages/docs/images` | 11.44 MiB, 42 files, tracked | Retain referenced docs images. Delete only orphaned screenshots after docs link audit. | Medium |
| `packages/examples/avatar/public` | 2.10 MiB, 2 files, tracked | Retain if avatar example is maintained. Consider moving heavyweight example assets to downloaded fixtures. | Low |
| `plugins/app-companion/public_src/vrms` | 25.96 MiB, 8 VRM files, tracked | Candidate move to source asset storage or Git LFS if only used to generate public compressed assets. Keep until build pipeline ownership is clear. | High |
| `plugins/app-companion/public/vrms` | 20.86 MiB, 40 files, tracked | Retain public compressed VRMs, previews, and backgrounds if app-companion ships them. Review source/public duplication policy. | High |
| `plugins/app-companion/public_src/animations` | 32.82 MiB, 71 FBX/GLB files, tracked | Candidate move to asset-source storage if compressed public assets are canonical. Do not delete without regenerating and runtime testing. | High |
| `plugins/app-companion/public/animations` | 11.53 MiB, 76 gzipped public animation files, tracked | Retain if runtime fetches `/animations/...`. Consider ensuring all catalog paths point to compressed served files. | High |
| `plugins/app-companion/public/vrm-decoders` | 2.29 MiB, 3 files, tracked | Retain if runtime GLTF/VRM decoder depends on local Draco decoder. | Medium |
| `plugins/app-training/datasets` | 6.83 MiB, 12 files, tracked | Owner decision: mark one canonical dataset lineage, archive superseded variants externally, keep metadata/provenance in Git. | High |
| `packages/benchmarks` | 53.80 MiB, 3,061 files, tracked | Keep small benchmark fixtures; move vendored tool binaries and large visual fixtures to download/cache where possible. | Medium |
| `packages/benchmarks/openclaw-benchmark/autonomous_agent_env/shellcheck-v0.10.0` | 14.97 MiB, 3 files, tracked | Replace tracked `shellcheck` binary with pinned install/download step if CI allows. | Medium |
| `packages/benchmarks/OSWorld/assets` | 7.43 MiB, 33 files, tracked | Retain if benchmark fixtures are required. Move to fixture artifact package if tests do not need them on every checkout. | Medium |
| `packages/benchmarks/OSWorld/mm_agents` | 6.50 MiB, 461 files, tracked | Likely benchmark source/assets. Review with benchmark owner before any pruning. | Medium |
| `packages/benchmarks/loca-bench` | 7.79 MiB, 530 files, tracked | Retain benchmark fixtures. The 1.00 MiB live sensor CSV is the largest data fixture. | Low |
| `packages/inference/verify` | 7.99 MiB, 103 files, tracked | Move generated/native verify binaries and `.o` outputs to build artifacts if reproducible. Keep source, fixtures, and scripts. | High |
| `packages/inference/verify/android-vulkan-smoke` | 5.51 MiB, 15 files, tracked | `vulkan_verify` is the large artifact. Owner decision: source-only rebuild vs checked-in smoke binary. | High |
| `packages/inference/verify/fixtures` | 1.32 MiB, 9 files, tracked | Retain fixtures if tests consume them. | Medium |
| `packages/training/scripts/harness/scenario_pool` | 0.87 MiB, 96 JSONL files, tracked | Retain. Small, source-like training/eval fixtures. | Low |
| `reports/porting` | 8.73 MiB, 101 files, tracked | Convert raw logs/symbol dumps to artifact storage after preserving indexed summaries. Many docs reference these paths. | Medium |
| `reports/porting/2026-05-09-baseline` | 6.32 MiB, 12 files, tracked | Candidate archive. Keep `INDEX.md` and stable summary; move `aosp-symbols-pre.txt`, `knip.txt`, `madge-graph.json`, `profile.json` externally if references are updated. | Medium |
| `reports/porting/2026-05-09-unified` | 0.79 MiB, 5 files, tracked | Retain until docs/porting references are rewritten or an index snapshot is kept. | Medium |
| `reports/porting/2026-05-09-w4` | 1.19 MiB, 35 files, tracked | Keep summary markdown; move raw symbol/SPIR-V/size outputs externally after owner approval. | Medium |
| `docs/audits` | 2.58 MiB, 1,031 files, tracked | Keep final audit reports. Apply generated-doc retention policy to prompt extraction outputs. | Low |
| `docs/audits/lifeops-2026-05-11/prompts` | 1.22 MiB, 989 generated prompt markdown files, tracked | Candidate archive or regenerate-on-demand. Keep manifest/index if this remains a review input. | Medium |

## Exact High-Impact File Candidates

| File | Size/status | Recommendation | Risk |
| --- | ---: | --- | --- |
| `cloud/apps/frontend/public/avatars/eliza-default.png` | 15.76 MiB, tracked | Optimize/convert after visual QA. Do not delete without UI reference audit. | Medium |
| `packages/benchmarks/openclaw-benchmark/autonomous_agent_env/shellcheck-v0.10.0/shellcheck` | 14.93 MiB, tracked executable | Replace with pinned download or package-manager install. | Medium |
| `packages/app-core/platforms/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png` | 12.89 MiB, tracked | Exact duplicate of the two numbered splash files. Dedupe only after Xcode validation. | Medium |
| `packages/app-core/platforms/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-1.png` | 12.89 MiB, tracked | Exact duplicate. | Medium |
| `packages/app-core/platforms/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-2.png` | 12.89 MiB, tracked | Exact duplicate. | Medium |
| `cloud/apps/frontend/public/images/blog/intro_blog_2.png` | 11.83 MiB, tracked | Optimize if blog output remains current. Referenced in `llms-full.txt`. | Low |
| `cloud/apps/frontend/public/images/blog/intro_blog_1.png` | 10.40 MiB, tracked | Optimize if blog output remains current. Referenced in `llms-full.txt`. | Low |
| `cloud/apps/frontend/public/fonts/sf-pro/SF-Pro-Display-*.otf` | 41.03 MiB total, 7 tracked executable files | Normalize mode; review license and unused weights. | Medium |
| `packages/inference/verify/android-vulkan-smoke/vulkan_verify` | 5.40 MiB, tracked executable | Prefer build/cache artifact if reproducible. | High |
| `plugins/app-companion/public_src/vrms/milady-7.vrm` | 4.03 MiB, tracked | Source asset. Move to LFS/external only if public gz is canonical and regeneration is documented. | High |
| `plugins/app-companion/public_src/vrms/milady-5.vrm` | 3.86 MiB, tracked | Same as above. | High |
| `reports/porting/2026-05-09-baseline/aosp-symbols-pre.txt` | 3.85 MiB, tracked generated dump | Archive raw dump externally after preserving summary and references. | Medium |
| `cloud/apps/frontend/public/agents/agent-2.png` | 3.41 MiB, tracked | Referenced by landing component. Optimize only. | Low |
| `packages/app/public/splash-bg.jpg` | 3.27 MiB, tracked | Optimize after visual QA. | Low |
| `packages/app/public/app-heroes/skills-viewer.png` | 3.02 MiB, tracked | Optimize or regenerate lower-size screenshot. | Low |
| `packages/homepage/public/models/iphone.glb` | 2.95 MiB, tracked | Retain if homepage uses it; compress if possible. | Medium |
| `plugins/app-companion/public/vrms/milady-7.vrm.gz` | 3.00 MiB, tracked public asset | Retain unless companion default model set changes. | High |
| `plugins/app-companion/public/vrm-decoders/draco/draco_decoder.js` | 2.02 MiB, tracked public decoder | Retain if local Draco decoding is required. | Medium |
| `packages/examples/avatar/public/bot.vrm` | 2.01 MiB, tracked example asset | Keep if example remains self-contained; otherwise download-on-demand. | Low |
| `plugins/app-training/datasets/lifeops_full_mixed_action_planner.jsonl` | 1.74 MiB, tracked dataset | Keep only if canonical. Otherwise archive with provenance. | High |
| `plugins/app-training/datasets/lifeops_corrected_action_planner.jsonl` | 1.72 MiB, tracked dataset | Same as above. | High |
| `plugins/app-training/datasets/lifeops_mixed_action_planner.jsonl` | 1.45 MiB, tracked dataset | Same as above. | High |
| `packages/benchmarks/loca-bench/gem/envs/machine_operating_s2l/preprocess/machine_operating/live_sensor.csv` | 1.00 MiB, tracked fixture | Retain unless benchmark owner approves external fixture download. | Low |

## Duplicate and Mode Findings

### Exact Duplicate Splash Images

All three iOS splash PNGs have SHA1 `22b67738009bd0ff75203224a33006486a7322a9`:

- `packages/app-core/platforms/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png`
- `packages/app-core/platforms/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-1.png`
- `packages/app-core/platforms/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-2.png`

Recommendation: ask the mobile owner whether `Contents.json` needs three physical files or can point multiple slots at one file. Validate with `bun --cwd packages/app run cap:sync:ios` and an Xcode asset catalog build before deleting any duplicate.

### Duplicate Plugin Hero Images

Exact duplicate SHA1 groups:

- `40928507993596345c090224f257cbeae872e20c`: `plugins/app-training/assets/hero.png`, `plugins/app-trajectory-logger/assets/hero.png`
- `849e6704cf1f51ab8898fe0777b3dcac650d02cc`: `plugins/app-steward/assets/hero.png`, `plugins/app-wallet/assets/hero.png`
- `8d6cebac9b9ad1e2e3d12b486b6cb79a6b4a589a`: `plugins/app-contacts/assets/hero.png`, `plugins/app-phone/assets/hero.png`, `plugins/app-vincent/assets/hero.png`, `plugins/app-wifi/assets/hero.png`

Recommendation: do not remove local plugin hero assets unless plugin packaging supports shared assets. If plugins publish independently, local duplication may be intentional.

### Companion Animation Duplicates

Exact duplicate SHA1 groups:

- `974992e29f19ac022abb0459ff5eb997fce9ea25`: `plugins/app-companion/public_src/animations/mixamo/Breathing Idle.fbx`, `plugins/app-companion/public_src/animations/BreathingIdle.fbx`
- `6a7db93d80a24e58815ad4032af3e368bbcc9b54`: `plugins/app-companion/public_src/animations/emotes/idle.glb`, `plugins/app-companion/public_src/animations/idle.glb`, `packages/examples/avatar/public/animations/idle.glb`

Recommendation: dedupe only after checking all path literals in `plugins/app-companion/src/emotes/catalog.ts`, example packaging, and any build copy step.

### Executable Bit Anomalies

All seven `cloud/apps/frontend/public/fonts/sf-pro/*.otf` files are tracked with executable mode (`-rwxr-xr-x`). They are static font assets and should probably be non-executable, pending owner approval.

Files:

- `cloud/apps/frontend/public/fonts/sf-pro/SF-Pro-Display-Bold.otf`
- `cloud/apps/frontend/public/fonts/sf-pro/SF-Pro-Display-Light.otf`
- `cloud/apps/frontend/public/fonts/sf-pro/SF-Pro-Display-Medium.otf`
- `cloud/apps/frontend/public/fonts/sf-pro/SF-Pro-Display-Regular.otf`
- `cloud/apps/frontend/public/fonts/sf-pro/SF-Pro-Display-Semibold.otf`
- `cloud/apps/frontend/public/fonts/sf-pro/SF-Pro-Display-Thin.otf`
- `cloud/apps/frontend/public/fonts/sf-pro/SF-Pro-Display-Ultralight.otf`

Only Regular, Medium, Semibold, and Bold were found in `cloud/apps/frontend/src/globals.css`; Light, Thin, and Ultralight need owner confirmation.

## Images and Public Asset Policy

### Retain, Optimize Only

These are referenced or likely served and should not be deleted in a cleanup pass:

- `cloud/apps/frontend/public/agents/agent-1.png`
- `cloud/apps/frontend/public/agents/agent-2.png`
- `cloud/apps/frontend/public/agents/agent-3.png`
- `cloud/apps/frontend/public/images/blog/intro_blog_1.png`
- `cloud/apps/frontend/public/images/blog/intro_blog_2.png`
- `packages/app/public/splash-bg.jpg`
- `packages/app/public/splash-bg.png`
- `packages/app/public/app-heroes/*.png`
- `packages/app-core/platforms/electrobun/assets/appIcon.iconset/*`
- `packages/elizaos/templates/project/apps/app/electrobun/assets/appIcon.iconset/*`
- `packages/docs/images/*` when referenced by docs

Recommended future implementation:

1. Build an image reference inventory with `rg -n "/path-or-filename"` plus route/static analysis.
2. Run lossless compression first.
3. Convert large PNG/JPEG display assets to WebP/AVIF only when all consumers support it.
4. Keep original source images outside runtime `public` directories if they are needed for regeneration.
5. Add a generated asset manifest if screenshots are produced by scripts.

### Candidate Move to CDN/Object Storage

- `cloud/apps/frontend/public/cloud-agent-samples/*.webp`: 46 files, 19.95 MiB.
- Potentially `cloud/apps/frontend/public/cloud-avatars/*.webp`: 35 files, 8.85 MiB.

Recommendation: if these are gallery/sample content rather than required app shell assets, move bulk images to CDN/object storage and keep a small checked-in fallback set plus a manifest.

## Companion App Asset Policy

`plugins/app-companion` has both source and public runtime assets:

- Source VRMs: `plugins/app-companion/public_src/vrms/*.vrm`, 25.96 MiB.
- Public compressed VRMs/previews/backgrounds: `plugins/app-companion/public/vrms`, 20.86 MiB.
- Source animations: `plugins/app-companion/public_src/animations`, 32.82 MiB.
- Public compressed animations: `plugins/app-companion/public/animations`, 11.53 MiB.
- Runtime references exist in `plugins/app-companion/src/emotes/catalog.ts`, `plugins/app-companion/src/vrm-assets.ts`, and `plugins/app-companion/src/components/avatar/VrmEngine.ts`.

Recommendation:

- Keep public compressed runtime assets until app-companion build and runtime tests prove an alternative.
- Decide whether `public_src` is source-of-truth. If yes, move it to Git LFS or an asset repository and make the compression pipeline deterministic. If no, delete it only after proving public compressed assets are sufficient for rebuild/release.
- Add a manifest mapping source assets to generated compressed assets, including hashes.

Owner questions:

- Are `public_src` assets needed by contributors for regeneration, or are they stale checked-in originals?
- Does plugin packaging include `public` only, `public_src` only, or both?
- Are the Mixamo/VRM licenses compatible with GitHub source distribution?

## Binaries, Generated Native Outputs, and Archives

Tracked binary/runtime candidates:

| File | Size/status | Recommendation | Risk |
| --- | ---: | --- | --- |
| `packages/benchmarks/openclaw-benchmark/autonomous_agent_env/shellcheck-v0.10.0/shellcheck` | 14.93 MiB, executable | Replace with pinned install/download. | Medium |
| `packages/inference/verify/android-vulkan-smoke/vulkan_verify` | 5.40 MiB, executable | Move to build artifact/cache if reproducible. | High |
| `packages/app-core/platforms/electrobun/src/libMacWindowEffects.dylib` | 213.85 KiB, executable | Keep if distributed with Electrobun app; otherwise build from source. | High |
| `plugins/app-companion/public/vrm-decoders/draco/draco_decoder.wasm` | 187.91 KiB, tracked | Keep if public decoder is required. | Medium |
| `packages/native-plugins/macosalarm/bin/macosalarm-helper` | 111.06 KiB, executable | Keep only if helper cannot be built during install. | High |
| `packages/native-plugins/activity-tracker/native/macos/activity-collector` | 94.88 KiB, executable | Keep only if helper cannot be built during install. | High |
| `packages/inference/verify/metal_bench` | 106.60 KiB, executable | Generated binary candidate; move to ignored build output. | Medium |
| `packages/inference/verify/dispatch_smoke` | 70.55 KiB, executable | Generated binary candidate. | Medium |
| `packages/inference/verify/vulkan_bench` | 64.91 KiB, executable | Generated binary candidate. | Medium |
| `packages/inference/verify/vulkan_dispatch_smoke` | 57.72 KiB, executable | Generated binary candidate. | Medium |
| `packages/inference/verify/cpu_bench` | 43.52 KiB, executable | Generated binary candidate. | Medium |
| `packages/app-core/platforms/android/gradle/wrapper/gradle-wrapper.jar` | 42.74 KiB, tracked | Retain; standard Gradle wrapper artifact. | Low |
| `packages/inference/verify/android-vulkan-smoke/*.o` | 39.56 KiB total | Generated object files; prefer rebuild. | Medium |
| `packages/inference/verify/**/spv/*.spv` and `reports/porting/2026-05-09-w4/vulkan/*.spv` | small files, tracked | Keep only as test fixtures or archived evidence; otherwise regenerate. | Medium |

Compressed archives are almost entirely runtime companion assets (`plugins/app-companion/public/**/*.gz`, 83 files, 30.79 MiB). Do not treat those as disposable archives; many are served runtime files.

## Data and Training Files

### LifeOps Training Datasets

Exact candidates under `plugins/app-training/datasets`:

| File | Size/status | Recommendation | Risk |
| --- | ---: | --- | --- |
| `plugins/app-training/datasets/lifeops_full_mixed_action_planner.jsonl` | 1.74 MiB, tracked | Keep only if canonical full dataset. | High |
| `plugins/app-training/datasets/lifeops_corrected_action_planner.jsonl` | 1.72 MiB, tracked | Keep if current corrected dataset. | High |
| `plugins/app-training/datasets/lifeops_mixed_action_planner.jsonl` | 1.45 MiB, tracked | Candidate archive if superseded. | High |
| `plugins/app-training/datasets/lifeops_action_planner_from_benchmark.jsonl` | 688.19 KiB, tracked | Keep if reproducibility source. | Medium |
| `plugins/app-training/datasets/lifeops_mixed_action_planner_small.jsonl` | 367.66 KiB, tracked | Keep as smoke dataset if used by tests. | Low |
| `plugins/app-training/datasets/lifeops_balanced16_action_planner.jsonl` | 363.30 KiB, tracked | Candidate archive unless actively used. | Medium |
| `plugins/app-training/datasets/lifeops_balanced_action_planner.jsonl` | 213.54 KiB, tracked | Candidate archive unless actively used. | Medium |
| `plugins/app-training/datasets/lifeops_corrected_balanced10.jsonl` | 212.18 KiB, tracked | Candidate archive unless actively used. | Medium |
| `plugins/app-training/datasets/lifeops_anthropic_action_planner.jsonl` | 122.60 KiB, tracked | Keep only with provenance/license note. | High |
| `plugins/app-training/datasets/action_planner_baseline.txt` | 2.29 KiB, tracked | Retain with dataset docs. | Low |
| `plugins/app-training/datasets/*.meta.json` | less than 1 KiB total, tracked | Retain and expand provenance metadata. | Low |

Policy recommendation:

- Pick canonical datasets by purpose: smoke, benchmark-derived, corrected full, and external/Anthropic-derived if licensed.
- Add dataset cards with source, generation command, intended use, PII review, and current owner.
- Move superseded full variants to release artifacts or an internal dataset store, not silent deletion.

### Benchmark Data and Results

Candidates:

- `packages/benchmarks/benchmark_results/latest`: 151 JSON files, 400.1 KiB, currently modified in the worktree.
- `packages/benchmarks/loca-bench/gem/envs/machine_operating_s2l/preprocess/machine_operating/live_sensor.csv`: 1.00 MiB.
- `packages/benchmarks/OSWorld/assets`: 7.43 MiB.
- `packages/benchmarks/HyperliquidBench/assets`: 0.94 MiB.
- `packages/benchmarks/compactbench/results-*.jsonl`: generated result-looking files around 24 KiB each.

Recommendation:

- Keep small fixtures that tests need.
- Stop committing `latest` result churn unless it is a documented dashboard input. Current `index.json` contains absolute local paths, which is a portability smell.
- Store large benchmark outputs under CI artifacts, object storage, or a versioned benchmark-results package.

## Models and Weights

No tracked ML weight files were found with common weight extensions (`.safetensors`, `.gguf`, `.onnx`, `.ckpt`, `.pth`, `.pt`). Model-like tracked assets are primarily 3D assets:

- `plugins/app-companion/public_src/vrms/*.vrm`
- `plugins/app-companion/public/vrms/*.vrm.gz`
- `packages/examples/avatar/public/bot.vrm`
- `packages/homepage/public/models/iphone.glb`
- `plugins/app-companion/public_src/animations/**/*.fbx`
- `plugins/app-companion/public_src/animations/**/*.glb`

Submodule status:

- `packages/inference/llama.cpp`: initialized and modified in the parent worktree status.
- `packages/training/vendor/llama.cpp`: tracked submodule entry but not initialized.

Recommendation: do not change submodule pointers or vendored model/tooling layout in Wave 6 cleanup. Assign to inference/training owners.

## Generated Docs, Reports, and Archive Policy

### Current Generated/Archive-Like Candidates

| Candidate | Size/status | Recommendation | Risk |
| --- | ---: | --- | --- |
| `docs/audits/lifeops-2026-05-11/prompts-manifest.json` | 667.32 KiB, tracked | Keep if prompt review remains active. Otherwise regenerate on demand. | Medium |
| `docs/audits/lifeops-2026-05-11/prompts/INDEX.md` | 227.81 KiB, tracked | Keep as index or regenerate from manifest. | Medium |
| `docs/audits/lifeops-2026-05-11/prompts/*.md` | 989 generated prompt files, 1.22 MiB directory total | Candidate archive after prompt audit closes. | Medium |
| `docs/audits/lifeops-2026-05-09/*.md` | 16 files, 0.35 MiB | Retain historical audit unless docs owner approves compression into a final report. | Low |
| `docs/audits/mobile-2026-05-11/REPORT.md` | 48.74 KiB, tracked | Retain as current audit report. | Low |
| `docs/audits/response-handler-and-evaluator-systems-2026-05-11.html` | 34.70 KiB, modified | Owner decision: generated HTML should either be final artifact or regenerated from source. | Low |
| `reports/porting/2026-05-09-baseline/aosp-symbols-pre.txt` | 3.85 MiB, tracked raw dump | Archive externally after summary remains. | Medium |
| `reports/porting/2026-05-09-baseline/knip.txt` | 1.22 MiB, tracked raw output | Archive externally or keep only scoped summary. | Medium |
| `reports/porting/2026-05-09-baseline/madge-graph.json` | 1.01 MiB, tracked raw graph | Archive externally if no tool consumes it. | Medium |
| `reports/porting/2026-05-09-unified/aosp-symbols-post.txt` | 799.04 KiB, tracked raw dump | Keep while referenced, then archive. | Medium |
| `reports/porting/2026-05-09-w4/symbols/*.txt` | about 0.98 MiB, tracked raw dumps | Archive after preserving summary. | Medium |
| `packages/inference/reports/porting/2026-05-11/*.md` | active inference design/status docs | Retain; referenced by inference code comments and roadmap docs. | Medium |
| `packages/app-core/test/contracts/lib/openzeppelin-contracts/audits/*.pdf` | about 3.89 MiB across audit PDFs | Keep if vendored OpenZeppelin tree is intentionally complete; otherwise strip docs from vendored fixture only after contract tests pass. | Medium |

### Recommended Docs Policy

1. `docs/` and `packages/docs/` are for durable human-facing docs.
2. `docs/audits/<topic-date>/` may contain dry-run and investigation reports, but each audit folder should have an `INDEX.md` or `README.md` that marks status: active, superseded, archived, or final.
3. Generated per-item markdown dumps, such as prompt extractions, should be either:
   - regenerated from scripts during review,
   - stored as CI/build artifacts,
   - or kept only while an audit is active.
4. `reports/<domain>/<date>/` should be for raw evidence and machine output. Raw reports should have a retention period and a summary promotion path into durable docs.
5. Raw logs, symbol dumps, profiler JSON, generated graphs, benchmark result JSON, and local absolute-path indexes should not be permanent docs unless an owner explicitly labels them as reproducibility artifacts.
6. Every generated report directory should record:
   - generator command,
   - source commit,
   - owner,
   - expiration/review date,
   - whether files can be regenerated,
   - post-cleanup validation command.
7. Markdown cleanup should never delete source-of-truth architecture docs, public docs, or audit reports still linked from current docs.

## Retention/Deletion/Move Recommendations

### Retain

- Runtime public assets that are referenced by app code:
  - `cloud/apps/frontend/public/agents/*.png`
  - `packages/app/public/**`
  - `plugins/app-companion/public/**`
  - `packages/app-core/platforms/electrobun/assets/appIcon.iconset/**`
- Small benchmark and training fixtures used by tests:
  - `packages/training/scripts/harness/scenario_pool/*.jsonl`
  - small `packages/benchmarks/**/fixtures/*.jsonl`
- Active docs and summaries:
  - `docs/porting/**`
  - `packages/inference/reports/porting/2026-05-11/*.md`
  - final audit reports with current references.

### Candidate Delete After Owner Approval

- Duplicate iOS splash PNGs if one file can serve all Xcode slots.
- Duplicate plugin hero PNGs if packaging supports shared asset references.
- Duplicate companion source animations where path references can be consolidated.
- Generated native binaries under `packages/inference/verify` if reproducible and not required for source checkout.
- Superseded training dataset variants after one canonical dataset lineage is documented.
- Raw generated prompt markdown after prompt audit closure and regeneration proof.

### Candidate Move to Git LFS or Asset Storage

- `plugins/app-companion/public_src/**/*.vrm`
- `plugins/app-companion/public_src/**/*.fbx`
- large `cloud/apps/frontend/public/**/*.png`
- `packages/homepage/public/models/iphone.glb`
- `packages/docs/images/*` only if docs hosting can pull external assets
- `packages/app-core/test/contracts/lib/openzeppelin-contracts/audits/*.pdf` if preserving vendored docs is required but Git history size matters.

### Candidate Move to CI/Release Artifacts

- `reports/porting/**` raw symbol dumps, profiler JSON, SPIR-V samples, logs, and generated graph JSON.
- `packages/benchmarks/benchmark_results/latest/**` if current result snapshots are generated by scheduled benchmarks.
- `packages/benchmarks/openclaw-benchmark/autonomous_agent_env/shellcheck-v0.10.0/shellcheck`.
- `packages/inference/verify/*_bench`, `*_smoke`, and `android-vulkan-smoke/vulkan_verify`.

## Owner Questions

1. Cloud frontend owner: are all seven SF Pro OTF weights licensed for repo distribution, and are Thin/Light/Ultralight intentionally shipped?
2. Cloud frontend owner: are `cloud-agent-samples` and `cloud-avatars` product-critical offline assets or CDN/gallery content?
3. Mobile owner: can the iOS splash asset catalog use one physical PNG for the three identical splash slots?
4. Companion owner: is `plugins/app-companion/public_src` required source-of-truth, or can it move to LFS/asset storage with a deterministic generation script?
5. Companion owner: do plugins publish independently such that duplicate `assets/hero.png` files must remain local to each package?
6. Benchmark owner: should `packages/benchmarks/benchmark_results/latest` be tracked, or should current results be generated and published by CI?
7. Benchmark owner: can the vendored `shellcheck` binary be replaced by a pinned setup step?
8. Inference owner: which files under `packages/inference/verify` are source fixtures versus generated build outputs?
9. Training owner: which `plugins/app-training/datasets/lifeops_*` files are canonical, superseded, or externally sourced?
10. Docs owner: what is the retention period for generated prompt audit markdown and raw `reports/porting` evidence?
11. Submodule owner: should `packages/training/vendor/llama.cpp` be initialized in normal checkouts or removed/converted to documented setup?

## Validation Commands

Read-only inventory commands used or recommended before implementation:

```sh
git status --short
git ls-files | wc -l
git ls-files -z | xargs -0 stat -f '%z %N' | sort -nr | head -120
git ls-files -s | awk '$1=="160000" {print}'
git submodule status --recursive
git ls-files -s | awk '$1=="100755" {print $4}' | sort
git ls-files | rg -i '\\.(png|jpe?g|gif|webp|svg|ico|icns|avif)$'
git ls-files | rg -i '\\.(jsonl|csv|tsv|parquet|arrow|sqlite|db|pkl|npy|npz|safetensors|onnx|gguf|bin)$'
git ls-files | rg -i '\\.(dylib|so|dll|wasm|jar|o|a|exe|spv)$'
git ls-files | rg -i '\\.(gz|zip|tar|tgz|bz2|xz|7z|rar)$'
```

Reference checks before deleting/moving any asset:

```sh
rg -n "filename-or-public-path" .
rg -n "cloud-agent-samples|cloud-avatars|intro_blog_1|intro_blog_2|agent-[123]\\.png" cloud/apps/frontend packages/app packages/homepage
rg -n "milady-|vrms/|animations/|draco_decoder|public_src" plugins/app-companion packages/examples/avatar
rg -n "reports/porting|docs/audits/lifeops-2026-05-11/prompts|prompts-manifest" .
shasum packages/app-core/platforms/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732*.png
git ls-files 'plugins/*/assets/hero.png' | xargs shasum | sort
```

Post-change validation gates for a future implementation PR:

```sh
bun run lint
bun run typecheck
bun run test
bun --cwd cloud/apps/frontend run build
bun --cwd cloud/apps/frontend run verify
bun --cwd packages/app run build
bun --cwd packages/app run cap:sync:ios
bun --cwd plugins/app-companion run build
bun --cwd plugins/app-companion run test
bun run lifeops:prompts:inventory
bun run lifeops:prompts:review
bun run test:launch-qa:docs
```

Additional gates when touching inference or benchmark artifacts:

```sh
bun run local-inference:dflash:build
bun run local-inference:ablation:quick
bun run lifeops:bench
bun run test:ci
```

## Implementation Checklist for Future Cleanup PR

1. Freeze scope.
   - Get owner approval for each candidate group.
   - Confirm no other worker has active changes in the target files.
   - Start from a clean branch or explicitly record unrelated dirty files.
2. Add policy first.
   - Define docs/report retention in `docs/audits/repo-cleanup-2026-05-11` or durable docs.
   - Define asset storage/LFS rules before moving large assets.
   - Define generated result policy for `benchmark_results/latest`.
3. Handle low-risk metadata.
   - Normalize executable bits on static font assets if approved.
   - Add/confirm `.gitattributes` or asset linting rules in a separate PR.
4. Handle exact duplicates.
   - iOS splash dedupe with Xcode/Capacitor validation.
   - Plugin hero dedupe only if packaging supports shared references.
   - Companion animation dedupe only after path-literal audit and runtime smoke.
5. Handle generated/native artifacts.
   - Replace vendored `shellcheck` binary with setup script or package-manager dependency.
   - Rebuild/move inference verify binaries to ignored outputs or CI artifacts.
   - Keep source fixtures and hash manifests.
6. Handle training/data.
   - Produce dataset cards and canonical lineage.
   - Archive superseded datasets externally with hashes.
   - Run privacy/provenance review before retaining external/generated datasets.
7. Handle docs/reports.
   - Promote stable summaries from `reports/porting` to durable docs.
   - Replace internal references to raw dumps with summary/index references.
   - Archive raw dumps/logs/profiler JSON as build artifacts.
   - Regenerate prompt audit outputs on demand or keep only manifest/index.
8. Validate.
   - Run the scoped builds/tests listed above.
   - Re-run size inventory and duplicate checks.
   - Confirm `git status --short` contains only intended cleanup files.
9. Review.
   - Attach before/after size tables.
   - Include owner signoff for every deleted or moved asset group.
   - Document rollback: restore from Git, LFS, or artifact URL with hash.

## Risk Register

| Risk | Level | Mitigation |
| --- | --- | --- |
| Removing served public assets breaks web/mobile runtime fetches. | High | Require reference audit, build, and browser/mobile smoke tests. |
| Moving companion `public_src` loses ability to regenerate compressed runtime assets. | High | Keep source asset hash manifest and deterministic generation script before move. |
| Removing native verify binaries hides platform-specific regressions. | High | Ensure binaries are reproducible from source in CI before deletion. |
| Deleting training data harms reproducibility or loses provenance. | High | Dataset cards, hashes, owner signoff, and external archive required. |
| Deleting `reports/porting` raw files breaks docs links. | Medium | Rewrite docs references and keep `INDEX.md` summaries. |
| Deduping plugin hero files breaks independent plugin publishing. | Medium | Verify package contents and registry expectations. |
| Font cleanup changes rendering or violates licensing assumptions. | Medium | Owner/licensing review plus visual regression screenshots. |
| Removing benchmark fixtures changes benchmark baselines. | Medium | Benchmark owner approval plus fixture hash snapshots. |
| Markdown audit pruning removes historical context. | Low | Keep final reports and indexes; archive raw generated fragments. |

## Dry-Run Conclusion

Wave 6 should not proceed as a broad deletion wave. The repo has real cleanup opportunities, but most high-byte candidates are runtime assets, reproducibility evidence, training datasets, or generated artifacts with active references. The safest implementation sequence is:

1. approve policy and ownership,
2. normalize obvious metadata,
3. dedupe exact duplicates with validation,
4. move generated/native/raw evidence to reproducible artifacts,
5. archive superseded datasets and generated prompt dumps only after owner signoff.

