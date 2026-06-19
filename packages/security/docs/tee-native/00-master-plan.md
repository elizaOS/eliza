# Eliza TEE-Native Confidential AI — Master Implementation Plan

Date: 2026-05-21

This is the top-level synthesis for the **TEE-native** program: hardware, OS, and
agent integration so that the Eliza E1 (open RISC-V AI phone SoC) runs as an
**ultra-private personal AI device** — the entire OS, the agent runtime, the NPU
runtime, model weights, and user data execute inside a **single-tenant
whole-system confidential domain**, with only a tiny trusted monitor, a hardware
root of trust, and mediated I/O outside the trust boundary. **Confidential AI is
the headline product feature.** We accept up to a **10% performance hit across the
board** and deliberately target **one design, not many SKUs**.

It indexes and reconciles four detailed lane plans produced by a parallel swarm:

| Layer | Detailed plan | Owns |
|---|---|---|
| **Hardware** | [`packages/chip/docs/security/tee-plan/07-hardware-implementation-plan.md`](../../../chip/docs/security/tee-plan/07-hardware-implementation-plan.md) (consolidates lanes 00–06) | Silicon TEE: TSM, memory isolation+encryption, RoT, secure I/O, side-channel/physical, perf, attestation |
| **OS** | [`packages/os/docs/tee-os-implementation-plan.md`](../../os/docs/tee-os-implementation-plan.md) | Confidential-guest boot, dstack/meta-dstack image, measured-boot manifest, kernel hardening, memory policy |
| **Agent** | [`packages/agent/docs/tee-agent-implementation-plan.md`](../../agent/docs/tee-agent-implementation-plan.md) | Evidence/policy/key-release, confidential-AI unseal, secret gating, dstack provider hardening |
| **Cross-cut** | [`threat-model-and-sidechannel.md`](threat-model-and-sidechannel.md) · [`attestation-and-dstack-integration.md`](attestation-and-dstack-integration.md) | Threat model, side-channel catalog, the end-to-end attestation chain, dstack verdict |

> **Status discipline (repo CLAUDE.md / AGENTS.md).** Every product-grade claim is
> fail-closed. Nothing here permits a "confidential" / "secure boot" /
> "side-channel resistant" claim until a backing transcript exists. Most claims are
> **BLOCKED** on FPGA, silicon, a real LPDDR5X controller, a real TDX/CC-GPU host,
> or a side-channel lab — **that is by design, not a defect.** Today only the
> software evidence/policy/key-release logic and pure-model gates can pass.

---

## 1. The honest starting point

The contracts are real; the silicon and the confidential runtime are not yet.

- **Hardware (verified against the tree).** PMP/ePMP/Smmtt/H-ext are absent (CVA6 is
  `cv64a6_imafdc_sv39`, only a PMA comment at `e1_soc_integrated.sv:796`). The
  IOMMU is identity-passthrough with a 6-entry allowlist, no page-table walk
  (`e1_riscv_iommu.sv:359`); the NPU and DMA bypass it. The RoT is development-only
  (`e1_lifecycle.sv:68` XORs `0xA5A5_5A5A`; `fw/pmc/src/secure_boot.c` returns 0;
  `fw/boot-rom/reset.S` is an unconditional jump to `0x8000_0000`). **The job is
  to make the existing contract true in hardware, not to invent a TEE.**
- **OS.** A provider-neutral measured-boot contract exists (`tee-measured-boot-contract.md`)
  with working `generate-/validate-tee-measurements.mjs` and a release schema. Gaps:
  the active Linux build (`linux/elizaos/`, Debian live-build) is **not
  bit-reproducible**, and the beta release manifest carries **no `tee` block** yet.
