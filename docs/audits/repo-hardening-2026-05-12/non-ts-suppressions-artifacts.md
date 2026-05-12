# Non-TypeScript Suppressions and Generated Artifact Hardening

Date: 2026-05-12  
Scope: tracked non-TypeScript suppressions, shell failure masking, Kotlin/Java suppressions, non-TS eslint/biome ignores, generated/training/benchmark artifacts, tracked build outputs/binaries/archives/models/images, and broad Python exception handlers. Existing `docs/audits/**`, `node_modules/**`, and ordinary `dist/**`/`build/**` trees were excluded from content scans unless called out as tracked artifacts.

## Executive summary

This repo has three different classes of hardening work:

1. **Must-fix repository hygiene:** generated QA reports/screenshots, local benchmark/evidence outputs, tracked mobile/inference build outputs, a checked-in native dylib, and a vendored shellcheck binary should be deleted from git and covered by ignore rules.
2. **Must-fix first-party suppression risk:** first-party Python under `packages/training/scripts/**`, skill scripts, and native plugin helper scripts contain broad `except Exception` handlers and type ignores that hide real failures. Most are in CLI/data pipelines, but several continue after parse, publish, cache, manifest, or training failures.
3. **Acceptable vendored/generated suppressions:** most Python suppressions are inside benchmark/vendor imports (`packages/benchmarks/**`, `packages/inference/llama.cpp/**`) and should not be hand-edited; either keep them isolated or stop vendoring them.

## Scan counts

| Surface | Count | Primary ownership | Classification |
| --- | ---: | --- | --- |
| Python `noqa` / `type: ignore` / pyright / mypy / broad `except` | 3,624 | `packages/benchmarks`, `packages/training`, `packages/inference/llama.cpp` | 334 first-party or local scripts, 3,290 vendored/benchmark |
| Python `noqa` | 448 | benchmarks + training | Mostly acceptable `E402` from script path mutation; should be reduced in first-party scripts |
| Python `type: ignore` | 515 | benchmarks + training | Must validate first-party ignores in training/inference quantization |
| Python pyright comments | 33 | benchmark/vendor | Accept as vendored unless forked |
| Python broad `except Exception` | 2,411 | benchmarks + training | Must fix first-party handlers that swallow errors |
| Python bare `except:` | 217 | benchmark/vendor | Vendored; do not edit unless removing vendor copy |
| Shell `|| true` / shellcheck disables | 271 | app-core scripts, cloud local infra, training scripts, inference verify | Mostly acceptable cleanup/probing; some CI/provisioning must-fix |
| Shell `shellcheck disable=` | 9 | inference/training/app-core | Mostly acceptable if documented |
| Kotlin/Java `@Suppress` | 23 | `packages/native-plugins/**` | Acceptable deprecation bridges, but localize and document SDK target |
| Non-TS eslint/biome ignores | 14 | wallet shim, codegen scripts, Svelte, CSS, MJS tests | Mostly acceptable generated/template; sanitize Svelte HTML paths |
| Artifact candidates scanned | 5,246 files / 380 MB | reports, frontend assets, benchmarks, app-core, training | Must delete generated reports/builds; keep real app assets and benchmark fixtures |

Top Python owners by count:

| Owner | Count | Note |
| --- | ---: | --- |
| `packages/benchmarks/OSWorld` | 1,736 | Vendored benchmark code; acceptable only if isolated |
| `packages/benchmarks/loca-bench` | 876 | Vendored benchmark workspaces; acceptable if documented |
| `packages/training/scripts` | 322 | First-party training/inference scripts; must harden |
| `packages/inference/llama.cpp` | 147 | Vendored upstream; do not edit locally |
| `packages/benchmarks/lifeops-bench` | 76 | Benchmark package; validate ownership |

## Must-fix: tracked generated artifacts and build outputs

These should be removed from git unless a package owner confirms they are immutable fixtures required at runtime. Add ignore rules before deletion so they do not reappear.

