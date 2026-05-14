# File Size, Binary, and JSON Artifact Audit

Date: 2026-05-13

Scope: `/Users/shawwalters/eliza-workspace/milady/eliza`

This was a research-only audit. No repository files were deleted. The only
intended file change from this follow-up is this markdown report.

## Executive summary

The largest local cleanup opportunities are already ignored generated
artifacts, dependency trees, local training data, native build products, and
runtime database state. The largest tracked repository weight is concentrated
in benchmark fixtures and public media assets.

High-confidence deletion candidates, after local validation, are:

- `cloud/node_modules` (~9.0 GiB) and `node_modules` (~4.4 GiB).
- `.turbo/cache` (~1.26 GiB).
- `packages/training/data/raw/mcp-flow` (~1.54 GiB).
- `cloud/apps/api/.wrangler/tmp` (~1.18 GiB) and
  `cloud/apps/api/.wrangler-dry-run` (~187 MiB).
- `packages/training/.venv` (~866 MiB).
- `plugins/plugin-local-inference/native/llama.cpp/build` (~200 MiB) and
  `plugins/plugin-local-inference/native/llama.cpp/build-validate` (~192 MiB).
- Local runtime DB state under `.eliza` and `cloud/.eliza`.

High-confidence tracked externalization/compression candidates are:

- Benchmark fixtures under `packages/benchmarks`, especially PDFs, `.pcap`,
  `.pptx`, `.mp4`, high-resolution PNGs, and benchmark JSONL datasets.
- Public web/app media under `cloud/apps/frontend/public`,
  `packages/app/public`, and `packages/app-core/platforms/ios/.../Splash.imageset`.
- Companion VRM/FBX/GLB assets where source and compressed copies coexist.

## Commands used

These commands are the audit inputs used for this report. They are read-only
except for this report file.

