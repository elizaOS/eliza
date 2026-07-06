# Eliza E1 — TEE-Native Threat Model and Side-Channel Mitigation Catalog

Date: 2026-05-21
Lane: cross-cutting / synthesis-spine (sibling to `upstreams/research/chip` hardware,
`packages/os` OS, `packages/agent` agent).

This document is the connective threat model the three layers share. It is the
companion to [`attestation-and-dstack-integration.md`](attestation-and-dstack-integration.md),
which threads the attestation chain that this threat model defends.

> **Fail-closed discipline.** Per repo `CLAUDE.md` / `AGENTS.md` and the chip
> package convention, every claim that depends on hardware, FPGA, or a
> side-channel/fault lab is marked **`BLOCKED`**. A `BLOCKED` row is not a defect:
> it is the explicit statement that the control is designed but not yet proven by
> a backing transcript. No "side-channel resistant" / "physically hardened" /
> "ciphertext-resistant" product claim may be made until the named evidence
> exists. The mitigation *design* below is asserted; the *resistance* is not.

## 0. Product framing and the trust boundary

The Eliza E1 is a **single-tenant secure-appliance phone**: an open RISC-V AI
SoC where the entire OS (elizaOS-Linux first, AOSP later), the agent runtime, the
NPU runtime, the model weights, and all user data run inside one whole-system
**confidential domain** (CoVE/AP-TEE TVM with a tiny M-mode TSM). Only a hardware
root of trust, that tiny monitor, and mediated I/O sit outside the trust
boundary. The same software stack can also run in the **cloud lane** as a
dstack-managed Intel TDX CVM with confidential NVIDIA H100/Blackwell GPUs.

Because there is exactly **one tenant**, the dominant industrial threat — a
malicious co-tenant sharing the machine — is **largely out of scope by
construction**. That single decision removes most of the practical attack surface
that breaks shared-cloud TEEs (cross-VM Prime+Probe, co-tenant ciphertext
correlation, noisy-neighbor PMU oracles). The remaining adversaries are the host
(in the cloud lane), the physical attacker (in the device lane), and the supply
chain (both). This framing matches **Apple Private Cloud Compute** (single-tenant
attested nodes, no operator shell, hardware-rooted attestation) and **Samsung
Knox Vault** (tamper-responsive secure element with sensor-driven zeroization). It
is deliberately *not* the multi-tenant-cloud framing where the host is assumed
benign-but-curious and co-tenancy is the headline risk.

### 0.1 In-scope adversaries

