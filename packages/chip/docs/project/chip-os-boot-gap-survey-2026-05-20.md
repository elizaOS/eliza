# Chip-to-OS Boot Gap Survey - 2026-05-20

Scope: every current blocker found while surveying whether `packages/chip`
can run the Linux and AOSP forks under `packages/os`, boot them on the chip
emulator path, start the Eliza launcher/agent, and run without issues.

This is evidence-only. It is not a boot-readiness claim. The current state is:

- `packages/chip` generated a Chipyard `ElizaRocketConfig` simulator and a
  Linux payload, but the current generated-AP smoke report is blocked in the
  `linux_boot` stage after only an early kernel command-line marker and before
  required OpenSBI/Linux completion markers. A previous quiet-workload
  completion is not current evidence for the survey.
- `packages/os/linux/elizaos` (`ARCH=riscv64`) has qemu-virt emulator
  boot evidence for the Debian fork, but that is generic QEMU virt evidence,
  not Eliza chip/AP evidence. The image still lacks a real Eliza agent binary.
- `packages/chip` AOSP preflight can see an external AOSP checkout only when
  `AOSP_DIR` is supplied. Full Cuttlefish/CTS/VTS/QEMU/Renode evidence is not
  captured in the current report, and no Android boot is tied to the generated
  Eliza AP simulator.
- The checked-in e1 RTL remains a debug/MMIO SoC scaffold. The local top is not
  a Linux/AOSP-capable phone AP.

## Current Aggregate Snapshot

Commands run from `packages/chip` on 2026-05-22:

| Command | Result | Evidence |
| --- | --- | --- |
| `make chip-os-bring-up-status` | Strict-effective blocker true; `release_blocker=false`; `PASS=51`, `BLOCKED=24`, `FAIL=0` across 75 gates. | `build/reports/chip-os-bring-up-status.json`. Linux/AOSP fork boot, launcher foreground, and agent liveness remain unproven. Strict mode remains non-releasable because BLOCKED objective gates are release-blocking for this survey. |
| `make chip-os-boot-gap-inventory` | Exit `0`; inventory status `BLOCKED`; `nonpassing_gates=24`, `blocked_gates=24`, `failed_gates=0`, `uncovered_gates=0`, `unstructured_reports=0`, `blocker_entries=485`, `blocker_codes=456`. | `build/reports/chip-os-boot-gap-inventory.json`. This is an inventory-only report and not boot or launcher evidence. It maps every current nonpassing aggregate gate to checker scripts, matching detailed reports, known differently named report aliases, structured blocker/failure rows when present, and nonpassing reports that still lack structured closure rows. |
| `make chip-os-gap-keyword-inventory` | Exit `0`; inventory status `BLOCKED`; `files_scanned=1959`, `findings=1858`, `paths_with_findings=492`. | `build/reports/chip-os-gap-keyword-inventory.json`. This is source-keyword inventory only. It is intentionally separate from the aggregate gate blocker inventory so TODO/stub/scaffold markers do not swamp per-gate blocker counts. |
| `make chip-os-evidence-provenance` | Exit `0`; provenance status `BLOCKED`; `files_scanned=267`, `findings=2354`, `paths_with_findings=252`. | `build/reports/chip-os-evidence-provenance.json`. This is evidence-quality inventory only. It flags host-local paths, missing timestamps/claim boundaries, reference-only scopes, placeholder markers, and blocked/fail markers before any artifact is promoted as boot, launcher, or agent evidence. |
| `make chip-os-optimization-gap-inventory` | Exit `0`; optimization inventory status `BLOCKED`; `artifacts=23`, `findings=64`, `areas=7`. | `build/reports/chip-os-optimization-gap-inventory.json`. This is optimization/performance inventory only. It tracks CPU/AP, NPU, memory/cache, benchmark, SOTA, power/thermal, Android launcher/agent, HAL, bridge, APK payload, release-readiness, and phone-runtime evidence that is still modeled, local-host, release-blocked, false-readiness, timeout, or otherwise not target runtime proof. |
| `make chip-os-identity-contract` | Exit `0`; identity contract status `BLOCKED`; `findings=5`; observed packages `app.eliza`, `ai.elizaos.app`, and `com.elizaos.agent`. | `build/reports/chip-os-identity-contract.json`. This static audit tracks package IDs, HOME role targets, service components, health endpoints, Android release validation metadata, app agent plugin stubs, and stale operator docs across the app, AOSP vendor layer, and chip smoke scripts. |
| `make chip-os-environment-preflight` | Exit `0`; preflight status `BLOCKED`; `missing_tools=4`, `missing_env_vars=7`, `missing_or_unwritable_paths=2`, `findings=13`. | `build/reports/chip-os-environment-preflight.json`. This captures host/tool/env/artifact blockers before trying to regenerate Linux, AOSP, Chipyard, launcher, agent, APK payload, or Android release-validation evidence. |
| `make chip-os-objective-evidence-matrix` | Exit `0`; matrix status `BLOCKED`; `requirements=43`, `proven=8`, `blocked=34`, `weak_static_only=1`, `missing=0`. | `build/reports/chip-os-objective-evidence-matrix.json`. This is the strict requirement-by-requirement closure view for the actual objective; it treats static contract passes as weak unless runtime boot/launcher/agent evidence exists. |
| `make chip-os-closure-plan` | Exit `0`; plan status `BLOCKED`; `phases=5`, `closed_phases=0`, `blocked_phases=5`, first blocked phase `p0_workflow_evidence_plumbing`. | `build/reports/chip-os-closure-plan.json`. This orders the current blockers by dependency: evidence/tooling, chip/AP boot base, Linux fork agent, AOSP launcher/agent, then phone runtime surfaces. Each phase now records `open_requirements`, `open_source_reports`, and top blocker codes derived from still-open requirements. |
| `make chip-os-report-freshness` | Exit `0`; freshness status `PASS`; `reports=47`, `missing_reports=0`, `stale_reports=0`, `missing_sources=0`. | `build/reports/chip-os-report-freshness.json`. This is a workflow audit only. It now watches existing aggregate gate detail reports as well as the survey reports, and currently finds every watched report current against its checker/source contract. |
| `python3 scripts/check_linux_memory_platform_contract.py` | `BLOCKED` | Linux and Android DTS projections match the central memory/platform tokens, but required Linux kernel build, DTB check, serial boot, OpenSBI handoff, Buildroot manifest, and e1 MMIO smoke evidence are still absent. |

## Environment Preflight

The P0 workflow blocker is now explicit. The current shell can find `repo`,
`adb`, `fastboot`, `apkanalyzer`, `curl`, `jq`, `node`, `bun`, `java`, and
`make`, but not the tools and paths needed to actually run the chip/AP, OS,
APK-payload, and Android release-validation evidence loops.

Current preflight blockers:

| Blocker | Current state | Why it blocks the objective |
| --- | --- | --- |
| `qemu-system-riscv64` | Missing from `PATH`. | OS RV64 qemu-virt smoke and AOSP QEMU boot evidence cannot be regenerated in this environment. |
| `renode` | Missing from `PATH`. | Renode/e1 SoC Android or peripheral smoke evidence cannot be regenerated. |
| `aapt` | Missing from `PATH`. | Staged Android system APK package metadata cannot be independently checked before launcher/agent runtime evidence. |
| `verilator` | Missing from `PATH`. | Generated Chipyard AP simulator evidence cannot be rebuilt or rerun from this shell. |
| `AOSP_DIR` | Unset. | AOSP import/build/boot tracks cannot locate the external checkout. |
| `AOSP_QEMU_SMOKE_COMMAND` and `AOSP_RENODE_SMOKE_COMMAND` | Unset. | AOSP QEMU/Renode stages remain version/preflight placeholders rather than target-specific boot commands. |
| `ELIZA_LINUX_TREE`, `ELIZA_BUILDROOT_TREE`, `ELIZA_OPENSBI_TREE` | Unset. | External Linux kernel, Buildroot, and OpenSBI evidence cannot be captured for the selected chip/AP target. |
| `CHIPYARD_LINUX_BINARY` | Unset. | Chipyard Verilator Linux smoke has no explicit payload path in the environment. |
| `packages/os/linux/elizaos/out` | Present but not writable by the current user. | The RV64 OS image output directory cannot be safely regenerated without ownership/permission repair. |
| `docs/evidence/android/eliza_launcher_runtime_evidence.json` | Missing. | There is no booted Android proof for HOME foreground, service process, `/api/health`, or clean logcat. |

## Inventory Coverage Holes

The machine-readable inventory now records when a nonpassing aggregate gate has
no matching detailed JSON report, and when a nonpassing detailed JSON report
has no structured finding, blocker, error, or failure rows. These are not
necessarily new product blockers; they are survey/workflow blockers because
reviewers must rely on aggregate stdout, summary counters, or free-text reason
fields rather than stable blocker codes and closure steps.

Current uncovered nonpassing gates: none. This only means every current
nonpassing aggregate gate has at least one matching nonpassing detail report; it
does not mean any Linux/AOSP boot, launcher, or agent objective is satisfied.

Current nonpassing reports without structured closure rows: none. This closes
the current report-format hole; the objective is still blocked by the detailed
rows below, not by missing inventory structure.

Newly structured this pass:

- `build/reports/android_sim_boot.json` now emits `findings` for host blockers such as unset `AOSP_DIR`, missing/broken `repo`, and the blocked Android simulator status.
- `build/reports/linux_boot_artifacts.json` now emits `findings` for unset external Linux/Buildroot/OpenSBI trees, missing generated-AP serial boot transcript, and missing target-side `e1-mmio-smoke` transcript.
- `build/reports/cpu_ap_scope.json` now emits `findings` for missing generated-AP transcripts and invalid CPU/AP evidence problems.
- `build/reports/software_bsp_scope.json` now emits `findings` for missing Buildroot/Linux runtime smoke logs, invalid AOSP evidence logs, AOSP scaffold errors, and failed BSP scope subchecks.
- `build/reports/npu_scope.json` now emits `findings` for missing real NPU/NNAPI/DMA/MLPerf/power evidence rather than only release-claim booleans.
- `build/reports/benchmark_efficiency_scope.json` now emits `findings` for missing calibrated target benchmark, power, thermal, memory, raw-artifact, and NPU proof evidence.
- `build/reports/power_thermal_scope.json` now emits `findings` for missing calibrated power, thermal, frequency, workload, throttle, calibration, and release-review evidence.
- `build/reports/phone_media_pipeline_scope.json` now emits `findings` for missing display/GPU/HWC/panel evidence and missing camera sensor/CSI/ISP/HAL/privacy evidence.
- `build/reports/radio_sensor_pmic_scope.json` now emits `findings` for missing Wi-Fi/Bluetooth/GNSS/NFC, sensors, haptics, PMIC, charger, battery, Android HAL, regulatory, and safety evidence.
- `build/reports/security_lifecycle_scope.json` now emits `findings` for missing secure boot, verified boot, rollback, debug authorization, lifecycle/OTP/OTBN, key ceremony, signer/HSM, fuse/OTP, and provisioning evidence.
- `build/reports/tee_software_aggregate.json` now emits `findings` for the missing TEE/security hardware gates: MTT enforcement, TSM ePMP wall RTL, secure boot ROM, OTP/lifecycle RTL, IOMMU/IOPMP, NPU secure I/O, MCIE/LPDDR5X, and side-channel lab evidence.
- `build/reports/sota_parity_audit.json` now emits `findings` for each blocked phone-class parity domain: CPU/AP, NPU, memory, Linux/AOSP BSP, benchmarks, sustained power/thermal, product package/board/PD, security, radio/sensor/PMIC, GPU/display/ISP, and manufacturing/tapeout.
- `build/reports/tee_purge_sequence_scope.json` now emits `findings` for missing purge RTL integration, formal/SVA proof, FPGA cache/BPU residue harness, and FPGA single-step side-channel evidence.
- `build/reports/rot_integration.json` now emits `findings` for the remaining physical/silicon FIPS entropy and provisioned device-identity blocker after the digital RoT, OpenTitan crypto datapath, entropy stack, and keymgr ladder checks pass.
- `build/reports/manufacturing_tapeout_scope.json` now emits `findings` for missing production PDK/IP, routed layout/signoff artifacts, DRC/LVS/antenna/STA closure, IR/EM/PDN/reliability closure, foundry/package approval, board release package, and first-article lab evidence.
- `build/reports/io_cell_contract.json` now emits `findings` for its missing source contract and blocked foundry IO-cell classes that lack Liberty, LEF, GDS, SPICE, IBIS, ESD/latchup, and corner-coverage deliverables.
- `build/reports/local-host-coremark-probe.json` now emits `findings` for local CoreMark timeout and the absence of any parseable local-host benchmark pass, while keeping the claim boundary that this is not chip/AP, AOSP, power, thermal, or release performance evidence.
- `build/reports/sim_ladder.json` now emits structured failure findings when a ladder step fails or required artifact is missing; the current standalone ladder report is `pass`, so it no longer appears in the nonpassing unstructured set.
- `build/reports/product_release_status.json` now emits `findings` for product preflight failure, placeholder/draft board package artifacts, FPGA scaffold and bitstream blockers, PD signoff, manufacturing evidence, KiCad release, OpenLane, and antenna metadata release blockers.
- `build/reports/cdc_formal_manifest.json` now emits `findings` for nonpassing CDC/RDC formal tasks; the current blocker is `droop_cdc` requiring `sv2v`, while `reset_sync` passes.
- Legacy `eliza.gate_status.v1` reports such as `build/reports/gate-board_fabrication_release.json` are now imported as structured `gate_status_*` closure rows when they are nonpassing.

Newly covered by structured detail reports or aliases:

- `core-selection-check` now writes `build/reports/core_selection.json` and PASSes: the big-core slot is the open XiangShan Kunminghu V3 8-wide scale-up with a real pinned upstream commit (no vendor license). Ascalon-D8 was surveyed but rejected for lack of a published mobile-volume license.
- `aosp-simulator-completion-check` now maps to `build/reports/android_sim_boot.json` and `build/reports/mvp_simulator.json`.
- `cpu-ap-completion-gate` now maps to `build/reports/cpu_ap_scope.json`.
- `minimum-linux-target-check` now maps to `build/reports/minimum-linux-kernel-target.json`.
- `chipyard-generated-linux-contract-check` now maps to `build/reports/chipyard_payload_path.json` and `build/reports/cpu_ap_scope.json`.
- `software-bsp-scaffold-check` writes `build/reports/software_bsp.json` for scaffold inventory, while the objective matrix uses `build/reports/software_bsp_scope.json` because external Buildroot, Linux, OpenSBI, AOSP, CTS/VTS, NNAPI, and release evidence remain blocked.
- `chipyard-verilator-linux-smoke-check` mirrors its smoke report into `build/reports/chipyard_verilator_linux_smoke.json`, currently blocked in `linux_boot` after an early kernel command-line marker and before the required OpenSBI/SBI handoff marker.
- `os-rv64-qemu-virt-boot-test` now writes `build/reports/qemu_virt_smoke.json`, currently passing as qemu-virt reference evidence, not chip/AP emulator evidence.
- `stub-audit` now writes `build/reports/stub_audit.json`, currently passing with allowlisted placeholder/stub inventory only.
- `prototype-status-dashboard-check` writes `build/reports/prototype_status_dashboard.json`, currently passing after the dashboard row for `platform-contract` was refreshed against the current MVP output.
- `rva23-compliance` now writes `build/reports/rva23_compliance.json`, currently blocked on the AOSP branch/profile pin.
- `pd-evidence-gates` now writes `build/reports/pd_evidence_gates.json`, currently passing after validating seven PD evidence gate manifests.
- `platform-contract-check` now writes `build/reports/platform_contract.json`, currently passing after the checker learned the current boot ROM header overlay form.
- `product-feature-gates-check` now writes `build/reports/product_feature_gates.json`, currently passing with product feature blockers named and fail-closed.

## Source Keyword Inventory

The gate inventory above tracks structured checker reports. A separate source
keyword inventory now scans chip RTL/firmware/software/docs plus the Linux
fork image scripts, Linux agent/daemon sources, AOSP vendor layer, AOSP
installer/scripts/system-ui surfaces, Android app native code, and shared
launcher app sources for unfinished-work markers. It excludes generated
bundles, evidence logs, build outputs, chroots, caches, and artifact
directories.

Current keyword inventory summary:

| Category | Count | Meaning |
| --- | ---: | --- |
| `stub_placeholder` | 1274 | `stub`, `placeholder`, `scaffold`, `dummy`, `mock`, or `fake` markers in source/survey scope. |
| `deferred_blocked` | 349 | `STATUS_LATER`, deferred, blocked-until, remains-blocked, or not-yet markers. |
| `implementation_missing` | 208 | `NotImplementedError`, not-implemented, unimplemented, or unsupported markers. |
| `todo` | 27 | `TODO`, `FIXME`, `XXX`, `HACK`, or `TBD` markers. |

Findings by scan root:

| Scan root | Findings | Paths | Dominant markers |
| --- | ---: | ---: | --- |
| `packages/chip/scripts` | 814 | 223 | 581 stub/placeholder, 131 deferred/blocked, 88 implementation-missing, 14 TODO. |
| `packages/chip/docs` | 759 | 187 | 491 stub/placeholder, 170 deferred/blocked, 90 implementation-missing, 8 TODO. |
| `packages/chip/verify` | 146 | 22 | 95 stub/placeholder, 32 deferred/blocked, 16 implementation-missing, 3 TODO. |
| `packages/chip/sw` | 52 | 21 | 44 stub/placeholder, 4 deferred/blocked, 4 implementation-missing. |
| `packages/chip/rtl` | 40 | 15 | 31 stub/placeholder, 8 deferred/blocked, 1 TODO. |
| `packages/chip/fw` | 20 | 12 | 16 stub/placeholder, 1 deferred/blocked, 2 implementation-missing, 1 TODO. |
| `packages/os/linux/elizaos/scripts` | 10 | 3 | 6 stub/placeholder, 3 implementation-missing, 1 deferred/blocked. |
| `packages/app/src` | 8 | 2 | 8 stub/placeholder. |
| `packages/app/android/app/src/main` | 5 | 4 | 4 implementation-missing, 1 deferred/blocked. |
| `packages/os/android/system-ui/native` | 2 | 1 | 1 stub/placeholder, 1 implementation-missing. |
| `packages/os/android/system-ui/src` | 1 | 1 | 1 stub/placeholder. |
| `packages/os/linux/elizaos/manifest.json` | 1 | 1 | 1 deferred/blocked. |

Top current source paths by keyword findings:

| Path | Findings | Survey implication |
| --- | ---: | --- |
| `packages/chip/verify/check_stub_audit.py` | 62 | The stub audit itself carries the allowlist and marker vocabulary; it is an inventory/control surface, not closure evidence. |
| `packages/chip/docs/project/critical-gap-review-2026-05-17.md` | 43 | Historical critical-gap review content still carries many blocked/stub markers; it is context for blockers, not current closure evidence. |
| `packages/chip/docs/project/workstream-gap-review.md` | 40 | Workstream review notes remain marker-heavy and should not be promoted as implementation or runtime proof. |
| `packages/chip/verify/rtl_gap_work_order.yaml` | 32 | RTL/firmware blockers remain explicitly tracked outside runtime boot evidence. |
| `packages/chip/scripts/check_software_bsp.py` | 26 | BSP evidence parsing still has many placeholder/failure guards; external Buildroot/Linux/OpenSBI/AOSP evidence remains required. |

Selected OS/app source markers that directly affect the objective:

| Path | Marker | Why it matters |
| --- | --- | --- |
| `packages/os/linux/elizaos/manifest.json` | `blocked until` promotion evidence | The Linux fork artifact is not promoted until qemu-virt, GRUB EFI RISC-V, and agent boot evidence are collected; chip/AP boot and agent-live evidence are still separate missing requirements. |
| `packages/os/linux/elizaos/scripts/qemu_virt_boot_riscv64.sh` | `unsupported` U-Boot argument | The qemu-virt path rejects a U-Boot handoff argument, so it does not prove the firmware chain required for chip/AP boot. |
| `packages/os/linux/elizaos/scripts/stage-agent-artifacts.sh` | `unsupported` host/target arch exits | Agent staging can fail before image build on unsupported host or target architecture; riscv64 payload provenance must stay pinned. |
| `packages/os/android/system-ui/native/README.md` | `NotImplementedError` / scaffold markers | The AOSP system UI native bridge remains documented as scaffold wiring rather than booted-device runtime evidence. |
| `packages/os/android/system-ui/src/providers/AndroidSystemProvider.tsx` | no mock/fake fallback marker | The provider intentionally fails when the Android bridge is absent; launcher evidence must prove the real bridge is present on-device. |
| `packages/app/src/main.tsx` | Vite native stub marker | The shared launcher app still has a native-stub development path; Android launcher evidence must use the real native bridge path. |
| `packages/app/android/app/src/main/java/app/eliza/AndroidVirtualizationBridge.java` | `unsupported-api` / unsupported contract marker | Android virtualization bridge handling can report unsupported AVF/Microdroid contracts; this cannot stand in for chip-emulator Android boot. |
| `packages/app/android/app/src/main/java/app/eliza/ElizaAgentService.java` | unsupported HTTP method handling | The app agent service has bounded HTTP method support; launcher/agent smokes must use the actual supported health/status contract. |

## Evidence Provenance

The source keyword inventory finds unfinished implementation markers. A
separate provenance audit now scans current report/evidence artifacts plus
Linux evidence, Android installer/vendor release manifests, OS release
manifests, confidential-release metadata, and the Android app agent plugin
manifest for problems that make evidence unsafe to promote as Linux/AOSP
chip-emulator, launcher, agent, or no-issues runtime proof.

Current provenance summary:

| Category | Count | Why it matters |
| --- | ---: | --- |
| `blocked_marker` | 1340 | Existing artifacts still contain explicit `BLOCKED`, `FAIL`, blocked-until, or missing-required markers. |
| `host_local_path` | 441 | Evidence contains local `/home`, `/tmp`, or similar paths that reduce reproducibility and can hide host-specific setup. |
| `missing_timestamp` | 195 | Structured evidence lacks generated time or timestamp provenance. |
| `placeholder_marker` | 198 | Evidence contains placeholder/stub/sentinel/TODO markers. |
| `missing_claim_boundary` | 78 | Structured evidence lacks an explicit claim boundary. |
| `nonpassing_status` | 64 | Structured evidence reports `blocked`, `fail`, or `failed`. |
| `weak_reference_scope` | 38 | Claim boundaries explicitly scope artifacts as reference-only or not chip/boot/runtime proof. |

Findings by provenance root:

| Root | Findings | Paths | Dominant provenance problems |
| --- | ---: | ---: | --- |
| `packages/chip/build/reports` | 1682 | 133 | 1163 blocked, 194 host-local, 42 missing-claim-boundary, 123 missing-timestamp, 53 nonpassing, 76 placeholder, 31 weak-reference. |
| `packages/chip/docs/evidence` | 603 | 99 | 162 blocked, 238 host-local, 28 missing-claim-boundary, 64 missing-timestamp, 10 nonpassing, 100 placeholder, 1 weak-reference. |
| `packages/os/linux/elizaos/evidence` | 47 | 13 | 8 blocked, 9 host-local, 1 missing-claim-boundary, 1 missing-timestamp, 1 nonpassing, 21 placeholder, 6 weak-reference. |
| `packages/os/release/confidential-2026-05-21` | 9 | 1 | 6 blocked, 1 missing-claim-boundary, 1 missing-timestamp, 1 placeholder. |
| `packages/os/android/installer/manifests` | 5 | 2 | 1 blocked, 2 missing-claim-boundary, 2 missing-timestamp. |
| `packages/os/release/beta-2026-05-16` | 4 | 2 | 2 missing-claim-boundary, 2 missing-timestamp. |
| `packages/app/android/app/src/main/assets/agent/plugins-manifest.json` | 2 | 1 | 1 missing-claim-boundary, 1 missing-timestamp. |
| `packages/os/android/vendor/eliza/manifests` | 2 | 1 | 1 missing-claim-boundary, 1 missing-timestamp. |

Top current provenance-problem artifacts include
`build/reports/chip-os-boot-gap-inventory.json`,
`docs/evidence/android/eliza_ai_soc_vendorimage.log`,
`build/reports/minimum_linux_npu_target.json`,
`build/reports/chip-os-bring-up-status.json`,
`build/reports/tapeout-readiness.json`, and
`build/reports/mvp_simulator.json`.

## Optimization Gap Inventory

Boot and launcher foreground are not sufficient for the requested "everything
runs with no issues" end state. The optimization inventory now checks whether
CPU/AP, NPU, memory/cache, benchmark, SOTA, power/thermal, Android
launcher/agent, APK payload, HAL, bridge, release-readiness, and phone-runtime
performance evidence is target-specific and release-usable rather than
modeled, local-host, reference-only, or explicitly blocked.

Current optimization inventory summary:

| Area | Findings | Typical blocker |
| --- | ---: | --- |
| `runtime` | 29 | Phone runtime, Android peripheral, launcher foreground, agent health, identity, APK payload, HAL, bridge, evidence-capture, and release-readiness surfaces remain blocked, so no-issues operation is unproven. |
| `npu` | 11 | NPU scope, minimum Linux+NPU, and coverage reports still block Android NNAPI, DMA-backed tensor execution, measured TOPS/latency/power, and phone-class claims. |
| `cpu` | 8 | CPU/AP boot and local CoreMark evidence are incomplete, local-host scoped, or not tied to sustained chip/AP emulator runtime. |
| `power_thermal` | 5 | Power/thermal evidence is scoped as projection or release-blocked until aligned measured traces exist. |
| `benchmarks` | 4 | Benchmark efficiency scope is release-blocked until calibrated target metadata, raw artifacts, power, thermal, and memory metadata exist. |
| `system` | 4 | SOTA parity remains blocked across phone-SoC domains. |
| `memory` | 3 | Cache/UMA/memory evidence is not yet enough for contended Android/Linux runtime performance claims. |

Runtime artifacts now included in the no-issues inventory:

| Artifact | Findings | Status | Runtime gap |
| --- | ---: | --- | --- |
| `phone_runtime_readiness` | 4 | `blocked` | Display/HWC/camera/audio/radio/sensor/PMIC/power/thermal runtime surfaces are not proven. |
| `android_peripheral_evidence` | 3 | `blocked` | Camera, microphone, speaker, Wi-Fi, Bluetooth, and cellular probes are absent or blocked. |
| `android_launcher_runtime` | 2 | `blocked` | HOME foreground, service process, `/api/health`, clean logcat, and launcher runtime evidence are missing. |
| `android_identity_contract` | 3 | `blocked` | Package, HOME role, service, and health endpoint identities still diverge across app/vendor/smoke paths. |
| `android_app_runtime_contract` | 3 | `blocked` | APK/package/service/API readiness is not enough for launcher foreground or local-agent runtime. |
| `android_system_apk_payload` | 3 | `blocked` | RISC-V local-agent payload and native loader assets are not proven in the staged system APK. |
| `aosp_hal_service_liveness` | 3 | `blocked` | E1 NPU and HWC HAL sources are still stub/fail-closed or framebuffer-only, the simulator HAL can mask chip HAL proof, and booted-product `lshal`/service liveness is missing. |
| `android_evidence_capture_strictness` | 3 | `blocked` | Source-scan or version-only placeholders still stand where real boot/CTS/VTS/launcher/agent evidence is required. |
| `android_release_readiness` | 3 | `blocked` | Release and post-flash checks do not yet prove chip/riscv64 boot, launcher, agent, logcat, or SELinux behavior. |
| `android_system_bridge` | 1 | `blocked` | Static bridge packaging and channel checks are aligned, but booted runtime evidence is missing for package install, service registration, permissions, JS binding, live UI consumption, and clean logs. |

