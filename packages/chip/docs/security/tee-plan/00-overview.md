# Eliza E1 — TEE-Native Architecture: Master Plan

Date: 2026-05-21

This is the index and synthesis for the E1 TEE program. The goal is a
**TEE-native ultra-private personal AI-agent device**: the entire OS (elizaOS
Linux first, AOSP later) plus the agent runtime, NPU runtime, model weights, and
user data run inside a **single-tenant whole-system confidential domain**, with
only a tiny trusted monitor, a hardware root of trust, and mediated I/O outside
the trust boundary. Some workloads may still run outside the domain on a
"standard" machine via an explicitly mediated channel.

The detailed lanes:

- [`01-tee-core-architecture.md`](01-tee-core-architecture.md) — confidential CPU+memory domain (the monitor, memory isolation, memory encryption/integrity, measured launch).
- [`02-root-of-trust.md`](02-root-of-trust.md) — OpenTitan-class RoT, secure boot, crypto replacement, OTP/lifecycle, DICE, provisioning.
- [`03-secure-io-iommu-npu.md`](03-secure-io-iommu-npu.md) — IOMMU/IOPMP, DMA isolation, device assignment, NPU as confidential I/O.
- [`04-side-channel-physical-hardening.md`](04-side-channel-physical-hardening.md) — microarch isolation, observability lockdown, ciphertext side channel, crypto hardening, tamper response.
- [`05-cpu-memory-performance.md`](05-cpu-memory-performance.md) — performance experiments, co-designed so the TEE taxes don't tank speed.
- [`06-os-on-tee-software.md`](06-os-on-tee-software.md) — booting/running the OS as a confidential guest, attestation agent, `TeeEvidence`, elizaOS integration.

> **Status discipline.** Per `AGENTS.md`/`CLAUDE.md`, every claim is fail-closed.
> Nothing here permits a "secure boot" / "confidential" / "side-channel
> resistant" claim until a backing transcript exists. Most product-grade claims
> are `BLOCKED` on FPGA, silicon, a real LPDDR5X controller, or a side-channel
> lab — that is by design, not a defect.

## 1. The honest starting point (what the lanes actually found)

The docs were ahead of the RTL. The audited reality:

- **No memory isolation primitive is wired.** The CVA6 wrapper is
  `cv64a6_imafdc_sv39` with **PMP disabled**; no ePMP/Smepmp/H-extension. The
  only repo-wide hint is one PMA comment in `e1_soc_integrated.sv`.
- **The IOMMU is a partial verification scaffold, not a complete phone/Linux
  IOMMU.** `e1_riscv_iommu.sv` does identity passthrough in BARE mode, keeps a
  6-entry on-chip allowlist fallback, and now covers a minimal DDT + Sv39
  first-stage KAT under identity G-stage. Non-identity G-stage, full PDT/PASID,
  IOPMP, MSI translation, and most command-queue behavior remain blocked. **The
  NPU and DMA bypass it entirely** (AXI-Lite MMIO, no source IDs, world-readable
  perf counters).
- **The root of trust is placeholder.** `e1_lifecycle.sv` uses `challenge ^
  0xA5A5_5A5A` for debug auth; `fw/pmc/src/secure_boot.c` is `return 0;`
  (accept-all); `fw/boot-rom/reset.S` is an unconditional jump to `0x8000_0000`.
  No OTP, no signature, no measurement.
- **The product contract already exists.** `confidential-domain.md` defines the
  six page states and the I/O rule; `TeeEvidence` is a real elizaOS type
  (`@elizaos/agent` `services/tee-evidence.ts`) with a working policy verifier,
  and the chip already has `scripts/check_tee_attestation_evidence.py` + example
  fixtures. The DICE CDI lane has a passing gate. **The skeleton and the consumer
  contract are real; the silicon mechanisms are not.**

So this program is "make the existing contract true in hardware," not "invent a
TEE." That is the right kind of gap to have.

## 2. The converged architecture (all lanes agree)