| # | Adversary | Lane | In scope? | Rationale |
|---|---|---|---|---|
| A1 | Malicious app / co-tenant inside the device | device | **Mostly N/A** | Single-tenant whole-OS domain: there is no second tenant to defend against. A compromised *app inside the agent* is an application-bug problem (see A6), not a TEE-isolation problem. |
| A2 | Malicious host / hypervisor / cloud operator | cloud | **In scope** | The TDX+dstack lane explicitly removes the operator from the TCB. The host can schedule, interrupt, observe ciphertext on the bus path it controls, and inject notifications. This is the Heckler/WeSee/TDXRay/TDXdown threat surface. |
| A3 | Physical attacker with the device in hand | device | **In scope (electrically/observably), staged** | Bus probing, DDR interposer, cold-boot, voltage/clock/EM/laser glitch, debug-port abuse. The product goal is "hard to attack without pulling the chip off the board." |
| A4 | Supply chain | both | **In scope** | Malicious firmware/image substitution, host-controlled registry mirror (dstack #616), unmeasured kernel cmdline (dstack #618), counterfeit DRAM/board. Defended by measured boot + reproducible images + the attestation chain. |
| A5 | Network adversary | both | **In scope (standard)** | MITM on agent ↔ cloud traffic. Defended by RA-TLS / attested TLS, not by the TEE per se. |
| A6 | Application logic bug inside the trusted domain | both | **In scope but orthogonal** | A bug in the agent leaks its own secrets regardless of the TEE. Defended by the agent's own capability/policy layer, not the silicon. Called out so it is never mistaken for a TEE failure. |

### 0.2 Explicitly out-of-scope / residual (honest boundary)

| # | Residual threat | Why out of scope | Mitigated only by |
|---|---|---|---|
| R1 | Nation-state invasive attack: decap + FIB circuit edit, e-beam probing, microsurgery on an active die | No commodity silicon defends this; defending it is a multi-million-dollar foundry/package program | Package design, active shield mesh, foundry contract, and the economic argument (cost ≫ value of one user's phone) |
| R2 | Unlimited-access power/EM analysis with arbitrary trace counts | First-order masking + hiding raises the bar; it does not make DPA *impossible* given infinite traces and a delidded part | TVLA-bounded leakage budget (BLOCKED on lab), masking, tamper-zeroization-before-extraction |
| R3 | Full physical bus interposition after the attacker has already pulled the chip / decapped the package | Once the DRAM bus is exposed at the die, the MEE is the only line left; counter-mode + integrity tree resists *correlation* but a sufficiently resourced attacker with the live bus is a residual | On-package memory (raises this from "solder a $1k interposer" to "delid + microprobe", see §2.3) |
| R4 | Compromise of the off-device verifier / KMS root key | The cloud KMS root is a single point of failure (dstack's own documented limitation; MPC-KMS is their planned fix) | Our own RoT key-ladder remains the device root (see attestation doc §4); never delegate the *device* secret to the cloud KMS |

**The honest one-line boundary:** *we defend everything an attacker can do without
permanently and destructively opening the package; we do not claim to defend a
funded lab that decaps the die.* This is the same boundary Apple PCC and Knox
Vault draw, stated plainly.

## 1. Memory: the threat and the design (the part the user emphasized)

Memory is where confidential computing most often actually breaks. The crypto is
rarely the weak point; the *observability of encrypted memory* and the *physical
bus* are. We treat memory as a first-class threat surface with three concrete
attack classes and a layered response.

### 1.1 The three memory attack classes

1. **Bus probing / DDR interposition.** **TEE.fail** (Georgia Tech + Purdue,
   Oct 2025) built a **sub-$1,000 DDR5 interposer**, downclocked memory to
   3200 MT/s, and read encrypted traffic off the bus on Intel SGX/TDX and AMD
   SEV-SNP — **no decapsulation required**. Because those platforms use
   **deterministic, address-tweaked AES-XTS**, identical plaintext at a fixed
   address yields identical ciphertext, so the attacker builds a ciphertext
   dictionary, recovers nonces, and *forges attestation quotes*. AMD's
   "Ciphertext Hiding" only blocks the *software* view; it does **not** stop bus
   interposition or fix determinism.
2. **Cold-boot / remanence.** DRAM retains contents for seconds after power loss
   (longer when chilled). An attacker freezes the DIMM, transplants it, and reads
   keys/plaintext — unless memory is encrypted *and* the keys live only inside
   the die and are scrubbed on tamper.
3. **Ciphertext side channel (no probe needed in the cloud lane).**
   **CipherLeaks** (USENIX '21) broke constant-time RSA/ECDSA in OpenSSL on
   SEV-SNP purely by watching the *ciphertext of the VMSA* change in
   hypervisor-readable encrypted memory — recovering the RSA `d` and ECDSA nonce
   `k` with 100% accuracy. The "Systematic Look at Ciphertext Side Channels"
   (IEEE S&P '22) generalized it. Determinism is the root cause in both the
   physical (TEE.fail) and software (CipherLeaks) variants.

### 1.2 The cryptographic design control — counter-mode + integrity tree (NOT XTS)

The single most important memory decision, already converged with the hardware
lane (`upstreams/research/chip/.../00-overview.md` §2.3, `04-side-channel...md` §3), is:

> **The memory-encryption engine (MEE) MUST use counter-mode AES with a
> per-line monotonic write counter folded into the encryption tweak, backed by a
> counter-integrity Merkle tree. Deterministic address-only XTS is FORBIDDEN for
> confidential memory.**

Why this is the right control, point by point against the attacks:

- **Defeats the ciphertext dictionary (TEE.fail / CipherLeaks).** A per-write
  counter means the same plaintext written to the same address at two different
  times produces *different* ciphertext. The attacker's core primitive —
  "identical ciphertext ⇒ identical plaintext" — no longer holds. This is the
  direct TEE.fail/CipherLeaks lesson and the reason XTS is banned here.
- **Defeats replay/rollback.** The integrity tree authenticates the
  `(ciphertext, counter)` pair; a stale counter fails verification and routes to
  the fault path (zeroization, §4). This closes the replay window an interposer
  attacker would otherwise use.
- **Shares one freshness source.** Counter-mode encryption and the integrity
  tree both consume the same monotonic counter, so freshness and integrity are
  not two separate (drift-prone) mechanisms.
- **Line granularity.** Freshness holds at cache-line / burst granularity — the
  resolution the bus observer can actually resolve. No sub-line deterministic
  structure is permitted.

**[PERF]** Counter fetch + tree walk is the **dominant** side-channel performance
cost (counter cache, tree cache, extra DRAM bandwidth). The perf lane
(`upstreams/research/chip/.../05-cpu-memory-performance.md`) must budget it explicitly;
integrity-tree caching is the primary recovery lever. Target: stay within the
program's 10% perf budget; **BLOCKED** on a real LPDDR5X controller model for the
measured figure.

### 1.3 Physical memory packaging — the "pull the chip off the board" lever

Cryptography raises the bar; **packaging** is what makes it *physically* hard. The
TEE.fail result is decisive here: a socketed DIMM on an exposed bus is a
**solder-a-cheap-interposer** attack. The defense is to remove the exposed bus.

**Recommendation (coordinate with the hardware lane's MEE + package design):**

> **Use in-package / on-package DRAM — preferably PoP (package-on-package) or
> in-package-integrated LPDDR5X — not socketed DIMMs and not a long exposed PCB
> DRAM bus.** This is the standard phone-class topology anyway, so it costs us
> nothing we were not already going to pay.

Effect on the attack ladder:

| Memory topology | Cheapest credible bus attack | Difficulty class |
|---|---|---|
| Socketed DDR5 DIMM (cloud-server default) | Slot in a <$1k interposer (TEE.fail) | **Easy / non-destructive** |
| Soldered DRAM, exposed PCB traces | Microsoldering onto BGA/trace fan-out | Moderate, destructive to board |
| **PoP / in-package DRAM (recommendation)** | **Delid the package and microprobe die-to-die bumps** | **Hard / destructive — "pull the chip off the board" and then some** |
| Fully monolithic / 3D-stacked die-on-die | Decap + FIB on an active interposer | Nation-state (R1, out of scope) |

So "**hard to attack without pulling the chip off the board**" is achieved by the
*combination*: counter-mode+integrity-tree means a bus tap yields only
non-correlatable ciphertext, **and** PoP/in-package DRAM means there is no
convenient bus to tap without destroying the package. Neither alone is enough —
XTS-on-PoP still leaks via determinism if the die-to-die link is ever reached;
counter-mode-on-socketed-DIMM is still cheaply tappable. **Both** are required.

What this does **not** defend: cold-boot is mitigated (keys never leave the die;
DRAM content is encrypted with a die-internal key scrubbed on tamper), but a
funded lab that delids and microprobes the live die-to-die interface is **R3**,
residual. We say so.

## 2. Side-channel mitigation catalog

Each row: attack class → representative public attack(s) → the E1 control → which
layer **owns** it → perf cost vs the 10% budget → evidence status. "Owner" is
silicon (`upstreams/research/chip`), OS/monitor (`packages/os` + the M-mode TSM), or agent
(`packages/agent`). This is the master cross-lane table; the chip lane's
`04-side-channel-physical-hardening.md` holds the RTL-level detail.

### 2.1 Microarchitectural state (cache / TLB / BPU / prefetcher)

| Attack | Representative | Control | Owner | Perf | Status |
|---|---|---|---|---|---|
| Cache timing (Prime+Probe, Flush+Reload, Flush+Flush) | TDXploit `clflush`/Flush+Flush on TDX GPA; classic cross-VM | L1 flush on domain entry+exit; L2/L3/SLC **way-partition** (disjoint way mask per domain); single `cd_state_purge` sequencer | silicon | partition: capacity loss; flush: cold-refill (tens of µs/heavy switch) — within budget if switches are coarse | **BLOCKED** (FPGA residue probe) |
| TLB / page-walk-cache observation (controlled channel) | Xu et al.; T-Time fine-grained timing controlled-channel on TDX | full TLB + PWC invalidate on boundary; CD never observes host walk fills | silicon | cold TLB refill on switch | **BLOCKED** (FPGA) |
| Branch-prediction leakage | Branch shadowing (SGX), BranchScope, Spectre history sharing | flush TAGE/ITTAGE/bimodal/SC/loop/BTB/FTB/RAS on boundary (`bpu_cd_purge`) | silicon | cold predictor refill | **BLOCKED** (FPGA) |
| Prefetcher training leakage | stride/offset prefetch cross-domain training | clear training tables + quiesce on boundary | silicon | minor | **BLOCKED** (FPGA) |
| SMT shared-structure leakage | PortSmash-class on shared rename/issue/LSU | **no-SMT for confidential domains** (monitor parks/quiesces siblings before launch finalizes) | silicon | SMT throughput loss on any future SMT part | design-asserted; **BLOCKED** on SMT part |
| Transient / speculative (L1TF, MDS) | Foreshadow, MDS | L1 purge with **store-buffer + MSHR drain before invalidate**; no cross-domain fill forwarding | silicon | part of the purge cost | **BLOCKED** (FPGA) |

The unifying mechanism is the **single canonical `cd_state_purge`** the monitor
drives on every trust-boundary crossing, fanned out in dependency order (quiesce
fetch → drain SB/MSHR → WB-invalidate L1D → invalidate L1I/TLB/PWC → flush
BPU/RAS → freeze+zero PMU → ack). The monitor blocks re-entry until ack. This is
the Sanctum/MI6 "state purge before crossing" guarantee made explicit. Single
tenancy means these purges happen on *host↔domain* boundaries (rare, coarse), not
on every app context switch — which is why the perf cost stays inside budget.

### 2.2 Observability lockdown (PMU / timers / perf counters)

| Attack | Representative | Control | Owner | Perf | Status |
|---|---|---|---|---|---|
| PMU as a single-instruction oracle | TDXRay performance-counter surrogates; branch-shadow amplification | force `mcountinhibit` for HPM counters while domain resident; not writable by guest/host for CD-attributed events; zero on exit | silicon + OS | CD loses self-profiling | design-asserted; **BLOCKED** (silicon) |
| High-res timer amplification | `rdcycle`/`mcycle`/MWAIT-fine-timing (TDXRay) | monitor virtualizes/coarsens the CD clock below the smallest measured µarch event; off-core MMIO timers IOPMP-blocked from untrusted observers | OS (monitor) + silicon (IOPMP) | CD timing is coarse-only | design-asserted; **BLOCKED** (silicon) |
| Cross-domain event attribution | shared cache/IOMMU/NPU counters feeding host-readable PMU | per-domain remap adapters gate CD-sourced strobes when `cd_resident` | silicon | none | design-asserted |

Pattern reference: **NVIDIA CC-On** disables performance counters inside the
confidential context for exactly this reason.

### 2.3 Single-step / interrupt-driven attacks

This class is the most active research front (2023–2025) and the one stock TEEs
keep losing.

| Attack | Representative | Control | Owner | Perf | Status |
|---|---|---|---|---|---|
| Precise single-stepping | **SGX-Step**; **TDXdown**/**StumbleStepping** (CCS '24) circumvent TDX's own detector by deluding its timing heuristic; **TDXploit** (USENIX '25) revives stepping at >99.99% accuracy and notes Intel will *not* fix StumbleStepping | **(a) Step detector:** monitor snapshots a CD-private `minstret`; implausibly small retired-instruction counts across repeated async exits trip a tamper counter → escalation. **(b) AEX-Notify-style atomic re-entry:** a monitor-trusted warm-up trampoline prefetches the next instruction's working set so the following step yields no clean per-instruction observation. **(c) Interrupt-rate clamp** in the secure IRQ router. | OS (monitor) + silicon (secure IRQ, `minstret` snapshot) | warm-up latency per async exit; rate clamp can throttle IRQ-heavy CD work | design-asserted; **BLOCKED** (FPGA single-step harness) |
| Interrupt / notification injection | **Heckler** + **WeSee** (Ahoi family, USENIX '24, CVE-2024-25744/25743): malicious hypervisor injects non-timer interrupts / `#VC` to bypass OpenSSH/sudo auth in CVMs | secure interrupt routing: untrusted IRQs cannot be injected into private monitor state; only a vetted interrupt set is deliverable to the CD; rate-clamped (shares the §2.3 path) | silicon (IMSIC secure IRQ) + OS (monitor) | clamp may throttle | **BLOCKED** (FPGA) |

Critical design note learned from TDXdown/StumbleStepping/TDXploit: **a
single-step *detector* that relies on a timing heuristic is itself a side channel
and is bypassable.** We therefore do **not** rely on detection alone — the
AEX-Notify-style atomic re-entry (deterministic warm-up) is the primary control;
detection + escalation is the backstop. AEX-Notify (USENIX '23, Intel/KU
Leuven/GT/Technion) is the proven pattern, ported to the M-mode monitor. (Note
the 2025 **AEX-NStep** result shows probabilistic interrupt-counting can still
extract a weak signal even with AEX-Notify; this is logged as a residual to
re-test in the silicon campaign, not a reason to abandon the control.)

### 2.4 Ciphertext side channel

Covered in depth in §1.2. Control: counter-mode + integrity tree (non-deterministic
ciphertext per write) + rollback detection. Owner: silicon (MEE). Perf: dominant
MEE/tree bandwidth. Status: **BLOCKED** on a DDR interposer bench (TEE.fail replay
against the E1 MEE).

### 2.5 Physical / fault injection and tamper response

| Attack | Representative | Control | Owner | Perf | Status |
|---|---|---|---|---|---|
| Voltage glitch / undervolt | **Plundervolt**, **VoltPillager** ($30 HW bypass of the Plundervolt microcode fix), **VoltJockey** | voltage droop/glitch sensor (RO-counter per rail, already in `rtl/power/droop_sensor.sv`) → alert network → escalation | silicon (RoT) | AON, ~0 steady-state | **BLOCKED** (fault bench) |
| Clock glitch | **CLKSCREW** | clock-glitch monitor vs AON reference window → alert | silicon (RoT) | AON | **BLOCKED** (fault bench) |
| Temperature / cold-boot | freeze/heat fault, DRAM remanence | out-of-band temp thresholds → alert; encrypted DRAM + die-internal keys scrubbed on tamper | silicon (RoT/PMIC) | AON | **BLOCKED** (lab) |
| Light / laser fault | decap + laser injection | on-die photo-sensor → alert (Knox-Vault pattern) | silicon (RoT) | AON | **BLOCKED** (PDK analog macro) |
| Physical probing / microsurgery | mesh breach | package + top-metal active shield mesh, continuity-monitored → alert | package | n/a | **BLOCKED** (package design) |
| Fault-skip of a security check | reset-glitch past secure boot / debug-unlock | **shadow (dual-rail complementary) registers** on every security-critical control reg; live/shadow mismatch → escalation; redundant control-flow encoding | silicon (RoT) | ~2× flop count on guarded regs (small) | design-asserted; **BLOCKED** (gate-level fault campaign) |
| Power/EM key extraction | DPA/CPA/template on key code | first-order Boolean/arith masking (OpenTitan AES pattern), constant-time, hiding; encrypt-after-decrypt / verify-after-sign fault detection | silicon (RoT) | masking ≥2× crypto datapath area + latency (RoT-local, small vs MEE) | **BLOCKED** (TVLA/DPA lab) |
| Debug-port abuse | JTAG/diagnostic read of secrets | lifecycle controller destroys debug access + production secrets before unlock; debug **fuse-off** in production lifecycle | silicon (RoT) | none | design-asserted; **BLOCKED** (silicon lifecycle) |

The unifying mechanism is the **OpenTitan-style alert/escalation network**: every
sensor uses **differential (dual-rail) signaling** (a cut or stuck wire is itself
an alarm), feeds a hardware escalation timer (interrupt+log → NMI → **secret
wipe** → reset/brick), and **completes autonomously in hardware even if firmware
is hung**. Zeroization targets: MEE keys, DICE/attestation private key,
KeyMint/StrongBox blobs, ephemeral session keys, and the SRAM scramble key (scrub
makes on-die SRAM unrecoverable). Resident confidential domains are torn down and
their private pages move to `scrub-pending`.

## 3. What "hard to attack without pulling the chip off the board" actually means

Precise statement of the achieved bar and the explicit non-claims:

**It means** an adversary holding the device cannot, **without destructively
opening the package**:

- read user data or model weights from DRAM — encrypted with a die-internal key
  (counter-mode); a cold-boot transplant yields ciphertext only;
- tap the memory bus to correlate ciphertext to plaintext — the bus is inside the
  package (PoP/in-package DRAM) and the ciphertext is non-deterministic
  (counter-mode + integrity tree), so TEE.fail's interposer attack has no exposed
  bus and no determinism to exploit;
- glitch voltage/clock to skip a security check — droop/clock sensors + shadow
  registers trip escalation → zeroization;
- single-step or interrupt-inject the agent to leak it instruction-by-instruction
  — AEX-Notify-style re-entry + secure IRQ routing + rate clamp;
- read secrets over the debug port — debug fused off / lifecycle-destroyed in
  production;
- and the moment any sensor fires (light, temperature, mesh breach, glitch), keys
  are **actively overwritten in hardware before extraction completes**.

To progress, the attacker must **delid/decap the package, microprobe the
die-to-die DRAM interface or the die itself, defeat or outrun the tamper sensors,
and do power/EM analysis with a leakage budget below the masking threshold** —
i.e., a funded lab, destroying the device, against one user's phone.

**It does NOT mean** (the honest non-claims, = §0.2 residuals):

- **R1** invasive nation-state attack (decap + FIB edit, e-beam) is *not*
  defended — only package/foundry contract and economics deter it;
- **R2** unlimited-trace power/EM on a delidded part is a residual the masking +
  TVLA budget *bounds* but does not eliminate;
- **R3** a lab that reaches and probes the live in-package die-to-die memory
  interface is residual (the MEE is the last line, and it resists *correlation*,
  not a fully instrumented live bus);
- **R6** application logic bugs inside the agent, and **R4** compromise of an
  off-device cloud verifier/KMS, are outside what the silicon can defend.

This is the Apple PCC / Knox Vault boundary, stated without spin. The owner
decision (`00-overview.md` §5.5) to accept this appliance boundary is what makes
the rest of the program tractable.

## 4. Cross-lane ownership summary

| Concern | Silicon (`chip`) | OS / monitor (`os`) | Agent (`agent`) |
|---|---|---|---|
| Memory confidentiality+integrity | MEE: counter-mode AES + integrity tree; in-package DRAM | marks pages private/shared; never puts secrets in `shared` | trusts `memoryEncrypted` claim before unseal |
| µarch isolation | `cd_state_purge` sequencer, way-partition, no-SMT | drives purge on every boundary crossing | n/a |
| Observability lockdown | `mcountinhibit` override, IOPMP timer block | virtualizes/coarsens CD clock | n/a |
| Single-step / IRQ | `minstret` snapshot, secure IMSIC IRQ | step detector + AEX-Notify re-entry + rate clamp | n/a |
| Physical/fault | sensors, masking, shadow regs, escalation→zeroization, debug fuse-off | reacts to escalation (teardown) | re-attests after recovery |
| Attestation evidence | DICE UDS→CDI, quote | `tee-measurements.json`, evidence service | `TeeEvidence` policy verify before key release (see attestation doc) |

## 5. Fail-closed evidence map (what stays BLOCKED)

| Evidence | Proves | Blocker |
|---|---|---|
| Cache/BPU/TLB residue probe | §2.1 µarch isolation | FPGA bitstream + cycle-accurate observation |
| Single-step / IRQ-injection harness | §2.3 (detector trips, warm-up runs, Heckler-style injection blocked) | FPGA + monitor firmware + secure IRQ router |
| MEE freshness model check | §1.2 (tweak includes per-write counter; no XTS) | runnable now (Python contract check vs chip spec-db) — **can pass pre-silicon** |
| Ciphertext bench (TEE.fail replay) | §2.4 no deterministic-ciphertext leak | silicon + DDR interposer |
| TVLA / DPA campaign | §2.5 masking, leakage below threshold | silicon + ChipWhisperer/EM bench |
| Fault campaign (glitch/laser) | §2.5 sensor→escalation→zeroization fires; no key extracted | silicon + fault bench + decap |
| Tamper E2E | §2.5 keys/SRAM verified zeroized after each sensor trip | silicon + bench |
| In-package DRAM topology audit | §1.3 no exposed socketed bus | package/board design transcript |

Only the **MEE-freshness model check** and the architecture/schema scope checks
can pass today. Everything else is `BLOCKED` by design until FPGA / silicon / lab.

## 6. Sources

- TEE.fail (DDR5 interposer, deterministic-ciphertext, quote forgery): https://tee.fail/ ; https://thehackernews.com/2025/10/new-teefail-side-channel-attack.html ; https://www.bleepingcomputer.com/news/security/teefail-attack-breaks-confidential-computing-on-intel-amd-nvidia-cpus/
- CipherLeaks (ciphertext side channel breaks constant-time RSA/ECDSA on SEV-SNP, USENIX '21, CVE-2020-12966): https://www.usenix.org/system/files/sec21-li-mengyuan.pdf ; A Systematic Look at Ciphertext Side Channels (IEEE S&P '22): https://ieeexplore.ieee.org/document/9833768/
- TDXdown / StumbleStepping (CCS '24): https://uzl-its.github.io/tdxdown/ ; https://dl.acm.org/doi/pdf/10.1145/3658644.3690230 ; Intel advisory INTEL-2024-10-08-001
- TDXploit (USENIX '25, revives single-stepping >99.99%, clflush Flush+Flush on TDX): https://fabianrauscher.com/papers/tdxploit.pdf ; https://www.usenix.org/conference/usenixsecurity25/presentation/rauscher
- TDXRay (host-side µarch side-channel analysis of TDX, S&P '26): https://tdxray.cpusec.org/assets/tdxray_sp26.pdf ; T-Time fine-grained controlled-channel on TDX
- Ahoi / Heckler / WeSee (malicious interrupt injection on TDX & SEV-SNP, USENIX '24, CVE-2024-25744/25743): https://ahoi-attacks.github.io/heckler/heckler_usenix24.pdf ; https://ahoi-attacks.github.io/
- AEX-Notify (single-stepping mitigation, USENIX '23): https://www.usenix.org/system/files/usenixsecurity23-constable.pdf ; AEX-NStep (probabilistic residual, 2025): https://arxiv.org/pdf/2510.14675
- Plundervolt: https://plundervolt.com/doc/plundervolt.pdf ; VoltPillager (USENIX '21): https://www.usenix.org/system/files/sec21summer_chen-zitai.pdf
- ACE: Confidential Computing for Embedded RISC-V (CoVE-compliant M-mode TSM, ~8k LoC Rust, excludes physical attacks): https://arxiv.org/html/2505.12995v1
- CoVE: Towards Confidential Computing on RISC-V: https://arxiv.org/pdf/2304.06167
- RISC-V secure enclave survey (Keystone PMP memory-aliasing bypass, attestation undermining): https://www.mdpi.com/2079-9292/14/21/4171
- Sanctum / MI6 (state purge before crossing), OpenTitan (masking, shadow regs, alert/escalation, scramble-key scrub), Apple PCC, Samsung Knox Vault, NVIDIA CC-On — as design pattern references.