| Owner | Evidence | Why it is risky | Recommendation |
| --- | --- | --- | --- |
| Root reports / app QA | `reports/apps-manual-qa/current/apps-catalog__desktop.png`; `reports/apps-manual-qa/current/contact-desktop.png`; `reports/apps-manual-qa/full-2026-05-12T01-30-36-617Z/report.json`; `reports/apps-manual-qa/full-2026-05-12T01-30-36-617Z/issue-index.json` | Generated screenshots and test result payloads are checked in; several are near 1 MB each and timestamped. | Delete `reports/apps-manual-qa/**`; ignore `reports/apps-manual-qa/**`. |
| Root porting reports | `reports/porting/2026-05-09-baseline/aosp-symbols-pre.txt`; `reports/porting/2026-05-09-baseline/knip.txt`; `reports/porting/2026-05-09-baseline/madge-graph.json`; `reports/porting/2026-05-09-w4/symbols/windows-x64-cpu-ggml-base-dll.txt`; `reports/porting/2026-05-09-w4/vulkan/turbo4.spv` | Local build logs, symbol dumps, generated graphs, compiled shader outputs, and timestamped evidence are tracked. | Move curated conclusions into docs; delete raw generated evidence; ignore `reports/porting/**` or route to audit docs intentionally. |
| Inference reports | `packages/inference/reports/gates/eliza1-gates-0_6b-20260512T013355Z.json`; `packages/inference/reports/local-e2e/2026-05-11/e2e-loop-0_6b-2026-05-11-30turn.json`; `packages/inference/reports/local-e2e/2026-05-11/eval-suite-run/0_6b-aggregate.json`; `packages/inference/reports/vad/vad-quality-20260512T013134Z.json` | Timestamped local eval results are generated artifacts and will churn. | Delete generated JSON outputs; keep only stable fixtures or summarized markdown. Ignore `packages/inference/reports/**/*.json`. |
| Inference verify bench results | `packages/inference/verify/bench_results/cpu_simd_m4max_2026-05-12.json`; `packages/inference/verify/bench_results/m4max_fused_2026-05-12.json` | Machine-specific benchmark outputs. These are already modified in the worktree, confirming churn. | Delete or move to external artifact storage; ignore `packages/inference/verify/bench_results/**`. |
| Mobile agent bundles | `packages/agent/dist-mobile-ios/pglite.wasm`; `packages/agent/dist-mobile-ios/initdb.wasm`; `packages/agent/dist-mobile-ios-jsc/pglite.wasm`; `packages/agent/dist-mobile-ios-jsc/initdb.wasm`; `packages/agent/dist-mobile-ios-jsc/manifest.json` | `dist-mobile-*` is generated distribution output. The two `pglite.wasm` files are 8.7 MB each. | Delete if build can reproduce them; otherwise move to release assets and document fetch step. Ignore `packages/agent/dist-mobile-ios*/**`. |
| Electrobun generated/native output | `packages/app-core/platforms/electrobun/.generated/brand-config.json`; `packages/app-core/platforms/electrobun/src/libMacWindowEffects.dylib` | `.generated` is generated config. The dylib is a compiled binary checked into source. | Delete generated config and build dylib from source or fetch release binary. Ignore `.generated/**` and generated native outputs. |
| Vendored shellcheck binary | `packages/benchmarks/openclaw-benchmark/autonomous_agent_env/shellcheck-v0.10.0/shellcheck` | 15.6 MB executable in benchmark tree. It is a third-party binary with supply-chain and platform drift risk. | Prefer package-manager install or download with checksum during setup. If kept, add provenance and checksum docs. |
| Training app datasets | `plugins/app-training/datasets/lifeops_full_mixed_action_planner.jsonl`; `plugins/app-training/datasets/lifeops_corrected_action_planner.jsonl`; `plugins/app-training/datasets/lifeops_mixed_action_planner.jsonl` | Large generated training corpora in an app package. They may be canonical, but the names look generated and they are not small fixtures. | Validate with app-training owner. If derived, move to external dataset storage and keep manifest/checksum only. |

Acceptable or validation-needed artifacts:

| Owner | Evidence | Classification |
| --- | --- | --- |
| Cloud/app frontend assets | `cloud/apps/frontend/public/avatars/eliza-default.png`; `cloud/apps/frontend/public/images/blog/intro_blog_1.png`; `packages/app/public/splash-bg.jpg` | Accept if these are production UI assets. Optimize size separately. |
| App/native packaging assets | `packages/app-core/platforms/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png`; `packages/app-core/packaging/msix/assets/StoreLogo.png`; `packages/app-core/packaging/flatpak/icons/512x512/ai.elizaos.App.png` | Accept as platform assets. |
| Benchmark fixtures | `packages/benchmarks/loca-bench/gem/envs/machine_operating_s2l/preprocess/machine_operating/live_sensor.csv`; `packages/benchmarks/OSWorld/assets/pubeval_monitor1.jpg`; `packages/benchmarks/OSWorld/uv.lock` | Accept if vendored benchmark snapshots are intentionally tracked; document source/version. |
| Companion VRM assets | `plugins/app-companion/public/vrms/eliza-7.vrm.gz`; `plugins/app-companion/public/vrms/eliza-5.vrm.gz` | Accept if runtime assets; add license/provenance if missing. |

