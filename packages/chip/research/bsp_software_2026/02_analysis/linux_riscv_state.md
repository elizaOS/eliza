# RISC-V Linux Kernel State, 2024 - early 2026

Date: 2026-05-19. Status of upstream (kernel.org) RISC-V support relevant to
Eliza E1 Linux bring-up. All claims here are upstream-state evidence; local
E1 boot evidence still requires generated AP RTL + the capture scripts
referenced in `docs/arch/boot.md`.

## Mainline / arch/riscv summary

- Maintainer: Palmer Dabbelt, with co-maintainers Albert Ou, Alexandre Ghiti,
  Anup Patel, Atish Patra. Tree `linux-riscv.git` feeds Linus during each
  merge window.
- RV64 is the only Linux-supported XLEN in mainline today; RV32 has working
  nommu paths but no Android use.
- Mainstream supported boards: SiFive Unmatched / Unleashed, StarFive
  VisionFive 2 / JH7110, T-Head TH1520, Microchip PolarFire SoC, Allwinner
  D1/D1s, Renesas RZ/Five, Andes AX25. QEMU virt is the Eliza E1 software
  reference target per `docs/arch/boot.md`.

## Paging and address translation

| Mode | XLEN | Max VA bits | Notes |
| --- | --- | --- | --- |
| Sv32 | 32   | 32          | RV32 nommu/MMU; not used by E1 |
| Sv39 | 64   | 39          | Linux default; supported since v5.x |
| Sv48 | 64   | 48          | Auto-detected; enabled per CPU since 6.2 |
| Sv57 | 64   | 57          | Probed since 6.5; enabled when HW + DT allow |

Linux supports run-time selection via the boot hartid SATP write probe.
ASIDs are used opportunistically; the kernel falls back to global flushes if
the implementation reports fewer than expected ASID bits. Eliza E1's
`linux-capable-cpu-contract.md` mandates Sv39 at minimum and currently pins
the ElizaRocketConfig single Rocket hart, which provides Sv39 + 16 ASIDs.

## Vector (V) and userland enablement

- **RVV 1.0 user mode**: merged Linux 6.5 (Aug 2023). Kernel exposes
  `HWCAP_ISA_V` and per-task lazy vector context. `prctl(PR_RISCV_V_*)` lets
  glibc / Bionic / runtimes opt into vector state.
- **In-kernel vector** (e.g. for memcpy/checksum on data heavy paths) added
  6.10 (Jul 2024) behind `CONFIG_RISCV_ISA_V_PREEMPTIVE`. Crypto and
  raid6/xor use vector when available.
- **hwprobe ABI** (`SYS_riscv_hwprobe`, merged 6.4) is the canonical way for
  userland (Bionic, glibc, Mesa, LiteRT) to ask for IMA, V, Zba/Zbb/Zbs,
  Zicboz block size, Zicbom block size, vendor bits.
- **Profile gating**: Android RV (and the RVA23 profile) require V; LiteRT
  and ExecuTorch delegates assume Zve64d at minimum. Eliza E1's selected
  ElizaRocketConfig today is RV64GC without V; vector remains an open work
  item tracked in `docs/arch/linux-capable-cpu-contract.md`.

## Hypervisor (H) extension and KVM-RV

- KVM RISC-V merged in 5.18 (May 2022); requires H extension at HS-mode.
- VS-mode local interrupt controller (AIA / IMSIC if present, else PLIC)
  exposed to the guest in 6.4+.
- SBI services forwarded to guest: TIME, IPI, RFENCE, HSM, SRST, PMU, NACL.
- Vector + FP guest state save/restore: 6.7 (Dec 2023).
- Steal-time accounting (SBI STA, v3.0 draft): in flight on the lists.
- Required for Android `aosp_cf_riscv64_phone` Cuttlefish boot via crosvm
  on a KVM-RV host. Eliza E1 does not need H today, but any 2028 product
  roadmap targeting Android virtualization HAL or virtio-based isolation
  must pull H into the AP.