## Identity Contract

Launcher and agent readiness can fail even after Android boots if the app,
vendor layer, release manifests, chip smoke scripts, and operator docs point at
different packages, service components, health endpoints, or agent payload
capabilities. The identity contract audit currently observes three package
identities: `app.eliza`, `ai.elizaos.app`, and legacy `com.elizaos.agent`.

Current identity blockers:

| Blocker | Current evidence | Why it matters |
| --- | --- | --- |
| `android_package_identity_mismatch` | Gradle, Capacitor, strings, shortcuts, and manifest code use `app.eliza`; OS vendor permissions, HOME/assistant overlays, and `ro.elizaos.home` use `ai.elizaos.app`; one operator doc still mentions `com.elizaos.agent`. | HOME role grants, privileged permission XML, `pm path`, foreground checks, and service smokes can target different packages. |
| `legacy_self_status_endpoint_still_required` | Chip smoke scripts probe `/api/health`, but `cuttlefish_agent_smoke.py` still requires `/api/agent/self-status` as an additional readiness check. | A launcher/agent run can pass the app watchdog endpoint while failing the legacy self-status schema, or vice versa. |
| `operator_docs_stale_agent_identity` | `docs/android/cuttlefish-agent-smoke-operator-recipe.md` still documents legacy `com.elizaos.agent` defaults. | Human-run smoke captures can use the wrong package/service and create misleading evidence. |
| `android_release_identity_validation_missing_launcher_agent_checks` | Android installer and beta release manifests validate only boot properties; their validation blocks do not include `pm path`, role holders, foreground activity, service liveness, `/api/health`, logcat, or SELinux checks. | A release/post-flash flow could pass while the wrong launcher package is installed or the agent is dead. |
| `android_agent_plugin_manifest_runtime_stubs` | `plugins-manifest.json` lists runtime-critical externals such as `@elizaos/plugin-shell`, `@elizaos/plugin-agent-orchestrator`, `node-llama-cpp`, `onnxruntime-node`, `sharp`, `canvas`, and `pty-manager` in `externalsAsStubs`. | The bundled Android agent can look packaged while local runtime capabilities are stubbed or unsupported. |

## MVP Simulator Breakdown

The refreshed MVP simulator report is current, but it is still `fail`. It
does not assert `on_chip_os_boot_claim`, `reference_android_os_boot_claim`,
`integrated_linux_npu_ml_claim`, `minimum_linux_npu_target_claim`, or
`status=pass`.

Current claim flags:

| Claim | Value | Meaning |
| --- | --- | --- |
| `reference_qemu_virt_os_boot_claim` | `true` | Generic qemu-virt OS boot reached an init/login marker; this remains reference-only. |
| `on_chip_os_boot_claim` | `false` | The chip/AP path is not boot-proven because required generated-AP prerequisites and smoke stages are nonpassing. |
| `reference_android_os_boot_claim` | `false` | Android simulator boot is blocked before virtual-device evidence. |
| `npu_ml_smoke_claim` | `true` | Local NPU ML smoke passes, but it is not integrated generated-AP Linux evidence. |
| `integrated_linux_npu_ml_claim` | `false` | The generated-AP Linux transcript lacks the required e1 NPU workload markers. |
| `minimum_linux_npu_target_claim` | `false` | Minimum Linux+NPU requires on-chip OS boot plus integrated Linux/NPU proof. |

Current MVP substeps:

| Step | Status | Scope | Current blocker or boundary |
| --- | --- | --- | --- |
| `android_sim_boot` | `blocked` | Android reference | `AOSP_DIR` is unset, so full Android simulator boot evidence is not captured. |
| `android_sim_report_check` | `blocked` | Android reference | Android report remains blocked by missing AOSP checkout and repo install. |
| `qemu_os_boot` | `pass` | qemu-virt reference | Useful generic OS reference boot only; it does not prove chip/AP boot. |
| `cpu_ap_linux_evidence` | `fail` | chip/AP prerequisite | `eliza_e1_opensbi_boot.log` manifest hash does not match the generated manifest. |
| `chipyard_verilator_preflight` | `pass` | chip/AP prerequisite | Verilator generation command is available, but later generated-AP checks still fail. |
| `chipyard_generated_ap` | `fail` | chip/AP prerequisite | Generated manifest uses an unapproved Chipyard tag and commit. |
| `chipyard_payload_path` | `blocked` | chip/AP prerequisite | Linux boot, trap/timer/IRQ, ISA/cache/MMU, and AP benchmark logs are missing. |
| `chipyard_verilator_linux_attempt` | `blocked` | chip/AP OS boot | Generated AP `run-binary-fast` exits with timeout status `124`. |
| `chipyard_verilator_linux_smoke` | `blocked` | chip/AP OS boot | Smoke log lacks OpenSBI/SBI handoff and Linux version markers. |
| `npu_ml_smoke` | `pass` | local NPU smoke | Local ML smoke passes but does not prove integrated Linux or Android NNAPI behavior. |
| `qemu_firmware_smoke` | `pass` | qemu-virt reference | Firmware reference smoke only. |
| `renode_firmware_smoke` | `pass` | Renode reference | Firmware reference smoke only. |
| `local_rtl_sim_ladder` | `blocked` | local RTL sim | Local RTL ladder is blocked by a missing simulation dependency. |

## Objective Evidence Matrix

The objective matrix makes the requested end state explicit and avoids treating
static contract checks as runtime proof. Current result:

| Proof state | Count | Meaning |
| --- | ---: | --- |
| `proven` | 3 | Report freshness, aggregate blocker traceability, and the current static Chipyard AP ABI detail report. |
| `blocked` | 34 | Required environment/runtime/build/boot/launcher/agent/provenance/optimization/identity evidence is absent, stale, unfinished-marker-laden, or explicitly blocked. |
| `weak_static_only` | 1 | The cross-fork agent payload static contract now passes, but runtime Linux/Android agent liveness still requires separate booted evidence. |
| `missing` | 0 | Every matrix source report exists and is parseable. |

Current non-proven objective requirements:

| Requirement | Source report | Current status | Required closure evidence |
| --- | --- | --- | --- |
| Environment preflight | `build/reports/chip-os-environment-preflight.json` | `blocked` | Host tools, external checkout env vars, smoke commands, writable paths, and launcher runtime evidence inputs are available. |
| MVP simulator claim boundary | `build/reports/mvp_simulator.json` | `fail` | Android, QEMU, generated-AP, and prerequisite stages pass within their declared claim boundaries, with no failed, timed-out, stale, or reference-only stage promoted to chip boot readiness. |
| PD evidence schema hygiene | `build/reports/pd_evidence_gates.json` | `fail` | Every PD manifest declares valid status, release-use, source-artifact, and release-blocker structure before physical evidence is used as readiness support. |
| Product feature manifest hygiene | `build/reports/product_feature_gates.json` | `fail` | Security lifecycle and product feature scope reports contain required fail-closed terms and no missing readiness blockers. |
| CPU/AP completion scope | `build/reports/cpu_ap_scope.json` | `cpu_ap_scope_release_blocked` | CPU/AP release claim is allowed, completion is claimed, generated AP transcripts are present, and Linux/RV64GC/AP benchmark/power/process-corner evidence is not missing. |
| CPU/AP boot readiness | `build/reports/cpu_ap_boot_readiness.json` | `blocked` | Generated manifest/verilog/DTS are present, generated AP Linux smoke passes, and Linux boot artifact manifest entries are present. |
| Chipyard payload path completeness | `build/reports/chipyard_payload_path.json` | `blocked` | Linux boot, OpenSBI boot, trap/timer/IRQ, ISA/cache/MMU, and AP benchmark evidence logs are captured from exact external commands. |
| Core selection phone-class pin | `build/reports/core_selection.json` | `pass` | Big-core slot is the open XiangShan Kunminghu V3 8-wide scale-up with a real pinned upstream commit (no vendor license; Ascalon-D8 surveyed but rejected). All cluster roles have a real pin. |
| RVA23/AOSP profile readiness | `build/reports/rva23_compliance.json` | `blocked` | Required RISC-V toolchain, profile matrix, and AOSP branch inputs are pinned and checked. |
| Linux fork chip boot | `build/reports/os_rv64_chip_boot_contract.json` | `blocked` | OS RV64 chip boot contract `status=pass` with a chip-target boot evidence row and generated-AP/chip-emulator transcript. |
| Linux agent liveness | `build/reports/os_rv64_chip_boot_contract.json` | `blocked` | Linux boot evidence includes `elizaos-agent-ready` or active systemd service plus localhost health/API smoke. |
| Software BSP scaffold inventory | `build/reports/software_bsp.json` | `blocked` | Scaffold/full BSP inventory is currently blocked by missing external Linux kernel build/DTB evidence; even a future scaffold pass cannot replace external Buildroot, Linux, OpenSBI, AOSP, compatibility, and NNAPI evidence. |
| Software BSP external evidence | `build/reports/software_bsp_scope.json` | `software_bsp_scope_release_blocked` | External Buildroot image, Linux kernel/DTB/boot, OpenSBI handoff, AOSP boot/compatibility, CTS/VTS, NNAPI, and release-claim evidence are all present. |
| Firmware boot chain | `build/reports/linux_firmware_boot_chain_contract.json` | `blocked` | Buildroot, OpenSBI, U-Boot, and handoff transcripts from the selected chip/AP target. |
| Linux boot artifact manifest | `build/reports/linux_boot_artifacts.json` | `BLOCKED` | Kernel build, `dtbs_check`, OpenSBI handoff, rootfs/initramfs manifest, generated-AP serial boot transcript, and e1 MMIO smoke transcript are captured without placeholder or `.BLOCKED` sidecars. |
| Minimum Linux kernel target | `build/reports/minimum-linux-kernel-target.json` | `blocked` | Kernel build, `dtbs_check`, serial OpenSBI/Linux boot transcript, and e1 MMIO smoke transcript are captured from the selected target. |
| Platform contract consistency | `build/reports/platform_contract.json` | `fail` | Boot ROM identity/version/vector words match the platform contract, and generated RTL/OS consumers are regenerated from the same source. |
| Boot security-chain contract | `build/reports/boot_security_chain_contract.json` | `blocked` | CPU-capable platform contract, non-placeholder reset ROM handoff, secure boot/AVB/rollback/key provisioning evidence, and negative tamper transcripts. |
| Linux/Android memory platform | `build/reports/linux_memory_platform_contract.json` | `blocked` | Kernel build, DTB check, serial boot, OpenSBI handoff, Buildroot manifest, and e1 MMIO smoke evidence. |
| AOSP full virtual-device boot | `build/reports/android_sim_boot.json` | `blocked` | Android simulator boot report `status=pass`, `require_full_evidence=true`, and every required evidence path attempted. |
| AOSP chip handoff | `build/reports/aosp_linux_handoff_contract.json` | `blocked` | AOSP checkout/tooling plus non-placeholder target-specific QEMU/Renode/chip-emulator boot commands. |
| AOSP HAL service liveness | `build/reports/aosp_hal_service_contract.json` | `blocked` | HIDL/interface packaging, VINTF, init, SELinux, `PRODUCT_PACKAGES`, Linux ABI constants, and booted `checkvintf`/`lshal`/service evidence are aligned. |
| Android evidence capture strictness | `build/reports/android_evidence_capture_contract.json` | `blocked` | Real AOSP boot transcripts, launcher runtime evidence, agent health evidence, and Tradefed CTS/VTS output replace source/version placeholders. |
| Android release readiness | `build/reports/android_release_readiness_contract.json` | `blocked` | Real hashes/sizes, chip/riscv64 artifact, boot validation, HOME/foreground checks, agent health, logcat, and SELinux scans in release and post-flash flows. |
| Android launcher foreground | `build/reports/android_launcher_runtime_evidence.json` | `blocked` | `sys.boot_completed=1`, HOME role/resolve, foreground Eliza activity, package grants, and clean logcat. |
| Android agent health | `build/reports/android_launcher_runtime_evidence.json` | `blocked` | Eliza service process, `/api/health` HTTP 200, `ready=true`, and no crash loop. |
| Android app riscv64 payload | `build/reports/android_app_runtime_contract.json` | `blocked` | APK/runtime contract `status=pass` and booted runtime smoke proving riscv64 extraction/start. |
| Android system APK payload | `build/reports/android_system_apk_payload.json` | `blocked` | Staged AOSP APK contains `assets/agent/riscv64`, `lib/riscv64`, manifest package, and machine-readable build provenance, then booted runtime smoke proves extraction/start. |
| Android identity contract | `build/reports/chip-os-identity-contract.json` | `blocked` | App, AOSP vendor layer, chip scripts, and docs agree on package id, HOME role target, service component, and health endpoint. |
| Cross-fork agent payload contract | `build/reports/cross_fork_agent_payload_contract.json` | `blocked` | Android riscv64 staging is fail-closed, Linux cannot fall back to a fake health responder, and runtime Linux/Android evidence proves the shared payload extracts, starts, and serves `/api/health` on booted targets. |
| Phone runtime surfaces | `build/reports/phone_runtime_readiness_contract.json` | `blocked` | Display/HWC/camera/audio/radio/sensor/PMIC/power/thermal runtime evidence for no-issues operation. |
| Minimum Linux+NPU target | `build/reports/minimum_linux_npu_target.json` | `blocked` | Minimum Linux target passes, target-side e1 NPU ML smoke transcript exists, and generated-AP Linux/NPU evidence is captured. |
| Android simulated peripheral evidence | `build/reports/android_simulated_peripheral_evidence.json` | `blocked` | `RESULT=0`/`status=PASS` logs for camera, microphone, speaker, Wi-Fi, Bluetooth, and cellular surfaces, or an explicitly scoped product milestone excluding them. |
| Android system bridge runtime | `build/reports/android_system_bridge_contract.json` | `blocked` | Booted runtime evidence proves the bridge service is registered, privileged, non-mock in production, and consumed by the UI. |
| Optimization runtime evidence | `build/reports/chip-os-optimization-gap-inventory.json` | `blocked` | CPU/AP, NPU, memory, cache, power, thermal, benchmark, and SOTA optimization evidence is target-specific enough to support no-issues runtime claims. |
| OS RV64 qemu tooling | `build/reports/qemu_virt_smoke.json` | `blocked` | qemu-virt smoke `status=pass` with `boot_completed=true` and required ElizaOS markers in this environment. |
| Evidence provenance hygiene | `build/reports/chip-os-evidence-provenance.json` | `blocked` | Evidence artifacts are portable, timestamped, claim-scoped, and free of placeholder/blocked markers before they are used for boot or launcher claims. |
| Unfinished marker inventory | `build/reports/chip-os-gap-keyword-inventory.json` | `blocked` | TODO, stub, placeholder, mock, fake, unsupported, deferred, and blocked markers across chip, Linux, AOSP, and app paths are classified in blocker reports or removed before readiness claims. |

