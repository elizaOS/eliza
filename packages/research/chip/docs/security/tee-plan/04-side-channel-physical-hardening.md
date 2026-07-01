# 04 — Side-Channel Resistance and Physical / Fault Hardening

Status: pre-silicon hardening plan. Not implementation evidence. This document
defines the side-channel and fault-resistance controls the Eliza E1 confidential
domain must satisfy before any "side-channel resistant", "DPA resistant",
"single-step resistant", "ciphertext-side-channel resistant", "tamper
responsive", or "physically hardened" product claim may be made. Every claim in
this lane is **fail-closed**: until a real FPGA, silicon, or lab transcript
backs it, the claim stays unclaimed and the owning `make` gate reports `BLOCKED`.

This is sibling 04 of the TEE plan. Cross-references:

- `00-overview.md` / `confidential-domain.md` — domain model, page states, the
  "Side-Channel Requirements" list this document concretizes.
- `01-tee-core-architecture.md` — memory-encryption engine (MEE), integrity
  tree, monitor entry/exit; consumes the ciphertext-freshness requirements in
  §3 and the state-purge sequence in §1.
- `02-root-of-trust.md` — RoT crypto primitives consume the masking and
  fault-detection requirements in §4; the alert/escalation network in §5 is the
  RoT alert handler instance.
- `03-secure-io-iommu-npu.md` — NPU/IOMMU consume the no-leakage performance-
  counter rule (§2) and the DMA-side state-purge on teardown.
- `05-cpu-memory-performance.md` — every control marked **[PERF]** below removes
  performance the perf lane must account for in its budgets.

The current `docs/security/threat-model.md` lists T8 (decap/FIB) and T9
(DPA/EM side channel) as **explicit v0 non-goals**. This document does not
overturn that. It defines the controls that move T9 and the software/electrically-
observable subset of T8 (glitch, voltage/clock/temperature/light fault
injection, single-step, ciphertext side channel) **in scope for the
confidential-domain product**, staged behind gates. Invasive imaging (e-beam,
FIB edit) remains out of scope and is mitigated only by package and foundry
contract.

---

## 0. Threat grounding (what kills TEEs in the field)

The historical record is unambiguous: memory encryption + remote attestation
are necessary but never sufficient. TEEs fall to observation and fault, not to
broken crypto. The controls below are derived from concrete public attacks:

| Class | Representative attacks | E1 control (section) |
|---|---|---|
| Controlled-channel / page-fault | Xu et al. controlled-channel; off-domain page-table observation | §1 (no shared page walker state across the boundary), §2 (precise-step defense) |
| Branch-prediction leakage | Branch shadowing on SGX; BranchScope; Spectre-class history sharing | §1 (BPU partition-or-flush) |
| Cache timing | Prime+Probe, Flush+Reload, controlled-channel cache attacks | §1 (cache partition-or-flush), §2 (counter lockdown) |
| Transient / speculative | Foreshadow/L1TF, MDS-class | §1 (L1 purge + no cross-domain fill forwarding), §5 perf note |
| Interrupt-driven single-step | SGX-Step, AEX-Notify gap, TDXDown/TDXRay single-step | §2 (AEX-Notify-style atomic re-entry, step detector) |
| Notification / interrupt injection | Ahoi | §2 (secure interrupt routing — coordinate with `03`) |
| Ciphertext side channel | CipherLeaks (SEV-SNP), TEE.fail (DDR5 deterministic ciphertext on SGX/TDX/SEV-SNP) | §3 (non-deterministic ciphertext, tweak/nonce freshness) |
| Voltage/clock fault | Plundervolt, CLKSCREW, VoltJockey | §5 (droop/clock glitch detectors → escalation) |
| Microarch counters as oracle | High-res PMU/timer as attack amplifier | §2 (counter disablement/virtualization) |
| Power/EM key extraction | DPA/CPA/template on key code | §4 (masking, constant-time, DPA-resistant datapath) |
| Physical glitch/probe/light | Laser/EM fault, decap probing | §5 (sensors + differential alerts + zeroization) |

