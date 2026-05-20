# Chip simulator -> Android boot pathfinder

This audit documents what `packages/chip` has today for booting Android (or
Linux) on a simulator, which simulator is closest to a usable Android launcher
screenshot, and the gap between the chip's RTL/SoC simulator and a full Android
boot.

Authoritative sibling docs (read these first):

- `docs/android/bsp-critical-gap-audit-2026-05-17.md` — canonical BSP blocker list.
- `docs/project/prototype-status-dashboard.md` — current PASS/BLOCK posture.
- `docs/project/aosp-simulator-completion-gate.yaml` — strict Android evidence gate.
- `docs/project/android-on-simulated-chip-todo-2026-05-17.md` — single source of
  truth for the three tracks (AOSP virtual-device, generated AP simulator,
  current e1-chip RTL).
- `docs/sim/boot-tiers-progress.md` and `docs/sim/tier2-boot-success-2026-05-18.md` —
  bare-metal / OpenSBI / Linux QEMU virt boot tiers and their evidence.
- `docs/sim/verilator-rocket-bootstrap-status.md` — Chipyard `ElizaRocketConfig`
  Verilator status.
- `docs/android/cuttlefish-riscv64-bringup.md` — `aosp_cf_riscv64_phone` recipe.

## Claim boundary (read once before quoting numbers)

Two distinct "chips" coexist in this repo and must not be conflated:

1. **`e1_chip`** in `sw/platform/e1_platform_contract.json`. This is the current
   silicon target. **`has_cpu: false`**. The bus master is the package debug
   nibble bridge (`DBG_LAUNCH` / `DBG_READY`, 4-bit address + 4-bit data). No
   CPU, no MMU, no privileged ISA. The Verilator harness
   (`sim/verilator/sim_main.cpp`) drives MMIO via that nibble bridge against
   `rtl/top/e1_chip_top.sv`. It **cannot boot Linux, full stop**, because there
   is nothing to execute a kernel.
2. **`e1_chip_cpu_variant`** in the same JSON. This is a *projected* Linux-capable
   SoC: `has_cpu: true`, `rv64gc`, PLIC at `0x0C000000`, CLINT at `0x02000000`,
   NS16550 UART at `0x10001000`, DRAM at `0x80000000`, NPU at `0x10020000`,
   display at `0x10030000`. It is a contract, not RTL. There is no checked-in
   pipeline that builds a `e1_chip_cpu_variant` Verilator/Renode model from the
   contract. The chosen route to give it teeth is to drive an external
   Chipyard `ElizaRocketConfig` Rocket core whose memory map is then asserted
   to match this contract.

Everything below is graded against those two boundaries.

## Per-simulator status