## Dependency-Ranked Closure Plan

The closure plan orders blockers by prerequisite depth so downstream Android
launcher work does not hide the earlier AP/firmware/ABI blockers. Current
status: all five phases are blocked. Phase rollups are driven by open
requirements first, so proven workflow rows no longer lead a blocked phase.

| Phase | Open requirements | First blocker codes | Exit criteria |
| --- | ---: | --- | --- |
| P0 `p0_workflow_evidence_plumbing` | 8 | `blockers_to_minimum_linux_npu_target_chipyard_generated_ap`, `blockers_to_minimum_linux_npu_target_chipyard_payload_path`, `blockers_to_minimum_linux_npu_target_chipyard_verilator_linux_attempt` | All nonpassing gates remain covered by reports, evidence provenance/manifests/dashboard rows are clean, and qemu-system-riscv64 plus required external paths are available to the OS/chip checks. |
| P1 `p1_chip_ap_boot_base` | 10 | `platform_contract_boot_vector_placeholder`, `platform_contract_has_no_cpu_boot_target`, `security_boot_docs_are_pre_silicon_or_blocked` | Core/profile/AP scope, CPU/AP boot readiness, Chipyard payload-path evidence, platform/boot-security contracts, firmware, generated-AP smoke, and memory/platform reports prove the selected e1-compatible AP target can hand off to Linux cleanly. |
| P2 `p2_linux_fork_agent` | 7 | `linux_boot_artifact_missing_e1_mmio_smoke`, `linux_boot_artifact_missing_serial_boot_log`, `linux_boot_preflight_external_buildroot_tree_eliza_buildroot_tree_is_unset_external_buildroot` | Linux manifest includes chip-target boot and agent-live evidence, with active service and health/API smoke. |
| P3 `p3_aosp_boot_launcher_agent` | 10 | `apk_missing_riscv64_agent_assets`, `apk_missing_riscv64_native_libs`, `cts_vts_plan_is_source_scan_only` | AOSP reports are full-evidence PASS, HAL/release/evidence-capture gates are clean, staged APK payload evidence passes, and launcher runtime evidence proves HOME foreground, service process, `/api/health` ready, and clean logcat. |
| P4 `p4_no_issues_phone_runtime` | 5 | `aosp_chip_product_declares_no_audio_hal`, `cuttlefish_e1_missing_phone_hals`, `peripheral_capture_probe_wifi_disabled` | Phone runtime, minimum Linux+NPU, Android peripheral, system bridge runtime, and optimization gap reports pass with real runtime evidence for every required surface. |

## Evidence Sample

Commands run on 2026-05-20:

| Command | Result | Evidence |
| --- | --- | --- |
| `python3 scripts/check_chipyard_verilator_linux_smoke.py` from `packages/chip` | `BLOCKED` | `build/chipyard/eliza_rocket/verilator-linux-smoke.json` reports progress stage `linux_boot`: wrapper `exit_code=124`, last progress marker is the forced kernel command line, and the required OpenSBI/SBI handoff marker is missing. |
| `python3 scripts/check_android_sim_boot.py` from `packages/chip` | `BLOCKED` | `build/reports/android_sim_boot.json` is build-only and says virtual-device smoke plus CTS/VTS were not requested. |
| `python3 scripts/check_aosp_linux_preflight.py --json` from `packages/chip` with no `AOSP_DIR` in the command environment | `BLOCKED` | Reports `AOSP_DIR is not set`, broken `repo`, missing `qemu-system-riscv64`, missing `renode`, and unset AOSP QEMU/Renode smoke commands. |
| `make -C packages/os/linux/elizaos release-check ARCH=riscv64` | `PASS` | Validates qemu-virt/GRUB emulator evidence and ISO checksum only. It does not prove Eliza chip boot or agent liveness. |

## Critical Blockers

| Area | Gap | Why it blocks the objective | Current evidence | Required closure evidence |
| --- | --- | --- | --- | --- |
| Generated AP Linux boundary | The Chipyard AP smoke gate is currently blocked in `linux_boot` after an early kernel command-line marker but before accepted OpenSBI/Linux completion markers. | The generated AP path does not currently prove even its bounded Linux completion prerequisite, so it cannot support OS fork, launcher, or agent readiness claims. | `packages/chip/build/reports/chipyard_verilator_linux_smoke.json` status `blocked`, progress stage `linux_boot`; blockers include wrapper `exit_code=124` and missing OpenSBI/SBI handoff. | Rerun with fresh PC evidence or enough timeout/trace to identify the payload stage, then capture accepted generated-AP completion before using it as a prerequisite. |
| Smoke-log status source of truth | The authoritative classification lives in the JSON gate, not in cherry-picked raw serial snippets. | Downstream review can misread partial UART/device-model output as broader readiness unless it follows the JSON checker. | `check_chipyard_verilator_linux_smoke.py` reports the blocked `linux_boot` state; raw log snippets do not override that report. | Keep the JSON report and checker output as the source of truth; do not promote raw serial snippets without the required OS fork and launcher/agent evidence. |
| Actual e1 RTL CPU/AP | `e1_chip` contract says `has_cpu: false`; `e1_soc_top` warns the CPU compiles as idle unless `E1_HAVE_CVA6` is defined; the old `e1_cpu_subsystem_stub` is a tiny RV-style executor. | The checked-in chip RTL cannot directly boot Linux/AOSP; generated Chipyard AP is a separate bring-up path. | `sw/platform/e1_platform_contract.json`, `rtl/top/e1_soc_top.sv`, `rtl/cpu/e1_cpu_subsystem_stub.sv`. | A selected top-level AP integration with real CPU, MMU, privilege, timer, IRQ, DRAM, UART, reset, and boot transcript. |
| Chipyard AP hardware ABI | The static Chipyard AP ABI detail report now passes, but that only proves the checked static ABI contract, not Linux/AOSP boot or driver operation. | Linux/AOSP readiness still depends on firmware handoff, memory/platform evidence, OS fork chip-target evidence, and runtime driver smoke. | `scripts/check_chipyard_ap_abi_contract.py` and `scripts/check_chipyard_verilator_linux_smoke.py` report `PASS`; `linux_firmware_boot_chain_contract` and `linux_memory_platform_contract` remain blocked. | Keep ABI drift gated while capturing DTB, OpenSBI, kernel, init/userland, OS fork chip-target, and driver smoke evidence. |
| Linux/Android memory-platform evidence | The unified memory-platform gate is no longer a static `FAIL`, but it remains `BLOCKED` because there is no external Linux kernel build, DTB check, generated-AP serial boot, OpenSBI handoff, Buildroot manifest, or e1 MMIO smoke evidence. | Matching DTS text is necessary but does not prove Linux or Android can boot through the memory/interrupt/platform path. | `scripts/check_linux_memory_platform_contract.py` reports `STATUS: BLOCKED linux_memory_platform_contract` and lists the six missing evidence producers. | Capture Linux kernel build, DTB check, serial boot, OpenSBI handoff, Buildroot manifest, and e1 MMIO smoke evidence for the selected chip/AP emulator target. |
| Memory/boot handoff | Generated DTS exposes 256 MiB at `0x80000000`, but the smoke log forces `mem=64M` and panics during Linux memory initialization. | Kernel memory topology is not valid for the selected payload/handoff. | `verilator-linux-smoke.log`, generated DTS, generated memmap. | Reconciled bootargs, DTB memory range, payload load addresses, and OpenSBI/Linux handoff evidence. |
| Linux fork mismatch | Debian RV64 qemu-virt boots on generic QEMU firmware/GRUB, not on the generated Eliza AP simulator. | It proves the OS image can boot in QEMU virt, not that `packages/chip` can run it. | `packages/os/linux/elizaos/evidence/qemu_virt_boot.json` claim boundary is qemu-virt only; `manifest.json` target has `device: null` and `hypervisor: qemu-virt`. | Boot the same OS artifact, or a declared chip-target variant, on the Eliza AP simulator and bind evidence into both chip and OS manifests. |
| Linux launcher/agent | The RV64 manifest marks `elizaos-agent-live` as collected, but that row reuses the same qemu-virt evidence file and the image can install a fallback Python health server when real agent artifacts are absent. | Objective requires the actual Eliza launcher/app/agent to start on the chip emulator, not a generic qemu-virt health endpoint or fallback `/api/health` responder. | `scripts/check_os_rv64_chip_boot_contract.py` reports `agent_live_evidence_reuses_qemu_virt_reference` and `linux_agent_fallback_payload_allowed`; `0010-elizaos-agent.hook.chroot` writes `fallback_agent.py` and `elizaos-fallback`. | Real agent bundle packaged fail-closed, fallback disabled for objective evidence, `elizaos-agent.service` active on the chip/AP emulator, and API/health smoke captured in chip-target transcript/evidence JSON. |
| Linux release gate scope | `check_release_manifest.py` correctly validates the qemu-virt/GRUB release artifact and required qemu transcript markers, but the chip-side contract now keeps that separate from chip-target boot and real-agent liveness. | A passing OS release gate can still leave the user objective blocked because it is not generated-AP/chip-emulator evidence. | `release-check` passes while `os_rv64_chip_boot_contract.json` blocks on `missing_chip_target_boot_evidence_row`, `manifest_target_not_chip_emulator`, `qemu_virt_evidence_is_reference_only`, `agent_live_evidence_reuses_qemu_virt_reference`, and `linux_agent_fallback_payload_allowed`. | Keep qemu-virt release evidence scoped as generic OS artifact evidence and add separate generated-AP/chip-emulator boot plus real-agent-live evidence rows. |
| AOSP full evidence | Current Android simulator report is build-only. It did not run Cuttlefish, CTS/VTS intake, QEMU, or Renode. | No evidence that AOSP boots, completes `sys.boot_completed`, or can run Eliza on any target. | `build/reports/android_sim_boot.json` has `require_full_evidence: false` and only five attempted logs. | Full mode report with all required evidence logs passing: lunch, vendorimage, VINTF, SELinux build, neverallow, CTS/VTS plan, Cuttlefish, QEMU, Renode. |
| AOSP chip evidence | Cuttlefish/QEMU/Renode evidence, even when captured, is reference software evidence only and explicitly not e1 chip hardware ABI proof. | Objective requires AOSP fork running on the chip emulator path. | `check_android_sim_boot.py` claim boundary and `boot_android_simulator.sh` report boundary. | Android boot/userspace transcript from generated Eliza AP simulator, with kernel/DTB/vendor image pairing and chip ABI markers. |
| AOSP product runtime | Chip-side `eliza_ai_soc` now packages and declares the HAL services, but the e1 NPU implementation is still stub/fail-closed, the HIDL interface is not packaged/generated from this tree, HWC is framebuffer-only, and the Cuttlefish simulator HAL can satisfy the same service identity. | The target can look wired while still lacking real Android hardware services required for a phone-like boot. | `scripts/check_aosp_hal_service_contract.py` reports `BLOCKED` for `aosp_e1_npu_hidl_interface_not_packaged`, `aosp_e1_npu_hal_is_stub_or_fail_closed`, `aosp_hwcomposer_is_framebuffer_stub`, and `aosp_cuttlefish_sim_hal_can_mask_real_e1_npu`; there is still no booted-device HAL liveness, VINTF, SELinux, `lshal`, or `/dev/e1-npu` evidence from the selected chip-emulator target. | Real fail-closed HAL binaries included, VINTF entries active, SELinux contexts/policies pass, ABI constants generated from the same contract, HIDL/interface packaging is present, simulator evidence is separated from chip evidence, and HAL liveness smoke is captured. |
| AOSP launcher path | `packages/os/android/vendor/eliza` imports `Eliza.apk` as privileged and strips launchers, but chip-side AOSP target is separate and not proven to include/run that vendor layer. | The app replacing Launcher3 on Cuttlefish/Pixel does not automatically mean the e1 AOSP target launches Eliza. | `packages/os/android/vendor/eliza/apps/Eliza/Android.bp`, `eliza_common.mk`; chip-side `sw/aosp-device` has a different product tree. | Single declared AOSP product for chip emulator that includes Eliza APK, grants roles/permissions, boots to HOME, and captures `dumpsys activity`/launcher foreground evidence. |

## Launcher, Agent, And Android Runtime Blockers