```
                         ┌──────────────────────────────────────┐
                         │  OpenTitan Earl Grey-class RoT (Ibex) │  lane 02
                         │  ROM • OTP/lifecycle • keymgr • DICE   │
                         │  CSRNG • KMAC/HMAC/AES • alert handler │
                         └───────────────┬──────────────────────┘
              holds cores in reset;      │ measurements, UDS→CDI, keys, alerts
              releases only on verified   │
              measured boot               ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │  M-mode TEE Security Manager (TSM) — tiny TCB (~10k LoC, ACE-style)     │  lane 01
   │  walled off from untrusted OpenSBI by a Smepmp rule-locked region      │
   │  (Dorami). Owns the page-state machine + measured launch + quote.      │
   └───────────────┬───────────────────────────────────────┬──────────────┘
                   │ programs                                │ launches
                   ▼                                         ▼
   ┌───────────────────────────────┐        ┌──────────────────────────────────┐
   │ Memory isolation: MTT/Smmtt    │        │  Confidential guest domain         │
   │ (whole-OS, DRAM-sized) +       │        │  elizaOS-Linux / AOSP + agent      │  lane 06
   │ MCIE: counter-mode AES +       │ lane01 │  + NPU runtime + weights + data    │
   │ counter-integrity tree at the  │        │  ALL inside the trust boundary     │
   │ memory controller (NOT XTS —   │        └──────────────────────────────────┘
   │ TEE.fail lesson)               │                       │
   └───────────────────────────────┘                       │ confidential I/O only
                   ▲                                         ▼
   ┌───────────────┴──────────────────────────────────────────────────────────┐
   │ Secure I/O: real two-stage IOMMU + IOPMP, per-master source IDs,            │  lane 03
   │ default-deny, monitor-programmed. Assigned (measured, SPDM) vs shared       │
   │ (bounce-buffer) devices. NPU re-homed behind IOMMU as confidential I/O:     │
   │ private queues, DMA isolation, perf-counter lockdown. Secure IRQ (IMSIC).   │
   └────────────────────────────────────────────────────────────────────────────┘

   Cross-cutting (lane 04): no-SMT for domains • cache/TLB/BPU partition-or-flush
   on domain switch • PMU/timer lockdown • masked constant-time crypto • droop/
   clock/temp/light sensors → alert escalation → key zeroization • shadow regs.

   Cross-cutting (lane 05): recover the perf the hardening costs — way-partition
   (not flush) caches, ASID/domain-tagged TLB/BPU, integrity-tree caching, NPU
   ATS pre-translation, domain-confined prefetch, virtualized per-domain Zihpm.
```

**Key decisions, converged:**

1. **Trust model:** single-tenant whole-OS **CoVE/AP-TEE confidential VM** with a
   tiny **M-mode TSM**, not a Keystone-style per-process enclave (won't scale to
   a full OS) and not a multi-tenant hypervisor (needless TCB). The SoC already
   reasons in guest-physical space (IOMMU G-stage), so the H-extension path is
   natural.
2. **Memory isolation:** **MTT/Smmtt** (table-walked, DRAM-sized) as the
   whole-OS spine; **Smepmp** only as the wall protecting the TSM inside M-mode.
3. **Memory confidentiality+integrity:** **counter-mode AES + counter-integrity
   tree** at the memory-controller boundary — explicitly *not* deterministic
   address-tweaked XTS, because of the TEE.fail / CipherLeaks ciphertext
   side-channel lesson.
4. **Root of trust:** integrate an **OpenTitan Earl Grey-class Ibex RoT** that
   holds the CVA6 cluster + PMC in reset and releases only on verified measured
   boot, rather than building a RoT from scratch.
5. **Attestation:** RoT DICE UDS→CDI → measured-launch chain → **`TeeEvidence`**
   (the existing elizaOS type) → quote→verify→**key release / unseal of model
   weights and user data**. This is the bridge from silicon to the product: the
   agent only gets its data after the device attests.

## 3. Cross-lane dependency graph

```
02 RoT ──(measurement regs, DICE key, alert handler, scramble-key ctrl)──┐
   │                                                                      │
   ├──> 01 TSM/monitor ──(page-state FSM, monitor-only programming)──> 03 secure I/O
   │         │                                                            │
   │         ├──(MEE freshness params, integrity-tree arity)──> 04 + 05   │
   │         └──(measured launch + quote shape)──────────────> 06         │
   │                                                                       │
04 hardening <──(perf costs tagged [PERF])──> 05 perf <──(NPU ATS, source IDs)── 03
   │                                                                       │
06 software (Salus/TSM, attestation agent, elizaOS unseal) <──(NPU private-queue attest)── 03
```

- **02 is the foundation** — almost everything roots in the RoT measurements and
  keys. Its W1 (OpenTitan integration) is the long pole.
- **01 is the spine** — the monitor/TSM and page-state machine that 03/04/06 all
  program against.
- **03 is the biggest single rebuild** — the IOMMU is essentially greenfield, and
  the NPU isolation is the headline "confidential on-device AI" feature.
- **04 and 05 are a tug-of-war** that must be designed together: 04 lists every
  control that costs performance (tagged `[PERF]`, MEE+integrity-tree bandwidth
  is the dominant cost), and 05 proposes the recovery for each.

## 4. One sequenced roadmap

The lanes' individual phasings collapse into three program phases gated by
hardware availability. Effort is the buildable-subset estimate per lane.

### Phase 1 — Buildable now (models, contracts, gates; no silicon needed)
Establishes the executable contract and the fail-closed gate floor on a laptop.
- **01:** page-state transition model (`page_state_model.py`), `TeeEvidence`
  quote serializer, scope gate → `make smoke`.
- **02:** OTP fuse-map checker, negative-evidence vectors scaffold, RoT
  `TeeEvidence` fixture.
- **06:** wire the *already-existing-but-unwired* TEE checkers into a
  `tee-software-check` aggregate (WI-0, 0.25 PM — do this first), measured-launch
  map, evidence-policy fixtures, reproducible guest-image manifest.