| Simulator | Top / model | Linux boot today | Android boot today | Notes |
|---|---|---|---|---|
| Verilator (`sim/verilator/sim_main.cpp`) | `rtl/top/e1_chip_top.sv` (`e1_chip`, no CPU) | NO — no CPU | NO | Debug-nibble MMIO harness only. Drives NPU/DMA/display registers via 4-bit bus. Useful for RTL signoff, irrelevant for OS boot. |
| Chipyard Verilator (`run_chipyard_eliza_verilator.sh`) | `ElizaRocketConfig` (Rocket RV64GC) | UNVERIFIED on this host — generator + smoke checker exist; prebuilt simulator ELF in `external/chipyard/sims/verilator/` is x86_64 Linux; macOS arm64 host blocked per `verilator-rocket-bootstrap-status.md`. `make tier4` is the target. | NO — no Android userspace, no display/input/touch model | This is the route the BSP doc names as the only credible "Android on our simulated chip" path, but only after Linux first boots on this generator. |
| Renode `sim/renode/eliza_e1.repl` (Tier 1) | RV64 + NS16550 UART at `0x10000000`, RAM at `0x80000000`, CLINT, PLIC | Only loads `build/qemu/e1_qemu_firmware.elf` (the small banner-printer "eliza e1 qemu"). NOT a Linux boot. Bounded smoke captures the banner. | NO | Address map is **qemu-virt**, not the chip variant (UART at `0x10000000`, not `0x10001000`). README marks it explicitly as "software reference only". |
| Renode `sim/renode/eliza_e1_tier2.resc` (Tier 2) | Loads OpenSBI `fw_payload.elf` + optional kernel `Image` + initrd + DTB | DESIGNED to boot Linux+busybox; same `eliza_e1.repl` platform; payloads not committed. Boot is expected to succeed when `external/opensbi/build/.../fw_payload.elf` and `external/linux/.../Image` are built (Tier 2 already worked under QEMU per `tier2-boot-success-2026-05-18.md`, so the OpenSBI+kernel handoff is proven on qemu-virt). | NO | Renode tier 2 is the lowest-overhead Linux boot of the chip-shaped platform, but it is still qemu-virt addressing, and it has no display/input/touch model. |
| QEMU virt (`scripts/run_qemu.sh`) | `qemu-system-riscv64 -machine virt` | YES via the existing Tier 2 evidence (`docs/sim/tier2-boot-success-2026-05-18.md`: Linux 6.6 + static busybox, `~ #` shell, transcript at `build/sim/qemu/tier2_linux.log`). | NO Android userspace. The `qemu_riscv64_smoke.log` in the AOSP evidence dir only records `qemu-system-riscv64 --version`, not any Android boot. | Standard `-machine virt`; CPU/timer/IRQ/UART model is generic. Display is `-nographic`. To run Android in QEMU virt you would need an AOSP `aosp_cf_riscv64_phone` build with QEMU-mode launch, which AOSP does not officially support — Cuttlefish (crosvm) is the supported launcher. |
| Cuttlefish (`aosp_cf_riscv64_phone`) | crosvm + virtio (gpu/input/snd/net/blk) | N/A (Linux is part of the Cuttlefish guest, not a separate boot) | UNVERIFIED in this repo. The committed `cuttlefish_riscv64_smoke.log` (2026-05-19) shows `cvd start ... -daemon` failed with `Command ... is not applicable: no device`, i.e. the host did not have a Cuttlefish device prepared. Cuttlefish itself is the upstream-supported Android-on-RISC-V simulator. | This is the only path that gives a **launcher screenshot** today, but it is *not* "our chip" — it is the generic AOSP riscv64 virtual device. |
| Chipyard / Rocket FireSim | not configured in this repo | NO | NO | Not wired. |

Concretely: the only place a real Linux kernel has demonstrably reached
userspace from this repo's pipeline is **QEMU virt Tier 2**. The only place a
real Android userspace can reach the launcher on RISC-V is **Cuttlefish
`aosp_cf_riscv64_phone`**. Neither is "our chip" in the silicon sense, and the
existing AOSP evidence files under `docs/evidence/android/` only contain
`--version` lines or `cvd: no device`, not boot.

## Lowest-blocker path to "Android launcher screenshot"

Ranked by hours-to-pixels:

1. **Cuttlefish `aosp_cf_riscv64_phone` on a Linux x86_64 host with KVM**
   (path *a* in the brief). The recipe is `docs/android/cuttlefish-riscv64-bringup.md`.
   Blockers on the current development host: `AOSP_DIR` is unset, `/dev/kvm`
   group membership/permissions, and no `repo`/`launch_cvd`/`cvd` installed
   per the boot-script preflight (`host_requirements` in
   `build/reports/android_sim_boot.json`). On a properly prepared Linux x86_64
   workstation, this is the only path that produces a real launcher screenshot
   in a single day of work. The trade-off is that the SoC under the launcher
   is **not** `eliza_ai_soc`; it is the generic `vsoc_riscv64`. Calling it
   "our chip" is a category error.