| Area | Gap | Why it blocks the objective | Current evidence | Required closure evidence |
| --- | --- | --- | --- | --- |
| Android package identity | The OS vendor layer grants roles and permissions to `ai.elizaos.app`, the actual Android app declares `applicationId "app.eliza"`, and one operator recipe still documents legacy `com.elizaos.agent` defaults. | HOME replacement, privileged permission grants, role holders, service startup, and human-run smoke scripts can target different package names. A booted image can still fail to launch Eliza or fail agent smoke because app build, vendor policy, and operator evidence are not normalized to one identity. | `packages/os/android/vendor/eliza/eliza_common.mk`, overlay `config.xml`, permission XMLs, `packages/app/android/app/build.gradle`, `packages/chip/docs/android/cuttlefish-agent-smoke-operator-recipe.md`, `packages/chip/sw/aosp-device/*agent*`. | One package ID chosen across app build, vendor privapp import, role/default-permission XML, manifests, smoke scripts, operator docs, and evidence. Capture `pm path`, `cmd role holders`, `dumpsys package`, and HOME foreground for that package. |
| Android service start workflow | The chip smoke now launches the exported app surface and lets `MainActivity` start the private `ElizaAgentService` from the app UID on branded AOSP. One operator recipe still documents legacy `com.elizaos.agent/.AgentService`. | The host no longer directly starts a non-exported service, but booted evidence still has to prove that app launch actually starts the service and health endpoint on riscv64. | `scripts/check_android_app_runtime_contract.py` no longer reports `android_agent_service_not_exported_for_adb_smoke`; remaining app-runtime blockers are the missing riscv64 APK assets and native libs. | Capture `dumpsys activity services`, service PID, `/api/health`, and logcat evidence showing app-owned startup works without crash/restart loops. |
| Agent HTTP contract | `start-eliza-agent-riscv64.sh` asserts `/api/agent/self-status` has `status: "ready"`, while `cuttlefish_agent_smoke.py` asserts `agentId` and `plugins[]` with ready plugin state. | The agent can satisfy one smoke and fail the other, so the gate does not define a stable liveness API. | `start-eliza-agent-riscv64.sh`, `scripts/cuttlefish_agent_smoke.py`. | Versioned self-status schema used by app, docs, and all chip/OS gates; transcript captures the response body. |
| Agent fixture availability | Cuttlefish agent smoke requires APK, llama model, golden audio/transcript, wakeword model/audio, and VAD audio through environment variables or defaults. | Missing model/audio fixtures block a real agent smoke independently of Android boot. | `agent-smoke-riscv64.sh`, `scripts/cuttlefish_agent_smoke.py`, `capture-aosp-evidence.sh`. | Checked-in small test fixtures or documented artifact fetch with hashes; smoke fails closed when any required fixture is missing. |
| Android system bridge | The native bridge no longer trips the static stub/package checks, but the contract now blocks because `docs/evidence/android/system_bridge_runtime_evidence.json` is missing. | UI status and controls can still be claimed from source/package inspection without proving the bridge is installed, registered, permissioned, JS-bound, non-mock, and clean on a booted Android target. | `build/reports/android_system_bridge_contract.json` reports `system_bridge_runtime_evidence_missing`; inputs include `SystemBridge.kt`, `AndroidSystemProvider.tsx`, the bridge contract, vendor package list, and privapp allowlist. | Capture booted bridge runtime evidence from the selected product with package install, service registration, permission grants, JS bridge binding, live-state UI consumption, no production mock fallback, and clean logcat/SELinux counts. |
| System UI packaging | The AOSP vendor layer covers the Eliza APK, role permissions, and static bridge package/privapp entries, but no evidence shows the native system bridge is running as a privileged component in the selected product. | Launcher foreground alone would not prove power/audio/network/system-control paths work. | `packages/os/android/vendor/eliza` package lists, bridge permission XML, and `build/reports/android_system_bridge_contract.json`. | Product package and permission XML kept aligned, plus boot evidence that the bridge service is registered and consumed by the UI. |
| Privapp/SELinux scope | `eliza_agent.te` includes broad userdebug-only allowances such as executing app data files. | A userdebug image may run in ways a production-like image would reject, and security policy can mask packaging mistakes. | `packages/os/android/vendor/eliza/sepolicy/eliza_agent.te`. | Narrow policy for production target or an explicit userdebug-only milestone boundary; neverallow pass and denial-free logcat for the chosen product. |
| AOSP missing dependency mask | Chip AOSP `BoardConfig.mk` sets `ALLOW_MISSING_DEPENDENCIES := true`. | AOSP builds can proceed while HAL/app/vendor dependencies are absent, producing evidence that does not prove the final product is complete. | `packages/chip/sw/aosp-device/device/eliza/eliza_ai_soc/BoardConfig.mk`. | Remove or tightly scope the flag before claiming boot readiness; build must fail when required Eliza packages/HALs are missing. |
| HAL docs/config drift | `eliza_ai_soc/README.md` describes `m vendorimage` building stub HALs, the packaged e1 NPU HAL still documents smoke-only stub/fail-closed behavior, HWC is framebuffer-only, and a separate Cuttlefish simulator HAL exposes the same `IE1Npu/default` service identity. | Reviewers can mistake scaffold HAL source, Cuttlefish sim behavior, or active VINTF fragments for chip-product HAL integration. | `device/eliza/eliza_ai_soc/README.md`, `device.mk`, `eliza_e1.xml`, `hal/e1_npu/*.rc`, `hal/e1_npu/E1Npu.h`, `hal/hwcomposer/hwcomposer.cpp`, `hal/e1_npu_sim/E1NpuSim.h`, `device/eliza/cuttlefish_e1/eliza_e1_cuttlefish.mk`, `manifest.fragment.xml`. | Product-specific matrix showing exactly which HALs are built, installed, declared in VINTF, started, and smoke-tested for chip AP versus Cuttlefish. |
| Launcher evidence | No current evidence captures role assignment, default HOME resolution, foreground Eliza activity, PackageManager grants, or crash-free logcat after Android boot. | The objective says the launcher app starts up; boot completion alone is insufficient. | Android reports are build-only; no `dumpsys activity`/`cmd role`/logcat launcher transcript is recorded. | Evidence bundle with `sys.boot_completed=1`, `cmd role holders`, `cmd package resolve-activity HOME`, foreground activity, app/service process, permission grants, and no fatal crash loop. |
| Product selection | Android targets are split across reference Cuttlefish, OS vendor Cuttlefish, OS chip phone, and chip scaffold products, but the capture defaults now match the fused Eliza chip product and Eliza Cuttlefish product. | Product naming can still confuse evidence review unless every transcript records the exact lunch target and claim boundary. | `scripts/check_aosp_product_contract.py` now reports `PASS` after `capture-aosp-evidence.sh` was aligned with `eliza_openagent_ai_soc_phone-trunk_staging-userdebug` and `eliza_cf_riscv64_phone-trunk_staging-userdebug`. | Keep a single named product for each claim: reference Cuttlefish, chip-emulator Android, and eventual hardware. Every evidence file must record the exact lunch target and imported vendor/device trees. |

## Android APK And Release Packaging Blockers

The current AOSP vendor layer imports a checked-in prebuilt APK at
`packages/os/android/vendor/eliza/apps/Eliza/Eliza.apk`. That artifact is not
just a build detail: it is the app the image installs as privileged `Eliza`.

| Area | Gap | Why it blocks the objective | Current evidence | Required closure evidence |
| --- | --- | --- | --- | --- |
| Prebuilt APK package id | The app-runtime contract currently reads the vendor prebuilt as `ai.elizaos.app`, but the wider identity contract still finds `app.eliza` in the app/shortcut source tree and `com.elizaos.agent` in operator docs. | The runtime APK can be aligned while adjacent build, shortcut, release, or human-run paths still target a different identity. | `android_app_runtime_contract.json` package evidence; `chip-os-identity-contract.json` still reports `android_package_identity_mismatch` and `operator_docs_stale_agent_identity`. | Prebuilt APK, Gradle/Capacitor app IDs, privapp/default-permission XMLs, overlays, shortcuts, static manifest, smoke scripts, release validation, and operator docs all target the same package. |
| Prebuilt APK native ABI | The prebuilt APK has `lib/arm64-v8a`, `lib/armeabi-v7a`, `lib/x86`, and `lib/x86_64`; it has no `lib/riscv64`. | A riscv64 Cuttlefish or chip AOSP target cannot load JNI/native runtime libraries from this APK. | `unzip -Z1 Eliza.apk` native ABI list. | RISC-V APK or product-specific APK split containing every required `lib/riscv64/*.so`; `pm install`/PackageManager ABI evidence on riscv64. |
| Local agent runtime ABI assets | The APK has `assets/agent/arm64-v8a` and `assets/agent/x86_64`, but no `assets/agent/riscv64`. `ElizaAgentService` explicitly throws if `assets/agent/<abi>` is missing for the runtime ABI. | On a riscv64 Android device, the foreground agent service cannot extract or execute Bun/local-agent assets, so launcher startup cannot become agent-ready. | `android_system_apk_payload.json` now reports `missing_riscv64_agent_runtime_entries`; `ElizaAgentService.extractAssetsIfNeeded()` checks `assets.list("agent/" + abi)` and throws when empty. | `assets/agent/riscv64` with Bun, loader, runtime libraries, launch script compatibility, and a service-start smoke proving extraction plus executable permissions. |
| Native loader ABI entries | The staged system APK has no `lib/riscv64` entries for `libeliza_bun.so`, musl loader, GCC runtime, or C++ runtime. | Even if `assets/agent/riscv64` were added, the service cannot link the extracted runtime from packaged native libraries on a riscv64 target. | `android_system_apk_payload.json` reports `missing_riscv64_native_loader_entries`; APK listing shows only arm64/x86_64 native runtime entries. | Add the `lib/riscv64` native runtime entries and prove PackageManager/device ABI selection plus service extraction on the booted target. |
| APK build provenance path | The staged APK includes machine-readable provenance, but `repo_root` is an absolute `/home/shaw/...` path and the claim boundary is packaging-only. | Host-local provenance is not reproducible release evidence and cannot prove a clean external AOSP build or booted launcher/agent runtime. | `android_system_apk_payload.json` reports `aosp_build_provenance_contains_host_local_path`. | Record reproducible source identity, relative source roots, artifact hashes, and keep packaging provenance separate from booted runtime evidence. |
| Host-started private agent service | `start-eliza-agent-riscv64.sh` now launches the app instead of directly starting the non-exported foreground service. | A real smoke can still fail if the app-owned startup path does not run on the selected product, but that is now a booted-evidence blocker rather than a static script/manifest contradiction. | `android_app_runtime_contract.json` no longer includes `android_agent_service_not_exported_for_adb_smoke`. | Prove app-owned startup on the booted target with foreground activity, service PID, `/api/health`, and clean logcat. |
| Local llama native path | Gradle comments say `android-riscv64-cpu` exists incrementally, but the prebuilt APK carries fork llama libs only for arm64/x86_64 style paths and no riscv64 local llama bundle. | The local agent can start but fail model execution, or cannot enable `ELIZA_LOCAL_LLAMA`, on a riscv64 target. | `app/build.gradle` `elizaForkLlamaAbis = ['arm64-v8a', 'x86_64', 'riscv64']`; APK contents lack riscv64. | RISC-V local inference artifacts staged into APK, with GGUF load and `/api/health`/chat smoke on riscv64. |
| App health endpoint mismatch | The actual service watchdog probes `/api/health` and expects JSON `ready: true`, optional `runtime: "ok"`, and optional `agentState: "running"`. The Capacitor plugin status path uses `/api/status`. Chip-side smokes use `/api/agent/self-status`. | Current smokes are not checking the API contract the app uses to decide the local agent is running. | `ElizaAgentService.HEALTH_URL`, `isReadyHealthBody()`, `AgentPlugin.getStatus()`, chip `start-eliza-agent-riscv64.sh`, `cuttlefish_agent_smoke.py`. | One versioned health/status contract or adapters in the chip smokes; evidence should capture the app watchdog endpoint and the external smoke endpoint. |
| AOSP build flag | The app only sets `BuildConfig.AOSP_BUILD` when Gradle is invoked with `-PelizaAospBuild=true`; the imported prebuilt only shows package/version metadata and no evidence that this flag was set. | AOSP-only boot behavior, longer timeouts, appop auto-grants, and local-llama defaults depend on this flag plus `ro.elizaos.product`. | `app/build.gradle`; `MainActivity`; `ElizaBootReceiver`; `ElizaAgentService`. | Build provenance for the imported APK showing `-PelizaAospBuild=true`, plus runtime logcat/sysprop evidence that AOSP branches executed. |
| Oversized prebuilt | The imported APK is 655 MiB and contains broad UI/media assets plus local agent runtimes. | Large privileged system APKs stress image size, OTA payload size, extraction time, first boot latency, and emulator startup, especially on constrained chip/AP images. | `ls -lh Eliza.apk`; APK asset listing. | Product-specific system APK or splits for riscv64/chip with measured boot/extraction time, image size budget, and no unused ABI payloads. |
| Dexpreopt disabled | `Android.bp` disables dexpreopt to skip optional uses-library manifest checks. | This avoids a Soong validation failure but can hide manifest/library drift and slow first boot. | `vendor/eliza/apps/Eliza/Android.bp` comments. | Declare optional uses libraries correctly or document dexpreopt-off as an intentional performance tradeoff with first-boot timing evidence. |
| Installer post-flash validation | `validate-post-flash.sh` checks ADB state, device, fingerprint, slot, and `sys.boot_completed`, but not HOME, roles, permissions, agent service, health, or logcat crash loops. | Android release validation can pass while Eliza never becomes the launcher or agent-ready. | `packages/os/android/installer/scripts/validate-post-flash.sh`. | Add read-only checks for `cmd role holders`, HOME resolve activity, `dumpsys package app`, permission grants, foreground activity, service process, `/api/health`, and fatal logcat scan. |
| Android release manifest placeholders | The beta Android manifest fails strict validation due all-zero SHA-256 and size `1`, but passes with `--allow-placeholders`. | Draft manifests can look structurally valid while no real bootable artifacts are present. | `node .../validate-release-manifest.mjs android-release-manifest.json` fails; same command with `--allow-placeholders` passes. | Published manifests must run without `--allow-placeholders` and with artifact-dir hash/size verification, then post-flash launcher/agent validation. |
| OS release evidence scope | The OS beta release manifest asks for `assistant-role-validation`, but the checked artifact entries have empty evidence arrays and no chip-riscv64 Android target. | Release metadata is not evidence that the chip AOSP fork boots or runs Eliza. | `packages/os/release/beta-2026-05-16/manifest.json`. | Evidence arrays populated with Cuttlefish/chip boot, role, launcher, and agent health logs, plus a declared chip-riscv64 target when available. |