Recommended ignore additions:

```gitignore
# Generated QA and local audit outputs
/reports/apps-manual-qa/**
/reports/porting/**

# Local inference/eval outputs
/packages/inference/reports/**/*.json
/packages/inference/verify/bench_results/**

# Generated mobile/app bundles
/packages/agent/dist-mobile-ios/**
/packages/agent/dist-mobile-ios-jsc/**
/packages/app-core/platforms/electrobun/.generated/**

# Native build products
/packages/app-core/platforms/electrobun/src/*.dylib
```

Do not add a blanket `*.json`, `*.jsonl`, or `*.png` ignore; the repo has legitimate manifests, fixtures, and UI assets.

## Must-fix: first-party Python suppressions and broad exceptions

Most `noqa: E402` in `packages/training/scripts/**` comes from direct script execution after mutating `sys.path`. That is acceptable as a short-term script convention, but it should be replaced over time by packaging the scripts as modules and invoking them with `python -m`.

Higher-risk first-party references:

| Owner | File:line | Issue | Recommendation |
| --- | --- | --- | --- |
| Training | `packages/training/scripts/transform_corpus_cleanup.py:173`, `:190`, `:407`, `:431` | Broad `except Exception` while transforming corpus data can hide bad rows and schema drift. | Catch parse/JSON/key errors explicitly and count/report skipped records. |
| Training publish | `packages/training/scripts/publish_dataset_to_hf.py:570`, `:661`; `packages/training/scripts/publish_pipeline_to_hf.py:233`, `:283` | Publish paths swallow broad errors. | Fail closed for upload/auth/repo errors; only tolerate cleanup/reporting failures. |
| Training collection | `packages/training/scripts/collect_trajectories.py:335` | Broad collection failure can silently drop trajectory data. | Emit structured error row and nonzero exit when collection quality threshold fails. |
| Training cache/inference | `packages/training/scripts/inference/hybrid_cache.py:1060`; `packages/training/scripts/inference/serve_vllm.py:168` | Runtime cache/server handlers hide unexpected failures. | Split optional-backend import failures from runtime cache corruption or request failures. |
| Training pipeline | `packages/training/scripts/run_pipeline.py:135`, `:530`; `packages/training/scripts/build_actions_catalog.py:593`, `:825`, `:839` | Pipeline gates and catalog building continue after broad exceptions. | Add failure accounting and make CI fail when error counts exceed zero outside explicit legacy rows. |
| Training rewrites | `packages/training/scripts/rewrites/mcp_routing_dataset.py:46`, `:66`, `:102`; `packages/training/scripts/rewrites/agent_trove.py:106`, `:135`; `packages/training/scripts/rewrites/openclaw_operator.py:48`, `:94`; `packages/training/scripts/rewrites/regularizer_reasoning_tool.py:117`, `:137` | Rewrite generation hides malformed source data. | Catch expected decode/schema exceptions, include source id in diagnostics, and summarize skips. |
| Training synth | `packages/training/scripts/synth/adaptive_synth.py:160`, `:718`, `:749`, `:765`; `packages/training/scripts/synth/drive_eliza.py:444`, `:460`, `:476`, `:627`, `:676` | Synthetic generation loops use broad catches; some surface, some continue. | Add typed failure result and per-run failure budget. |
| Training manifests | `packages/training/scripts/manifest/stage_local_eliza1_bundle.py:363`, `:370`; `packages/training/scripts/manifest/stage_real_eliza1_bundle.py:210`, `:217`, `:663`; `packages/training/scripts/manifest/stage_eliza1_bundle_assets.py:120`; `packages/training/scripts/manifest/stage_eliza1_source_weights.py:203` | Bundle staging/network paths catch everything. | Separate optional network errors from local manifest/asset corruption; fail on local corruption. |
| Quantization | `packages/training/scripts/quantization/qjl_apply.py:136`, `:285`, `:330`, `:399`, `:405`, `:470`, `:471`, `:472`, `:473`, `:509`, `:510`; `packages/training/scripts/quantization/gguf_eliza1_apply.py:160`, `:161`, `:162` | Many `type: ignore` entries around dynamic cache/kernel mutation. | Add Protocols or adapter classes for cache/kernel interfaces; reserve ignores for import boundaries. |
| Quantization vendored fork | `packages/training/scripts/quantization/fused_turboquant_vendored/vllm_plugin/plugin.py:26`, `:44`; `packages/training/scripts/quantization/fused_turboquant_vendored/hf/fused_cache.py:725`, `:745` | Vendored subtree under first-party training path. | Either treat as vendored with provenance or harden as first-party. |
| Native plugin helper | `packages/native-plugins/polarquant-cpu/scripts/polarquant_to_gguf.py:56`, `:182`, `:213` | GGUF import ignore plus broad exceptions in converter. | Add optional dependency guard and explicit conversion error classes. |
| Skill scripts | `packages/skills/skills/nano-banana-pro/scripts/generate_image.py:105`, `:178`; `packages/skills/skills/skill-creator/scripts/package_skill.py:81`; `packages/skills/skills/skill-creator/scripts/init_skill.py:280`, `:292`, `:300` | CLI scripts catch broad exceptions. | Accept only at top-level CLI boundary if they print actionable error and exit nonzero; otherwise narrow. |