Mitigation patterns we deliberately copy: Sanctum / MI6 (cache partitioning +
state purge on speculative OoO cores, no shared microarchitectural state across
the enclave boundary), no-SMT-for-sensitive-domains, NVIDIA CC-On counter
disablement, OpenTitan (first-order masking, shadow registers, differential
alerts, escalation network, SRAM scramble-key scrub), Apple SEP (DPA/timing-
resistant AES), Samsung Knox Vault (temperature/voltage/glitch/laser detectors
with hardware escalation).

---

## 1. Microarchitectural isolation

**Objective.** No microarchitectural state created inside a confidential domain
is observable by, or shared with, any other domain (host, another CD, debug, or
device path). The boundary is the **monitor domain-switch** (entry/exit of a
confidential domain) and any **context switch** that crosses the CD trust line.

### 1.1 SMT — disabled for confidential domains (recommendation: hard disable)

The E1 CVA6-class core is single-threaded today; this is a forward constraint
for any future SMT cluster. Provable SMT partitioning of shared rename, issue,
LSU, and predictor structures has no public, verifiable construction we can
defend, so the policy is:

- **A confidential domain runs with SMT disabled on its hart.** The monitor
  refuses measured launch onto a hart that has a co-resident sibling thread
  unless the sibling is `idle`/parked and the partner thread context is purged.
- Enforcement seam: `rtl/cpu/cluster/e1_cluster_top.sv` exposes a
  `cd_smt_quiesce` input from the monitor; when asserted the cluster parks all
  sibling threads on the target hart before `measured` state is finalized. The
  monitor reads back a `cd_smt_quiesced` ack before allowing the launch digest
  to finalize (ties to the `measured` page-state freeze in `confidential-
  domain.md`).
- **[PERF]** Loss of SMT throughput on any future SMT part while a CD is
  resident. Account in `05`.

### 1.2 Partition-or-flush matrix

For each shared microarchitectural structure the policy is **partition** (way/
set/index reservation, preferred — lower latency, deterministic) or **flush**
(purge on boundary crossing). The default is flush on entry **and** exit so a
domain neither inherits attacker-primed state nor leaves probe-able residue.

| Structure | RTL owner | Policy | Mechanism |
|---|---|---|---|
| L1I | `rtl/cache/l1i/e1_l1i_cache.sv` | flush on CD entry+exit | extend existing `ifu_flush` into a `cd_purge` that invalidates all valid bits + drops in-flight prefetch (already drops on flush) |
| L1D | `rtl/cache/l1d/e1_l1d_cache.sv` | flush on entry+exit; drain first | writeback-invalidate all sets/ways; **drain MSHRs + store buffer before invalidate** (§1.3) so no dirty CD line escapes unencrypted timing |
| L2 / L3 | `rtl/cache/l2`, `rtl/cache/l3` | partition (way-mask) preferred; flush fallback | reuse the SLC way-partition pattern (below); per-CD `way_alloc_mask` so CD and host occupy disjoint ways — no eviction-based Prime+Probe across the line |
| SLC (system cache) | `rtl/cache/slc/e1_slc.sv` | **partition (already supported)** | `way_alloc_mask[qos_class]` + `way_enable_mask[bank]` already exist; assign a reserved CD QoS class with a disjoint way mask; never share a way set with host/DMA clients while a CD is resident |
| TLB / page-walk cache | CVA6 MMU (wrapper `rtl/cpu/e1_cva6_wrapper.sv`) | flush on entry+exit | full TLB + PWC invalidate; CD never observes host walk-cache fills and vice versa (controlled-channel defense) |
| BPU: TAGE/ITTAGE/bimodal/SC/loop | `rtl/cpu/bpu/{tage,ittage,bimodal,sc,loop_predictor}.sv` | flush on entry+exit | a `bpu_cd_purge` strobe resets prediction tables + useful bits (the periodic `useful_reset` path in `bpu_csr.sv` shows the reset-strobe wiring to reuse) |
| BPU: RAS | `rtl/cpu/bpu/ras.sv` | flush | reset stack pointer + clear entries (return-address shadowing defense) |
| BPU: BTB/FTB/uFTB/FTQ | `rtl/cpu/bpu/{ftb,uftb,ftq}.sv` | flush | invalidate FTB/uFTB; drain FTQ via the existing flush path (`ftq_to_l1i` already drops on flush) |
| Prefetchers (Berti/BO/IPCP/SPP/stride/FDIP) | `rtl/cache/prefetch/*` | flush + quiesce | clear training tables; FDIP already takes a `flush` (`e1_fdip_l1i_prefetcher.sv`); add a uniform `cd_purge` so trained strides/offsets do not cross the boundary |
| Store buffer / MSHR / LSU queues | CVA6 LSU + `e1_l1d_cache.sv` MSHR | drain (§1.3) | block boundary completion until empty |
| PMU/HPM counters | `rtl/cpu/csr/zihpm.sv`, `bpu_csr.sv` | freeze + zero (see §2) | inhibit during CD; zero on exit |