## RTL, Firmware, And Verification Stub Inventory

The local stub audit is useful but easy to misread. `python3
verify/check_stub_audit.py` currently passes and writes
`build/reports/stub_audit.json`: owned placeholders are allowlisted or tied to
documented open gaps. It does not close any RTL gap. The blocking source of truth is
`packages/chip/verify/rtl_gap_work_order.yaml`.

| Area | Open gap | Why it blocks Linux/AOSP-on-chip | Current evidence | Required closure evidence |
| --- | --- | --- | --- | --- |
| CPU core | The normal tree still carries `rtl/cpu/e1_cpu_subsystem_stub.sv`, plus cluster/RVV/CVA6-disabled fail-closed paths. | Linux/AOSP require a real RV64 privileged core with MMU, traps, interrupts, atomics, timer, cache/memory ordering, and boot handoff. | Stub audit allowlist; `rtl_gap_work_order.yaml` `cpu-real-core-integration`, `cpu-privileged-boot-contract`, and `cpu-legacy-stub-module-name`. | Production RV64 core wrapper integrated into the SoC address map with generated DTS, OpenSBI handoff, Linux boot transcript, and real CPU architectural/privileged coverage. |
| Boot ROM | The contract ROM exposes identity/version words; the executable reset stub is not wired into a CPU wrapper or exercised by an OS boot simulation. | Firmware cannot be trusted to initialize machine state and hand off to OpenSBI/Linux/AOSP. | `rtl_gap_work_order.yaml` `bootrom-firmware-handoff`; `fw/boot-rom/reset.S`; `rtl/bootrom/e1_bootrom.sv`. | Executable reset ROM connected in the selected AP path, with checked reset-vector, trap, interrupt, handoff-address, and serial transcript evidence. |
| Interrupt/timer path | CLINT/PLIC behavior is still scaffolded; `e1_soc_top` documents placeholder interrupt completion and PLIC-lite wiring. | Linux needs timer interrupts, external interrupts, IRQ routing, and interrupt-controller DT compatibility before it can boot reliably. | Stub audit entries for `test_clint_timer_irq.py`, `test_plic_claim_threshold.py`, and `rtl/top/e1_soc_top.sv`; `rtl_gap_work_order.yaml` CPU boot-contract gap. | CLINT/PLIC-compatible RTL or declared equivalent, DT nodes, driver compatibility, interrupt smoke, timer tick evidence, and Linux boot log using those interrupts. |
| Interconnect | The Linux contract fabric is still an AXI-Lite/debug scaffold and does not route the full SoC, NPU, display, ordering, coherency, or multi-master behavior. | Booting a phone OS depends on coherent/full-width memory traffic, device routing, DMA, display scanout, and fault handling beyond small contract windows. | `rtl_gap_work_order.yaml` `interconnect-full-soc-routing`, `interconnect-display-npu-linux-mmio`, and `interconnect-axi-lite-proof-coverage`; stub audit entries for AXI-Lite scaffold. | Address map generated from platform contract, protocol assertions, complete routing tests, arbitration/backpressure coverage, and software-visible NPU/display nodes. |
| DRAM/memory | DRAM is a small SRAM-backed AXI-Lite aperture; the DRAM controller is a DFI-facing scaffold. | Linux/AOSP require large RAM, realistic latency/backpressure, cacheable memory, boot-time discovery, and memory tests. | `rtl_gap_work_order.yaml` `dram-controller-and-capacity`; stub audit entries for `rtl/memory/dram_ctrl/e1_dram_ctrl.sv`. | Real memory-controller boundary or verified large external memory model, capacity discovery, boot memtest, error policy, and kernel memory map evidence. |
| DMA | DMA is a word-copy AXI-Lite master against the scaffold memory aperture; long transfer and protocol coverage are incomplete. | Android/Linux drivers need reliable DMA completion, IRQs, cache/coherency policy, burst behavior, and error handling. | `rtl_gap_work_order.yaml` `dma-real-memory-system` and `dma-proof-depth-and-protocol`; long-transfer cocotb test noted as not wired into `make cocotb`. | Production-memory DMA tests, partial-beat and long-burst behavior, coherency policy, IRQ completion, protocol proofs, and driver smoke. |
| NPU | The NPU is bounded MMIO/scalar/scratch-GEMM, not a production accelerator with descriptor queues or tensor memory interface. | AOSP NNAPI/agent model execution claims cannot be backed by the chip NPU yet. | `rtl_gap_work_order.yaml` `npu-production-accelerator` and `npu-test-coverage-accounting`; skipped queue-stress scaffold. | Selected accelerator IP or microarchitecture, descriptor ABI, memory/tensor interface, interrupts, Linux/Android driver contract, NNAPI/VTS/CTS smoke, and coverage summary. |
| Display | Display has timing registers and SRAM-backed scanout, but no production framebuffer client, DSI bridge, panel PHY, format pipeline, or panel init. | A launcher may start but the phone display path is not proven to show it on chip. | `rtl_gap_work_order.yaml` `display-real-framebuffer-path` and `display-proof-gap`. | Production framebuffer path, bandwidth/QoS coverage, mode programming, underflow policy, panel init, and display trace or hardware-in-loop evidence. |
| Security/lifecycle | Lifecycle uses fixed debug-auth/key material and security boot-chain docs are not enforced by simulator boot. | Production or locked-device boot claims are out of scope until debug state, keying, rollback, and verification are explicit. | Stub audit entry for `rtl/security/e1_lifecycle.sv`; platform contract has boot-vector placeholders. | Provisioned or modeled lifecycle state, key/OTP policy, AVB/rollback/debug-lock integration, and boot evidence for the selected lifecycle state. |
| Formal/signoff | Formal gates can fall back to Yosys structural/SAT checks when SymbiYosys is missing. | A green formal status may mean shallow structural coverage, not proof of protocol correctness. | `rtl_gap_work_order.yaml` `formal-yosys-fallback-is-not-equivalent`. | CI/signoff sets `REQUIRE_SBY=1` and records solver, depth, covered modules, bounded/inductive status, and proof artifacts. |
| QEMU/Renode gates | Current QEMU/Renode checks can validate scaffold semantics or tool presence without executable e1-chip boot. | They cannot be used as chip emulator proof for Linux/AOSP. | `rtl_gap_work_order.yaml` `qemu-renode-scaffold-pass-risk`; Renode stub audit labels the flow as qemu-virt reference, not e1-chip ABI. | Real timeout-bounded run against a contract-compatible e1 model or explicitly scoped reference target, with firmware image, DTB, serial transcript, and exit-status checks. |

## AOSP Completion-Gate Blockers

`python3 scripts/check_aosp_simulator_completion_gate.py` currently exits
blocked. Its output is stronger than the build-only Android report because it
also checks required app, peripheral, and MVP simulator claims.

| Gate area | Current failure | Impact | Required closure evidence |
| --- | --- | --- | --- |
| MVP simulator report | `build/reports/mvp_simulator.json` does not assert `on_chip_os_boot_claim`, `reference_android_os_boot_claim`, `integrated_linux_npu_ml_claim`, `minimum_linux_npu_target_claim`, or `status=pass`. | The top-level simulator report does not support Linux/AOSP-on-chip or integrated NPU/runtime claims. | MVP report generated from real boot and NPU/runtime smokes with each claim true only when backed by artifacts. |
| Android simulator report | `build/reports/android_sim_boot.json` does not have `status=pass`. | Android boot remains blocked at the simulator gate. | Full Android report with passing launch/build/VINTF/SELinux/CTS-VTS/Cuttlefish/QEMU/Renode stages, or narrowed required stages with honest claim boundaries. |
| Cuttlefish boot evidence | `docs/evidence/android/cuttlefish_riscv64_smoke.log` contains failure markers and `RESULT=1`; `docs/evidence/android/cuttlefish_riscv64_boot.log` is missing. | There is no current Cuttlefish boot-completed evidence to support Android userspace readiness. | Passing Cuttlefish transcript with `RESULT=0`, `sys.boot_completed=1`, SELinux state, no kernel panic, and build metadata. |
| Agent smoke evidence | `docs/evidence/android/eliza_ai_soc_cuttlefish_agent_smoke.log` is missing. | No evidence proves the Eliza app/agent starts after Android boot. | Agent smoke transcript with package/service identity, install/start, forwarded health endpoint, plugin readiness, model/audio fixture checks, and no crash loop. |
| Phone peripheral simulation | Required rear/front camera, microphone, speaker, Wi-Fi, Bluetooth, and cellular logs are blocked with `RESULT=2`; the launcher script disables Wi-Fi while Wi-Fi evidence is required; product docs still declare no audio/mic/speaker support and missing phone HAL coverage. | A phone-like AOSP boot claim would omit core device surfaces the launcher/system UI expects. | Passing simulated peripheral logs, product/launcher wiring consistent with those required surfaces, or an explicitly scoped milestone that excludes each missing subsystem. |

## CPU/AP Completion-Gate Blockers

`python3 scripts/check_cpu_ap_completion_gate.py --require-complete` currently
fails. This gate is useful because it describes the missing proof needed before
the generated AP path can be treated as a real Linux-capable chip target.

| Missing evidence | Current failure | Impact | Required closure evidence |
| --- | --- | --- | --- |
| Linux boot transcript | `build/evidence/cpu_ap/eliza_e1_linux_boot.log` is too small and lacks required markers including command, generated manifest, early console, DTS hash, memory/CPU/timer/interrupt/UART/chosen nodes, `CONFIG_MMU`, initramfs start, e1 MMIO smoke result, and PASS status. | Existing artifacts do not prove generated AP Linux boot or the handoff contract. | Full transcript captured from the selected generated AP simulator with all required markers and no panic/failure markers. |
| Trap/timer IRQ evidence | `build/evidence/cpu_ap/eliza_e1_trap_timer_irq.log` is missing. | Linux boot cannot be trusted without trap and timer interrupt evidence. | Checked trap/timer IRQ log from AP simulation with declared command, artifact hashes, and PASS marker. |
| ISA/cache/MMU evidence | `build/evidence/cpu_ap/eliza_e1_isa_cache_mmu.log` is missing. | A launcher-capable OS needs privileged ISA, cache, and MMU behavior, not only a simple console transcript. | ISA/cache/MMU smoke transcript or architecture-test evidence tied to the generated AP. |
| AP benchmark evidence | `build/evidence/cpu_ap/eliza_e1_ap_benchmarks.log` is missing. | No performance or sustained execution evidence exists for the AP path. | AP benchmark transcript with workload, toolchain, simulator, timing/cycle data, and PASS criteria. |

## Aggregator And Dashboard Workflow Gaps

`scripts/aggregate_tapeout_readiness.py` is the closest current unified chip
plus OS view, but it is explicitly view-only and not a boot-readiness claim.
The current strict bring-up snapshot reports `PASS=51`, `FAIL=0`, `BLOCKED=24`.
The strict target exits nonzero and writes a dedicated objective report, but
that report is still an inventory/status artifact rather than proof that Linux
or AOSP booted or that the Eliza launcher/agent is live.