Acceptable first-party Python suppressions after validation:

| Pattern | Examples | Why acceptable |
| --- | --- | --- |
| Script import-order suppressions | `packages/training/scripts/train_local.py:38`, `:39`, `:246`; `packages/training/scripts/validate_corpus.py:94`, `:95`; `packages/training/scripts/cloud_run.py:36` | These are mostly `E402` after path setup. They are not ideal, but they do not hide runtime behavior. |
| Optional acceleration imports | `packages/training/scripts/train_local.py:80`; `packages/training/scripts/lib/attn.py:26`; `packages/training/scripts/training/te_fp8.py:154` | Accept if optional dependency fallback is explicit and tested. |
| Tests intentionally violating types | `packages/training/scripts/test_eliza_record.py:92`; `packages/training/scripts/test_default_thought_leak.py:135`, `:136`, `:139` | Accept if they are testing invalid inputs and scoped to tests. |

Vendored/generated Python to leave alone:

| Owner | Evidence | Classification |
| --- | --- | --- |
| `packages/benchmarks/OSWorld` | `packages/benchmarks/OSWorld/lib_run_single.py:712`; `packages/benchmarks/OSWorld/mm_agents/coact/autogen/oai/client.py:1156` | Vendored benchmark/agent code; isolate or update upstream. |
| `packages/benchmarks/loca-bench` | 876 suppressions/broad catches in benchmark workspaces | Benchmark fixture/vendor payload. |
| `packages/inference/llama.cpp` | `packages/inference/llama.cpp/convert_hf_to_gguf.py`; `packages/inference/llama.cpp/gguf-py/**` | Upstream vendored inference subtree. |

## Shell hardening

`|| true` is common in cleanup, probing, and diagnostics. Keep it when the command is genuinely optional and the script immediately records that fact. Harden it when the command is part of provisioning, CI preparation, or a test assertion.

Must-fix or validate:

| Owner | File:line | Issue | Recommendation |
| --- | --- | --- | --- |
| Cloud provisioning | `cloud/packages/scripts/cf-bootstrap.sh:39`, `:52`, `:54`, `:69` | Cloudflare resource creation is intentionally masked. | Make creates idempotent by checking existence first, then fail on unexpected errors. |
| App-core Docker CI | `packages/app-core/scripts/docker-ci-smoke.sh:223`, `:224`, `:243`, `:245`, `:246`, `:248`, `:260`, `:349` | Dependency install/patch/build-info steps can fail without failing the smoke. | Split optional diagnostics from required setup. Required patch/install steps should fail. |
| Plugin SQL migration test | `plugins/plugin-sql/src/__tests__/migration/e2e/run-upgrade-test.sh:539`, `:792`, `:818` | Test start/diff failures can be masked. | Only allow expected failure cases with explicit assertions on captured output. |
| Personal absolute path | `packages/benchmarks/gauntlet/run_multi_benchmark.sh:10` | Sources `/Users/sohom/gauntlet/.env` and suppresses failure. | Replace with repo-relative or documented env loading; do not commit personal paths. |
| Benchmark env export | `packages/benchmarks/openclaw-benchmark/openclaw/run.sh:47`, `:52`; same pattern in `bmadmethod/run.sh`, `ohmyopencode/run.sh`, `ralphy/run.sh` | `export $(grep ... | xargs) || true` masks bad env files and is unsafe for whitespace. | Use `set -a; . "$file"; set +a` after validating file exists, or parse explicitly. |

