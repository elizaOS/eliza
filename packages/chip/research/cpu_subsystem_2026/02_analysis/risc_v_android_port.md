# State of Android on RISC-V (through 2026-05-19)

Date: 2026-05-19

This note records what the Android RV port can actually do today, what is
still upstream-blocked, and what that means for the Eliza E1 plan that
keeps Linux/OpenSBI as the near-term boot target and leaves Android as a
later milestone.

## Headline status

- **Linux RV64.** Production-ready upstream. Debian, Ubuntu, Fedora, and
  openSUSE all ship riscv64 images. Kernel 6.5+ has RVV in kernel,
  Sscofpmf perf, Sstc supervisor timers, AIA support, KVM RV64.
- **Android RV64.** Not in mainline AOSP build targets as of January 2024.
  Lives in the `riscv-android-sig` AOSP fork plus the Cuttlefish emulator
  target. Android-on-RV is on the RISE Project roadmap. Google removed
  the in-tree AOSP RISC-V build target in January 2024 and described it
  as deferral of product readiness, not project cancellation.
- **ART.** RV64 code generator and JIT are merged in AOSP `art/`. RVV
  codegen is behind a feature flag and tracks RVA22+V.
- **HotSpot.** OpenJDK 21+ has full HotSpot RISC-V C1/C2 JIT. JDK 22+
  added RVV intrinsics.
- **Bionic / NDK.** RV64 ABI follows RVA22+V; toolchain support in NDK
  builds for AOSP fork only; CTS/VTS on Cuttlefish RV in CI but not as a
  release gate.

## Key upstream landing points

| Component | Status | URL |
| --- | --- | --- |
| Linux kernel RV64 (mainline) | production | <https://git.kernel.org/pub/scm/linux/kernel/git/riscv/linux.git/> |
| OpenSBI | production | <https://github.com/riscv-software-src/opensbi> |
| KVM RISC-V | merged, H-ext upstream | mainline kernel |
| `riscv-android-sig` AOSP fork | active development | <https://github.com/riscv-android-src> |
| Cuttlefish RV emulator | active development | <https://source.android.com/docs/setup/create/cuttlefish> |
| ART RV64 codegen | merged in AOSP `art/` | code_generator_riscv64.cc |
| OpenJDK RV64 JIT | shipping (JDK 21+) | <https://openjdk.org/projects/riscv-port/> |
| LLVM RV codegen | production | LLVM trunk |
| GCC RV codegen | production | GCC 14+ |
| Bionic libc RV | in `riscv-android-sig`, not mainline AOSP | |
| NDK RV | tracked in RISE project, not GA | |

## What Android RV requires from the silicon

The Android RV ABI baseline is RVA22 with V. RVA23 is the 2024 ratification
that hard-mandates V, B, K and is expected to be the eventual Android RV
baseline. Concretely, an Eliza E1 silicon device targeting Android RV
would need:

| Requirement | Why |
| --- | --- |
| RV64GC + V (RVA22U64+V) | Bionic and NDK ABI assumption. |
| Zba/Zbb/Zbs (B subset) | RVA22 mandatory subset. |
| Zicntr/Zihpm | counters used by RV `perf` and Android profiling. |
| Zicbom/Zicbop/Zicboz | cache management for DMA and graphics. |
| Sv39 MMU (Sv48 optional) | Bionic page-table support. |
| Sscofpmf | `perf` support; Android Studio profiling. |
| Sstc | low-jitter supervisor timers. |
| Smaia/Ssaia (or PLIC fallback) | Linux IRQ controller. RVA22 still allows PLIC. |
| Zkn/Zks/Zvkn (recommended) | crypto and TLS performance. |
| H ext (recommended) | for Cuttlefish-on-device and Android container scenarios. |

E1's current selection (Rocket RV64GC, PLIC, CLINT, Sv39) is below the
RVA22+V bar in two important places: no V, and using CLINT rather than
Sstc/Smaia. This is acceptable for the Linux smoke gate. It is not
acceptable for any Android RV claim.

## Toolchain and image plumbing

- **Cross-compile:** clang 17+ or gcc 14+ with `-march=rv64gcv_zba_zbb_zbs`.
- **Kernel:** mainline 6.5+ with `CONFIG_RISCV`, `CONFIG_RISCV_ISA_V`,
  `CONFIG_RISCV_SBI_V01`, `CONFIG_RISCV_AIA` (optional).
- **U-Boot:** EFI boot path with RV64 EFI stub.
- **Firmware:** OpenSBI 1.3+ for Sstc/AIA pass-through.
- **AOSP fork:** `riscv-android-sig` branch tracking AOSP `main` with
  Bionic / ART / NDK patches.
- **Emulator:** Cuttlefish `cf_riscv64_only_phone`.
- **CTS/VTS:** CTS RV target builds in Google's internal CI; no public
  release gate yet.

## Risk register

| Risk | Mitigation |
| --- | --- |
| Google's January 2024 AOSP riscv64 build target removal extends Android RV timeline | Track RISE Project milestones; do not commit E1 to an Android RV ship date. |
| Vendor cores still on RVV 0.7.1 (T-Head C910/C920) create ABI confusion | E1 must commit to RVV 1.0 only. |
| AIA (Smaia/Ssaia) adoption uneven across cores | Plan to keep PLIC as the bring-up fallback. |
| Bionic patches not yet upstream | Build internal AOSP fork from `riscv-android-sig`. |
| CTS/VTS-on-RV not a release gate | Track Cuttlefish RV CTS pass rate as a directional metric only. |

## Recommendation for E1

1. Do not make any Android RV claim. The repo policy (`mobile-sota-2026.yaml`
   already lists Android usability as v0 second-tier) is correct.
2. Add to the future `docs/spec-db/cpu-2028-target.yaml`:
   - target profile: RVA22U64+V, with named Zb*, Zicb*, Sscofpmf, Sstc,
     and optional H entries.
   - vector requirement: RVV 1.0 (forbid 0.7.1).
   - Sstc/AIA requirement: tracked, may use PLIC fallback.
   - Android upstream path: `riscv-android-sig`, not mainline AOSP, with
     a tracked branch hash.
3. Keep Linux + OpenSBI smoke as the only near-term boot claim.
4. Watch for RVA23 baseline adoption by Google's Android RV plan; if it
   becomes the gate, the E1 CPU/AP selection has to escalate beyond
   Rocket to BOOM or KunMingHu before any product claim.