| Area | Gap | Why it blocks the objective | Current evidence | Required closure evidence |
| --- | --- | --- | --- | --- |
| Strict bring-up semantics | The strict objective target remains non-releasable while BLOCKED gates exist, but it still reports status from checker outputs rather than from actual booted Linux/AOSP runtime evidence. | It correctly blocks the objective, but it does not replace the missing OS fork boot transcripts, launcher foreground proof, or agent health proof. | `build/reports/chip-os-bring-up-status.json` now records `PASS=51 FAIL=0 BLOCKED=24 release_blocker=false`; strict consumers must still treat the blocked gates as effective release blockers for this objective. | Keep the strict target as the operator entry point, and clear it only with chip-target Linux agent liveness, AOSP boot, Eliza HOME foreground, and Android agent health evidence. |
| Strict summary wording | Strict mode treats BLOCKED as release-blocking even when the base aggregate has no FAIL gates. | Operators need the strict-effective blocker signal to avoid treating a no-FAIL aggregate as releasable. | Current aggregate has no FAIL gates, but 24 BLOCKED gates still cover missing boot, launcher, agent, HAL, release, and runtime evidence. | Keep strict-effective blocker wording in summaries and, if consumers parse JSON, add/consume an explicit strict/effective blocker field. |
| Aggregator boot security-chain coverage | The aggregate now includes a static boot ROM and secure boot-chain contract check. | This prevents identity-only ROM words, artifact-only reset ROM evidence, accept-all secure-boot firmware, and specification-only AVB/rollback/key ceremony docs from being missed while OS boot logs are reviewed. | `scripts/check_boot_security_chain_contract.py` reports `BLOCKED` because `e1_chip.has_cpu` is false, the platform contract still has `boot_vector_placeholder`, RTL boot ROM is not the generated executable reset ROM, reset ROM is a fixed-address unauthenticated handoff stub, `check_boot_rom.py` can mask missing toolchain as success, boot ROM release evidence is not wired/exercised in simulator, PMC secure boot returns success as a placeholder, and security docs remain blocked/spec-only. | Wire the executable reset ROM into the selected CPU/AP path, make missing toolchains/artifacts block readiness, implement or explicitly scope secure boot, and capture reset-vector, trap-loop, authenticated handoff, AVB/rollback, and negative-tamper transcripts. |
| Aggregator generated AP ABI coverage | The aggregate now includes a static Chipyard AP ABI contract check, and the current detail report passes. | This keeps generated AP ABI drift visible, but it is still not OS fork, launcher, or agent runtime proof. | `scripts/check_chipyard_ap_abi_contract.py` reports `PASS`; the remaining AP-side blockers are firmware handoff, memory/platform evidence, and real runtime markers. | Keep the static ABI report passing while closing firmware, memory/platform, OS fork chip-target, and runtime evidence blockers. |
| Aggregator phone runtime coverage | The aggregate now includes a phone runtime readiness contract that reclassifies release-blocked scope reports as blockers for this objective. | Existing media, security, radio/sensor/PMIC, and power/thermal scope checks intentionally pass when they prove non-claims remain honest; for “everything runs with no issues,” those honest non-claims must still block readiness. | `scripts/check_phone_runtime_readiness_contract.py` reports `BLOCKED` for display/graphics/HWC/camera/audio-media privacy, secure/verified boot/rollback/debug lock/production keys, Wi-Fi/Bluetooth/GNSS/NFC/cellular/sensors/haptics/PMIC/charger, and sustained power/thermal/throttle/frequency evidence. | Capture real runtime evidence for HWC/display/camera/audio privacy, secure boot and rollback/debug state, radio/sensor/health/power/thermal HALs, calibrated power/thermal traces, and sustained workload stability. |
| Aggregator Linux BSP contract coverage | The aggregate now includes a static Linux BSP contract check. | This prevents stale kernel fragments or reduced driver import scripts from being treated as adequate OS-fork bring-up collateral. | `scripts/check_linux_bsp_contract.py` reports `BLOCKED` for stale OpenPhone symbols/import paths, missing active `CONFIG_ELIZA_E1_*` symbols, missing DTS-backed display/GPIO driver symbols, legacy ASHMEM/ION config, reduced `drivers/e1` import while fuller `drivers/eliza` exists, NPU/DMA-only capture checks, and old `openphone-evidence` blocked markers. | Pick one active driver tree, align `eliza_e1.fragment`, import/capture scripts, DTS nodes, and evidence markers, then capture an external kernel build/DTB/smoke transcript. |
| Aggregator Linux boot-artifact coverage | The aggregate now includes `linux-boot-artifacts-check` with `--require-pass`, and the checker now emits a `STATUS: BLOCKED` line. | This prevents missing OpenSBI handoff, kernel build, DTB check, rootfs/initramfs, generated-AP serial boot, or MMIO smoke artifacts from being invisible in the unified view. | `scripts/check_linux_boot_artifacts.py --require-pass` reports `BLOCKED`: `ELIZA_LINUX_TREE`, `ELIZA_BUILDROOT_TREE`, and `ELIZA_OPENSBI_TREE` are unset; kernel build, DTB check, OpenSBI handoff, serial boot, Buildroot image manifest, and e1 MMIO smoke logs are missing with `.BLOCKED` sidecars. | Capture every artifact in `docs/evidence/linux/eliza-linux-boot-artifacts.json` from the selected external trees and generated AP boot path, with PASS markers and no placeholder/BLOCKED text. |
| Aggregator Linux memory/platform coverage | The aggregate includes the Linux memory/platform contract check as a hard blocker. | Linux and AOSP cannot boot reliably if their DTS files disagree with the central platform contract for DRAM, CLINT, PLIC, UART, e1 DMA/NPU/display registers, IRQs, ISA, MMU, or stale compatible strings. | `scripts/check_linux_memory_platform_contract.py` reports `BLOCKED`: DTS/platform projections are aligned enough for the static contract, but required kernel build, DTB check, serial boot, OpenSBI handoff, Buildroot manifest, and e1 MMIO smoke evidence are still absent. | Reconcile `sw/platform/e1_platform_contract.json`, generated DTSI, Linux DTS, Android DTS, generated AP DTS/DTB, and evidence manifests; then capture kernel build, DTB check, OpenSBI handoff, serial boot, Buildroot manifest, and e1 MMIO smoke evidence. |
| Aggregator firmware boot-chain coverage | The aggregate now includes a Linux firmware boot-chain contract check for Buildroot, OpenSBI, and U-Boot evidence. | This prevents missing firmware handoff proof, missing U-Boot validation, qemu-virt reference evidence, and stale Buildroot sidecars from being hidden behind a scaffold-only BSP pass. | `scripts/check_linux_firmware_boot_chain_contract.py` reports `BLOCKED` for missing Buildroot evidence, missing OpenSBI build/handoff evidence, missing U-Boot build and OpenSBI-to-U-Boot boot-chain transcripts, no `u-boot` target in `check_software_bsp.py`, qemu-virt reference-only claim boundaries, stale OpenPhone/hello sidecars, host-local preflight paths, and placeholder OpenSBI handoff commands. | Capture Buildroot, OpenSBI, and U-Boot PASS transcripts from the selected external trees and chip/AP emulator boot path; add U-Boot to the software BSP checker or keep the dedicated gate authoritative; regenerate sidecars and preflight reports without stale placeholders. |
| Aggregator Chipyard Verilator smoke coverage | The aggregate includes the generated-AP Chipyard Verilator Linux smoke check, and the current detail report is blocked in `linux_boot`. | This keeps the generated-AP prerequisite visible in the strict objective view instead of letting stale or partial smoke evidence hide the current timeout. | `scripts/check_chipyard_verilator_linux_smoke.py` reports `STATUS: BLOCKED chipyard.verilator_linux_smoke.linux_boot`; the report blockers include timeout `exit_code=124` and missing OpenSBI/SBI handoff. | Restore a passing generated-AP smoke with accepted markers, then still close the separate firmware, memory/platform, OS fork chip-target, launcher foreground, and agent health gates before claiming the full objective. |
| Aggregator cross-fork agent payload coverage | The aggregate now includes a fail-closed cross-fork agent payload check, and the static contract currently passes. | This prevents Linux and Android from independently booting to a shell/UI while packaging different, missing, optional, or fallback local-agent runtimes. | `scripts/check_cross_fork_agent_payload_contract.py` reports `PASS`: Android riscv64 staging fails closed unless explicitly marked optional for non-objective builds, and Linux no longer installs a fallback `/api/health` responder when real agent artifacts are absent. | Keep the static payload contract passing, then require `/api/health`/agent-live evidence from actual booted Linux and Android targets. |
| Aggregator chip-OS bring-up workflow coverage | The aggregate now includes a static workflow contract for `make chip-os-bring-up-status`, and the Make target now runs strict mode with a dedicated report. | This keeps the named operator command fail-closed for missing boot/launcher/agent evidence, while still making clear it is not runtime proof by itself. | `scripts/check_chip_os_bringup_workflow_contract.py` reports `PASS`; `make chip-os-bring-up-status` writes `build/reports/chip-os-bring-up-status.json` and exits nonzero while objective gates are blocked or failing. | Keep the workflow contract passing, then close the underlying Linux/AOSP/launcher/agent evidence blockers rather than weakening the target. |
| Aggregator AOSP Linux handoff coverage | The aggregate now includes a static AOSP handoff contract check. | This prevents missing AOSP checkout/tooling and placeholder QEMU/Renode stages from being buried in preflight output while the unified view only shows broader Android simulator blockers. | `scripts/check_aosp_linux_handoff_contract.py` reports `BLOCKED`: `AOSP_DIR` is unset, the `repo` launcher is present but repo is not installed, import/build/Cuttlefish/CTS-VTS/QEMU/Renode tracks are blocked, `AOSP_QEMU_SMOKE_COMMAND` and `AOSP_RENODE_SMOKE_COMMAND` are unset, and `boot_android_simulator.sh` QEMU/Renode stages are version/placeholder checks rather than Android boots. | Provide a valid AOSP checkout and host toolchain, define target-specific QEMU/Renode boot commands, and replace placeholder stages with transcripts that boot AOSP artifacts and capture boot/launcher/agent markers. |
| Aggregator app coverage | The aggregate gate now includes a static Android app runtime contract check, but it still does not prove HOME foreground, role grant, permission grant, service liveness, or `/api/health` on a booted device. | Static package/APK/script checks are necessary but not sufficient for proving the Eliza launcher app starts. | `scripts/check_android_app_runtime_contract.py` reports `BLOCKED` for missing riscv64 native libs, missing `assets/agent/riscv64`, and the adb foreground-service smoke targeting a non-exported service; it is registered as `android-app-runtime-contract-check`. | Extend from static contract checking to booted-device evidence: `pm path`, `cmd role holders`, HOME foreground, app-owned service start path, service process, `/api/health`, and fatal logcat scan. |
| Aggregator launcher runtime coverage | The aggregate now includes a booted-device launcher evidence check. | This prevents `sys.boot_completed=1` or a build-only Android report from standing in for launcher/agent readiness. | `scripts/check_android_launcher_runtime_evidence.py` reports `BLOCKED` because `docs/evidence/android/eliza_launcher_runtime_evidence.json` is missing. The required schema covers `sys_boot_completed`, riscv64 ABI, `pm path`, role holders, HOME resolve, foreground activity, service PID, `/api/health`, logcat crash count, SELinux denial count, and transcript/log artifacts. | Capture the structured evidence JSON and referenced logcat/transcript from the selected fused chip-emulator product after boot. |
| Aggregator Android evidence capture coverage | The aggregate now includes a static Android evidence-capture contract check. | This prevents generic Cuttlefish boot, QEMU version checks, source-scanned CTS/VTS plans, legacy self-status markers, or malformed launcher evidence JSON from satisfying Android readiness. | `scripts/check_android_evidence_capture_contract.py` reports `BLOCKED` because `cuttlefish-boot-gate.sh` writes launcher evidence with the wrong claim boundary for `check_android_launcher_runtime_evidence.py`, its JSON shape is missing the nested `device`/`app`/`agent`/`logs`/`artifacts` fields required by that checker, QEMU riscv64 smoke is version-only, and the CTS/VTS plan is a source/module scan rather than a Tradefed run. | Require `eliza_launcher_runtime_evidence.json`, align package/service defaults to the built APK, make the boot gate emit the exact launcher-runtime schema and claim boundary with package/HOME/role/foreground/service/health/logcat/transcript fields, and replace source/version placeholders with real boot and Tradefed transcripts. |
| Aggregator Android peripheral coverage | The aggregate now includes a static Android simulated-peripheral evidence check. | This prevents a booted launcher claim from ignoring phone surfaces that are required by the completion gate but currently blocked or contradicted by product wiring. | `scripts/check_android_simulated_peripheral_evidence.py` reports `BLOCKED` for all seven archived peripheral logs (`rear_camera`, `front_camera`, `microphone`, `speakers`, `wifi`, `bluetooth`, `cellular_5g_lte`) because they record `RESULT=2`/`status=BLOCKED`, lack PASS/result proof, and miss required markers; it also flags `launch-cuttlefish-riscv64.sh` disabling Wi-Fi, `eliza_ai_soc` documenting no audio/mic/speaker support, and `cuttlefish_e1` documenting missing phone HAL coverage. | Capture PASS adb-backed peripheral logs from the selected Android target and align launcher/product documentation with the required Wi-Fi, audio, camera, Bluetooth, and cellular surfaces. |
| Aggregator system bridge coverage | The aggregate now includes Android system bridge contract and runtime-evidence checks. | This prevents a launcher foreground pass from masking that system UI status/control surfaces are not proven on a booted target. | `scripts/check_android_system_bridge_contract.py` reports `BLOCKED` for `system_bridge_runtime_evidence_missing`: static packaging/channel checks are aligned, but no booted product evidence shows the bridge registered, permissioned, JS-bound, consumed by the UI, and clean in logcat/SELinux on the chip-emulator target. | Capture the bridge runtime evidence JSON from the selected fused chip-emulator product with package install, service registration, permission grants, JS bridge binding, live-state UI consumption, no production mock fallback, and clean logcat/SELinux counts. |
| Aggregator Android release coverage | The aggregate now includes a static Android release readiness contract check. | This prevents placeholder Android release manifests and thin post-flash scripts from standing in for a bootable chip/riscv64 release with launcher and agent evidence. | `scripts/check_android_release_readiness_contract.py` reports `BLOCKED` for all-zero partition hashes, sentinel sizes, missing chip/riscv64 target, boot-property-only validation, missing launcher/agent checks in post-flash and installer validation, missing umbrella integrity fields, empty umbrella evidence, and no Android riscv64 chip artifact. | Publish real artifacts with hash/size verification, add the chip-emulator Android riscv64 target, and make release/post-flash validation require package install, HOME role, foreground activity, service PID, `/api/health`, logcat, and SELinux evidence. |
| Aggregator AOSP product coverage | The aggregate now includes a static AOSP product-composition check, and the current detail report passes. | This catches the case where one flow builds the fused Eliza chip product while the evidence capture helper records scaffold or upstream Cuttlefish logs. | `scripts/check_aosp_product_contract.py` reports `PASS` after capture defaults were aligned with the fused chip-emulator and Eliza Cuttlefish products. | Keep capture defaults matched to the selected products and keep scaffold/upstream reference logs explicitly out of launcher readiness claims. |
| Aggregator AOSP HAL service coverage | The aggregate now includes a static AOSP HAL service contract check. | This catches active VINTF/service claims that do not map to a packaged, startable, policy-labeled service and Linux ABI-compatible implementation. | `scripts/check_aosp_hal_service_contract.py` reports `BLOCKED` because the e1 NPU HIDL interface is not packaged/generated, the e1 NPU HAL remains stub/fail-closed, HWC is framebuffer-only, and the Cuttlefish simulator HAL can mask real e1 NPU service proof. There is still no booted-target `checkvintf`, `lshal`, service PID, `/dev/e1-npu`, or logcat evidence for the selected chip-emulator product. | Keep VINTF, PRODUCT_PACKAGES, init, SELinux, HIDL generation, and Linux ABI constants in lockstep, separate simulator evidence from chip evidence, then capture `checkvintf`, `lshal`, service PID, `/dev/e1-npu`, and logcat evidence. |
| Aggregator Linux objective coverage | The aggregate now includes a chip-side OS RV64 contract check, while the OS variant's own release gate remains a qemu-virt release-artifact check. | This prevents a passing qemu-virt release row or fallback health endpoint from being mistaken for the objective's chip-target Linux boot plus real-agent liveness requirement. | `scripts/check_os_rv64_chip_boot_contract.py` reports `BLOCKED` for missing chip-target boot evidence, manifest target still being qemu-virt instead of chip emulator, qemu-virt-only evidence, the `elizaos-agent-live` row reusing qemu-virt evidence, and the Linux image allowing a fallback Python agent payload. | Add a real chip-target Linux evidence row and real-agent-live row backed by generated AP/chip-emulator transcript, `systemctl is-active elizaos-agent.service`, process/PID proof, and API health from the full agent bundle; make fallback payloads fail closed for objective evidence. |
| Absolute local paths | OS RV64 gates previously used absolute `/home/shaw/milady/eliza/...` paths. | The unified dashboard was host-local and could break when the repo is checked out elsewhere. | Fixed in current worktree: OS RV64 aggregate entries use chip-relative sibling paths, and `test_host_local_paths_are_not_hardcoded` rejects `/home/shaw/` in `GATES`. | Keep sibling-package paths repo-relative and avoid host-local evidence paths in new gates. |
| Scaffold check wording | `software-bsp-scaffold-check` runs with `--scaffold-only`; it prints scaffold checks as clear while listing missing Buildroot, Linux, OpenSBI, and AOSP external evidence. | A scaffold pass can be read as BSP readiness unless the following blocker lines are retained. | `python3 scripts/check_software_bsp.py all --scaffold-only` output: local scaffold checks clear; external evidence blocked for Buildroot, Linux, OpenSBI, AOSP. | Split scaffold status from evidence status in aggregator rows, or make this objective use `--require-evidence` gates. |
| Prototype dashboard drift | The dashboard is now refreshed against `check_mvp_status.py`. | Planning/status docs can otherwise contradict gate output and hide missing or regenerated evidence. | `check_prototype_status_dashboard.py` writes `build/reports/prototype_status_dashboard.json` with `status=pass`. | Keep dashboard validation in CI so future MVP row drift is caught before release review. |
| AOSP completion schema coverage | The AOSP completion gate requires agent smoke, simulated peripherals, VINTF, SELinux, HAL, and boot markers, but still uses legacy `/api/agent/self-status` markers and does not validate APK package identity/ABI. | Even a passing gate could still target the wrong app package or miss riscv64 APK asset defects. | `docs/project/aosp-simulator-completion-gate.yaml` requires `SELF_STATUS_*` markers and peripheral logs; APK checks are absent. | Extend the gate with APK metadata checks and align health markers with the real `ElizaAgentService` `/api/health` contract. |

