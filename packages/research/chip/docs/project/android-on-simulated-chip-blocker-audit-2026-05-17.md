# Android on simulated chip blocker audit - 2026-05-17

Scope: everything needed to run Android against the Eliza simulated-chip
story without overstating the current hardware. This audit separates three
tracks:

- Android virtual-device evidence: AOSP/Cuttlefish/QEMU/Renode software smoke.
- Eliza CPU/AP simulator evidence: generated Chipyard/Rocket AP boot path.
- Current e1-chip RTL evidence: debug/MMIO prototype only, not Android boot.

## Current claim boundary

Android is not proven running on the current e1-chip RTL. The central
platform contract still has `e1_chip.has_cpu=false`, so the checked-in RTL is
not an Android-capable AP. QEMU/Cuttlefish/Renode evidence is useful software
and simulator plumbing evidence only. A real "Android on our simulated chip"
claim requires a generated CPU/AP simulator, boot firmware handoff, Linux boot,
Android userspace smoke, and manifest-bound transcripts.

## Completed in this pass

| Status | Completed item | Result |
|---|---|---|
| DONE | Unify Android evidence file names across the capture helper, simulator driver, checker, docs, and manifests. | `capture-aosp-evidence.sh`, `boot_android_simulator.sh`, `check_android_sim_boot.py`, AOSP docs, and `sw/aosp-device/evidence_manifest.json` now use the strict nine-log AOSP evidence set. Legacy `cuttlefish_riscv64_boot.log`, `cts_virtual_device_subset.log`, and `vts_virtual_device_subset.log` are documented as aliases only. |
| DONE | Add capture modes for all strict AOSP evidence logs. | Added `sepolicy-build`, `selinux-neverallow`, `cts-vts-plan`, `cuttlefish-smoke`, `qemu-smoke`, and `renode-smoke` modes. |
| DONE | Keep Android simulator reports from claiming e1-chip proof. | `check_android_sim_boot.py` requires reference-only claim boundaries and rejects pass reports unless `scripts/check_software_bsp.py aosp` evidence status clears. |
| DONE | Align `boot_android_simulator.sh` with the strict AOSP gate. | Full mode attempts build/VINTF/SELinux, CTS/VTS intake, Cuttlefish, QEMU, and Renode categories. `--build-only` stops before virtual-device and compatibility-intake categories. |
| DONE | Fix default AOSP product mismatch for repo-local product files. | Capture and simulator scripts default to `eliza_ai_soc-userdebug`, which is exported by `AndroidProducts.mk`. |
| DONE | Fix QEMU payload manifest discovery. | `check_qemu_linux_payload_status.py` now accepts the timestamped Debian payload directory written by `fetch_qemu_linux_payload.py` while preserving the older non-timestamped path. |
| DONE | Align QEMU payload docs with the fetch helper default. | The QEMU README and payload plan now mention `debian-installer-riscv64-20260517T000000Z`. |
| DONE | Ensure Buildroot kernel fragment enables the parent Eliza BSP symbol. | Added `CONFIG_ELIZA_E1_BSP=m` alongside NPU/DMA module selections. |
| DONE | Remove hardcoded personal path from the AOSP local manifest seed. | Replaced the old local path/project name with a clear placeholder and repo name. |

## Remaining blockers