- **Agent.** The evidence/policy core is genuinely production-grade and well-tested:
  `tee-evidence.ts` (strict `normalizeTeeEvidence`, no `any`), `tee-policy.ts`
  (`evaluateTeeEvidencePolicy` — the single trust decision), `tee-revocation.ts`,
  `tee-release-policy.ts`, `tee-signer-backend.ts` (re-attests every sign), and the
  fail-closed `remote-capability-endpoint-provider`. **Current hardware-bound
  gaps:** no real quote verification anywhere (the dstack provider fetches a
  self-asserted `TeeEvidence` JSON; `evidence.quote` is carried but never
  cryptographically checked); the HTTP key-release path does not bind a fresh
  nonce + ephemeral key (replayable); no production wiring (the `tee-*` modules
  are exported but nothing in agent boot consumes them); and **no
  confidential-inference path** (`model-key` scope has no consumer).

So all three layers have a real skeleton and a real consumer contract; the silicon
mechanisms, the reproducible confidential image, and the runtime quote-verification
are the work.

---

## 2. The converged three-layer architecture

```
 ┌───────────────────────────────────────────────────────────────────────────┐
 │ AGENT  (packages/agent)  — runs INSIDE the confidential domain              │
 │  normalizeTeeEvidence → evaluateTeeEvidencePolicy → releaseKey              │
 │  unseal model weights + user data; confidential inference; signer re-attest │
 │  fail-closed: no trusted evidence ⇒ no model-key, no signing, no plugin sync│
 └───────────────▲───────────────────────────────────────────┬───────────────┘
                 │ TeeEvidence (normalized)                    │ unsealed keys
 ┌───────────────┴───────────────────────────────────────────▼───────────────┐
 │ OS  (packages/os)  — the WHOLE OS is the confidential guest                 │
 │  elizaOS-Linux (first) / AOSP (later); dm-verity+IMA rootfs; no-swap/mlock; │
 │  dm-crypt user data keyed off the unsealed key; signed tee-measurements.json│
 │  dstack/meta-dstack profile for the cloud TDX lane (separate from product)  │
 └───────────────▲───────────────────────────────────────────┬───────────────┘
                 │ launch evidence + measurements              │ runs as guest
 ┌───────────────┴───────────────────────────────────────────▼───────────────┐
 │ HARDWARE  (packages/chip)                                                   │
 │  OpenTitan Earl Grey RoT (Ibex): ROM • OTP/lifecycle • DICE • CSRNG • KMAC  │
 │     holds CVA6 cluster + PMC in reset; releases only on verified meas. boot │
 │  M-mode TEE Security Manager (TSM, ~10k LoC, Dorami Smepmp wall)            │
 │  Memory: Smmtt/MTT isolation + MCIE (AES-CTR + counter-integrity tree)      │
 │  Secure I/O: 2-stage IOMMU+IOPMP, NPU re-homed as confidential I/O          │
 │  Physical: in-package PoP LPDDR5X • sensors → escalate → zeroize • fuse debug│
 └─────────────────────────────────────────────────────────────────────────────┘

 Two substrates share ONE provider-neutral contract:
   • ON-DEVICE  : CoVE/AP-TEE confidential VM on the E1 RISC-V chip (the product)
   • CLOUD      : Intel TDX + NVIDIA H100/Blackwell confidential GPU via dstack
```

**Converged decisions (all lanes agree):**

1. **Trust model:** single-tenant whole-OS **CoVE/AP-TEE confidential VM** with a
   tiny **M-mode TSM** — not a Keystone per-process enclave (won't scale to a full
   OS) and not a multi-tenant hypervisor (needless TCB).
2. **Memory isolation:** **Smmtt/MTT** (table-walked, DRAM-sized) as the whole-OS
   spine; **Smepmp** only as the Dorami wall protecting the TSM inside M-mode.
3. **Memory confidentiality+integrity:** **counter-mode AES + counter-integrity
   (Merkle) tree** at the memory controller — explicitly **NOT** address-tweaked
   XTS, because of the **TEE.fail / CipherLeaks** ciphertext-side-channel lesson
   (deterministic encryption leaks on a sub-$1k DDR5 interposer).
4. **Root of trust:** integrate a **vendored OpenTitan Earl Grey-class Ibex RoT**
   that holds the application cluster in reset and releases only on verified
   measured boot — rather than building a RoT from scratch.