## High-Priority Implementation Gaps

| Area | Gap | Evidence | Closure |
| --- | --- | --- | --- |
| AP contract source of truth | `sw/platform/e1_platform_contract.json` describes `e1_chip` as no-CPU debug ABI while generated Chipyard AP is tracked in separate generated artifacts. | Contract does not encode a complete AP boot ABI. | Add a machine-readable AP contract or explicitly designate generated Chipyard DTS/memmap as temporary AP source, then gate drift. |
| Boot firmware | OpenSBI platform glue exists, but generated smoke uses FireMarshal/Chipyard payload, not a repo-owned Eliza OpenSBI build chain. | `sw/opensbi/platform/eliza/platform.c`; Chipyard smoke payload path under `external/chipyard/software/firemarshal`. | Build/rebuild OpenSBI with declared payload/DTB, archive command, hashes, and handoff transcript. |
| Linux BSP config drift | `sw/linux/configs/eliza_e1.fragment` still refers to `OPENPHONE_HELLO_*`, `drivers/openphone`, and legacy Android configs such as ASHMEM/ION; import/capture scripts only validate the reduced NPU/DMA tree while the DTS exposes display/GPIO too. | File content is stale relative to `drivers/e1`/`drivers/eliza`, and an external kernel build can miss DTS-backed driver coverage. | `scripts/check_linux_bsp_contract.py` reports seven blockers covering fragment, import, capture, DTS-driver, and evidence-marker drift. | Rewrite fragment for current driver names and current Android kernel requirements; pick one driver tree; prove with external kernel build, DTB check, and target smoke logs. |
| DTS source mismatch | Checked-in `sw/linux/dts/eliza-e1.dts` uses UART `0x10001000`, while generated Chipyard AP console is `sifive,uart0` at `0x10020000`. | Static DTS and generated DTS disagree. | Pick per-target DTB sources and make gates reject using the wrong DTB for a boot claim. |
| QEMU tool availability | Current preflight without `AOSP_DIR` reports `qemu-system-riscv64` missing, while OS RV64 qemu release evidence clearly came from another environment/path. | `check_aosp_linux_preflight.py --json`; OS evidence. | Standardize tool PATH setup across chip and OS gates or record host-local tool provenance per gate. |
| Renode | Renode is missing on PATH for AOSP preflight and there is no real Android-capable Renode e1 SoC boot script. | Preflight blockers and `boot_android_simulator.sh` Renode stage only checks version after printing the missing handoff requirement. | Install/pin Renode and model the real AP/peripheral boot path, or remove Renode from required full evidence for the current objective. |
| AOSP QEMU/Renode commands | `AOSP_QEMU_SMOKE_COMMAND` and `AOSP_RENODE_SMOKE_COMMAND` are unset in preflight. | `check_aosp_linux_preflight.py --json`. | Define target-specific commands that actually boot AOSP artifacts, not version checks. |
| Cuttlefish product split | Capture defaults now use `eliza_openagent_ai_soc_phone-trunk_staging-userdebug` and `eliza_cf_riscv64_phone-trunk_staging-userdebug`, matching the build/boot product defaults. | `capture-aosp-evidence.sh`, `boot_android_simulator.sh`, `packages/os/android/vendor/eliza/products/eliza_cf_riscv64_phone.mk`, `build/reports/aosp_product_contract.json`. | Keep capture defaults aligned with the selected fused/Eliza products and require every scaffold/upstream reference log to carry a non-readiness claim boundary. |
| Android app evidence | The repository contains a prebuilt `Eliza.apk`, but no current evidence proves it starts after boot on riscv64 Cuttlefish or chip AP. | APK import exists; no full Android pass report. | Capture package install, role resolution, HOME intent, foreground activity, service/agent health, and logcat without crash loops. |
| Android identity normalization | The app package, vendor role/default-permission target, and chip agent smoke package are three different names today. | `app.eliza`, `ai.elizaos.app`, and `com.elizaos.agent` all appear in active integration paths. | Normalize identity or make every gate explicitly override the package/service names from the built artifact metadata. |
| HAL build surfaces | Stub HAL source exists under `hal/e1_npu` and `hal/hwcomposer`; the product now packages and declares these surfaces, but the e1 NPU HAL is smoke-only/fail-closed and HWC is framebuffer-only. | `aosp_hal_service_contract.json` reports the stub/fail-closed e1 NPU HAL, framebuffer-only HWC, unpackaged HIDL interface, and simulator HAL identity mask. | Replace the stubs with runtime-capable HALs or keep the phone-runtime claims blocked; prove AOSP build, VINTF, SELinux, `lshal`, `/dev/e1-npu`, SurfaceFlinger/display, and logcat behavior on the selected target. |
| Peripheral phone stack | Audio, camera, modem, BT, Wi-Fi, sensors, thermal, power, USB, storage, AVB/OTA are absent or explicitly deferred for chip AOSP. | `manifest.xml` absent HAL list, kernel fragment comments, package docs. | Per-subsystem contracts, Linux drivers, Android HALs, SELinux policy, and emulator/hardware smoke evidence. |
| Security boot chain | Boot ROM has a placeholder vector and security docs are not enforced by the simulator boot path. | `sw/platform/e1_platform_contract.json` `boot_vector_placeholder`; security docs. | Reset vector, ROM verification policy, key/AVB/rollback/debug state integrated into boot artifacts or explicitly scoped out of emulator milestone. |
| Release aggregator | `chip-os-bring-up-status` is now fail-closed and strict, every current nonpassing gate has a matching detailed JSON report, and every current nonpassing detail report contributes structured closure rows. | `build/reports/chip-os-boot-gap-inventory.json` reports `uncovered_gates=0` and `unstructured_reports=0`; aggregate coverage and machine-readable blocker coverage are present. | Keep new gates aligned with structured reports so every blocker has stable machine-readable codes, evidence, and next steps. |

## Workflow And Gate Problems

| Problem | Impact | Evidence | Fix |
| --- | --- | --- | --- |
| Raw log snippets are weaker than JSON classification | Makes survey/release review error-prone if reviewers promote a UART/device-model excerpt without the checker’s claim boundary. | Current Python checker returns `STATUS: BLOCKED chipyard.verilator_linux_smoke.linux_boot`. | Require JSON report/checker output and claim boundary text in docs and release notes, not raw snippets. |
| `release-check` for OS RV64 can pass while chip-target Linux remains blocked | It validates qemu-virt release evidence, not generated-AP/chip-emulator boot. | OS release gate `PASS`; chip-side contract blocks `manifest_target_not_chip_emulator` and `qemu_virt_evidence_is_reference_only`. | Keep release-check scoped to OS artifact promotion and require the chip-side contract for this objective. |
| Linux agent-live evidence can be satisfied by fallback health | The build hook installs `fallback_agent.py` unless real artifacts are required, so `/api/health` can prove only a fallback responder. | `0010-elizaos-agent.hook.chroot` contains `install_fallback_payload`, `elizaos-fallback`, and `fallback_agent.py`; chip-side contract blocks `linux_agent_fallback_payload_allowed`. | Set objective builds to fail when real agent artifacts are missing and require transcript/status proof from the full Eliza agent bundle. |
| `elizaos-ready` marker split is only partially closed | Current boot markers distinguish `elizaos-firstboot-ready` and `elizaos-agent-ready`, but the agent-ready row is still qemu-virt scoped and fallback-capable. | `qemu_virt_boot.json` includes both markers under qemu-virt claim boundary. | Keep the marker split, but bind agent-ready to chip-target evidence and full-agent payload proof. |
| AOSP full mode includes stages that are placeholders | QEMU/Renode stages currently do not boot Android; they check tool/version plus artifact presence. | `boot_android_simulator.sh` stage scripts. | Replace with real boot commands or classify them as planned/not-required. |
| Docs are stale against current artifacts | `STATUS.md` still says no ISO/qemu boot captured even though manifest and release gate now pass; the chip-side OS RV64 contract now reports this as `os_rv64_status_report_stale_against_manifest`. | `STATUS.md` vs `manifest.json`/evidence; `scripts/check_os_rv64_chip_boot_contract.py`. | Regenerate status page from manifest/check output while keeping qemu-virt scope separate from chip-target/agent-live readiness. |
| Personal-path evidence | Several evidence files use `/home/shaw/...` absolute paths. | Chipyard log and OS evidence/transcripts. | Normalize evidence with artifact-relative paths plus host metadata, or mark personal paths as local-run provenance. |
| Dirty/generated worktree | Many generated board/mechanical and OS output changes are present. | `git status --short`. | Separate boot-gap changes from unrelated generated artifacts before publishing or review. |
| Tool environment drift | Chip AOSP preflight cannot find QEMU/Renode under current command environment; OS release evidence was captured elsewhere. | Preflight tools report vs OS evidence. | Add common tool env loader or explicit `make tools`/PATH wrapper for cross-package checks. |

## Ordered Closure Plan

1. Restore a passing generated-AP smoke with accepted markers, but do not
   promote it beyond its claim boundary; capture the missing firmware,
   memory/platform, OS fork chip-target, and runtime driver evidence separately.
2. Reconcile the generated AP DTS/DTB with the e1 CPU-variant ABI or keep the
   Chipyard AP explicitly scoped as reference-only while building a separate
   e1-compatible AP path.
3. Keep the chip/OS bring-up aggregator strict while closing its remaining
   Debian RV64 chip-target boot, AOSP full virtual-device, Android-on-chip,
   Eliza app foreground, and Linux/Android agent-active blockers.
4. Split `elizaos-ready` into first-boot and agent-live evidence, then require
   agent-live for this objective.
5. Package a real Linux RV64 Eliza agent binary into the Debian image and
   capture `systemctl is-active elizaos-agent.service` plus API health.
6. Choose the AOSP chip-emulator product: either merge the OS vendor Eliza
   layer into `eliza_ai_soc`, or make a declared Cuttlefish/e1 product that
   includes both the app and chip HAL/device tree.
7. Normalize Android package/service identity across `packages/app`,
   `packages/os/android/vendor/eliza`, and `packages/chip/sw/aosp-device`,
   then capture HOME, role, service, `/api/health`, and any supported
   external agent-status endpoint evidence.
8. Replace AOSP QEMU/Renode placeholder stages with real commands or remove
   them from required full evidence until implemented.
9. Build and boot the selected AOSP image far enough to prove
   `sys.boot_completed=1`, Eliza HOME foreground, no boot loop, and no fatal
   SELinux/HAL denials.
10. Reconcile the platform contract, checked-in DTS, generated Chipyard DTS,
   OpenSBI platform, Linux driver config, and Android BoardConfig into explicit
   target-specific contracts.
11. Only after the above, promote any manifest status beyond scaffold/reference
    evidence for "Linux/AOSP forks boot on Eliza chip emulator and launcher runs."