```bash
git status --short --untracked-files=all
test -f docs/cleanup-audit/2026-05-13/file-size-binary-json-audit.md && sed -n '1,220p' docs/cleanup-audit/2026-05-13/file-size-binary-json-audit.md || true

git ls-tree -r -l HEAD | awk '$4 ~ /^[0-9]+$/ {printf "%s\t%s\n", $4, $5}' | sort -nr | head -120
git ls-tree -r -l HEAD | awk '$4 ~ /^[0-9]+$/ {path=$5; ext=path; sub(/^.*\./,"",ext); if (ext==path) ext="[none]"; sum[ext]+=$4; count[ext]++} END{for (e in sum) printf "%.1f MiB\t%d\t.%s\n", sum[e]/1048576, count[e], e}' | sort -nr | head -80

git ls-files '*.json' | awk '{dir=$0; sub("/[^/]*$", "", dir); count[dir]++} END{for (d in count) if (count[d] > 1) print count[d] "\t" d}' | sort -nr
git ls-files '*.jsonl' | awk '{dir=$0; sub("/[^/]*$", "", dir); count[dir]++} END{for (d in count) if (count[d] > 1) print count[d] "\t" d}' | sort -nr
git ls-files '*.json' '*.jsonl' | awk '{dir=$0; sub("/[^/]*$", "", dir); count[dir]++} END{folders=0; files=0; for (d in count) { if (count[d] > 1) folders++; files+=count[d]; } print folders " folders_with_more_than_1_json_or_jsonl"; print files " tracked_json_or_jsonl_files_in_those_folders"}'
git ls-files '*.json' '*.jsonl' | awk '{dir=$0; sub("/[^/]*$", "", dir); count[dir]++} END{for (d in count) if (count[d] > 1) print count[d] "\t" d}' | sort -nr | awk 'NR<=120 {print}'
git ls-files '*.json' '*.jsonl' | awk '{dir=$0; sub("/[^/]*$", "", dir); count[dir]++} END{for (d in count) if (count[d] > 1) print count[d] "\t" d}' | awk -F'\t' '$1>=10 {print}' | sort -nr
git ls-files '*.json' '*.jsonl' | awk '{dir=$0; sub("/[^/]*$", "", dir); count[dir]++} END{for (d in count) if (count[d] > 1) print count[d] "\t" d}' | awk -F'\t' '{root=$2; split(root,p,"/"); key=p[1]; if (p[1]=="packages") key=p[1]"/"p[2]; else if (p[1]=="plugins") key=p[1]"/"p[2]; else if (p[1]=="cloud") key=p[1]"/"p[2]; folders[key]++; files[key]+=$1} END{for (k in folders) print files[k] " files\t" folders[k] " folders\t" k}' | sort -nr | head -80
git ls-files '*.json' '*.jsonl' | awk '{dir=$0; sub("/[^/]*$", "", dir); count[dir]++} END{for (d in count) if (count[d] == 2) print count[d] "\t" d}' | wc -l
git ls-files '*.json' '*.jsonl' | awk '{dir=$0; sub("/[^/]*$", "", dir); count[dir]++} END{for (d in count) if (count[d] == 2) print count[d] "\t" d}' | awk -F'\t' '{split($2,p,"/"); key=p[1]; if (p[1]=="packages") key=p[1]"/"p[2]; else if (p[1]=="plugins") key=p[1]"/"p[2]; else if (p[1]=="cloud") key=p[1]"/"p[2]; folders[key]++} END{for (k in folders) print folders[k] "\t" k}' | sort -nr | head -80

git ls-files --others --exclude-standard -z | while IFS= read -r -d '' f; do [ -f "$f" ] && stat -f '%z\t%N' "$f"; done | sort -nr | head -80
git ls-files --others --exclude-standard '*.json' '*.jsonl' | awk '{dir=$0; sub("/[^/]*$", "", dir); count[dir]++} END{for (d in count) if (count[d] > 1) print count[d] "\t" d}' | sort -nr

du -sk node_modules cloud/node_modules .turbo/cache cloud/apps/api/.wrangler/tmp cloud/apps/api/.wrangler-dry-run cloud/.eliza .eliza packages/training/data/raw/mcp-flow packages/training/.venv packages/training/local-corpora/light-multilight/source/extracted/episodes/multiparty/room/graphs packages/training/local-corpora/nubilio-trajectories/training-datasets/trajectories packages/app-core/dist packages/core/dist packages/app/dist packages/registry/site/node_modules packages/bun-ios-runtime/artifacts .benchmark-logs skills/.cache plugins/plugin-local-inference/native/llama.cpp/build plugins/plugin-local-inference/native/llama.cpp/build-validate plugins/plugin-local-inference/native/llama.cpp/models 2>/dev/null

git check-ignore -v node_modules cloud/node_modules .turbo/cache cloud/apps/api/.wrangler/tmp cloud/apps/api/.wrangler-dry-run cloud/.eliza/.pgdata/pg_wal/000000010000000000000001 .eliza/.pgdata/pg_wal/000000010000000000000001 packages/training/data/raw/mcp-flow packages/training/.venv packages/training/local-corpora/light-multilight/source/extracted/episodes/multiparty/room/graphs packages/app-core/dist packages/core/dist packages/app/dist packages/registry/site/node_modules packages/bun-ios-runtime/artifacts .benchmark-logs/action-benchmark-full-20260508T093014Z.log skills/.cache/catalog.json 2>/dev/null
git -C plugins/plugin-local-inference/native/llama.cpp check-ignore -v build/darwin-arm64-metal-fused/tools/server/bundle.js.hpp build-validate/tools/server/bundle.js.hpp 2>/dev/null

find .turbo/cache cloud/apps/api/.wrangler/tmp cloud/apps/api/.wrangler-dry-run cloud/.eliza .eliza packages/training/data/raw/mcp-flow packages/training/.venv packages/training/local-corpora/light-multilight/source/extracted/episodes/multiparty/room/graphs packages/training/local-corpora/nubilio-trajectories/training-datasets/trajectories packages/app-core/dist packages/core/dist packages/app/dist packages/bun-ios-runtime/artifacts .benchmark-logs skills/.cache plugins/plugin-local-inference/native/llama.cpp/build plugins/plugin-local-inference/native/llama.cpp/build-validate 2>/dev/null -type f -print0 | xargs -0 stat -f '%z\t%N' 2>/dev/null | sort -nr | head -120
find node_modules cloud/node_modules packages/registry/site/node_modules plugins/plugin-local-inference/native/voice-bench/node_modules 2>/dev/null -type f -size +10000000c -print0 | xargs -0 stat -f '%z\t%N' 2>/dev/null | sort -nr | head -80
find .turbo/cache packages/training/data/raw packages/training/local-corpora packages/app-core/dist packages/core/dist packages/app/dist packages/benchmarks/benchmark_results cloud/apps/api/.wrangler/tmp cloud/apps/api/.wrangler-dry-run .eliza cloud/.eliza .benchmark-logs skills/.cache 2>/dev/null -type f \( -name '*.json' -o -name '*.jsonl' \) | awk '{dir=$0; sub("/[^/]*$", "", dir); count[dir]++} END{for (d in count) if (count[d] > 1) print count[d] "\t" d}' | sort -nr | head -160

file plugins/plugin-local-inference/native/verify/qjl_mt_check.darwin-arm64-metal-fused plugins/plugin-local-inference/native/llama.cpp/models/ggml-vocab-command-r.gguf plugins/plugin-local-inference/native/llama.cpp/models/ggml-vocab-gemma-4.gguf plugins/plugin-local-inference/native/llama.cpp/build/darwin-arm64-metal-fused/tools/server/bundle.js.hpp packages/training/.venv/lib/python3.11/site-packages/onnxruntime/capi/libonnxruntime.1.25.1.dylib 2>/dev/null
git worktree list --porcelain
find .claude/worktrees -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l && git worktree list --porcelain | awk '/^worktree .*\.claude\/worktrees\// {n++} /^locked / {locked++} END {print n " registered_claude_worktrees"; print locked " locked_worktrees_total"}'

nl -ba .gitignore | sed -n '60,90p;125,160p;190,210p;248,262p;276,284p;428,438p'
nl -ba cloud/.gitignore | sed -n '1,10p;90,118p'
nl -ba packages/training/.gitignore | sed -n '1,40p'
nl -ba packages/benchmarks/.gitignore | sed -n '40,55p'
```

One broad ignored JSON walk that included `.claude/worktrees` was stopped and
replaced with the narrower path-specific generated JSON command above. The
process stopped was the audit's own scan, not an unrelated process.

## Current status caveat

`git status --short --untracked-files=all` shows a very dirty worktree with
many unrelated modifications and deletions. This audit treats those changes as
context only. It does not recommend deleting any currently modified source file
based on dirty status alone.

Notable current untracked artifacts:

| Path | Size | Classification | Suggested action |
|---|---:|---|---|
| `plugins/plugin-local-inference/native/verify/qjl_mt_check.darwin-arm64-metal-fused` | 50 KiB | local Mach-O verification binary | Ignore pattern or place under ignored build output; do not commit |
| `reports/eliza1-release-gates/*-20260514T*.json` | small | generated release-gate run outputs | Move generated outputs under an ignored subfolder or curate before tracking |
| `patches/@solana%2F*.patch`, `patches/electrobun@1.18.1.patch` | small | dependency patch files | Track if intentional `patch-package` patches; otherwise remove after validation |
| `docs/cleanup-audit/2026-05-13/*.md` | small | audit docs | Track if these reports are intended repo documentation |