**Single canonical purge signal.** The monitor drives one `cd_state_purge`
pulse on every boundary crossing. A small `rtl/cpu/cd_purge_seq.sv` sequencer
(new RTL, owned by the CPU lane — not authored here) fans this out to each
structure's local purge input **in dependency order**: (1) stop fetch / quiesce
prefetch, (2) drain store buffer + MSHRs, (3) writeback-invalidate L1D, (4)
invalidate L1I + TLB/PWC, (5) flush BPU/RAS/BTB, (6) freeze+zero PMU, (7) ack to
monitor. The monitor blocks re-entry until ack — this is the Sanctum/MI6
"state purge before crossing" guarantee made explicit.

### 1.3 Store-buffer / MSHR drain

On a boundary crossing the LSU must reach a fence-equivalent point: store buffer
empty, all MSHRs retired, no speculative loads in flight. This is stronger than
a `fence` — it must also guarantee no **speculative** L1D fill from the prior
domain remains forwardable (Foreshadow/L1TF lesson). The drain handshake is part
of the `cd_purge_seq` ack so the monitor cannot finalize the switch early.

### 1.4 Enforcement and verification hooks

- The monitor owns the policy register block (in the RoT/monitor MMIO window,
  defined by `02`): per-CD way masks, purge-on-switch enable, SMT-quiesce
  requirement, and a read-only `cd_purge_done` status.
- Static guarantee: a SVA (SystemVerilog assertion) set asserts that **no CD
  boundary crossing completes while any purge ack is low** and that **no L1D
  line tagged with a CD ASID is present after exit purge**. These run under
  Verilator/formal (`make formal`) — see §6.

**[PERF]** Flush-on-switch costs cold-cache and cold-predictor refill on every
domain crossing; partitioning costs effective capacity. Both are real and must
be modeled in `05` (expect tens of µs of refill per heavy switch).

---

## 2. Counter and observability lockdown

High-resolution counters are not just leakage — they are the **amplifier** that
turns coarse timing into a single-instruction oracle (SGX-Step, branch
shadowing). The rule mirrors NVIDIA CC-On: inside a confidential domain, precise
microarchitectural observation is denied or virtualized.

### 2.1 PMU / HPM disablement

- While a CD is resident, **`mcountinhibit` is forced** to inhibit all
  programmable HPM counters (3..15) and is **not writable from the CD or host**
  for CD-attributed events. `zihpm.sv` already has the per-counter inhibit bus;
  the monitor drives an override input `cd_hpm_force_inhibit` that ORs into the
  inhibit decode and cannot be cleared by guest CSR writes while resident.
- BPU PMU counters (`bpu_csr.sv`) are frozen the same way: a `cd_pmu_freeze`
  gates the per-event increment, and the counters are **zeroed on CD exit** so a
  later host read cannot infer CD branch behavior.
- LCOFI/overflow interrupts derived from CD-attributed events are suppressed
  while resident (no overflow-interrupt timing channel).
- Cross-domain events (cache/IOMMU/NPU agents feeding `zihpm`) must not attribute
  CD activity to a host-readable counter; the per-domain remap adapters in
  `rtl/cpu/csr/` gate CD-sourced strobes when `cd_resident` is set.

### 2.2 High-resolution timers

