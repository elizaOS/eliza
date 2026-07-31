# Artifact-sync retirement — full inventory classification

Generated 2026-07-31 for elizaOS/eliza#17487 (issue #16290, redo of #16304).

**Method.** The authoritative in-repo inventory of the retired global artifact
sync is the 499-path `# --- synced artifacts ---` block deleted from the root
`.gitignore` by this PR (the retired `artifacts-manifest.json` claimed a
`fileCount` of 638 for the archive tarball; the 139-entry delta is files that
existed only inside the tarball with no per-path ignore line — not
independently verifiable from this repo, and recoverable only from the archive
itself, `elizaOS/eliza-archive` release `dev-artifacts`). Every entry below was classified mechanically:
`git ls-files` decides *tracked*, a repo-wide `git grep -F` on the basename
(with a parent-directory-qualified second pass for generic basenames) finds
consumers, and known migrated loaders / the new benchmark fixture guard are
annotated explicitly. Grep-by-name is a lead, not proof — entries where a code
consumer survives are listed as **unresolved** rather than guessed at.

| Class | Entries |
| --- | ---: |
| Still needed — committed | 60 |
| Retired — consumer migrated | 6 |
| Benchmark fixture — fail-closed guarded | 15 |
| Retired — dead (no consumer) | 332 |
| Retired — referenced only in docs/markdown | 8 |
| Unresolved — code consumer remains, file unobtainable in-repo | 78 |
| **Total** | **499** |

## Still needed — committed (60)

The file is tracked in git on this branch; retiring the sync does not affect it.