## Largest tracked files

These files are tracked in `HEAD`. Sizes are approximate MiB from Git object
metadata.

| Rank | Path | Size | Class | Assessment |
|---:|---|---:|---|---|
| 1 | `packages/benchmarks/skillsbench/tasks/organize-messy-files/environment/DAMOP.pptx` | 33.5 MiB | PPTX benchmark fixture | Externalize or LFS candidate |
| 2 | `packages/benchmarks/skillsbench/tasks/dapt-intrusion-detection/environment/packets.pcap` | 31.2 MiB | packet capture fixture | Externalize or LFS candidate |
| 3 | `packages/benchmarks/claw-eval/tasks/T078_officeqa_max_yield_spread/fixtures/pdf/treasury_bulletin_1970_06.pdf` | 27.2 MiB | PDF benchmark fixture | Externalize/LFS |
| 4 | `packages/benchmarks/claw-eval/tasks/T079_officeqa_zipf_exponent/fixtures/pdf/treasury_bulletin_2020_12.pdf` | 25.1 MiB | PDF benchmark fixture | Externalize/LFS |
| 5 | `packages/benchmarks/claw-eval/tasks/T082_officeqa_qoq_esf_change/fixtures/pdf/treasury_bulletin_2022_12.pdf` | 24.3 MiB | PDF benchmark fixture | Externalize/LFS |
| 6 | `packages/benchmarks/swe-bench-pro/helper_code/sweap_eval_full_v2.jsonl` | 24.2 MiB | benchmark JSONL dataset | Externalize or shard/compress |
| 7 | `packages/benchmarks/claw-eval/tasks/T081_officeqa_cagr_trust_fund/fixtures/pdf/treasury_bulletin_1953_02.pdf` | 23.8 MiB | PDF benchmark fixture | Externalize/LFS |
| 8 | `packages/benchmarks/claw-eval/tasks/T085_officeqa_army_expenditures/fixtures/pdf/treasury_bulletin_1952_12.pdf` | 23.4 MiB | PDF benchmark fixture | Externalize/LFS |
| 9 | `packages/benchmarks/claw-eval/tasks/T083_officeqa_mad_excise_tax/fixtures/pdf/treasury_bulletin_2018_12.pdf` | 21.5 MiB | PDF benchmark fixture | Externalize/LFS |
| 10 | `packages/benchmarks/claw-eval/tasks/T080_officeqa_bond_yield_change/fixtures/pdf/treasury_bulletin_1960_07.pdf` | 21.0 MiB | PDF benchmark fixture | Externalize/LFS |
| 11 | `packages/benchmarks/claw-eval/tasks/T077_officeqa_highest_dept_spending/fixtures/pdf/treasury_bulletin_1958_10.pdf` | 19.0 MiB | PDF benchmark fixture | Externalize/LFS |
| 12 | `packages/benchmarks/claw-eval/tasks/T085_officeqa_army_expenditures/fixtures/pdf/treasury_bulletin_1948_04.pdf` | 18.3 MiB | PDF benchmark fixture | Externalize/LFS |
| 13 | `cloud/apps/frontend/public/avatars/eliza-default.png` | 15.8 MiB | 4096px PNG web asset | Compress/resize or source-vs-runtime split |
| 14 | `packages/benchmarks/claw-eval/tasks/T084_officeqa_geometric_mean_silver/fixtures/pdf/treasury_bulletin_1940_10.pdf` | 15.7 MiB | PDF benchmark fixture | Externalize/LFS |
| 15 | `packages/benchmarks/claw-eval/tasks/T076_officeqa_defense_spending/fixtures/pdf/treasury_bulletin_1941_01.pdf` | 15.1 MiB | PDF benchmark fixture | Externalize/LFS |
| 16 | `packages/benchmarks/openclaw-benchmark/autonomous_agent_env/shellcheck-v0.10.0/shellcheck` | 14.9 MiB | ELF executable | Prefer install/download step or LFS |
| 17 | `packages/benchmarks/skillsbench/tasks/mario-coin-counting/environment/super-mario.mp4` | 14.7 MiB | MP4 benchmark fixture | Externalize/LFS |
| 18-21 | `packages/benchmarks/claw-eval/tasks/M0*/fixtures/2512.17495v2.pdf` | 13.7 MiB each | duplicate PDF fixture | Deduplicate shared fixture path |
| 22-24 | `packages/app-core/platforms/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732*.png` | 12.9 MiB each | iOS splash PNGs | Check if three copies are required; optimize |
| 25 | `cloud/apps/frontend/public/images/blog/intro_blog_2.png` | 11.8 MiB | 4096x2304 PNG | Compress/resize |
| 26 | `cloud/apps/frontend/public/images/blog/intro_blog_1.png` | 10.4 MiB | 4096x2304 PNG | Compress/resize |
| 27 | `packages/benchmarks/claw-eval/tasks/T072_restaurant_menu_contact/fixtures/media/menu.jpeg` | 6.7 MiB | JPEG benchmark fixture | Externalize or optimize if exact pixels not needed |
| 28-32 | `packages/benchmarks/claw-eval/tasks/M037_video_food_shop_search/fixtures/gt_*.png` | 5.4-6.6 MiB | PNG benchmark fixtures | Externalize/LFS |
| 33-36 | `cloud/apps/frontend/public/fonts/sf-pro/SF-Pro-Display-*.otf` | 5.8-6.0 MiB each | OTF font files | Subset or convert runtime web fonts to WOFF2 if license permits |

Tracked-size concentration by extension:

| Extension/class | Tracked size | Count | Notes |
|---|---:|---:|---|
| `.pdf` | 314.8 MiB | 46 | mostly benchmark fixtures |
| `.png` | 271.2 MiB | 365 | benchmark fixtures and public UI/media assets |
| `.ts` | 62.8 MiB | 8,794 | source, not cleanup target |
| `.jsonl` | 35.0 MiB | 327 | benchmark/training datasets |
| `.json` | 33.7 MiB | 2,525 | source config, fixtures, manifests |
| `.pptx` | 33.6 MiB | 3 | benchmark fixtures |
| `.pcap` | 31.2 MiB | 1 | benchmark fixture |
| `.webp` | 28.8 MiB | 81 | public media assets |
| `.vrm` | 28.0 MiB | 9 | companion/avatar assets |
| `.gz` | 25.3 MiB | 62 | includes compressed VRM/runtime assets |
| `.otf` | 23.5 MiB | 4 | web fonts |
| `.jpg` | 19.8 MiB | 76 | public/fixture images |
| `.mp4` | 15.9 MiB | 4 | video fixtures |
| executable `shellcheck` | 14.9 MiB | 1 | benchmark vendored binary |
| `.fbx` | 14.2 MiB | 19 | companion animation assets |
| `.csv` | 12.0 MiB | 157 | benchmark/training fixtures |
| `.jpeg` | 11.4 MiB | 6 | benchmark/public images |
| `.glb` | 7.4 MiB | 33 | 3D assets |

## Largest ignored/generated folders

These paths are ignored by existing `.gitignore` files unless otherwise noted.
They are the strongest local deletion candidates after confirming no running
process needs them.

| Path | Size | Ignore proof | Suggested action | Confidence |
|---|---:|---|---|---|
| `cloud/node_modules` | ~9.0 GiB | `cloud/.gitignore:4 node_modules` | Delete/reinstall when cloud deps are not needed | High |
| `node_modules` | ~4.4 GiB | `.gitignore:203 node_modules/` | Delete/reinstall when root deps are not needed | High |
| `packages/training/data/raw/mcp-flow` | ~1.54 GiB | `packages/training/.gitignore:4 data/` | Delete if raw training data is reproducible | High |
| `.turbo/cache` | ~1.26 GiB | `.gitignore:72 .turbo` | Safe cache cleanup | High |
| `cloud/apps/api/.wrangler/tmp` | ~1.18 GiB | `cloud/.gitignore:114 .wrangler` | Delete after stopping Wrangler/dev server | High |
| `packages/training/.venv` | ~866 MiB | `packages/training/.gitignore:3 .venv/` | Delete/recreate virtualenv | High |
| `packages/training/local-corpora/light-multilight/.../graphs` | ~537 MiB | `packages/training/.gitignore:24 local-corpora/` | Delete if corpus extraction is reproducible | High |
| `plugins/plugin-local-inference/native/llama.cpp/build` | ~200 MiB | submodule `.gitignore:46 /build*` | Delete native build output | High |
| `plugins/plugin-local-inference/native/llama.cpp/build-validate` | ~192 MiB | submodule `.gitignore:46 /build*` | Delete native build output | High |
| `cloud/.eliza` | ~192 MiB | `cloud/.gitignore:97 .eliza/` | Delete only if local DB state is disposable | Medium |
| `cloud/apps/api/.wrangler-dry-run` | ~187 MiB | `cloud/.gitignore:115 .wrangler-dry-run` | Delete generated dry-run bundles | High |
| `packages/registry/site/node_modules` | ~148 MiB | `packages/registry/site/.gitignore:10 node_modules` | Delete/reinstall if needed | High |
| `packages/training/local-corpora/nubilio-trajectories/training-datasets/trajectories` | ~106 MiB | `packages/training/.gitignore:24 local-corpora/` | Delete if reproducible | High |
| `packages/app/dist` | ~99 MiB | `.gitignore:131 dist/` | Delete build output | High |
| `.eliza` | ~83 MiB | `.gitignore:151 **/.eliza/` | Delete only if local DB state is disposable | Medium |
| `packages/bun-ios-runtime/artifacts` | ~70 MiB | `packages/bun-ios-runtime/.gitignore:1 artifacts/` | Delete generated XCFramework artifacts | High |
| `skills/.cache` | ~69 MiB | `.gitignore:432 skills/.cache/` and `.gitignore:434 .cache/` | Safe cache cleanup | High |
| `packages/core/dist` | ~72 MiB | `packages/core/.gitignore:2 dist` | Delete build output | High |
| `packages/app-core/dist` | ~64 MiB | `.gitignore:131 dist/` | Delete build output | High |
| `.benchmark-logs` | ~21 MiB | `.gitignore:197 *.log` | Delete old local benchmark logs | High |
| `.claude/worktrees` | 115 directories; 111 registered and locked | `.gitignore:280 /.claude` | Do not delete blindly; use `git worktree` lifecycle after confirming stale locks | Medium |

## Largest ignored/generated files

Representative top files from ignored/generated candidate areas:

| Path | Size | Class | Suggested action |
|---|---:|---|---|
| `packages/training/.venv/lib/python3.11/site-packages/torch/lib/libtorch_cpu.dylib` | ~206 MiB | Python venv native library | Remove with `.venv` |
| `packages/training/data/raw/mcp-flow/test_data/smithery_unseen_tool_tool100.json` | ~201 MiB | raw training JSON | Remove with raw data or externalize |
| `packages/training/data/raw/mcp-flow/test_data/smithery_seen_test_tool100.json` | ~200 MiB | raw training JSON | Remove with raw data or externalize |
| `packages/training/data/raw/mcp-flow/test_data/smithery_unseen_server_tool100.json` | ~164 MiB | raw training JSON | Remove with raw data or externalize |
| `cloud/node_modules/.bun/@next+swc-darwin-arm64.../next-swc.darwin-arm64.node` | ~124 MiB | dependency native module | Remove with `cloud/node_modules` |
| `node_modules/.bun/@next+swc-darwin-arm64.../next-swc.darwin-arm64.node` | ~124 MiB | dependency native module | Remove with `node_modules` |
| `node_modules/.bun/workerd.../workerd` | ~107 MiB | dependency tool binary | Remove with `node_modules` |
| `cloud/apps/api/.wrangler-dry-run/index.js.map` | ~95 MiB | generated source map | Delete dry-run output |
| `.turbo/cache/2f95320863083651.tar.zst` | ~84 MiB | Turbo cache archive | Delete cache |
| `packages/bun-ios-runtime/artifacts/ElizaBunEngine.xcframework/.../ElizaBunEngine` | ~70 MiB | generated XCFramework binary | Delete generated artifact |
| `skills/.cache/catalog.json` | ~69 MiB | local cache catalog | Delete cache |
| `cloud/apps/api/.wrangler/tmp/dev-*/index.js.map` | ~54 MiB each | generated source maps | Delete Wrangler tmp |
| `plugins/plugin-local-inference/native/llama.cpp/build*/tools/server/bundle.js.hpp` | ~31 MiB each | native build-generated C++ header | Delete native build dirs |
| `packages/app/dist/assets/ort-wasm-simd-threaded.asyncify-*.wasm` | ~22 MiB | generated build output | Delete `packages/app/dist` |
| `.eliza/.pgdata/pg_wal/*` and `cloud/.eliza/.pgdata*/pg_wal/*` | 16 MiB each | local Postgres WAL | Delete only with disposable DB state |

Dependency trees also contain many large platform binaries that are expected
for package installs: `ffprobe`, `workerd`, `@next/swc`, `onnxruntime`,
`@nomicfoundation/edr`, `@biomejs/cli`, `@bufbuild/buf`, and
`llama-cpp-capacitor`. These are not repo cleanup issues as long as
`node_modules` stays ignored.

## Binary file classes worth removing or externalizing

| Class | Current location examples | Current state | Recommendation |
|---|---|---|---|
| Benchmark PDFs | `packages/benchmarks/claw-eval/tasks/**/fixtures/**/*.pdf` | tracked, largest class at ~315 MiB | Move to fixture download step, LFS, or content-addressed shared fixture store |
| Duplicate benchmark PDFs | `packages/benchmarks/claw-eval/tasks/M075.../2512.17495v2.pdf`, `M084...`, `M085...`, `M086...` | same-size tracked copies | Deduplicate to shared fixture path or fetch-on-demand |
| Packet captures | `packages/benchmarks/skillsbench/tasks/dapt-intrusion-detection/environment/packets.pcap` | tracked ~31 MiB binary | LFS/external fixture |
| PowerPoint fixtures | `packages/benchmarks/skillsbench/tasks/organize-messy-files/environment/DAMOP.pptx` | tracked ~33.5 MiB | LFS/external fixture |
| Video/audio fixtures | `packages/benchmarks/skillsbench/tasks/mario-coin-counting/environment/super-mario.mp4`, WAVs under native/bench areas | tracked or generated | Externalize unless small and essential |
| High-resolution PNG/JPEG/WebP | `cloud/apps/frontend/public/avatars/eliza-default.png`, `cloud/apps/frontend/public/images/blog/*.png`, benchmark `gt_*.png` | tracked | Optimize runtime assets; externalize exact-pixel benchmark images |
| iOS splash images | `packages/app-core/platforms/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732*.png` | tracked 3 copies | Verify duplicate necessity; compress if possible |
| Fonts | `cloud/apps/frontend/public/fonts/sf-pro/*.otf` | tracked OTFs | Prefer WOFF2/subset runtime fonts if license permits |
| 3D/avatar assets | `plugins/app-companion/public_src/vrms/*.vrm`, `plugins/app-companion/public/vrms/*.vrm.gz`, `.fbx`, `.glb` | tracked source and compressed assets | Confirm both source and generated compressed assets must be tracked |
| Vendored executables | `packages/benchmarks/openclaw-benchmark/.../shellcheck` | tracked ELF | Prefer setup download or LFS |
| Generated app/native builds | `packages/*/dist`, `plugins/plugin-local-inference/native/llama.cpp/build*`, `packages/bun-ios-runtime/artifacts` | ignored | Delete locally, keep ignored |
| Runtime DB/WAL files | `.eliza`, `cloud/.eliza` | ignored | Delete only after confirming state is disposable |
| Dependency native modules | `node_modules`, `cloud/node_modules` | ignored | Delete whole dependency tree, not individual files |
| Local caches | `.turbo/cache`, `skills/.cache` | ignored | Safe to delete |
| GGUF vocab files | `plugins/plugin-local-inference/native/llama.cpp/models/*.gguf` | tracked inside gitlink/submodule | Keep if upstream submodule requires them; otherwise manage in submodule, not parent repo |

## JSON and JSONL inventory

Tracked JSON/JSONL inventory:

- 514 tracked folders contain more than one `.json` or `.jsonl` file.
- Those folders account for 2,857 tracked `.json`/`.jsonl` files.
- 290 of those folders contain exactly 2 JSON/JSONL files.
- The large tracked JSON/JSONL clusters are mainly benchmark fixtures,
  scenario pools, registry entries, migrations, app/plugin configs, and test
  mocks.

### Tracked JSON/JSONL folders by root