- `rdcycle`/`mcycle` and any fabric high-res timer are **virtualized** for the
  CD: the monitor traps and returns a coarsened/offset value, or denies, per
  policy. Default = coarsen to a resolution below the smallest measured
  microarchitectural event (calibrated in the leakage campaign, §6).
- Off-core timers reachable via MMIO must be IOPMP-blocked from untrusted
  observers timing CD execution (coordinate with `03`).

**[PERF]** CD code loses precise self-profiling. Confidential workloads that
want timing must use a monitor-mediated coarse clock. Note in `05`.

### 2.3 Single-step / precise-interrupt defense (AEX-Notify-style)

SGX-Step and TDXDown single-step an enclave by arming a one-shot timer to fire
one instruction in. Defenses:

- **Step detector.** On every CD asynchronous exit the monitor records the
  retired-instruction count since last entry (read from a CD-private,
  monitor-only `minstret` snapshot). If the count is implausibly small
  (≤ threshold) for repeated exits, the monitor treats it as a single-step
  attack: it increments a tamper counter and, past a policy threshold,
  **escalates** (→ §5 zeroization).
- **AEX-Notify-equivalent atomic re-entry.** Re-entry into the CD after an
  asynchronous exit runs a monitor-trusted prefetch/warm-up trampoline that
  re-establishes the next-instruction working set (cache/TLB lines) so the
  subsequent single-step does not yield a clean per-instruction observation.
  This is the AEX-Notify mitigation pattern (Constable et al.) ported to the
  monitor.
- **Interrupt-rate clamp.** The secure interrupt router (owned by `03`) clamps
  the rate of asynchronous exits attributable to a single CD; sustained
  high-rate stepping trips the same tamper path. This also addresses Ahoi-style
  notification injection.

**[PERF]** The warm-up trampoline adds re-entry latency on every async exit and
the rate clamp can throttle interrupt-heavy CD workloads. Model in `05`.

---

## 3. Ciphertext side-channel hardening (MEE design implications)

TEE.fail and CipherLeaks demonstrate that **deterministic memory ciphertext is
itself a side channel**: an observer with DDR/bus visibility (T4-class, or a
co-tenant on shared memory) learns plaintext relations from ciphertext
collisions, even with an unbroken cipher. This directly constrains the
memory-encryption engine designed in `01`.

Requirements the MEE in `01-tee-core-architecture.md` MUST satisfy:

1. **Non-deterministic ciphertext per write.** Identical plaintext written to
   the same physical address at different times MUST NOT (in general) produce
   identical ciphertext. Equivalently: the encryption must be freshened by a
   per-write nonce/counter, not only by physical address. A pure
   address-tweaked, deterministic mode (XTS-style with address-only tweak) is
   **forbidden for confidential memory** — that is exactly the TEE.fail
   exposure.
2. **Counter/nonce freshness via the integrity tree.** Bind a monotonic
   per-line write counter (the integrity-tree counter) into the encryption
   tweak so freshness and integrity share one freshness source. This is the
   standard counter-mode-encryption + Merkle/SGX-style integrity-tree
   construction; `01` owns the tree, this lane owns the freshness requirement.
3. **No ciphertext replay window.** The integrity tree must detect rollback of
   a (ciphertext, counter) pair; a stale counter must fail verification
   (fail-closed → fault path, §5). Coordinate the tree arity / overhead with
   `01` and the bandwidth cost with `05`.
4. **Granularity.** Freshness must hold at the line granularity the observer can
   resolve (cache line / burst). Sub-line deterministic structure that leaks
   intra-line plaintext relations is disallowed.
5. **Shared buffers are explicit.** Memory marked `shared` (host/device
   mediation) is outside the confidentiality guarantee by design; the monitor
   and drivers must never place secret-dependent data in `shared` pages
   expecting MEE protection.

**[PERF]** Counter-mode freshness + integrity tree adds DRAM bandwidth (counter
fetch, tree walk) and area (counter cache, tree cache). This is the dominant
side-channel performance cost; `05` must budget MEE+tree overhead explicitly.

---

## 4. Crypto-engine hardening (coordinate with `02-root-of-trust`)