2. **Cuttlefish + `eliza_ai_soc` device overlay** (path *d*). The repo's
   `BoardConfig.mk` already does `-include device/google/cuttlefish/vsoc_riscv64/BoardConfig.mk`
   and layers Eliza VINTF/HAL/SELinux on top. This means the same Cuttlefish
   guest kernel/userspace boots, with our HAL manifest and `androidboot.hardware=eliza_ai_soc`,
   without a `eliza_ai_soc` RTL model. This is the right surface for Eliza
   HAL/VINTF/SELinux smoke and is the path the existing `boot_android_simulator.sh`
   targets. It is still not e1-chip silicon proof.

3. **Renode Tier 2 with `eliza_e1.repl` + AOSP riscv64 kernel + a minimal
   Android-on-Renode patch set** (path *b*, but stretched to Android). The
   platform model has CPU/UART/CLINT/PLIC, but no virtio-gpu, virtio-input,
   virtio-snd, or DRM/KMS framebuffer model. To get a launcher screenshot from
   here, the platform `.repl` would need a Renode virtio-gpu peripheral or a
   simple framebuffer + DRM driver pair, plus a virtio-input device. Weeks of
   work at minimum, and Renode performance for a full Android userspace is
   marginal.

4. **`e1_soc_top` on Verilator** (path *c*). Out of reach. The current top is
   `e1_chip_top` (no CPU). Even the Chipyard `ElizaRocketConfig` simulator is
   too slow for a full Android boot — minutes of simulated time per wall-clock
   second. Useful for RTL/driver MMIO bring-up, useless for a launcher.

**Recommendation:** use path 2 (Cuttlefish with the `eliza_ai_soc` overlay) for
the "Android launcher on our SoC" claim, and keep path 3 (Renode Tier 2 +
`e1_chip_cpu_variant` addressing) as the bridge to silicon-relevant Linux/NPU
HAL evidence. Path 1 is for fastest pixels, and `boot_android_simulator.sh`
already wraps paths 1 and 2 with the same nine-log gate.

## Concrete blockers between the chip simulator and an Android boot

In dependency order, drawn from `android-on-simulated-chip-todo-2026-05-17.md`,
`bsp-critical-gap-audit-2026-05-17.md`, and the current evidence inventory:

1. **No CPU in the e1-chip RTL.** `e1_chip.has_cpu=false`. Required: select and
   integrate the `e1_chip_cpu_variant` projection. The chosen route is
   `ElizaRocketConfig` via Chipyard; the bootstrap script exists; the build is
   blocked on Linux x86_64 host availability (macOS arm64 host in
   `verilator-rocket-bootstrap-status.md` cannot finish the build).

2. **No `e1_chip_cpu_variant` RTL contract assertion.** Even after Chipyard
   builds, nothing currently asserts that the generated Rocket memory map
   matches the contract addresses (PLIC `0x0C000000`, CLINT `0x02000000`, UART
   `0x10001000`, DMA `0x10010000`, NPU `0x10020000`, display `0x10030000`).
   Renode Tier 1's `eliza_e1.repl` is on qemu-virt addresses (UART
   `0x10000000`), not the contract.

3. **No platform firmware handoff for the chip-variant target.** OpenSBI exists
   only as a documented scaffold (`docs/sw/opensbi/README.md`). U-Boot likewise.
   Required: build `fw_dynamic` / `fw_payload` for the chip-variant memory map
   and capture handoff transcript.

4. **No kernel built with our drivers.** `sw/linux/` has importable
   `eliza,e1-npu` (misc char) and `eliza,e1-dma` (platform) driver sources and
   a DTS, but no kernel build. Evidence files under
   `docs/evidence/linux/` are `*.BLOCKED` placeholders.

5. **No display path.** Linux DTS has `display@10030000` `status="disabled"`.
   No `drivers/gpu/drm/eliza` driver, no simple-framebuffer mapping, no Android
   gralloc/hwcomposer that talks to the e1-chip display registers. The
   `hwcomposer.eliza_ai_soc` HAL source exists under `hal/hwcomposer/` but has
   no underlying framebuffer model in any simulator.