| Root | JSON/JSONL files in multi-file folders | Folder count | Classification |
|---|---:|---:|---|
| `packages/benchmarks` | 1,227 | 247 | benchmark fixtures, benchmark configs, benchmark test data |
| `packages/app-core` | 130 | 7 | source registry/config plus test/platform data |
| `packages/training` | 112 | 5 | training scenario pools and tracked training/eval datasets |
| `packages/examples` | 88 | 39 | example app/plugin configs |
| `plugins/plugin-local-inference` | 71 | 16 | native verification configs/results and plugin package config |
| `packages/native-plugins` | 49 | 24 | native plugin package/config manifests |
| `test` | 40 | 2 | test mocks/environments |
| `plugins/app-lifeops` | 29 | 4 | scenarios and test catalogs |
| `cloud/packages` | 28 | 7 | DB migration metadata and package configs |
| `packages/elizaos` | 19 | 7 | templates and package configs |
| `cloud/services` | 18 | 8 | service package/config manifests |
| `plugins/app-training` | 17 | 2 | training datasets and plugin config |
| `packages/shared` | 13 | 3 | source i18n/local-inference config |
| `plugins/plugin-wallet` | 12 | 4 | source chain config/artifacts |
| `plugins/plugin-mysticism` | 12 | 4 | source data for engines |
| `packages/ui` | 11 | 2 | UI package/config/locales |
| `scripts` | 10 | 2 | benchmark/config scripts |
| `packages/registry` | 10 | 2 | registry site/package config |

### Tracked JSON/JSONL folders with at least 10 files

| Count | Folder | Classification | Recommendation |
|---:|---|---|---|
| 187 | `packages/benchmarks/qwen-claw-bench/data/qwenclawbench-v1.1-100/assets/task_00029_openclaw_runtime_diagnostics_skill_and_health_audit/sessions` | benchmark session JSONL | Externalize if generated from benchmark corpus; keep if canonical fixture |
| 101 | `packages/benchmarks/OSWorld/evaluation_examples/examples/multi_apps` | benchmark examples | Keep or externalize with OSWorld fixture pack |
| 96 | `packages/training/scripts/harness/scenario_pool` | training/test harness scenario pool | Keep if hand-curated; consider generated manifest boundary |
| 69 | `packages/app-core/src/registry/entries/plugins` | source registry entries | Keep source config |
| 47 | `packages/benchmarks/OSWorld/evaluation_examples/examples/libreoffice_impress` | benchmark examples | Keep/externalize as OSWorld fixtures |
| 47 | `packages/benchmarks/OSWorld/evaluation_examples/examples/libreoffice_calc` | benchmark examples | Keep/externalize as OSWorld fixtures |
| 46 | `packages/benchmarks/OSWorld/evaluation_examples/examples/chrome` | benchmark examples | Keep/externalize as OSWorld fixtures |
| 26 | `packages/benchmarks/OSWorld/evaluation_examples/examples/gimp` | benchmark examples | Keep/externalize as OSWorld fixtures |
| 24 | `packages/benchmarks/OSWorld/evaluation_examples/examples/os` | benchmark examples | Keep/externalize as OSWorld fixtures |
| 23 | `plugins/app-lifeops/scenarios` | source/test scenario definitions | Keep source scenario fixtures |
| 23 | `packages/benchmarks/skillsbench/docs/skills-research` | benchmark research dataset | Externalize if regenerated or archival |
| 23 | `packages/benchmarks/OSWorld/evaluation_examples/examples/libreoffice_writer` | benchmark examples | Keep/externalize as OSWorld fixtures |
| 23 | `packages/app-core/src/registry/entries/connectors` | source registry entries | Keep source config |
| 23 | `packages/app-core/src/registry/entries/apps` | source registry entries | Keep source config |
| 22 | `test/mocks/environments` | test mocks | Keep tests |
| 22 | `packages/benchmarks/OSWorld/evaluation_examples/examples_windows/multi_app` | benchmark examples | Keep/externalize as OSWorld fixtures |
| 22 | `packages/benchmarks/OSWorld/evaluation_examples/examples/vs_code` | benchmark examples | Keep/externalize as OSWorld fixtures |
| 21 | `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/_authoring/candidates/static` | benchmark authoring candidates | Review generated vs canonical |
| 18 | `test/mocks/mockoon` | test mocks | Keep tests |
| 17 | `packages/benchmarks/OSWorld/evaluation_examples/examples/vlc` | benchmark examples | Keep/externalize as OSWorld fixtures |
| 15 | `plugins/plugin-local-inference/native/verify` | native verification configs/results | Split generated results from checked-in fixtures |
| 15 | `packages/benchmarks/OSWorld/evaluation_examples/examples/thunderbird` | benchmark examples | Keep/externalize as OSWorld fixtures |
| 15 | `cloud/packages/db/migrations/meta` | migration snapshots | Keep if required by migration tooling; avoid generated churn |
| 14 | `plugins/app-training/datasets` | training JSONL datasets | Externalize if large/derived |
| 13 | `packages/benchmarks/orchestrator_lifecycle/scenarios` | benchmark scenarios | Keep if canonical benchmark inputs |
| 11 | `plugins/plugin-local-inference/native/verify/fixtures` | native verification fixtures | Keep curated fixtures only |
| 11 | `packages/benchmarks/OSWorld/evaluation_examples/examples_windows/excel` | benchmark examples | Keep/externalize as OSWorld fixtures |
| 10 | `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/_authoring/candidates/live` | benchmark authoring candidates | Review generated vs canonical |

### Folders with exactly two tracked JSON/JSONL files

There are 290 tracked folders with exactly two JSON/JSONL files. Most are
normal package/plugin config pairs (`package.json` plus `tsconfig.json` or
similar), example app configs, native plugin manifests, and small benchmark
fixture directories.

Distribution of those exactly-two folders by root:

| Root | Folder count |
|---|---:|
| `packages/benchmarks` | 172 |
| `packages/examples` | 31 |
| `packages/native-plugins` | 23 |
| `plugins/plugin-local-inference` | 7 |
| `cloud/services` | 7 |
| `cloud/packages` | 5 |
| `packages/elizaos` | 4 |
| `plugins/app-lifeops` | 3 |
| `plugins/plugin-mysticism` | 2 |
| `cloud/apps` | 2 |

The remaining exactly-two folders are one-off app/plugin/package config
directories. These should not be bulk-deleted; they are source configuration
unless they live under a generated output root.

### Generated or ignored JSON/JSONL folders

Generated/ignored JSON folders with more than one JSON/JSONL file:

| Count | Folder | Classification | Suggested action |
|---:|---|---|---|
| 21,834 | `packages/training/local-corpora/light-multilight/source/extracted/episodes/multiparty/room/graphs` | extracted local corpus | Delete if reproducible; keep ignored |
| 12,244 | `.turbo/cache` | cache metadata | Delete cache |
| 10,917 | `packages/training/local-corpora/light-multilight/source/extracted/episodes/multiparty/room` | extracted local corpus | Delete if reproducible |
| 627 | `packages/training/data/raw/pi-mono` | raw training data | Delete/externalize |
| 409 | `packages/training/data/raw/mcp-flow/function_call/mcphub` | raw training data | Delete/externalize |
| 273 | `packages/training/data/raw/mcp-flow/function_call/smithery` | raw training data | Delete/externalize |
| 220 | `packages/benchmarks/benchmark_results/baselines` | generated benchmark results | Delete or keep outside repo |
| 219 | `packages/training/local-corpora/nubilio-trajectories/training-datasets/trajectories` | local corpus/training data | Delete if reproducible |
| 133 | `packages/training/data/raw/mcp-flow/function_call/mcpso` | raw training data | Delete/externalize |
| 115 | `packages/training/data/raw/mcp-flow/function_call/glama` | raw training data | Delete/externalize |
| 112 | `packages/training/data/raw/mcp-flow/function_call/deepnlp` | raw training data | Delete/externalize |
| 100 | `packages/training/data/raw/mcp-flow/function_call/pipedream` | raw training data | Delete/externalize |
| 69 | `packages/app-core/dist/registry/entries/plugins` | generated build output mirror | Delete `dist` |
| 33 | `packages/training/data/raw/mcp-flow/test_data` | raw generated training/test data | Delete/externalize |
| 31 | `packages/training/data/raw/hf-coding-tools-traces` | raw training traces | Delete/externalize |
| 23 | `packages/app-core/dist/registry/entries/connectors` | generated build output mirror | Delete `dist` |
| 23 | `packages/app-core/dist/registry/entries/apps` | generated build output mirror | Delete `dist` |
| 19 | `packages/benchmarks/benchmark_results/rg_*/.../local_db/canvas` | generated benchmark run output | Delete benchmark results |
| 19 | `packages/app-core/dist/platforms/ios/App/Pods/Local Podspecs` | generated build/vendor output | Delete `dist` |
| 18 | `packages/training/data/raw/zomi-opus-tatoeba` | raw training data | Delete/externalize |
| 12 | `packages/training/data/raw/scambench/formats` | raw training data | Delete/externalize |
| 12 | `packages/training/data/raw/scam-defense-corpus/formats` | raw training data | Delete/externalize |
| 10 | `packages/training/data/raw/carnice-glm5-hermes/data` | raw training data | Delete/externalize |

Classification rules for JSON files:

- Source config: package manifests, plugin manifests, registry entries under
  `packages/app-core/src/registry/entries`, migration metadata that is required
  by the migration system, i18n keyword data, and app/plugin config files.
- Test fixtures: `test/mocks/**`, `plugins/*/test/**`,
  `packages/*/test/**`, `plugins/plugin-local-inference/native/verify/fixtures`.
- Benchmark fixtures: `packages/benchmarks/**` except ignored
  `benchmark_results*`; these are canonical only if benchmarks require them at
  checkout time.
- Training data: `packages/training/datasets/**` when tracked intentionally;
  `packages/training/data/**` and `packages/training/local-corpora/**` are
  ignored local data and should remain outside Git.
- Generated build mirrors: any JSON under `dist`, `.turbo/cache`,
  `.wrangler*`, benchmark result directories, and app-core generated platform
  output.

## Recommended `.gitignore` and repo-structure changes

1. Keep existing ignores. Current ignore coverage already handles the largest
   local generated roots:
   - `.turbo` at `.gitignore:72`.
   - `node_modules/` at `.gitignore:203` and `cloud/.gitignore:4`.
   - `dist/` and `**/dist/**` at `.gitignore:85`, `.gitignore:89`, and
     `.gitignore:131`.
   - local DB state via `**/.eliza/` at `.gitignore:151` and `cloud/.gitignore:97`.
   - `.claude` at `.gitignore:280`.
   - TypeScript build info at `.gitignore:256`.
   - caches via `skills/.cache/` and `.cache/` at `.gitignore:432-434`.
   - training `.venv`, `data`, and `local-corpora` in `packages/training/.gitignore`.
   - benchmark result directories in `packages/benchmarks/.gitignore:48`.
2. Add a targeted ignore for local native verification executables:

   ```gitignore
   plugins/plugin-local-inference/native/verify/*.darwin-arm64-*
   plugins/plugin-local-inference/native/verify/qjl_mt_check.*
   ```

   Rationale: `plugins/plugin-local-inference/native/verify/qjl_mt_check.darwin-arm64-metal-fused`
   is currently untracked and looks like a generated Mach-O binary.