Key material (DICE secrets, attestation key, KeyMint/StrongBox keys, MEE keys)
is handled by the RoT crypto engines in `02`. Those engines must resist
power/EM key extraction and fault attacks. This lane sets the requirements; `02`
owns the implementation.

### 4.1 Constant-time

All secret-dependent code and datapaths run in constant time: no secret-
dependent branches, no secret-dependent memory addressing, no early-exit
comparisons (constant-time tag/compare). The `confidential-domain.md`
"constant-time boot and key code" requirement is satisfied here for the boot/
key path and verified by the constant-time gate (§6). The placeholder
`fw/pmc/src/secure_boot.c` (currently a stub returning 0) must, when
implemented, use constant-time HMAC/ECDSA verify.

### 4.2 First-order masking

Symmetric and asymmetric primitives that touch long-lived keys (AES for MEE/
KeyMint, the signature engine) implement **first-order Boolean/arithmetic
masking** (OpenTitan AES masking pattern): every secret-dependent intermediate
is split into ≥2 shares with fresh randomness from the RoT entropy source, so
first-order DPA/CPA on a single intermediate yields no key correlation. Higher-
order masking is a separately gated requirement.

### 4.3 Fault detection — encrypt-after-decrypt / verify-after-sign

- **AES:** verify by re-encrypting the decryption result (encrypt-after-decrypt)
  and comparing; mismatch → fault alert (§5). This catches a single injected
  fault in the datapath (DFA defense).
- **Signature:** verify-after-sign before releasing any signature; a faulted
  signature (Bellcore-class RSA-CRT fault, or faulted ECDSA scalar mult) is
  caught and never emitted.
- **Redundancy:** critical control-flow (key-release decisions, lifecycle
  checks) uses redundant/complementary encoding so a single bit flip does not
  flip a deny into an allow (this is also why §5 mandates shadow registers).

### 4.4 DPA / timing resistance

Beyond masking: hiding (shuffling/dummy operations where cheap), no key-
dependent table indexing (T-table-free or masked-table AES), and a leakage
budget set by the TVLA campaign (§6). Pattern reference: Apple SEP DPA-resistant
AES.

**[PERF]** Masking ≥ doubles crypto datapath area and randomness demand and adds
latency; verify-after-sign doubles signature verify cost. These are RoT-local
and small relative to MEE bandwidth, but `05`/`02` should record them.

---

## 5. Physical / fault hardening and tamper response

**Objective.** Detect electrically- and physically-observable fault attempts
(voltage/clock glitch, temperature, light/laser, probe) and respond by
escalating to **secret zeroization** before the attacker can extract or
fault-bypass a key. This reuses existing power-sensing RTL and the
OpenTitan-style alert/escalation network already partially present in
`pmc_top.sv`.

### 5.1 Sensors

| Sensor | Source | Detects | Status |
|---|---|---|---|
| Voltage droop / glitch | `rtl/power/droop_sensor.sv` (RO-counter, per rail) — **already exists** | Plundervolt/VoltJockey undervolting, voltage glitch | reuse: route `droop_alarm_o` (already into `pmc_top` `droop_alarm_i`) into the alert network, not only DVFS |
| Clock glitch / frequency | new `rtl/security/clk_glitch_mon.sv` (CPU/RoT lane) | CLKSCREW, clock-stretch/overshoot, missing/extra edges | compare monitored clock against AON reference window; pairs with existing `clock_stretcher.sv` |
| Temperature | new sensor (PMIC/AON; coordinate with `thermal_policy.c`) | freeze/heat fault, cold-boot, decap thermal anomaly | out-of-band hi/lo thresholds → alert (distinct from thermal-throttle policy) |
| Light / laser | new on-die photo-sensor (analog macro; **BLOCKED on PDK macro**) | decap + laser fault injection | Knox-Vault-style; requires foundry analog IP |
| Mesh / active shield | package + top-metal mesh (**BLOCKED on package design**) | physical probing/microsurgery | continuity/integrity monitored → alert |

Reuse note: the `droop_sensor` confirm-window (`DROOP_CONFIRM_SAMPLES`) and
event counter are exactly the debounced-glitch primitive a fault detector needs;
the only addition is routing its alarm to the alert handler in addition to the
clock stretcher.