6. **No input path.** `sw/aosp-device/.../dts/eliza-e1-android.dts` has no
   touch, keyboard, or virtio-input node. The BSP audit explicitly says
   "Runbook allows Cuttlefish/evdev only".

7. **No audio path.** Excluded from manifest entries per the BSP audit.

8. **No NPU runtime ABI for Android.** `e1_npu_hal` source exists, but no
   IE1Npu HIDL/AIDL contract has been built into an AOSP tree and exercised
   from a process. The runtime contract sits in
   `docs/spec-db/e1-npu-runtime-contract.json`.

9. **No AOSP `vendor.img` produced.** The repo holds product/BoardConfig/VINTF
   scaffolds. Nothing is built. `boot_android_simulator.sh` is the wrapper,
   but it requires an external `AOSP_DIR`.

10. **No nine-log strict AOSP evidence on disk.** All ten files listed in
    `aosp-simulator-completion-gate.yaml` either don't exist, are alias
    placeholders, or only contain `--version` lines. `cuttlefish_riscv64_smoke.log`
    shows `RESULT=1` and `cvd: no device`.

11. **DRAM too small for Linux on the e1-chip-style models.** Renode Tier 1
    `eliza_e1.repl` declares `Memory.MappedMemory @ sysbus 0x80000000` of size
    `0x100000` (1 MiB). The AXI-lite DRAM aperture in the RTL contract is
    similarly tiny. Tier 2 needs to use the `eliza_e1_tier2.resc` flow which
    relies on a larger memory model in the OpenSBI/`fw_payload` ELF segment
    layout (currently uncommitted).

12. **Cuttlefish prerequisites missing on the current host.** `repo`,
    `launch_cvd`/`cvd`, kvm group membership, and an actual AOSP checkout.
    Listed by the boot-script preflight at
    `build/reports/android_sim_boot.json`.

## `boot_android_simulator.sh` invocation result

Ran from this worktree on the current host (Linux x86_64, no `AOSP_DIR`,
`renode` is at `tools/bin/renode`, `qemu-system-riscv64` at
`tools/bin/qemu-system-riscv64`, no `/dev/kvm` or AOSP checkout):

```
$ sh scripts/boot_android_simulator.sh
BLOCKED: AOSP_DIR is not set; wrote build/reports/android_sim_boot.json
```

Exit 2. Wrote `build/reports/android_sim_boot.json` with `status: blocked`,
`required_evidence` listing the ten AOSP logs, and `host_requirements.missing`
naming `AOSP_DIR is not set`, `repo launcher found at /home/shaw/bin/repo,
but repo is not installed`, `qemu-system-riscv64 not found on PATH` (the
`tools/bin` entry is not on the script's `PATH`), `renode not found on PATH`
(same). Captured stdout to
`build/reports/chip-boot-attempt.log`.

The script behaved as designed: it fails closed without an external AOSP
checkout. No Android, Linux, or e1-chip boot was attempted.

## Bottom line

- "Run elizaOS on our risc v chip in simulator" today resolves to one of:
  - Run elizaOS on **Cuttlefish `aosp_cf_riscv64_phone`** (with our
    `eliza_ai_soc` overlay) on a properly provisioned Linux x86_64 + KVM host.
    This gives you Android pixels but the silicon is virtio, not `e1_chip`.
  - Run elizaOS on **Renode Tier 2** (`eliza_e1_tier2.resc`) with a built
    OpenSBI + Linux + busybox + agent. This gives you a riscv64 Linux shell
    closer to the contract's address map. No Android, no launcher.
  - Wait on the **Chipyard `ElizaRocketConfig` Verilator** path on a Linux
    x86_64 host to give you Linux on a chip-relevant Rocket model, then layer
    Android atop it. This is the "Android on our simulated chip" claim per the
    BSP audit and is still gated by everything in the blocker list above.

- No path produces a launcher screenshot of Android running on bit-accurate
  `e1_chip` RTL today, and no path is one command away from doing so.