| Path | Note |
| --- | --- |
| `packages/homepage/tests/e2e/visual.spec.ts-snapshots/connected-desktop-chromium-linux.png` | tracked in git |
| `packages/homepage/tests/e2e/visual.spec.ts-snapshots/connected-mobile-chromium-linux.png` | tracked in git |
| `packages/homepage/tests/e2e/visual.spec.ts-snapshots/get-started-desktop-chromium-linux.png` | tracked in git |
| `packages/homepage/tests/e2e/visual.spec.ts-snapshots/get-started-mobile-chromium-linux.png` | tracked in git |
| `packages/homepage/tests/e2e/visual.spec.ts-snapshots/login-desktop-chromium-linux.png` | tracked in git |
| `packages/homepage/tests/e2e/visual.spec.ts-snapshots/login-mobile-chromium-linux.png` | tracked in git |
| `packages/os/homepage/public/assets/billboard_concept.jpg` | tracked in git |
| `packages/os/homepage/public/assets/chibi_usb_concept.jpg` | tracked in git |
| `packages/os/homepage/public/assets/concept_minipc.jpg` | tracked in git |
| `packages/os/homepage/public/assets/concept_phone.jpg` | tracked in git |
| `packages/os/homepage/public/assets/concept_usbdrive.jpg` | tracked in git |
| `packages/os/homepage/public/assets/elizaos-usb-key-concept.png` | tracked in git |
| `packages/os/homepage/public/brand/concepts/billboard_concept.jpg` | tracked in git |
| `packages/os/homepage/public/brand/concepts/chibi_usb_concept.jpg` | tracked in git |
| `packages/os/homepage/public/brand/concepts/concept_minipc.jpg` | tracked in git |
| `packages/os/homepage/public/brand/concepts/concept_phone.jpg` | tracked in git |
| `packages/os/homepage/public/brand/concepts/concept_usbdrive.jpg` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/checkout-desktop-desktop-darwin.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/checkout-desktop-desktop-linux.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/checkout-desktop-mobile-darwin.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/checkout-desktop-mobile-linux.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/hardware-box-desktop-desktop-darwin.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/hardware-box-desktop-desktop-linux.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/hardware-box-desktop-mobile-darwin.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/hardware-box-desktop-mobile-linux.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/hardware-case-desktop-desktop-darwin.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/hardware-case-desktop-desktop-linux.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/hardware-case-desktop-mobile-darwin.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/hardware-case-desktop-mobile-linux.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/hardware-chibi-usb-desktop-desktop-darwin.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/hardware-chibi-usb-desktop-desktop-linux.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/hardware-chibi-usb-desktop-mobile-darwin.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/hardware-chibi-usb-desktop-mobile-linux.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/hardware-mini-pc-desktop-desktop-darwin.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/hardware-mini-pc-desktop-desktop-linux.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/hardware-mini-pc-desktop-mobile-darwin.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/hardware-mini-pc-desktop-mobile-linux.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/hardware-raspberry-pi-desktop-desktop-darwin.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/hardware-raspberry-pi-desktop-desktop-linux.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/hardware-raspberry-pi-desktop-mobile-darwin.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/hardware-raspberry-pi-desktop-mobile-linux.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/hardware-usb-desktop-desktop-darwin.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/hardware-usb-desktop-desktop-linux.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/hardware-usb-desktop-mobile-darwin.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/hardware-usb-desktop-mobile-linux.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/landing-desktop-desktop-darwin.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/landing-desktop-desktop-linux.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/landing-desktop-mobile-darwin.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/landing-desktop-mobile-linux.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/landing-mobile-desktop-darwin.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/landing-mobile-desktop-linux.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/landing-mobile-mobile-darwin.png` | tracked in git |
| `packages/os/homepage/tests/visual.spec.ts-snapshots/landing-mobile-mobile-linux.png` | tracked in git |
| `packages/training/data/voice/sam-distill/synthesis_manifest.jsonl` | tracked in git |
| `plugins/plugin-contacts/assets/hero.png` | tracked in git |
| `plugins/plugin-feed/assets/hero.png` | tracked in git |
| `plugins/plugin-phone/assets/hero.png` | tracked in git |
| `plugins/plugin-task-coordinator/assets/hero.png` | tracked in git |
| `plugins/plugin-trajectory-logger/assets/hero.png` | tracked in git |
| `plugins/plugin-wifi/assets/hero.png` | tracked in git |

## Retired — consumer migrated (6)

A consumer exists but no longer depends on the synced copy: it builds, downloads, or fails closed on its own.

| Path | Note |
| --- | --- |
| `packages/benchmarks/tau-bench/elizaos_tau_bench/upstream/envs/airline/data/flights.json` | loader migrated to elizaos_tau_bench/data_assets.py (upstream download/cache, fails closed) |
| `packages/benchmarks/tau-bench/elizaos_tau_bench/upstream/envs/airline/data/reservations.json` | loader migrated to elizaos_tau_bench/data_assets.py (upstream download/cache, fails closed) |
| `packages/benchmarks/tau-bench/elizaos_tau_bench/upstream/envs/airline/data/users.json` | loader migrated to elizaos_tau_bench/data_assets.py (upstream download/cache, fails closed) |
| `packages/benchmarks/tau-bench/elizaos_tau_bench/upstream/envs/retail/data/orders.json` | loader migrated to elizaos_tau_bench/data_assets.py (upstream download/cache, fails closed) |
| `packages/benchmarks/tau-bench/elizaos_tau_bench/upstream/envs/retail/data/users.json` | loader migrated to elizaos_tau_bench/data_assets.py (upstream download/cache, fails closed) |
| `plugins/plugin-local-inference/native/verify/cuda_verify` | explicit in-repo producer: plugins/plugin-local-inference/native/verify/Makefile (nvcc); gitignored build product |

## Benchmark fixture — fail-closed guarded (15)

Archive-only Terminal-Bench task fixtures. `elizaos_terminal_bench/fixture_guard.py` raises a typed MissingArchiveFixtureError naming the file and the recovery path before any Docker build or staging step.

| Path | Note |
| --- | --- |
| `packages/benchmarks/terminal-bench/tasks/build-pov-ray/tests/reference_illum1.png` | fail-closed guarded by elizaos_terminal_bench/fixture_guard.py |
| `packages/benchmarks/terminal-bench/tasks/causal-inference-r/task-deps/data.csv` | fail-closed guarded by elizaos_terminal_bench/fixture_guard.py |
| `packages/benchmarks/terminal-bench/tasks/download-youtube/tests/long_trunks.mp4` | fail-closed guarded by elizaos_terminal_bench/fixture_guard.py |
| `packages/benchmarks/terminal-bench/tasks/financial-document-processor/documents/1t2tala7.jpg` | fail-closed guarded by elizaos_terminal_bench/fixture_guard.py |
| `packages/benchmarks/terminal-bench/tasks/financial-document-processor/documents/53lc58dr.jpg` | fail-closed guarded by elizaos_terminal_bench/fixture_guard.py |
| `packages/benchmarks/terminal-bench/tasks/financial-document-processor/documents/sg65kxvf.jpg` | fail-closed guarded by elizaos_terminal_bench/fixture_guard.py |
| `packages/benchmarks/terminal-bench/tasks/financial-document-processor/documents/ujv6oh9s.jpg` | fail-closed guarded by elizaos_terminal_bench/fixture_guard.py |
| `packages/benchmarks/terminal-bench/tasks/fmri-encoding-r/fMRIdata.RData` | fail-closed guarded by elizaos_terminal_bench/fixture_guard.py |
| `packages/benchmarks/terminal-bench/tasks/gcode-to-text/text.gcode.gz` | fail-closed guarded by elizaos_terminal_bench/fixture_guard.py |
| `packages/benchmarks/terminal-bench/tasks/reshard-c4-data/tests/files_hashes.json` | fail-closed guarded by elizaos_terminal_bench/fixture_guard.py |
| `packages/benchmarks/terminal-bench/tasks/sqlite-with-gcov/vendor/sqlite-fossil-release.tar.gz` | fail-closed guarded by elizaos_terminal_bench/fixture_guard.py |
| `packages/benchmarks/terminal-bench/tasks/train-fasttext/tests/private_test.txt` | fail-closed guarded by elizaos_terminal_bench/fixture_guard.py |
| `packages/benchmarks/terminal-bench/tasks/video-processing/example_video.mp4` | fail-closed guarded by elizaos_terminal_bench/fixture_guard.py |
| `packages/benchmarks/terminal-bench/tasks/video-processing/tests/test_video.mp4` | fail-closed guarded by elizaos_terminal_bench/fixture_guard.py |
| `packages/benchmarks/terminal-bench/tasks/weighted-max-sat-solver/test_instance.wcnf` | fail-closed guarded by elizaos_terminal_bench/fixture_guard.py |

## Retired — dead (no consumer) (332)

Repo-wide grep on the basename (and a parent-dir-qualified second pass where the basename is generic) found no consumer outside the retired sync machinery.

| Path | Note |
| --- | --- |
| `.eliza-artifacts-version` | referenced only by the authority contract's own marker list |
| `packages/app-core/platforms/electrobun/assets/appIcon.iconset/icon_512x512@2x.png` | basename matched only unrelated files; parent-dir-qualified grep: 0 consumers |
| `packages/app-core/platforms/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-1.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/app-core/platforms/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-2.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/app-core/platforms/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/benchmarks/OSWorld/assets/authorization.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/benchmarks/OSWorld/assets/pubeval_monitor1.jpg` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/benchmarks/OSWorld/assets/pubeval_monitor2.jpg` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/benchmarks/OSWorld/assets/pubeval_subnet.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/benchmarks/OSWorld/assets/pubeval3.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/benchmarks/OSWorld/assets/unsafemode.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/benchmarks/OSWorld/assets/usertype.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/benchmarks/solana/solana-gym-env/docs/trajectory-viewer/public/assets/program_discovery.png` | basename matched only unrelated files; parent-dir-qualified grep: 0 consumers |
| `packages/cloud-frontend/public/agents/agent-2.webp` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/cloud-frontend/public/avatars/eliza-default.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/cloud-frontend/public/avatars/historyscholar.webp` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/cloud-frontend/public/brand/elizaos-phone-transparent.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/cloud-frontend/public/brand/elizaos-phone.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/cloud-frontend/tests/e2e/visual.spec.ts-snapshots/terms-of-service-desktop-chromium-desktop-darwin.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/cloud-frontend/tests/e2e/visual.spec.ts-snapshots/terms-of-service-desktop-chromium-mobile-darwin.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/cloud-frontend/tests/e2e/visual.spec.ts-snapshots/terms-of-service-mobile-chromium-desktop-darwin.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/cloud-frontend/tests/e2e/visual.spec.ts-snapshots/terms-of-service-mobile-chromium-mobile-darwin.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/elizaos/templates/project/apps/app/electrobun/assets/appIcon.iconset/icon_512x512@2x.png` | basename matched only unrelated files; parent-dir-qualified grep: 0 consumers |
| `packages/homepage/tests/e2e/visual.spec.ts-snapshots/connected-mobile-chromium-darwin.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/homepage/tests/e2e/visual.spec.ts-snapshots/get-started-mobile-chromium-darwin.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/os/linux/tails/wiki/src/news/celebrating_10_years/tails-1.0.png` | basename matched only unrelated files; parent-dir-qualified grep: 0 consumers |
| `packages/os/setup/public/clouds/clouds_1x_1080p.mp4` | basename matched only unrelated files; parent-dir-qualified grep: 0 consumers |
| `packages/os/setup/public/clouds/clouds_1x_1080p.webm` | basename matched only unrelated files; parent-dir-qualified grep: 0 consumers |
| `packages/os/setup/public/clouds/clouds_1x_720p.mp4` | basename matched only unrelated files; parent-dir-qualified grep: 0 consumers |
| `packages/os/setup/public/clouds/clouds_1x_720p.webm` | basename matched only unrelated files; parent-dir-qualified grep: 0 consumers |
| `packages/os/setup/public/clouds/clouds_4x_1080p.mp4` | basename matched only unrelated files; parent-dir-qualified grep: 0 consumers |
| `packages/os/setup/public/clouds/clouds_4x_1080p.webm` | basename matched only unrelated files; parent-dir-qualified grep: 0 consumers |
| `packages/os/setup/public/clouds/clouds_4x_480p.mp4` | basename matched only unrelated files; parent-dir-qualified grep: 0 consumers |
| `packages/os/setup/public/clouds/clouds_4x_480p.webm` | basename matched only unrelated files; parent-dir-qualified grep: 0 consumers |
| `packages/os/setup/public/clouds/clouds_4x_720p.mp4` | basename matched only unrelated files; parent-dir-qualified grep: 0 consumers |
| `packages/os/setup/public/clouds/clouds_4x_720p.webm` | basename matched only unrelated files; parent-dir-qualified grep: 0 consumers |
| `packages/os/setup/public/clouds/clouds_8x_1080p.mp4` | basename matched only unrelated files; parent-dir-qualified grep: 0 consumers |
| `packages/os/setup/public/clouds/clouds_8x_1080p.webm` | basename matched only unrelated files; parent-dir-qualified grep: 0 consumers |
| `packages/os/setup/public/clouds/clouds_8x_360p.mp4` | basename matched only unrelated files; parent-dir-qualified grep: 0 consumers |
| `packages/os/setup/public/clouds/clouds_8x_360p.webm` | basename matched only unrelated files; parent-dir-qualified grep: 0 consumers |
| `packages/os/setup/public/clouds/clouds_8x_480p.mp4` | basename matched only unrelated files; parent-dir-qualified grep: 0 consumers |
| `packages/os/setup/public/clouds/clouds_8x_480p.webm` | basename matched only unrelated files; parent-dir-qualified grep: 0 consumers |
| `packages/os/setup/public/clouds/clouds_8x_720p.mp4` | basename matched only unrelated files; parent-dir-qualified grep: 0 consumers |
| `packages/os/setup/public/clouds/clouds_8x_720p.webm` | basename matched only unrelated files; parent-dir-qualified grep: 0 consumers |
| `packages/research/chip/board/kicad/e1-phone/pcb/fab-demo/e1-phone-mainboard-real-footprint-development.step` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/chip/board/kicad/e1-phone/pcb/fab-demo/e1-phone-mainboard-routed-development.step` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/chip/board/kicad/e1-phone/preview/kicad-cli-mainboard.svg` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/chip/board/kicad/e1-phone/preview/schematic/e1-phone-compute.svg` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/chip/board/kicad/e1-phone/preview/schematic/e1-phone-power_usb.svg` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/chip/board/kicad/e1-phone/production/sourcing/public-cad-downloads/hirose_bm28b0_6_24dp_2_0_35v_53/BM28B0.6-24DP_2-0.35V_3d_stp.stp` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/chip/board/kicad/e1-phone/production/sourcing/public-cad-downloads/hirose_bm28b0_6_50dp_2_0_35v_53/BM28B0.6-50DP_2-0.35V_3d_stp.stp` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/chip/board/kicad/e1-phone/production/sourcing/public-cad-downloads/hirose_df40c_80dp_0_4v_51/DF40C-80DP-0.4V_3d_stp.stp` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/chip/board/kicad/e1-phone/production/step/routed-board-with-components.step` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/chip/docs/evidence/cpu_ap/bpu_h2p_sc_debug_replay.json` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/chip/mechanical/e1-phone/out/e1-phone-exploded.mp4` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/chip/mechanical/e1-phone/out/e1-phone-solid-assembly.step` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/chip/mechanical/e1-phone/out/orange_back_shell.step` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/chip/mechanical/e1-phone/out/orange_side_frame.step` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/chip/mechanical/e1-phone/review/local-kicad-cli/routed-drc.json` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/chip/mechanical/e1-phone/review/part-explode-contact-sheet.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/chip/sw/aosp-device/fixtures/golden-stt.wav` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/chip/sw/firemarshal/eliza-e1-ap-benchmarks/bin/ap-bench-lite` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/chip/sw/firemarshal/eliza-e1-ap-benchmarks/bin/coremark` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/chip/sw/firemarshal/eliza-e1-ap-benchmarks/bin/fio` | basename matched only unrelated files; parent-dir-qualified grep: 0 consumers |
| `packages/research/chip/sw/firemarshal/eliza-e1-ap-benchmarks/bin/lat_mem_rd` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/chip/sw/firemarshal/eliza-e1-ap-benchmarks/bin/stream_c.exe` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/chip/sw/firemarshal/eliza-e1-linux-smoke/e1-npu-ml-smoke` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/chip/sw/firemarshal/eliza-e1-linux-smoke/eliza-riscv-hwprobe` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/asimov-1/meshes/IMU_ORIGIN.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/asimov-1/meshes/LEFT_ANKLE_B.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/asimov-1/meshes/LEFT_ELBOW.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/asimov-1/meshes/LEFT_HIP_PITCH.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/asimov-1/meshes/LEFT_HIP_ROLL.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/asimov-1/meshes/LEFT_HIP_YAW.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/asimov-1/meshes/LEFT_KNEE.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/asimov-1/meshes/LEFT_SHOULDER_PITCH.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/asimov-1/meshes/LEFT_SHOULDER_ROLL.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/asimov-1/meshes/LEFT_SHOULDER_YAW.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/asimov-1/meshes/NECK_PITCH.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/asimov-1/meshes/NECK_YAW.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/asimov-1/meshes/RIGHT_ANKLE_B.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/asimov-1/meshes/RIGHT_ELBOW.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/asimov-1/meshes/RIGHT_HIP_PITCH.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/asimov-1/meshes/RIGHT_HIP_ROLL.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/asimov-1/meshes/RIGHT_HIP_YAW.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/asimov-1/meshes/RIGHT_KNEE.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/asimov-1/meshes/RIGHT_SHOULDER_PITCH.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/asimov-1/meshes/RIGHT_SHOULDER_ROLL.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/asimov-1/meshes/RIGHT_SHOULDER_YAW.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/asimov-1/meshes/WAIST_YAW.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/hiwonder-ainex/meshes/body_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/hiwonder-ainex/meshes/l_ank_pitch_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/hiwonder-ainex/meshes/l_hip_roll_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/hiwonder-ainex/meshes/l_sho_roll_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/hiwonder-ainex/meshes/r_ank_pitch_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/hiwonder-ainex/meshes/r_hip_roll_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/hiwonder-ainex/meshes/r_sho_roll_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/head_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/left_ankle_roll_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/left_hand_index_0_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/left_hand_index_1_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/left_hand_middle_0_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/left_hand_middle_1_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/left_hand_palm_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/left_hand_thumb_1_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/left_hand_thumb_2_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/left_hip_yaw_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/left_knee_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/left_rubber_hand.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/left_shoulder_roll_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/left_wrist_roll_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/left_wrist_yaw_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/pelvis_contour_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/pelvis.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/right_ankle_roll_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/right_hand_index_0_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/right_hand_index_1_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/right_hand_middle_0_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/right_hand_middle_1_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/right_hand_palm_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/right_hand_thumb_1_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/right_hand_thumb_2_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/right_hip_yaw_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/right_knee_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/right_rubber_hand.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/right_shoulder_roll_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/right_wrist_roll_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/right_wrist_yaw_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/torso_link_rev_1_0.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-g1/mjcf/assets/waist_yaw_link_rev_1_0.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-h1/mjcf/assets/left_hip_pitch_link.stl` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-h1/mjcf/assets/left_hip_roll_link.stl` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-h1/mjcf/assets/left_hip_yaw_link.stl` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-h1/mjcf/assets/left_knee_link.stl` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-h1/mjcf/assets/left_shoulder_pitch_link.stl` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-h1/mjcf/assets/left_shoulder_roll_link.stl` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-h1/mjcf/assets/left_shoulder_yaw_link.stl` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-h1/mjcf/assets/pelvis.stl` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-h1/mjcf/assets/right_hip_pitch_link.stl` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-h1/mjcf/assets/right_hip_roll_link.stl` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-h1/mjcf/assets/right_hip_yaw_link.stl` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-h1/mjcf/assets/right_knee_link.stl` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-h1/mjcf/assets/right_shoulder_pitch_link.stl` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-h1/mjcf/assets/right_shoulder_roll_link.stl` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-h1/mjcf/assets/right_shoulder_yaw_link.stl` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-h1/mjcf/assets/torso_link.stl` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-r1/mjcf/assets/head_pitch_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-r1/mjcf/assets/head_yaw_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-r1/mjcf/assets/left_ankle_roll_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-r1/mjcf/assets/left_elbow_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-r1/mjcf/assets/left_hip_pitch_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-r1/mjcf/assets/left_hip_roll_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-r1/mjcf/assets/left_hip_yaw_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-r1/mjcf/assets/left_knee_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-r1/mjcf/assets/left_shoulder_pitch_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-r1/mjcf/assets/left_shoulder_roll_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-r1/mjcf/assets/left_shoulder_yaw_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-r1/mjcf/assets/left_wrist_roll_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-r1/mjcf/assets/pelvis_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-r1/mjcf/assets/right_ankle_roll_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-r1/mjcf/assets/right_elbow_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-r1/mjcf/assets/right_hip_pitch_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-r1/mjcf/assets/right_hip_roll_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-r1/mjcf/assets/right_hip_yaw_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-r1/mjcf/assets/right_knee_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-r1/mjcf/assets/right_shoulder_pitch_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-r1/mjcf/assets/right_shoulder_roll_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-r1/mjcf/assets/right_shoulder_yaw_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-r1/mjcf/assets/right_wrist_roll_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-r1/mjcf/assets/waist_roll_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/assets/profiles/unitree-r1/mjcf/assets/waist_yaw_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/cad/erobot/erobot_views.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/cad/erobot/visual/erobot_views.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/cad/erobot/visual/parts_grid.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/checkpoints/_validator/final_params` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/examples/robot-mujoco-demo/evidence/aruco_full_anchor/obsbot_live.mp4` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/examples/robot-mujoco-demo/evidence/aruco_full_anchor/side_by_side.mp4` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/examples/robot-mujoco-demo/evidence/live/live_camera_aruco_annotated.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/examples/robot-mujoco-demo/evidence/live/live_camera_aruco_contact_sheet.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/examples/robot-mujoco-demo/evidence/live/live_camera_aruco.mp4` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/examples/robot-mujoco-demo/evidence/live/live_camera_frame.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/examples/robot-mujoco-demo/evidence/real/real_robot_contact_sheet.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/examples/robot-mujoco-demo/evidence/real/real_robot_onboard_strip.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/examples/robot-mujoco-demo/evidence/real/real_robot_sweep_robot_cam.mp4` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/examples/robot-mujoco-demo/evidence/sweep/actions_contact_sheet.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/examples/robot-mujoco-demo/evidence/sweep/actions_sweep.mp4` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/mechanical/unitree-r1-bodykit/cad/source-assets/concept/eliza_front_reference.glb` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/mechanical/unitree-r1-bodykit/cad/source-assets/concept/eliza_front_reference.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/mechanical/unitree-r1-bodykit/cad/source-assets/human-donor/eliza_face_donor.obj` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/mechanical/unitree-r1-bodykit/cad/source-assets/human-donor/eliza_face_donor.stl` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/mechanical/unitree-r1-bodykit/review/blender-bodykit-parts.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/mechanical/unitree-r1-bodykit/review/cad-step-evidence.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/mechanical/unitree-r1-bodykit/review/current-cad-step-screenshot.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/mechanical/unitree-r1-bodykit/review/eliza-donor.blend` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/mechanical/unitree-r1-bodykit/review/eliza-donor.blend1` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/mechanical/unitree-r1-bodykit/review/eliza-face-donor.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/mechanical/unitree-r1-bodykit/review/manufacturing-manifest.json` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/mechanical/unitree-r1-bodykit/review/unitree-r1-bodykit.blend` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/mechanical/unitree-r1-bodykit/review/unitree-r1-bodykit.blend1` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/mechanical/unitree-r1-bodykit/review/visual-concept-orange-android.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/vendor/unitree_mujoco/unitree_robots/r1/meshes/head_pitch_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/vendor/unitree_mujoco/unitree_robots/r1/meshes/head_yaw_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/vendor/unitree_mujoco/unitree_robots/r1/meshes/left_ankle_roll_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/vendor/unitree_mujoco/unitree_robots/r1/meshes/left_elbow_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/vendor/unitree_mujoco/unitree_robots/r1/meshes/left_hip_pitch_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/vendor/unitree_mujoco/unitree_robots/r1/meshes/left_hip_roll_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/vendor/unitree_mujoco/unitree_robots/r1/meshes/left_hip_yaw_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/vendor/unitree_mujoco/unitree_robots/r1/meshes/left_knee_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/vendor/unitree_mujoco/unitree_robots/r1/meshes/left_shoulder_pitch_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/vendor/unitree_mujoco/unitree_robots/r1/meshes/left_shoulder_roll_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/vendor/unitree_mujoco/unitree_robots/r1/meshes/left_shoulder_yaw_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/vendor/unitree_mujoco/unitree_robots/r1/meshes/left_wrist_roll_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/vendor/unitree_mujoco/unitree_robots/r1/meshes/pelvis_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/vendor/unitree_mujoco/unitree_robots/r1/meshes/right_ankle_roll_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/vendor/unitree_mujoco/unitree_robots/r1/meshes/right_elbow_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/vendor/unitree_mujoco/unitree_robots/r1/meshes/right_hip_pitch_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/vendor/unitree_mujoco/unitree_robots/r1/meshes/right_hip_roll_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/vendor/unitree_mujoco/unitree_robots/r1/meshes/right_hip_yaw_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/vendor/unitree_mujoco/unitree_robots/r1/meshes/right_knee_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/vendor/unitree_mujoco/unitree_robots/r1/meshes/right_shoulder_pitch_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/vendor/unitree_mujoco/unitree_robots/r1/meshes/right_shoulder_roll_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/vendor/unitree_mujoco/unitree_robots/r1/meshes/right_shoulder_yaw_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/vendor/unitree_mujoco/unitree_robots/r1/meshes/right_wrist_roll_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/vendor/unitree_mujoco/unitree_robots/r1/meshes/waist_roll_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/research/robot/vendor/unitree_mujoco/unitree_robots/r1/meshes/waist_yaw_link.STL` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/training/datasets/eliza1-sft-0_6b/train.jsonl` | basename matched only unrelated files; parent-dir-qualified grep: 0 consumers |
| `packages/ui/src/components/shell/__e2e__/output-home/02-mobile-home-editing.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/02-desktop-half.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/03-desktop-full.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/04-desktop-beyond-full-rubberband.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/05-desktop-mid-drag-hold.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/06-desktop-free-rest.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/08-desktop-flick-open.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/09-desktop-flick-open.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/09-desktop-nudge-snapback.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/10-desktop-nudge-snapback.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/11-mobile-half.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/12-mobile-full.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/12-mobile-half.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/13-mobile-beyond-full-rubberband.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/13-mobile-full.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/14-mobile-beyond-full-rubberband.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/14-mobile-mid-drag-hold.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/15-mobile-mid-drag-hold.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/16-mobile-free-rest.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/17-mobile-flick-open.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/18-mobile-nudge-snapback.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/19-mobile-flick-open.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/20-mobile-nudge-snapback.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/24-state-responding.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/25-state-typing-send.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/26-state-responding.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/27-state-typing-send.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/29-state-multiline-input.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/31-state-keyboard-full.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/31-state-multiline-input.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/32-state-no-provider-gate.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/33-state-keyboard-full.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/33-state-reduced-motion-open.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/34-state-no-provider-gate.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__e2e__/output/34-state-reduced-motion-open.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__screenshots__/slash-commands/01-all-commands--desktop.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__screenshots__/slash-commands/02-filtered--desktop.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__screenshots__/slash-commands/03-settings-sections--desktop.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/components/shell/__screenshots__/slash-commands/04-settings-filtered--desktop.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/first-run/__e2e__/output/01-mobile-choose.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/first-run/__e2e__/output/02-mobile-choose-no-local-runtime.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/first-run/__e2e__/output/03-mobile-choose-cloud-connected.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/first-run/__e2e__/output/04-mobile-remote.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/first-run/__e2e__/output/05-mobile-cloud-signin.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `packages/ui/src/first-run/__e2e__/output/06-mobile-busy.png` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/BreathingIdle.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/emotes/dance-happy.glb` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/emotes/dance-popping.glb` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/emotes/fishing.glb` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/Idle.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Acknowledging.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Agreeing 2.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Agreeing.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Angry.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Bashful.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Blow A Kiss.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Bored.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Breakdance Freeze Var 4.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Breathing Idle.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Cheering.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Clapping.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Crying.fbx` | basename matched only unrelated files; parent-dir-qualified grep: 0 consumers |
| `plugins/plugin-companion/public_src/animations/mixamo/Fallen Idle.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Gangnam Style.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Happy Idle.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Happy.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Hard Head Nod.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Hip Hop Dancing 2.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Hip Hop Dancing.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Joyful Jump.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Kneeling Idle.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Look Around.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Looking.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Mma Kick.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Rejected.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Relieved Sigh.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Rumba Dancing.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Salute.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Shoulder Rubbing.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Spin In Place.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Standing Greeting 2.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Surprised.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Thankful.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Thinking.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Wave Hip Hop Dance.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Whatever Gesture.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/mixamo/Yawn.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public_src/animations/Standing Greeting.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public/animations/emotes/dance-happy.glb.gz` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public/animations/emotes/dance-popping.glb.gz` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public/animations/emotes/greeting.fbx` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public/animations/mixamo/Angry.fbx.gz` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public/animations/mixamo/Bashful.fbx.gz` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public/animations/mixamo/Bored.fbx.gz` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public/animations/mixamo/Happy.fbx.gz` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public/animations/mixamo/Hip Hop Dancing 2.fbx.gz` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public/animations/mixamo/Look Around.fbx.gz` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public/animations/mixamo/Wave Hip Hop Dance.fbx.gz` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public/animations/mixamo/Yawn.fbx.gz` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public/vrms/eliza-2.vrm.gz` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public/vrms/eliza-3.vrm.gz` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public/vrms/eliza-4.vrm.gz` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public/vrms/eliza-5.vrm.gz` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public/vrms/eliza-6.vrm.gz` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public/vrms/eliza-7.vrm.gz` | no consumer (repo-wide grep on basename: 0 hits) |
| `plugins/plugin-companion/public/vrms/eliza-8.vrm.gz` | no consumer (repo-wide grep on basename: 0 hits) |

## Retired — referenced only in docs/markdown (8)

The only remaining references are prose (README/guides). The docs reference is stale-but-harmless; fix opportunistically.

| Path | Note |
| --- | --- |
| `packages/app-core/test/contracts/lib/openzeppelin-contracts/audits/2018-10.pdf` | referenced only in docs/markdown: packages/app-core/test/contracts/lib/openzeppelin-contracts/audits/README.md |
| `packages/app-core/test/contracts/lib/openzeppelin-contracts/audits/2023-05-v4.9.pdf` | referenced only in docs/markdown: packages/app-core/test/contracts/lib/openzeppelin-contracts/audits/README.md |
| `packages/app-core/test/contracts/lib/openzeppelin-contracts/audits/2023-10-v5.0.pdf` | referenced only in docs/markdown: packages/app-core/test/contracts/lib/openzeppelin-contracts/audits/README.md |
| `packages/app-core/test/contracts/lib/openzeppelin-contracts/audits/2024-10-v5.1.pdf` | referenced only in docs/markdown: packages/app-core/test/contracts/lib/openzeppelin-contracts/audits/README.md |
| `packages/app-core/test/contracts/lib/openzeppelin-contracts/audits/2025-07-v5.4.pdf` | referenced only in docs/markdown: packages/app-core/test/contracts/lib/openzeppelin-contracts/audits/README.md |
| `packages/app-core/test/contracts/lib/openzeppelin-contracts/audits/2026-02-v5.6.pdf` | referenced only in docs/markdown: packages/app-core/test/contracts/lib/openzeppelin-contracts/audits/README.md |
| `packages/benchmarks/OSWorld/mm_agents/uipath/imgs/element_predictions.png` | referenced only in docs/markdown: packages/benchmarks/OSWorld/mm_agents/uipath/README.md |
| `packages/benchmarks/OSWorld/mm_agents/uipath/imgs/schema.png` | referenced only in docs/markdown: packages/benchmarks/OSWorld/mm_agents/uipath/README.md |

## Unresolved — code consumer remains, file unobtainable in-repo (78)

A code-level reference to the path still exists but the file has no in-repo producer after the sync retirement. Each needs a per-surface decision: commit a small replacement, migrate the consumer, or delete the reference.

| Path | Note |
| --- | --- |
| `packages/app/public/app-heroes/database-viewer.png` | consumers: packages/app-core/scripts/playwright-ui-smoke-api-stub.mjs, scripts/generated/static-asset-manifest.json |
| `packages/app/public/app-heroes/log-viewer.png` | consumers: packages/app-core/scripts/playwright-ui-smoke-api-stub.mjs, scripts/generated/static-asset-manifest.json |
| `packages/app/public/app-heroes/memory-viewer.png` | consumers: packages/app-core/scripts/playwright-ui-smoke-api-stub.mjs, scripts/generated/static-asset-manifest.json |
| `packages/app/public/app-heroes/plugin-viewer.png` | consumers: packages/app-core/scripts/playwright-ui-smoke-api-stub.mjs, scripts/generated/static-asset-manifest.json |
| `packages/app/public/app-heroes/relationship-viewer.png` | consumers: packages/app-core/scripts/playwright-ui-smoke-api-stub.mjs, scripts/generated/static-asset-manifest.json |
| `packages/app/public/app-heroes/runtime-debugger.png` | consumers: packages/app-core/scripts/playwright-ui-smoke-api-stub.mjs, scripts/generated/static-asset-manifest.json |
| `packages/app/public/app-heroes/skills-viewer.png` | consumers: packages/app-core/scripts/playwright-ui-smoke-api-stub.mjs, scripts/generated/static-asset-manifest.json |
| `packages/app/public/app-heroes/trajectory-viewer.png` | consumers: packages/app-core/scripts/playwright-ui-smoke-api-stub.mjs, scripts/generated/static-asset-manifest.json |
| `packages/app/public/brand/background/Clouds_Loop_HQ_1080p.mp4` | consumers: packages/shared/src/brand-classic/index.ts, scripts/generated/static-asset-manifest.json |
| `packages/app/public/brand/background/Clouds_Loop_Mobile_480p.mp4` | consumers: packages/shared/src/brand-classic/index.ts, scripts/generated/static-asset-manifest.json |
| `packages/app/public/brand/concepts/billboard_concept.jpg` | consumers: packages/shared/src/brand-classic/index.ts, scripts/generated/static-asset-manifest.json |
| `packages/app/public/brand/concepts/chibi_usb_concept.jpg` | consumers: packages/shared/src/brand-classic/index.ts, scripts/generated/static-asset-manifest.json |
| `packages/app/public/brand/concepts/concept_minipc.jpg` | consumers: packages/shared/src/brand-classic/index.ts, scripts/generated/static-asset-manifest.json |
| `packages/app/public/brand/concepts/concept_phone.jpg` | consumers: packages/shared/src/brand-classic/index.ts, scripts/generated/static-asset-manifest.json |
| `packages/app/public/brand/concepts/concept_usbdrive.jpg` | consumers: packages/shared/src/brand-classic/index.ts, scripts/generated/static-asset-manifest.json |
| `packages/benchmarks/HyperliquidBench/assets/logo.png` | consumers: packages/feed/packages/testing/unit/shared/assets.test.ts, plugins/plugin-agent-orchestrator/src/__tests__/diff-review-gate.test.ts |
| `packages/benchmarks/OSWorld/mm_agents/mobileagent_v3/Perplexica_rag_knowledge_verified.json` | consumers: packages/benchmarks/OSWorld/scripts/python/run_multienv_mobileagent_v3.py |
| `packages/cloud-frontend/public/avatars/amara.webp` | consumers: packages/cloud/shared/src/lib/utils/default-avatar.ts |
| `packages/cloud-frontend/public/avatars/eliza.png` | consumers: packages/agent/src/config/schema.ts, packages/cloud/api/src/blob-host.test.ts, packages/cloud/shared/src/lib/utils/default-avatar.ts (+1 more) |
| `packages/cloud-frontend/public/brand/background/Clouds_Loop_HQ_1080p.mp4` | consumers: packages/shared/src/brand-classic/index.ts, scripts/generated/static-asset-manifest.json |
| `packages/cloud-frontend/public/brand/background/Clouds_Loop_Mobile_480p.mp4` | consumers: packages/shared/src/brand-classic/index.ts, scripts/generated/static-asset-manifest.json |
| `packages/cloud-frontend/public/product/elizaos-usb-key-concept.png` | consumers: scripts/generated/static-asset-manifest.json |
| `packages/docs/images/ask-to-join-vc.jpeg` | consumers: packages/app-core/packaging/flatpak/ai.elizaos.App.metainfo.xml |
| `packages/docs/images/shakespeare-discord-screenshot.jpeg` | consumers: packages/app-core/packaging/flatpak/ai.elizaos.App.metainfo.xml |
| `packages/docs/images/shakespeare-screenshot.jpeg` | consumers: packages/app-core/packaging/flatpak/ai.elizaos.App.metainfo.xml |
| `packages/homepage/public/brand/background/Clouds_Loop_HQ_1080p.mp4` | consumers: packages/shared/src/brand-classic/index.ts, scripts/generated/static-asset-manifest.json |
| `packages/homepage/public/brand/background/Clouds_Loop_Mobile_480p.mp4` | consumers: packages/shared/src/brand-classic/index.ts, scripts/generated/static-asset-manifest.json |
| `packages/homepage/public/product/elizaos-usb-key-concept.png` | consumers: scripts/generated/static-asset-manifest.json |
| `packages/os/homepage/public/brand/background/Clouds_Loop_HQ_1080p.mp4` | consumers: packages/shared/src/brand-classic/index.ts, scripts/generated/static-asset-manifest.json |
| `packages/os/homepage/public/brand/background/Clouds_Loop_Mobile_480p.mp4` | consumers: packages/shared/src/brand-classic/index.ts, scripts/generated/static-asset-manifest.json |
| `packages/os/linux/elizaos/config/includes.chroot/opt/elizaos-artifacts/elizaos-app/agent-bundle.js` | consumers: .gitleaksignore, packages/os/linux/elizaos/build.sh, packages/os/linux/elizaos/config/hooks/normal/0010-elizaos-agent.hook.chroot (+5 more) |
| `packages/os/linux/elizaos/config/includes.chroot/opt/elizaos-artifacts/elizaos-app/musl-runtime/bun` | consumers: packages/os/linux/elizaos/build.sh, packages/os/linux/elizaos/config/hooks/normal/0010-elizaos-agent.hook.chroot, packages/os/linux/elizaos/config/includes.chroot/opt/elizaos-artifacts/bun.sha256 (+7 more) |
| `packages/os/linux/tails/wiki/src/install/inc/success/start.mp4` | consumers: packages/os/linux/tails/wiki/src/install/inc/steps/clone.inline.ar.po, packages/os/linux/tails/wiki/src/install/inc/steps/clone.inline.bg.po, packages/os/linux/tails/wiki/src/install/inc/steps/clone.inline.ca.po (+31 more) |
| `packages/os/linux/tails/wiki/src/install/inc/videos/mac.mp4` | consumers: packages/os/linux/tails/wiki/src/install/inc/steps/mac_startup_disks.inline.html |
| `packages/os/linux/tails/wiki/src/lib/fontawesome/webfonts/fa-solid-900.ttf` | consumers: packages/os/linux/tails/wiki/src/lib/fontawesome/css/all.css, packages/os/linux/tails/wiki/src/lib/fontawesome/css/all.min.css, packages/os/linux/tails/wiki/src/lib/fontawesome/css/solid.css (+1 more) |
| `packages/os/linux/tails/wiki/src/lib/SourceSans3-Italic-VariableFont_wght.ttf` | consumers: packages/os/linux/tails/wiki/src/local.css |
| `packages/os/linux/tails/wiki/src/lib/SourceSans3-VariableFont_wght.ttf` | consumers: packages/os/linux/tails/wiki/src/local.css |
| `packages/shared/assets-classic/background/clouds_background.jpg` | consumers: packages/os/homepage/index.html, packages/shared/src/brand-classic/brand.css, packages/shared/src/brand-classic/index.ts (+3 more) |
| `packages/shared/assets-classic/background/Clouds_Loop_HQ_1080p.mp4` | consumers: packages/shared/src/brand-classic/index.ts, scripts/generated/static-asset-manifest.json |
| `packages/shared/assets-classic/background/Clouds_Loop_Mobile_480p.mp4` | consumers: packages/shared/src/brand-classic/index.ts, scripts/generated/static-asset-manifest.json |
| `packages/shared/assets-classic/background/optimized/clouds_1x_1080p.mp4` | consumers: packages/shared/src/brand-classic/index.ts |
| `packages/shared/assets-classic/background/optimized/clouds_1x_1080p.webm` | consumers: packages/shared/src/brand-classic/index.ts |
| `packages/shared/assets-classic/background/optimized/clouds_1x_720p.mp4` | consumers: packages/shared/src/brand-classic/index.ts |
| `packages/shared/assets-classic/background/optimized/clouds_1x_720p.webm` | consumers: packages/shared/src/brand-classic/index.ts |
| `packages/shared/assets-classic/background/optimized/clouds_4x_1080p.mp4` | consumers: packages/shared/src/brand-classic/index.ts |
| `packages/shared/assets-classic/background/optimized/clouds_4x_1080p.webm` | consumers: packages/shared/src/brand-classic/index.ts |
| `packages/shared/assets-classic/background/optimized/clouds_4x_480p.mp4` | consumers: packages/shared/src/brand-classic/index.ts |
| `packages/shared/assets-classic/background/optimized/clouds_4x_480p.webm` | consumers: packages/shared/src/brand-classic/index.ts |
| `packages/shared/assets-classic/background/optimized/clouds_4x_720p.mp4` | consumers: packages/shared/src/brand-classic/index.ts |
| `packages/shared/assets-classic/background/optimized/clouds_4x_720p.webm` | consumers: packages/shared/src/brand-classic/index.ts |
| `packages/shared/assets-classic/background/optimized/clouds_8x_1080p.mp4` | consumers: packages/shared/src/brand-classic/index.ts |
| `packages/shared/assets-classic/background/optimized/clouds_8x_1080p.webm` | consumers: packages/shared/src/brand-classic/index.ts |
| `packages/shared/assets-classic/background/optimized/clouds_8x_360p.mp4` | consumers: packages/shared/src/brand-classic/index.ts |
| `packages/shared/assets-classic/background/optimized/clouds_8x_360p.webm` | consumers: packages/shared/src/brand-classic/index.ts |
| `packages/shared/assets-classic/background/optimized/clouds_8x_480p.mp4` | consumers: packages/shared/src/brand-classic/index.ts |
| `packages/shared/assets-classic/background/optimized/clouds_8x_480p.webm` | consumers: packages/shared/src/brand-classic/index.ts |
| `packages/shared/assets-classic/background/optimized/clouds_8x_720p.mp4` | consumers: packages/shared/src/brand-classic/index.ts |
| `packages/shared/assets-classic/background/optimized/clouds_8x_720p.webm` | consumers: packages/shared/src/brand-classic/index.ts |
| `packages/shared/assets-classic/concepts/billboard_concept.jpg` | consumers: packages/shared/src/brand-classic/index.ts, scripts/generated/static-asset-manifest.json |
| `packages/shared/assets-classic/concepts/chibi_usb_concept.jpg` | consumers: packages/shared/src/brand-classic/index.ts, scripts/generated/static-asset-manifest.json |
| `packages/shared/assets-classic/concepts/concept_minipc.jpg` | consumers: packages/shared/src/brand-classic/index.ts, scripts/generated/static-asset-manifest.json |
| `packages/shared/assets-classic/concepts/concept_phone.jpg` | consumers: packages/shared/src/brand-classic/index.ts, scripts/generated/static-asset-manifest.json |
| `packages/shared/assets-classic/concepts/concept_usbdrive.jpg` | consumers: packages/shared/src/brand-classic/index.ts, scripts/generated/static-asset-manifest.json |
| `packages/shared/assets/background/Clouds_Loop_HQ_1080p.mp4` | consumers: packages/shared/src/brand-classic/index.ts, scripts/generated/static-asset-manifest.json |
| `packages/shared/assets/background/Clouds_Loop_Mobile_480p.mp4` | consumers: packages/shared/src/brand-classic/index.ts, scripts/generated/static-asset-manifest.json |
| `packages/shared/assets/concepts/billboard_concept.jpg` | consumers: packages/shared/src/brand-classic/index.ts, scripts/generated/static-asset-manifest.json |
| `packages/shared/assets/concepts/chibi_usb_concept.jpg` | consumers: packages/shared/src/brand-classic/index.ts, scripts/generated/static-asset-manifest.json |
| `packages/shared/assets/concepts/concept_minipc.jpg` | consumers: packages/shared/src/brand-classic/index.ts, scripts/generated/static-asset-manifest.json |
| `packages/shared/assets/concepts/concept_phone.jpg` | consumers: packages/shared/src/brand-classic/index.ts, scripts/generated/static-asset-manifest.json |
| `packages/shared/assets/concepts/concept_usbdrive.jpg` | consumers: packages/shared/src/brand-classic/index.ts, scripts/generated/static-asset-manifest.json |
| `plugins/plugin-companion/assets/hero.png` | consumers: packages/agent/src/services/registry-client-local.ts, packages/agent/src/services/registry-client-queries.ts, packages/agent/src/services/registry-client-types.ts (+24 more) |
| `plugins/plugin-companion/public/vrms/eliza-1.vrm.gz` | consumers: packages/app-core/scripts/lib/static-asset-manifest.mjs, packages/app/test/ui-smoke/helpers.ts |
| `plugins/plugin-documents/assets/hero.png` | consumers: packages/agent/src/services/registry-client-local.ts, packages/agent/src/services/registry-client-queries.ts, packages/agent/src/services/registry-client-types.ts (+24 more) |
| `plugins/plugin-form/assets/hero.png` | consumers: packages/agent/src/services/registry-client-local.ts, packages/agent/src/services/registry-client-queries.ts, packages/agent/src/services/registry-client-types.ts (+24 more) |
| `plugins/plugin-personal-assistant/assets/hero.png` | consumers: packages/agent/src/services/registry-client-local.ts, packages/agent/src/services/registry-client-queries.ts, packages/agent/src/services/registry-client-types.ts (+24 more) |
| `plugins/plugin-shopify/assets/hero.png` | consumers: packages/agent/src/services/registry-client-local.ts, packages/agent/src/services/registry-client-queries.ts, packages/agent/src/services/registry-client-types.ts (+24 more) |
| `plugins/plugin-training/assets/hero.png` | consumers: packages/agent/src/services/registry-client-local.ts, packages/agent/src/services/registry-client-queries.ts, packages/agent/src/services/registry-client-types.ts (+24 more) |
| `plugins/plugin-wallet-ui/assets/hero.png` | consumers: packages/agent/src/services/registry-client-local.ts, packages/agent/src/services/registry-client-queries.ts, packages/agent/src/services/registry-client-types.ts (+24 more) |