3. Avoid a blanket ignore for `reports/eliza1-release-gates/*.json`. Existing
   tracked release-gate evidence lives there, and the current worktree shows
   tracked deletions plus new generated JSON outputs. Prefer one of these
   structures:

   ```text
   reports/eliza1-release-gates/curated/       # tracked evidence
   reports/eliza1-release-gates/generated/     # ignored run output
   ```

   Then ignore only:

   ```gitignore
   reports/eliza1-release-gates/generated/
   ```

4. Add `.gitattributes` rules if large benchmark/media assets stay in-repo but
   should not inflate normal Git history:

   ```gitattributes
   packages/benchmarks/**/*.pdf filter=lfs diff=lfs merge=lfs -text
   packages/benchmarks/**/*.pcap filter=lfs diff=lfs merge=lfs -text
   packages/benchmarks/**/*.pptx filter=lfs diff=lfs merge=lfs -text
   packages/benchmarks/**/*.mp4 filter=lfs diff=lfs merge=lfs -text
   packages/benchmarks/**/*.png filter=lfs diff=lfs merge=lfs -text
   plugins/app-companion/**/*.vrm filter=lfs diff=lfs merge=lfs -text
   plugins/app-companion/**/*.fbx filter=lfs diff=lfs merge=lfs -text
   ```

   Validate repository policy before adding LFS. If LFS is not acceptable,
   use a fixture downloader with content hashes.

5. Split generated benchmark outputs from canonical benchmark fixtures. The
   ignore already catches `**/benchmark_results*/`; keep generated outputs under
   that pattern and avoid committing timestamped run directories.

6. For benchmark fixtures, consider a manifest-based external fixture store:

   ```text
   packages/benchmarks/fixtures-manifest.json
   packages/benchmarks/scripts/fetch-fixtures.ts
   packages/benchmarks/.fixtures/   # ignored local materialized assets
   ```

   The manifest should include URL/source, SHA-256, size, and license/provenance.

7. For public assets, separate editable source assets from runtime assets:

   ```text
   cloud/apps/frontend/public/...       # optimized runtime assets only
   assets/source/...                    # optional LFS/external source images
   ```

   This is relevant for 4096px PNGs and OTF font files.

8. For `.claude/worktrees`, do not change ignore rules. The root ignore already
   excludes them. Cleanup should use Git worktree-aware validation because the
   audit found 115 directories, 111 registered `.claude/worktrees`, and 111
   locked worktrees.

## Recommended validation before deleting

Use dry-run and path-specific validation before deleting anything.

For ignored generated artifacts:

```bash
git check-ignore -v <path>
git status --ignored --short <path>
du -sk <path>
git clean -ndX -- <path>
```

For dependency trees:

```bash
git check-ignore -v node_modules cloud/node_modules
bun install --frozen-lockfile --dry-run  # if supported by current Bun version
```

After deletion, reinstall and run the relevant smoke tests:

```bash
bun install
bun run typecheck
bun test
```

For Wrangler output:

```bash
ps -ax | grep -i wrangler
git check-ignore -v cloud/apps/api/.wrangler/tmp cloud/apps/api/.wrangler-dry-run
git clean -ndX -- cloud/apps/api/.wrangler cloud/apps/api/.wrangler-dry-run
```

Only delete after stopping any active dev server that owns those directories.

For training data and virtualenvs:

```bash
git check-ignore -v packages/training/data packages/training/local-corpora packages/training/.venv
du -sk packages/training/data packages/training/local-corpora packages/training/.venv
```

Before deletion, confirm the data source or script can recreate the data. For
`.venv`, confirm the Python dependency installation path is documented.

For native build outputs:

```bash
git -C plugins/plugin-local-inference/native/llama.cpp check-ignore -v build build-validate
git -C plugins/plugin-local-inference/native/llama.cpp status --short --ignored
```

Rebuild after cleanup with the native plugin's documented build command.

For `.eliza` and `cloud/.eliza` database state:

```bash
git check-ignore -v .eliza cloud/.eliza
find .eliza cloud/.eliza -maxdepth 3 -type f | head
```

Do not delete unless local agent/cloud DB state is known to be disposable or
backed up.

For `.claude/worktrees`:

```bash
git worktree list --porcelain
find .claude/worktrees -maxdepth 1 -mindepth 1 -type d | wc -l
```

Do not use blind `rm -rf`. Remove only stale, unlocked worktrees through a
Git-aware workflow after confirming no active agent owns them.

For tracked asset externalization:

```bash
git ls-tree -r -l HEAD | sort -nr | head
git grep -n '<asset-file-name>'
```

Then validate benchmark/app behavior after moving assets:

```bash
bun test <affected package>
bun run lint
bun run typecheck
```

For public media optimization:

```bash
file <asset>
sips -g pixelWidth -g pixelHeight <asset>  # macOS
```

Validate visual output in app/browser before replacing tracked images.

## Priority recommendations

1. Clean local ignored artifacts first: dependency trees, `.turbo/cache`,
   Wrangler temp output, training raw data, `.venv`, local corpora, and native
   build directories. These are high-confidence and do not require repo design
   decisions.
2. Add targeted ignore coverage for
   `plugins/plugin-local-inference/native/verify/*.darwin-arm64-*` or route
   those binaries into an existing ignored build directory.
3. Decide a policy for `reports/eliza1-release-gates`: curated tracked evidence
   versus generated run output.
4. Externalize or LFS the large benchmark fixtures, starting with the top PDFs,
   `.pcap`, `.pptx`, `.mp4`, and duplicate paper PDFs.
5. Optimize public PNG/font assets separately from benchmark fixture work.
6. Treat `.claude/worktrees` as a workflow cleanup, not a file cleanup. The
   current worktrees are locked and should be handled through `git worktree`
   commands only after stale ownership is verified.