- **04:** side-channel scope gate + MEE-freshness model check + purge-sequence
  SVA.
- **05:** stand up the in-tree perf measurement loop (BPU/cache/SLC/DRAMsim3 +
  ChampSim/MPKI/lmbench harness) and run the P0 experiments that need no fork.

### Phase 2 — FPGA / simulator (RTL blocks land, cocotb/formal pass against stand-ins)
- **01:** `e1_mtt_checker.sv`, `e1_tsm_epmp_wall.sv`, MCIE model.
- **02:** secure boot ROM (constant-time Ed25519 + SHA-256), measurement extend,
  `e1_lc_ctrl.sv` (retire the 2-bit lifecycle block), OTP RTL.
- **03:** real two-stage PTW + DDT/PDT walker + IOPMP (Phase 1 of that lane),
  source-ID tagging, revoke/scrub, then **NPU secure-I/O re-home + private-queue
  FSM + counter guard** (the headline), then MSI/IMSIC secure IRQ.
- **04:** purge sequencer, counter/timer lockdown, single-step detector; FPGA
  cache/BPU residue + single-step harnesses (BLOCKED until bitstream).
- **06:** Salus + CoVE TSM bring-up, riscv64 CoVE QEMU/Renode confidential-boot
  smoke harness (BLOCKED until a target exists), NPU private-queue attestation
  contract.

### Phase 3 — Silicon (the product claims; almost all BLOCKED today)
Full CoVE TSM + H-ext two-stage + MTT for the whole guest; MCIE on real LPDDR5X;
RoT silicon + key ceremony; side-channel/fault lab validation (TVLA, DPA,
glitch/laser, ciphertext bench, tamper E2E); end-to-end signed `TeeEvidence`;
confidential elizaOS-Linux boot. The evidence gates enumerate each as a
fail-closed blocked claim.

### Effort (buildable subset, order-of-magnitude)
| Lane | PM | Long pole |
|---|---|---|
| 01 core | ~8 | MTT checker + MCIE model (high risk) |
| 02 RoT | ~23.5 | OpenTitan integration W1 (~8 PM, high risk) |
| 03 secure I/O | ~21.5 | IOMMU rebuild + NPU isolation (greenfield) |
| 04 hardening | substantial; most evidence BLOCKED on lab | masked crypto + tamper sensors |
| 05 perf | experiment-driven (P0 now → P3 fork-gated) | core choice (see §5) |
| 06 software | ~9 | Salus/TSM bring-up + riscv64 CoVE target |

Roughly **60+ person-months** of buildable engineering before lab/silicon, with
**OpenTitan RoT integration and the IOMMU/NPU rebuild as the two critical
paths**, designed against the perf budget from lane 05.

## 5. Decisions the owner needs to make

These gate large amounts of downstream work and are not ours to assume:

1. **Application core.** The current CVA6 little-core won't hit phone-class perf.
   Lane 05 recommends mid-core-first on **XiangShan (Kunminghu)** in XS-GEM5,
   with the big core selected as the **open XiangShan Kunminghu V3 8-wide
   scale-up** (no vendor IP license; Tenstorrent Ascalon was surveyed but
   rejected for lack of published mobile-volume license terms). This choice
   drives the whole perf lane and the H-extension/TSM integration target.
2. **OpenTitan integration depth.** Vendored Earl Grey subsystem (fastest path to
   a real RoT, ~8 PM integration) vs a trimmed from-scratch RoT (smaller TCB,
   much slower). Lane 02 recommends vendored Earl Grey.
3. **Memory encryption scope for v1.** Full MCIE on LPDDR5X is silicon-BLOCKED.
   Decide whether the first FPGA milestone targets the protected-agent subset
   (agent + weights private) or attempts whole-OS, since MCIE bandwidth is the
   dominant perf cost.
4. **Android timeline.** AVF/pKVM is ARM64-only and riscv64 has a 16KB-page gap;
   lane 06 recommends **Linux-first, AOSP-later**. Confirm that sequencing.
5. **Whole-OS vs appliance reality.** "Everything in the TEE" is a single-tenant
   secure-appliance model — it dramatically cuts co-tenant side channels but does
   not stop power/EM/bus/malicious-device leakage. Confirm the threat model
   accepts that boundary (it matches Apple PCC / Knox Vault framing).

## 6. What to do first (concrete, low-risk, this week)

1. `06 WI-0`: wire the existing-but-orphaned `check_tee_*.py` scripts + fixtures
   into a `tee-software-check` aggregate on `make smoke`. Pure win, 0.25 PM.
2. `01 W1/W2` + `04 §6.1`: land the spec-db targets and the pure-Python
   page-state + MEE-freshness + scope gates so every TEE claim is fail-closed in
   CI from day one.
3. Make the **§5 decisions 1 and 2** (core + RoT depth) — they unblock the two
   critical paths.
4. Stand up the lane-05 in-tree perf loop so every later hardening change is
   measured against a baseline, not guessed.