### 5.2 Differential alert signaling

All sensor → alert-handler signals use **differential (dual-rail) encoding**
(OpenTitan alert pattern): a stuck-at or cut wire is itself an alarm. A
single-ended sensor output that can be pinned low by an attacker is forbidden on
the security alert path. `pmc_top.sv` already instantiates an Ibex-based
controller with `alert_minor_o` / `alert_major_*` ports currently unconnected —
the RoT alert handler (`02`) is the consumer; this lane requires those ports be
wired to a real handler rather than left open.

### 5.3 Escalation network → zeroization

The alert handler runs an **escalation timer / phase machine** (OpenTitan
escalation): an unhandled or repeated alert escalates through phases →
(1) interrupt + log, (2) NMI to monitor, (3) **secret wipe**, (4) reset/brick.
Concrete zeroization targets on escalation:

- **Key state:** MEE keys, DICE/attestation private key, KeyMint/StrongBox key
  blobs, ephemeral session keys — actively overwritten (not merely powered off).
- **SRAM scramble-key scrub:** rotate/scrub the SRAM scramble key so on-die SRAM
  contents become unrecoverable (OpenTitan scramble-key scrub). `pmc_top.sv`
  exposes `scramble_key_*` ports on the Ibex (tied off today) — the production
  wiring drives a real scramble key whose scrub is an escalation action.
- **CD teardown:** all resident CDs are torn down and their `private` pages move
  to `scrub-pending` (per `confidential-domain.md`) and are zeroized.

Escalation must complete **autonomously in hardware** even if firmware is hung
(the timer fires regardless) — this is why the network is hardware, not a
software policy loop.

### 5.4 Lifecycle and reset-glitch resistance (ties to `e1_lifecycle.sv`)

- **Tamper/teardown/failed-health-check → zeroization** is the same escalation
  path. The lifecycle controller (`rtl/security/e1_lifecycle.sv`) already
  destroys debug access in LOCKED and has an RMA-wipe concept (test plan
  TC-DEBUG-005); the escalation network extends "wipe on RMA" to "wipe on
  detected physical attack". The placeholder `DEVICE_KEY_PLACEHOLDER` and
  `*_PLACEHOLDER` constants in `e1_lifecycle.sv` are **release blockers** — real
  fused key rows required (tracked by `02`).
- **Shadow registers.** Every security-critical control register (lifecycle
  state, alert enables, key-release gates, way-mask/purge policy) is stored as a
  value + complementary shadow (OpenTitan shadow-register pattern). A single
  fault that flips the live copy without flipping the shadow raises a mismatch
  alert → escalation. This is the reset-glitch / fault-skip defense: an attacker
  glitching past a security check trips the shadow mismatch.
- **Reset-glitch hardening.** Reset de-assertion and lifecycle sampling are
  redundantly sampled across the AON reference; a glitched reset that tries to
  re-open debug or skip secure boot is caught by shadow mismatch + clock-glitch
  monitor.

**[PERF]** Sensor sampling and the escalation network are AON-domain and near-
zero steady-state cost. Shadow registers ~2× the flop count of guarded control
registers (small absolute area). Dual-rail alert routing is wiring-only.

---

## 6. Verification, evidence, and fail-closed gates

Every control above needs evidence. Most evidence requires FPGA, silicon, or a
side-channel/fault lab and is therefore **`BLOCKED`** today — stated explicitly,
fail-closed, following the package convention (gate writes a JSON report under
`build/reports/`, refuses to assert the claim, names the missing dependency and
the command that will prove it). Gate naming mirrors existing security gates
(`security-lifecycle-scope-check`, `docs-check`).

### 6.1 Pre-silicon (runnable now — can pass)