5. **Attestation:** RoT DICE UDS→CDI → measured-launch chain → normalized
   **`TeeEvidence`** → policy verify → **key release / unseal** of model weights and
   user data. The agent only gets its data after the device attests.

---

## 3. The end-to-end attestation chain (the program spine)

This is the single thread that connects silicon to product. Numbered flow:

1. **RoT root.** OpenTitan UDS → DICE → CDI; RoT holds the CVA6 cluster + PMC in
   reset.
2. **Measured boot.** ROM → BL1/BL2 → OpenSBI → **M-mode TSM** → confidential guest;
   each stage measured and folded into the DICE chain. Cores release only on a
   verified chain.
3. **Quote.**
   - *On-device:* the TSM signs a **CoVE/AP-TEE quote** with a DICE Alias key.
   - *Cloud:* dstack's guest-agent collects a **TDX + H100/NRAS quote** (compose
     hash in RTMR3).
4. **Normalize.** `normalizeTeeEvidence()` maps either quote into the **one
   `TeeEvidence` shape** (`packages/agent/src/services/tee-evidence.ts`).
5. **Key release.** dstack KMS (or the on-device local verifier) derives a
   **deterministic app-specific key** bound to the measured app and wraps it to the
   guest's ephemeral public key; `report_data = H(nonce ‖ epk)` binds freshness +
   channel. On-device, any dstack-KMS-derived key is **subordinate to the device
   DICE key** — our RoT stays the root.
6. **Policy verify.** `evaluateTeeEvidencePolicy()` checks, in order:
   kind → provider → measurements → revocation → security-version → nonce →
   timestamp → claims.
7. **Unseal.** `releaseKey()` decrypts model weights + user-data volume key **inside
   the domain**; weights stream into the NPU private queues / local model runtime.
8. **Negative path.** A tampered agent/OS/NPU-firmware yields a different
   measurement → KMS/verifier withholds the key → weights stay ciphertext. Failure
   is enforced by *data unavailability*, not by a checked flag.

The field-level mapping (silicon measurement registers ↔ OS `tee-measurements.json`
↔ `TeeEvidence` fields/claims) is specified in
[`attestation-and-dstack-integration.md`](attestation-and-dstack-integration.md).

---

## 4. dstack integration verdict