Mostly acceptable with comments:

| Owner | Examples | Why acceptable |
| --- | --- | --- |
| Cleanup/teardown | `cloud/packages/infra/local/teardown.sh:11`-`:18`; `packages/app-core/platforms/electrobun/scripts/smoke-test.sh:513`; `packages/training/scripts/smoke_full_stack.sh:265`-`:268` | Cleanup should be best-effort, but log when cleanup failure may affect next run. |
| Hardware probing | `packages/inference/verify/android_vulkan_smoke.sh:171`-`:185`; `packages/inference/verify/gh200_runner.sh:150`, `:155`; `packages/inference/verify/rocm_runner.sh:166` | Hardware discovery should tolerate missing tools, as long as final capability result is explicit. |
| Shellcheck disables | `packages/inference/verify/runtime_graph_smoke.sh:129`, `:143`; `packages/training/scripts/smoke_full_stack.sh:157`; `packages/app-core/scripts/docker-ci-smoke.sh:69`; `packages/app-core/scripts/build-image.sh:87` | Narrow disables for intentional word splitting or dynamic source are acceptable when explained. |

## Kotlin/Java suppressions

All 23 Kotlin/Java suppressions are `@Suppress("DEPRECATION")` in Android native plugin code. This is usually acceptable because Android APIs often require SDK-version bridges, but each suppression should be adjacent to a version guard or fallback.

References:

- `packages/native-plugins/gateway/android/src/main/java/ai/eliza/plugins/gateway/GatewayPlugin.kt:111`
- `packages/native-plugins/appblocker/android/src/main/java/ai/eliza/plugins/appblocker/AppBlockerPlugin.kt:48`, `:239`
- `packages/native-plugins/appblocker/android/src/main/java/ai/eliza/plugins/appblocker/AppBlockerForegroundService.kt:239`, `:332`
- `packages/native-plugins/websiteblocker/android/src/main/java/ai/eliza/plugins/websiteblocker/WebsiteBlockerVpnService.kt:298`
- `packages/native-plugins/swabble/android/src/main/java/ai/eliza/plugins/swabble/SwabblePlugin.kt:762`, `:777`
- `packages/native-plugins/camera/android/src/main/java/ai/eliza/plugins/camera/CameraPlugin.kt:438`, `:558`
- `packages/native-plugins/mobile-signals/android/src/main/java/ai/eliza/plugins/mobilesignals/MobileSignalsPlugin.kt:416`, `:422`, `:890`, `:908`
- `packages/native-plugins/canvas/android/src/main/java/ai/eliza/plugins/canvas/CanvasPlugin.kt:1339`
- `packages/native-plugins/screencapture/android/src/main/java/ai/eliza/plugins/screencapture/ScreenCapturePlugin.kt:106`, `:404`, `:476`
- `packages/native-plugins/talkmode/android/src/main/java/ai/eliza/plugins/talkmode/TalkModePlugin.kt:990`, `:1001`
- `packages/native-plugins/wifi/android/src/main/java/ai/eliza/plugins/wifi/WiFiPlugin.kt:168`, `:190`, `:249`

Recommendation: keep only if each block has an SDK guard or compatibility comment. If a whole function is suppressed, reduce the annotation to the deprecated call expression where possible.

## Non-TS eslint/biome ignores