| Priority | Blocker | Why it blocks Android on simulated chip | Required evidence to clear |
|---|---|---|---|
| BLOCKER | Generate or import the selected CPU/AP simulator path. | The current e1-chip contract has no CPU. Android needs an AP with reset, DRAM, timer, interrupts, UART, and MMU-capable CPU. | Generated Chipyard/Rocket manifest with DTS, memmap, Verilog/FIRRTL, simulator binary, hashes, and tool versions. |
| BLOCKER | Build the generated AP Verilator simulator. | Android/Linux boot evidence must come from an executable AP simulator, not only generated source files. | Verilator build transcript and simulator executable referenced by the generated manifest. |
| BLOCKER | Define the AP hardware ABI in the central platform contract. | The platform JSON only describes the debug/MMIO e1 chip and not the AP boot ABI. | Contract entries for reset vector, DRAM, UART, CLINT/ACLINT, PLIC/IMSIC, boot ROM/firmware handoff, and generated AP source of truth. |
| BLOCKER | Create a real firmware handoff path. | Linux/Android needs OpenSBI or equivalent machine-mode firmware and a deterministic next-stage handoff. | OpenSBI build log, handoff transcript, payload load addresses, and generated DTB reference. |
| BLOCKER | Boot Linux on the selected AP simulator. | Android userspace depends on a booting kernel, initrd/rootfs, console, timer, interrupt, and memory path. | `eliza_e1_linux_boot.log`, trap/timer/IRQ log, ISA/cache/MMU log, AP benchmark/sanity log, and CPU/AP evidence manifest hashes. |
| BLOCKER | Build or import Android-capable AOSP artifacts. | The repo-local AOSP tree is a scaffold; no strict vendorimage, VINTF, SELinux, or smoke evidence is complete. | The nine logs required by `scripts/check_software_bsp.py aosp`: lunch, vendorimage, checkvintf, SELinux build, neverallow, CTS/VTS plan, Cuttlefish smoke, QEMU smoke, Renode smoke. |
| BLOCKER | Produce an Android smoke transcript tied to the AP simulator. | Cuttlefish and qemu-virt are reference-only. They do not prove Eliza AP ABI. | A transcript from the generated AP simulator showing Android init/userspace progress and explicit claim boundary. |
| BLOCKER | Add an AP boot DTB source of truth. | Checked-in Linux/AOSP DTS scaffolds are not complete boot DTBs. | Generated Chipyard DTS/DTB audit with CPU, memory, timer, interrupt controller, UART console, and payload-safe DRAM range. |
| BLOCKER | Implement or import boot-grade UART, timer, and interrupt contracts. | Android/Linux cannot close without early console, clocksource/timer, and interrupt delivery. | RTL/generator contract entries, Linux binding/driver configuration, and boot transcript evidence. |
| BLOCKER | Replace the tiny local SRAM model for OS boot claims. | The local AXI-lite DRAM model is far too small for Linux/Android payloads. | Generated AP DRAM model/controller evidence with enough capacity for the selected payloads. |

## High-priority follow-ups

| Priority | Follow-up | Required work |
|---|---|---|
| HIGH | Add active Android HAL build rules only after binaries/source exist. | Add reviewed source or prebuilts for `e1_npu.default` and any `hwcomposer.eliza_ai_soc` path, then enable packages and VINTF entries with fail-closed behavior. |
| HIGH | Complete SELinux policy for future Android services. | Add device/service/hwservice contexts and access rules, then archive policy build and neverallow transcripts. |
| HIGH | Rework simulator fstab once the boot target is selected. | Avoid AVB/A-B/file-encryption flags that cannot be satisfied by the selected virtual target unless real keys, partitions, and mount evidence exist. |
| HIGH | Add BoardConfig boot image/vendor_boot/DTB packaging decisions. | Define kernel, DTB, bootconfig, partition sizing, and image flow for the external AOSP tree. |
| HIGH | Patch external Linux integration into Kconfig/Makefile. | The import helper copies BSP files, but the external kernel must include the Eliza driver directory and DT bindings. |
| HIGH | Add strict import-check behavior for CI/release modes. | Current import checks intentionally block softly when external tree env vars are unset; release gates should require them only when claiming external integration. |
| HIGH | Bring AP CLINT/interrupt coverage into platform-contract checks. | Hidden timer/software interrupt windows must either become contract entries or be excluded from the boot story. |
| HIGH | Wire `e1_soc_top`/CLINT tests into the standard sim ladder. | Current default cocotb ladder does not cover all boot-relevant top-level behavior. |
| HIGH | Fix Chipyard import manifest reproducibility issues. | Remove duplicate JSON keys and use one canonical full commit/tag representation. |

## Medium-priority follow-ups

| Priority | Follow-up | Required work |
|---|---|---|
| MEDIUM | Restore `scripts/test_software_bsp_evidence.py`. | Update stale API/CLI expectations or remove it from maintained test surfaces. |
| MEDIUM | Add host-buildable NPU probe automation to AOSP scaffold checks. | Compile/run the fail-closed probe in CI where a host C++ compiler is available. |
| MEDIUM | Add pinned independent hashes for Debian QEMU payloads. | Current fetch verifies against downloaded `SHA256SUMS` from the selected Debian source; a lock manifest would strengthen reproducibility. |
| MEDIUM | Clean duplicated architecture prose before using docs as contract evidence. | De-duplicate boot, interconnect, and Linux CPU contract docs. |
| MEDIUM | Add CI coverage for QEMU Linux payload status when artifacts exist. | Keep this optional unless payload artifacts are fetched in CI. |

## Current validation commands

Run these after local changes:

```sh
python3 scripts/test_android_sim_boot_status.py
python3 scripts/check_android_sim_boot.py
python3 scripts/test_software_bsp_checks.py
python3 scripts/check_software_bsp.py aosp --scaffold-only
python3 scripts/check_qemu_linux_payload_status.py
python3 scripts/test_qemu_smoke_status.py
make docs-check
```

Expected current outcome: local scaffold/status tests pass or block honestly.
Strict AOSP/CPU/AP evidence gates remain blocked until external AOSP, generated
AP simulator, and boot transcripts exist.