| Gate (`make` target, to be added by owning lane) | Validates | Tool |
|---|---|---|
| `tee-side-channel-scope-check` | this doc's claims are listed `forbidden_until_evidence` in the security spec; no claim is asserted without a backing transcript | Python scope check (pattern: `check_security_lifecycle_scope.py`) |
| `tee-purge-sva` | SVA: no CD boundary completes while any purge ack low; no CD-ASID L1D line after exit purge; PMU inhibited while `cd_resident` | Verilator/formal (`make formal`) |
| `tee-mee-freshness-model` | a model check that the MEE tweak includes a per-write counter (no address-only deterministic mode); cross-checks `01` parameters | Python contract check against `01` spec-db entry |
| `tee-constant-time-lint` | static check that key/boot code has no secret-dependent branch/index (annotated regions); ct-verif/binsec-style or annotation lint | static analysis (BLOCKED on tool selection — fail-closed until chosen) |

### 6.2 FPGA / pre-silicon dynamic (BLOCKED — needs FPGA bitstream)

| Item | Validates | Blocker |
|---|---|---|
| Single-step harness | drive interrupt-per-instruction stepping at a CD on FPGA; assert step-detector trips + warm-up trampoline runs | needs FPGA build + monitor firmware (`03` interrupt router) |
| Cache/BPU residue probe | Prime+Probe / branch-shadow harness across a CD boundary; assert no residual signal | FPGA + cycle-accurate observation |
| Pre-silicon fault campaign | SYNFI-style / gate-level fault-injection on the netlist: inject single faults across key-release, lifecycle, AES verify; assert every fault is caught (shadow mismatch / encrypt-after-decrypt) or benign | gate-level netlist + fault-injection flow (BLOCKED on synth netlist + SYNFI-equivalent) |

### 6.3 Silicon / lab (BLOCKED — needs taped-out part + lab)

| Item | Validates | Blocker |
|---|---|---|
| TVLA leakage assessment | Welch t-test (fixed-vs-random) on power/EM traces of AES/signature; assert |t| below threshold over N traces (first-order) | silicon + ChipWhisperer/EM bench + masked-crypto netlist |
| DPA/CPA campaign | correlation power analysis on MEE/KeyMint keys; assert no key recovery within trace budget | silicon + DPA bench |
| Physical fault injection | voltage/clock glitch, EM, laser fault on running CD; assert sensor → escalation → zeroization fires; assert no key extracted | silicon + fault bench + decap (laser) |
| Ciphertext side-channel bench | DDR bus capture; assert no deterministic ciphertext collision leak (TEE.fail replay against E1 MEE) | silicon + DDR interposer |
| Tamper-response E2E | trigger each sensor; readback key/SRAM storage = zeroized; lifecycle reflects bricked/scrubbed | silicon + bench |

### 6.4 Evidence schema

Reuse the package convention (`docs/security/test-plan.md`): each test case
emits `docs/manufacturing/evidence/side-channel/<TC-ID>/{transcript.json,
trace.bin|uart.log, summary.json}`; the scope check asserts presence + schema
validity and keeps the matching `forbidden_claims` entry unclaimed until a real
transcript exists. Proposed TC families: `TC-SC-ISO-*` (§1), `TC-SC-CTR-*`
(§2), `TC-SC-CIPHER-*` (§3), `TC-SC-CRYPTO-*` (§4), `TC-FAULT-*` / `TC-TAMPER-*`
(§5).

---

## 7. Open items / cross-lane dependencies

- `01` — confirm MEE is counter-mode-with-freshness, not address-only
  deterministic; publish tree arity + counter-cache size for `05` budgeting.
- `02` — wire `pmc_top` `alert_*` and `scramble_key_*` ports to a real RoT alert
  handler + scramble-key controller; replace `e1_lifecycle.sv` placeholder keys
  with fused rows; own masking + fault-detection implementation.
- `03` — secure interrupt router must support the rate clamp and step detector
  signaling; NPU/IOMMU must not leak CD activity into shared performance
  counters.
- `05` — account for the **[PERF]** costs: flush-on-switch refill, partition
  capacity loss, MEE+integrity-tree bandwidth (dominant), timer virtualization,
  AEX-Notify re-entry latency, masking area/latency.
- CPU lane — author `rtl/cpu/cd_purge_seq.sv` (the single canonical purge
  sequencer) and the per-structure `cd_purge` inputs; author
  `rtl/security/clk_glitch_mon.sv`.
- PDK/package — light/laser sensor analog macro and active-shield mesh are
  `BLOCKED` on foundry analog IP and package design respectively.