| Owner | File:line | Classification | Recommendation |
| --- | --- | --- | --- |
| Wallet shim | `plugins/plugin-wallet/src/browser-shim/shim.template.js:1`, `:2` | Acceptable generated/template compatibility shim. | Keep if generated output is reviewed; add source/provenance comment. |
| Cloud API codegen | `cloud/apps/api/src/_generate-router.mjs:186`, `:187` | Acceptable generator emitting lint-disabled generated TS. | Ensure generated output path is ignored or regenerated deterministically. |
| Cloud SDK codegen | `cloud/packages/sdk/scripts/generate-public-routes.mjs:155` | Acceptable generator output. | Same as above. |
| UI CSS | `packages/ui/src/styles/xterm.css:175` | Acceptable third-party CSS override. | Keep; selector should stay narrowly scoped. |
| App-core scripts | `packages/app-core/scripts/report-coverage-surfaces.mjs:37`; `packages/app-core/scripts/validate-regression-matrix.mjs:66` | Acceptable regex control-character explanation. | Keep if tests cover glob conversion. |
| App-core test runner | `packages/app-core/test/scripts/test-parallel.mjs:202`, `:230` | Acceptable sequential async loop in test orchestration. | Keep with comment that order/concurrency is intentional. |
| Svelte vendored webui | `packages/inference/llama.cpp/tools/server/webui/src/lib/components/app/content/MarkdownContent.svelte:83`, `:606`, `:613` | Vendored upstream plus raw HTML rendering. | If this webui is exposed, validate sanitizer. Otherwise leave upstream. |
| Docs mention | `packages/docs/docs/launchdocs/16-all-app-pages-qa.md:375` | Documentation quote, not active suppression. | No action. |

## Validation needed

Before deleting anything, owners should confirm:

- App/platform owners: whether `packages/agent/dist-mobile-ios*/**` is reproducible from source or intentionally checked in for mobile runtime bootstrapping.
- Electrobun owner: whether `packages/app-core/platforms/electrobun/src/libMacWindowEffects.dylib` is built by `scripts/build-macos-effects.sh` and can be removed from source control.
- Training/app-training owners: whether `plugins/app-training/datasets/*.jsonl` are canonical product fixtures or generated training outputs.
- Benchmark owners: whether vendored benchmark trees have source/version/provenance files. If not, add provenance or switch to submodules/download steps.
- Inference owners: whether `packages/inference/reports/**` should be audit documentation or generated CI artifacts. Current timestamped JSONs look generated and should not be tracked.

## Recommended enforcement

1. Add a repo hygiene CI check that fails on tracked files under generated report/output paths:
   - `reports/apps-manual-qa/**`
   - `reports/porting/**`
   - `packages/inference/verify/bench_results/**`
   - `packages/agent/dist-mobile-ios*/**`
   - `packages/app-core/platforms/electrobun/.generated/**`
2. Add a Python lint gate for first-party scripts only, excluding vendored benchmark/inference trees:
   - Flag new `except Exception` unless it has an allowlisted comment and structured logging.
   - Flag new bare `except:`.
   - Flag new unqualified `# type: ignore` without an error code.
3. Add a shell lint rule for first-party scripts:
   - Permit `|| true` in cleanup traps and diagnostics.
   - Require an inline reason and follow-up status check for provisioning/build/test commands.
4. Add a CODEOWNERS-backed generated artifact policy:
   - Runtime assets are allowed with provenance.
   - Benchmark fixtures are allowed with source/version.
   - Local reports, screenshots, logs, compiled outputs, and model artifacts are not allowed in git.

## Reproduction commands

Commands used for this audit:

```sh
rg --line-number --no-heading --glob '!docs/audits/**' --glob '!**/node_modules/**' --glob '!**/dist/**' --glob '!**/build/**' --glob '*.py' '(#\s*noqa(?::|\b)|#\s*type:\s*ignore|pyright:\s*ignore|#\s*pyright:|#\s*mypy:|^\s*except\s+Exception\b|^\s*except\s*:)'
rg --line-number --no-heading --glob '!docs/audits/**' --glob '!**/node_modules/**' --glob '!**/dist/**' --glob '!**/build/**' --glob '*.{sh,bash,zsh}' '(shellcheck\s+disable=|\|\|\s*true\b)'
rg --line-number --no-heading --glob '!docs/audits/**' --glob '!**/node_modules/**' --glob '!**/dist/**' --glob '!**/build/**' --glob '*.{kt,kts,java}' '@Suppress(?:Warnings)?\b'
rg --line-number --no-heading --glob '!docs/audits/**' --glob '!**/node_modules/**' --glob '!**/dist/**' --glob '!**/build/**' --glob '!*.ts' --glob '!*.tsx' --glob '!*.mts' --glob '!*.cts' '(eslint-(?:disable|enable|ignore)|biome-ignore)'
git ls-files
```