dstack (https://github.com/Dstack-TEE/dstack) runs `docker-compose` workloads in a
TDX CVM: a guest-agent (`tappd` → `dstack.sock`) emits the quote (compose hash in
RTMR3), a **KMS in its own TEE** derives deterministic per-app keys bound to
(compose + image + args + env), a gateway does RA-TLS, and **meta-dstack (Yocto)**
gives a reproducible image. zkSecurity audited it (May 2025).

**Verdict — two lanes, one contract:**

- **Cloud x86 lane (usable ~as-is, with pins).** Use dstack for the TDX + H100
  confidential-AI path. **Mandatory hardening before reliance:** forbid DevMode and
  dev-KMS; pin a post-Feb-2026 release with QE-identity + TCB-status enforcement and
  TLS verification **on**; enforce on-chain `AppAuth` code-hash allowlists; keep
  secrets out of env/logs; **never make dstack KMS the root of trust.** Track the
  still-open issues — **#609 KMS attestation bypass (`quote_enabled=false`)** and
  **#608 DevMode allow-all** are OPEN; #614/#618/#617/#616/#612/#613/#610/#611 are
  closed-but-must-verify.
- **On-device RISC-V lane (dstack is a higher layer over our RoT).** The TDX quote
  path is **replaced by the CoVE quote**; DevMode / `no_tee` / `quote_enabled=false`
  are removed at build time; dstack KMS, if used at all, derives only app-layer keys
  subordinate to the device DICE key. Our **OpenTitan RoT + M-mode CoVE TSM + signed
  golden measurements** are the root, with an on-device verifier as the default.
- **OS build separation.** Adopt **meta-dstack/Yocto** patterns via a **new third
  profile `ELIZAOS_PROFILE=confidential`**, kept separate from the Tails/live-build
  consumer product. The shared seam between product and confidential builds is the
  **manifest + measurements contract**, not the build tool.

---

## 5. Memory architecture & physical hardening — the "pull the chip off the board" answer

The user asked specifically how memory factors in and how to make the device hard to
attack without physically removing the chip.

- **Encryption, not just isolation.** Smmtt/MTT isolates address ranges; **MCIE**
  (AES-CTR + counter-integrity Merkle tree at the controller) makes off-chip DRAM
  contents confidential *and* tamper-evident. Counter-mode (vs XTS) is the explicit
  defense against **CipherLeaks/TEE.fail** ciphertext correlation. MEE parameters
  sized to the budget: split counters, arity-8 tree ≤4 levels, 32–64KB counter cache
  + a pinned SLC way.
- **Physical memory packaging (the decisive choice).** Recommend **in-package /
  PoP (package-on-package) LPDDR5X**, not socketed DIMMs. TEE.fail's interposer
  attack taps an *exposed* DDR bus; routing the DDR lanes inside the package stack
  removes that bus. Combined with counter-mode encryption, a bus tap then yields only
  non-correlatable ciphertext **and** there is no accessible bus to tap — an attack
  now requires delidding + microprobing the package ("pull the chip off the board,
  and then some"). Full in-package / 2.5D integration is a v2 stretch.
- **OS memory policy.** No host swap (zram-only); `mlock`/`mlockall` +
  `MADV_DONTDUMP` for secret/weight pages; hugepages for the weights arena in private
  memory; dm-crypt over a private block device for weights/state; explicit RAM key
  zeroization on shutdown/panic; **hibernation + kexec + kdump disabled**;
  `guest_memfd` unmapped-private-memory model.
- **Agent memory hygiene.** Decrypted weights, prompts, and KV-cache live only on
  memory-encrypted pages inside the domain; buffers are zeroized; no secret export to
  host logs/env/crash reports.

---

## 6. Side-channel mitigation catalog (cross-layer)

Each attack class → control → owning layer → budget note. Full detail in
[`threat-model-and-sidechannel.md`](threat-model-and-sidechannel.md).

| Attack class | Representative work | Control | Layer | Cost |
|---|---|---|---|---|
| Microarch (cache/TLB/BPU) | classic + Foreshadow/MDS | **way-partition** (not flush) caches, ASID/domain-tagged TLB/BPU, **no-SMT** for the domain | Silicon + OS | low w/ partition; flush would blow budget |
| Observability | perf-counter leakage | PMU/timer/`rdpmc` lockdown; `perf_event_paranoid=3`; disable high-res counters to guest | Silicon + OS | ~0 |
| Single-step / interrupt | **SGX-Step, TDXdown/StumbleStepping, Ahoi/Heckler/WeSee** | **AEX-Notify-style deterministic atomic re-entry as the primary control**, step *detector* only as backstop; secure-IRQ routing + rate clamp | Silicon (TSM) | low |
| Ciphertext / bus | **CipherLeaks, TEE.fail** | counter-mode AES + integrity tree (not XTS); in-package PoP DRAM | Silicon | within budget (§5) |
| Fault injection | **Plundervolt, VoltPillager** | droop/clock/temp/glitch/laser sensors → alert escalation → **key zeroization**; shadow registers; locked voltage/clock in secure domain | Silicon | area, not runtime |
| Provisioning / debug | — | debug fused off in production; OTP lifecycle; measured kernel cmdline (dstack #618 lesson) | Silicon + OS | ~0 |

Crypto inside the domain stays **constant-time + masked** even on "secure" hardware.

---

## 7. Canonical contract reconciliation

A drift correction the swarm surfaced, now settled:

- **Canonical evidence type:** `packages/agent/src/services/tee-evidence.ts` —
  `TeeEvidence`, `TeeMeasurementName`, `TeeClaims`, `normalizeTeeEvidence`,
  `evaluateTeeEvidencePolicy`. **This is the contract every layer targets.**
- **Legacy types:** `packages/core/src/types/tee.ts` holds only the old elizaOS
  Phala/TDX types (`TEEMode`, `TeeType`, `TeeAgent`, `RemoteAttestationQuote`, …).
  Do **not** add the new confidential-AI fields here; do not conflate the two homes.
- **`TeeMeasurementName` already includes** `compose`, `npuFirmware`, `gpuFirmware`
  (alongside `boot`/`os`/`agent`/`policy`/`device`/`container`). The gaps are:
  1. `compose` / `gpuFirmware` / `npuFirmware` are **typed but absent from the OS
     measurement contract + fixtures** — add them so the OS manifest mirrors dstack's
     RTMR3 binding and the H100/NPU confidential-AI proof.
  2. **No model-weights digest** anywhere — add a `modelWeights` measurement name so a
     swapped/poisoned model fails attestation. (Biggest single gap for confidential AI.)
  3. Add a `monitor` measurement name (the TSM digest) for the on-device chain.
  4. For on-device inference, `npuProtected` / `ioProtected` should be **required**
     claims (today optional); cloud adds `gpuProtected`.
- **Claims contract confirmed correct:** `debugDisabled`, `secureBoot`,
  `memoryEncrypted`, `ioProtected` are the right base set; the work is *enforcing*
  already-present optional fields, not breaking the type.

---

## 8. Unified sequenced plan

Three program phases gated by hardware availability; effort is the buildable-subset
estimate.

### Phase 1 — Buildable now (laptop; no silicon, no TDX host)
Establish the executable contract and the fail-closed gate floor.
- **Agent (~13.5 PW):** add the production-profile policy; wire `tee-*` into agent
  boot (consume `resolveTeeRuntimePolicy`, gate secrets, wrap the signer); add fresh
  nonce + epk binding to the key-release client; negative/revocation test vectors;
  plumb the `model-key` unseal path against synthetic fixture evidence.
- **OS (~3.25 PM):** add the `tee` block to the release manifest; create the
  `meta-elizaos` confidential profile; build the evidence bridge with fixture
  transcripts; ship policy + dstack-pin data; add `compose`/`gpuFirmware`/`npuFirmware`/
  `modelWeights` to the measurement contract + fixtures.
- **Hardware (Phase-1 models/gates):** page-state transition model, `TeeEvidence`
  quote serializer, OTP fuse-map checker, MEE-freshness model check, purge-sequence
  SVA, the perf measurement loop (BPU/cache/SLC/DRAMsim3 + ChampSim/lmbench). Wire
  the existing-but-orphaned `check_tee_*.py` into a `tee-software-check` aggregate.

### Phase 2 — FPGA / simulator (RTL lands; cocotb/formal pass against stand-ins)
- **Hardware:** `e1_mtt_checker.sv`, `e1_tsm_epmp_wall.sv`, MCIE model; secure boot
  ROM (constant-time Ed25519 + SHA-256), `e1_lc_ctrl.sv`, OTP RTL; real two-stage
  PTW + DDT/PDT walker + IOPMP + source-ID tagging, then **NPU secure-I/O re-home +
  private-queue FSM** (the headline), then MSI/IMSIC secure IRQ; purge sequencer,
  counter/timer lockdown, single-step backstop.
- **OS:** cloud TDX lane — real dstack CVM on a TDX + CC-GPU host (BLOCKED until host
  available); reproducible meta-dstack image + signed measurements; confidential-boot
  smoke on riscv64 CoVE QEMU/Renode + Salus (BLOCKED until target exists).
- **Agent:** real dstack KMS quote verification on TDX + H100 (BLOCKED on hardware);
  RA-TLS + KMS-identity pinning; refuse DevMode/simulated quotes under prod profile.

### Phase 3 — Silicon (the product claims; almost all BLOCKED today)
Full CoVE TSM + H-ext two-stage + Smmtt for the whole guest; MCIE on real LPDDR5X;
RoT silicon + key ceremony; in-package PoP memory; side-channel/fault lab validation
(TVLA, DPA, glitch/laser, ciphertext bench, tamper E2E); end-to-end signed
`TeeEvidence`; confidential elizaOS-Linux boot; real on-device confidential inference.

### Effort & critical paths
| Layer | Buildable-subset PM | Long pole |
|---|---|---|
| Hardware | ~60+ (whole program) | **OpenTitan RoT integration (~8 PM)** ∥ **IOMMU+IOPMP+NPU rebuild (~22 PM)** |
| OS | ~3.25 now + ~6 cloud-TDX | meta-dstack reproducible image + measured boot |
| Agent | ~13.5 PW (Phase A) | production-profile → boot wiring → unseal plumbing |

Two parallel hardware critical paths (RoT and secure-I/O) dominate the timeline;
agent + OS Phase-1 work has **no hardware dependency** and should start immediately.

---

## 9. Open owner-decisions

These gate large amounts of downstream work and are not the swarm's to assume:

1. **Application core.** CVA6 won't hit phone-class perf. Mid-core-first on
   **XiangShan (Kunminghu)**; the big core is gated on a **licensing decision:
   Tenstorrent Ascalon vs XiangShan Kunminghu** (Ascalon is already a BLOCKED
   licensing gate). Drives the whole perf lane and the H-ext/TSM integration target.
2. **OpenTitan integration depth.** Vendored Earl Grey subsystem (recommended, ~8 PM)
   vs trimmed from-scratch RoT (smaller TCB, much slower).
3. **Memory-encryption scope for v1.** Full MCIE on LPDDR5X is silicon-BLOCKED.
   Decide whether the first FPGA milestone targets the protected-agent subset (agent
   + weights private) or whole-OS, since MCIE bandwidth is the dominant perf cost.
4. **Memory packaging.** Confirm **in-package PoP LPDDR5X** (the §5 recommendation) —
   it is the cost/feasibility decision that makes the physical-attack story real.
5. **Android timeline.** AVF/pKVM is ARM64-only and riscv64 has a 16KB-page gap;
   recommend **Linux-first, AOSP-later**. Confirm sequencing.
6. **Whole-OS vs appliance reality.** "Everything in the TEE" is a single-tenant
   secure-appliance model — it dramatically cuts co-tenant side channels but does not
   stop power/EM/bus/malicious-device leakage on a delidded part. Confirm the threat
   model accepts that boundary (matches Apple PCC / Knox Vault framing).

---

## 10. Residual-risk register & what is explicitly NOT defended

We defend everything achievable **without destructively opening the package**. We do
**not** claim defense against:

- **R1** Nation-state decap / FIB editing.
- **R2** Unlimited-trace power / EM analysis on a delidded part.
- **R3** Live in-package die-to-die probing.
- **R4** Cloud KMS root-key compromise (cloud lane only; on-device root is our RoT).
- **R6** Application logic bugs above the TEE boundary.

This is the same boundary Apple PCC and Samsung Knox Vault state plainly. The
single-tenant whole-OS model removes co-tenant side channels by construction; the
remaining residual is physical and supply-chain, mitigated (not eliminated) by
in-package memory, tamper sensors → zeroization, fused-off debug, and measured
provisioning.

---

## 11. What to do first (concrete, this week)

1. **Agent + OS Phase-1 work has no hardware dependency — start now.** Wire the
   `tee-*` suite into agent boot behind a production policy profile; add the nonce/epk
   binding to key release; add the `tee` block + the missing measurement names
   (`compose`, `gpuFirmware`, `npuFirmware`, `modelWeights`, `monitor`) to the OS
   contract and fixtures.
2. **Stand up the fail-closed gate floor:** `tee-software-check` aggregate (wire the
   orphaned `check_tee_*.py`), the page-state + MEE-freshness + scope gates, so every
   TEE claim is fail-closed in CI from day one.
3. **Make owner-decisions §9.1 and §9.2** (core + RoT depth) — they unblock the two
   hardware critical paths.
4. **Stand up the lane-05 perf loop** so every later hardening change is measured
   against a baseline, not guessed.
5. **Pin/harden dstack** per §4 before any reliance, and stand up the cloud TDX lane
   contract against fixture evidence so it's ready when a TDX + CC-GPU host appears.