## Sscofpmf and performance monitoring

- Sscofpmf (supervisor count overflow + filter) ratified 2022; mainline
  Linux perf support merged 6.7. Adds overflow-aware hardware perf counters
  per hart and a SBI PMU v2.0 extension to manage them.
- `perf record / perf stat / perf top` now produce useful RV traces on
  Sscofpmf hardware; without it the kernel falls back to software events
  only (cycle + instruction emulation via SBI PMU v1.0).
- eBPF perf integration: `perf_event_open` -> bpf_perf_event_output works on
  RV64 with Sscofpmf. Without Sscofpmf, ARM-style PMU profilers degrade
  significantly.
- ElizaRocketConfig currently exposes the basic Zicntr cycle / instret only.
  Sscofpmf is on the open issue list for the next AP iteration. Until
  Sscofpmf lands, Android system-tracing (`perfetto`) on E1 will be
  cycle/instret only.

## eBPF on RV64

- JIT in `arch/riscv/net/bpf_jit_comp64.c` since 5.6 (Apr 2020).
- Tail calls, atomics, ALU64, dynptr, kfunc dispatch all supported.
- libbpf, bpftool, bpftrace, BCC build for RV64 (Debian Ports, Fedora).
- Android eBPF (system/bpf, netd) builds for RV64 since AOSP main grew RV.
  CTS BpfTest passes on Cuttlefish RV64 in the riscv-android-sig CI matrix.

## ACPI vs DT on RV

- Device Tree (DT) is the only mainline RV boot interface today; OpenSBI
  hands a DTB or a flattened device tree blob via a1 to the supervisor
  payload as defined in the RISC-V boot protocol.
- ACPI on RV: a draft of ECR (ACPI for RISC-V) is in progress at the UEFI
  Forum / RISC-V International. Kernel patches exist for RHCT, RIMT, and
  MADT-equivalents but are not merged as of 2026-05-19.
- The Android RV path is DT-only. Eliza E1 should not bet on ACPI for
  the 2028 path; the `docs/sw/aosp-device` and `docs/sw/linux/dts/`
  contract are correctly DT-shaped.

## Memory ordering, Zicbom, CBO

- Zicbom (cache-block management) merged 6.2 and is consumed by DMA non
  coherent flows. Required for any non-coherent DMA device + Linux DMA-API.
- Zicboz (cache block zero) merged 6.3; used by clear_page / memset.
- `Ssvnapot` (NAPOT page) ratified, kernel HugeTLB support landed 6.5.
- Eliza E1 memory subsystem must declare Zicbom block size in DT
  (`riscv,cbom-block-size`) and surface it through hwprobe so LiteRT and
  the NPU DMA path can size buffers correctly.

## Sstc (supervisor timer extension)

- Adds stimecmp register so supervisor can program timer interrupts
  directly, eliminating the SBI TIME ecall on each timer reload.
- Linux clocksource driver landed 6.5; OpenSBI advertises Sstc in DT.
- Major latency win for tickful kernels; required to keep Android animation
  jitter inside CTS budgets.

## What this means for Eliza E1

1. The current ElizaRocketConfig Linux contract is workable for early
   `make minimum-linux-npu-target` smoke but is below the floor for
   Android. Critical near-term gaps (matching the
   `linux-capable-cpu-contract.md` ledger): Sscofpmf, Sstc, V/Zve64d,
   Zicbom block size declaration, ASID width verification, KVM H optional.
2. The RV64 kernel side is mature: distro userland (Debian, Fedora) and
   Buildroot/Yocto images work end-to-end on qemu-virt today, so the
   software reference target named in `docs/arch/android-contract.md`
   is a real product not a research bet.
3. Once vector and Sscofpmf are present, the kernel side does not block
   Android; Cuttlefish RV64 + AOSP main is the next gate. See
   `android_riscv_state.md`.
