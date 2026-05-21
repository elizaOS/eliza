# 06 — OS-on-TEE Software Stack

Date: 2026-05-21
Status: planning gate (no boot/FPGA/silicon evidence yet — fail closed)
Owner lane: confidential-computing systems software (OS-as-confidential-guest,
attestation agent, elizaOS integration)

This document is the software-side companion to the hardware TEE lanes. It owns
the contract for booting and running the OS as a confidential guest, the
measured-launch sequence, the attestation agent and `TeeEvidence` bridge to
elizaOS, the elizaOS integration, and the Android path. It is a requirements and
work-item plan, not implementation evidence; every milestone fails closed with a
gate that names its missing dependency.

Cross-references (sibling tee-plan docs; some are still landing):

- `01-tee-core-architecture.md` — confidential-domain abstraction (CoVE/TSM vs
  M-mode monitor), page-state machine, the security-manager TCB.
- `02-root-of-trust.md` — ROM/lifecycle/OTP, DICE→CDI derivation, signing.
- `03-secure-io-iommu-npu.md` — IOPMP/IOMMU source-ID policy, NPU as secure I/O.
- `05-cpu-memory-performance.md` — ePMP/Smepmp, memory confidentiality/integrity,
  side-channel partitioning, SMT policy.

Authoritative existing artifacts this plan builds on (do not duplicate):

- `docs/security/confidential-domain.md` — measured-launch chain, page states,
  attestation measurement list, I/O rule, side-channel requirements.
- `docs/spec-db/tee-confidential-domain-contract.json` +
  `scripts/check_tee_confidential_domain_contract.py`.
- `docs/spec-db/tee-attestation-evidence.example.json` +
  `scripts/check_tee_attestation_evidence.py`.
- `docs/spec-db/tee-page-state-transitions.json`,
  `tee-iopmp-source-id-map.json`, `tee-side-channel-claim-matrix.json`.
- The canonical agent-side type lives in elizaOS `@elizaos/agent`
  `services/tee-evidence.ts` (`TeeEvidence`, `TeeMeasurements`, `TeeClaims`,
  `TeeFreshness`, `normalizeTeeEvidence`) and the verifier in
  `services/tee-policy.ts` (`evaluateTeeEvidencePolicy`). This plan does NOT
  redefine those types; it specifies how chip-side software populates them.

Gap noted during audit: the two `check_tee_*.py` scripts and the four
`tee-*` spec-db artifacts exist but are **not wired into any `make` target**.
Closing that wiring is the first, lowest-risk, fully-runnable work item (WI-0).

---

## 1. Boot-to-confidential-OS flow

### 1.1 Recommended software contract: CoVE/TSM-style confidential VM

Two architectural shapes were considered for the software contract:

- **(A) M-mode secure monitor + S-mode OS** (Keystone/OP-TEE-on-RISC-V shape):
  a single M-mode monitor partitions memory with ePMP and runs one or more
  S-mode enclaves. Simple, but the "enclave" is not a full OS with its own
  virtual-memory regime and device model; whole-OS confidentiality means the
  monitor grows into a de-facto hypervisor, which is exactly the TCB bloat we
  want to avoid.
- **(B) RISC-V CoVE / AP-TEE confidential VM** (TSM = TEE Security Manager in
  HS-mode, behind an M-mode TSM-driver): the OS runs as a normal guest (VS/VU)
  inside a hardware-isolated confidential VM (TVM). The TSM is the small,
  measured supervisor-domain TCB; the host hypervisor stays untrusted and only
  schedules/donates pages it can never read. This matches the
  `confidential-domain.md` page-state machine (`free`/`private`/`shared`/
  `measured`/`device-assigned`/`scrub-pending`) one-to-one, and matches the
  Salus reference hypervisor + TSM split used by the RISC-V CoVE effort.

**Recommendation: adopt the CoVE/TSM confidential-VM model as the software
contract (shape B), with Salus as the bring-up host hypervisor and a Salus-class
TSM as the reference TCB.** This must be confirmed consistent with
`01-tee-core-architecture.md`; if 01 selects a pure M-mode monitor, this lane
falls back to shape A with the agent/NPU runtime as the protected payload and the
"whole-OS" claim explicitly downgraded to "protected-agent subset" (the subset
already permitted by `confidential-domain.md` §Security Objective). The
`TeeEvidence.kind` value is `"cove"` for shape B and `"keystone"`/`"eliza-vault"`
for the shape-A fallback; both are already in the allowed-kinds set.

### 1.2 What runs inside vs outside the confidential domain

Inside the domain (measured, private memory, integrity+confidentiality protected):

- Guest kernel (elizaOS Linux first), in-domain device drivers (virtio-confidential
  front-ends, NPU queue driver, storage/crypto), initramfs, rootfs, dtb, policy blob.
- The elizaOS **agent runtime** (`@elizaos/agent` + app-core), local inference
  engine, and the **NPU runtime** (`compiler/runtime/`) driving private queues.
- **Model weights and user data**, unsealed only after attestation (see §3.4).
- The **attestation agent** (in-domain quote requester / evidence assembler).

Outside the domain (untrusted-by-design, minimal):

- M-mode firmware below the TSM (ROM, BL1/BL2, OpenSBI/TSM-driver) — measured but
  not in the confidential guest's address space.
- Host hypervisor / scheduler (Salus host context): donates and reclaims pages,
  schedules vCPUs, brokers mediated I/O. Never reads private memory.
- Mediated I/O backends: display compositor, network, non-secure storage, clock —
  reached only through `shared` pages and explicit copy, per the I/O rule.
- The RoT (lane 02) and secure-I/O fabric (lane 03) are hardware peers, not guest
  software.

### 1.3 Boot chain composition

```text
RoT/ROM (lane 02)              measure -> boot.romState, lifecycle
  -> BL1/BL2                   measure -> boot (BL chain)
  -> OpenSBI + TSM-driver (M)  measure -> boot (firmware), monitor digest
  -> TSM / security manager    measure -> measurements.monitor (security-manager)
  -> [host hypervisor: Salus]  untrusted; requests TVM create
  -> TVM finalize (measured pages locked)
       guest kernel+initramfs  measure -> measurements.os
       rootfs/system + dtb     measure -> measurements.os (or split os/rootfs)
       policy blob             measure -> measurements.policy
  -> guest entry (VS-mode), measured launch complete -> attestation quote available
       agent image/container   measure -> measurements.agent (+ measurements.container/compose)
       NPU firmware + queue policy measure -> measurements.npuFirmware
       attestation -> key release -> unseal weights/user data -> elizaOS runs
```

The `measured` page set is immutable from TVM-finalize until teardown
(`confidential-domain.md` illegal transition: `measured` mutation after digest
finalization). Failed launch routes every private page to `scrub-pending`.

---

## 2. Measured launch in software

### 2.1 Measurement sources (maps to `confidential-domain.md` §Attestation Measurements)

| `TeeEvidence` field | Produced by | When measured |
| --- | --- | --- |
| `measurements.boot` | RoT/ROM + BL1/BL2 + OpenSBI/TSM-driver digests, folded by DICE (lane 02) | pre-TSM, M-mode |
| `measurements.monitor` (TSM) | TSM-driver measures TSM image at load | M-mode, before TVM create |
| `measurements.os` | TSM measures guest kernel + initramfs + dtb + rootfs hash into TVM measurement register at `add-region`/`finalize` | TVM finalize |
| `measurements.policy` | TSM measures the in-domain policy blob (page/IO/debug policy) | TVM finalize |
| `measurements.agent` | in-domain attestation agent hashes agent image (and `container`/`compose` for containerized deploys) at first run, extends a runtime measurement log | post-launch, in-domain |
| `measurements.npuFirmware` | NPU runtime hashes loaded NPU firmware + queue-policy blob before private-queue ownership (lane 03) | post-launch, before private inference |
| `measurements.device` | TSM/IOPMP source-ID policy digest (lane 03 `tee-iopmp-source-id-map.json`) | TVM finalize |
| `claims.*` | TSM + lifecycle: `secureBoot`, `debugDisabled`, `productionLifecycle`, `memoryEncrypted`, `ioProtected`, `npuProtected` | finalize + runtime |
| `securityVersion` | rollback/anti-rollback counter from RoT (lane 02) | M-mode |

Digest convention is the existing `sha256:<64 lowercase hex>` enforced by
`check_tee_attestation_evidence.py` and `normalizeDigest` in `tee-evidence.ts`.

### 2.2 Reproducible guest image build

Measurements are only verifiable if the guest image is **bit-reproducible**. The
plan adopts a dstack/`meta-confidential`-style reproducible build:

- Pin Buildroot/elizaOS-Linux config, kernel config, dtb source, toolchain SHAs.
- Emit a signed **image manifest** (`sw/confidential/image-manifest.schema.json`)
  recording each component's `sha256:` digest and the exact build inputs.
- A `reproduce` gate rebuilds from the manifest and asserts digest equality, so
  `measurements.os`/`measurements.boot` in a quote can be recomputed offline by a
  verifier from public sources (the Apple PCC / Confidential-Containers "the image
  is the policy" model).

This reuses the existing AVB/boot-image work (`docs/security/avb-a-b-ota.md`,
`boot-image-format.md`) for the verified-boot half; the new piece is the
TVM-measurement-register binding and the offline-reproducibility manifest.

---

## 3. Attestation agent + `TeeEvidence`

### 3.1 Canonical schema (anchored to `@elizaos/agent`)

The chip-side attestation agent emits exactly the `TeeEvidence` shape consumed by
`evaluateTeeEvidencePolicy`. For E1 confidential-VM launches:

```jsonc
{
  "kind": "cove",                          // shape-A fallback: "keystone" | "eliza-vault"
  "provider": "eliza-riscv",
  "hardwareVendor": "eliza",
  "platformVersion": "e1-<rev>",
  "securityVersion": <rollback counter, int>,
  "measurements": {
    "boot": "sha256:...",                  // ROM+BL+OpenSBI+TSM-driver (DICE-folded)
    "monitor": "sha256:...",               // TSM / security-manager digest
    "os": "sha256:...",                    // kernel+initramfs+dtb+rootfs
    "policy": "sha256:...",                // in-domain policy blob
    "device": "sha256:...",                // IOPMP source-ID policy digest
    "agent": "sha256:...",                 // elizaOS agent image
    "container": "sha256:...",             // optional, containerized agent
    "npuFirmware": "sha256:..."            // when private inference enabled
  },
  "freshness": { "nonce": "<verifier nonce>", "timestamp": "<RFC3339>", "verifier": "<id>" },
  "claims": {
    "secureBoot": true, "debugDisabled": true, "productionLifecycle": true,
    "memoryEncrypted": true, "ioProtected": true, "npuProtected": true
  },
  "quote": "<base64 CoVE attestation evidence>",
  "certificatePem": "<DICE/RoT cert chain>",
  "reportData": "sha256:<binds nonce + ephemeral pubkey>"
}
```

`reportData` MUST bind the verifier `nonce` and the RA-TLS ephemeral public key so
the quote is not replayable and is tied to the live channel. `check_tee_attestation_evidence.py`
already enforces required measurements (`boot`/`os`/`agent`/`policy`/`device`),
required true claims (`debugDisabled`/`secureBoot`/`ioProtected`),
`memoryEncrypted` for `kind:"cove"`, the `sha256:` format, and `reportData` shape.
**Extend that checker (do not fork it)** to also require `monitor` and `npuFirmware`
when claims advertise `npuProtected`.

### 3.2 Quote → verify → key-release flow (RA-TLS / KMS)

```text
verifier issues nonce
  -> in-domain attestation agent calls TSM "get-attestation" with reportData=H(nonce||epk)
  -> TSM returns CoVE quote signed by RoT-derived key (DICE cert chain)
  -> agent assembles TeeEvidence, serves it over RA-TLS (epk in TLS cert)
  -> verifier runs evaluateTeeEvidencePolicy(evidence, policy):
       allowedKinds, allowedProviders, requiredMeasurements (golden digests
       from the reproducible image manifest), revokedMeasurements,
       minSecurityVersion, expectedNonce, maxAgeMs, requiredClaims
  -> trusted -> KMS releases the data-encryption key wrapped to epk
  -> agent unseals model weights / user data
```

The verifier and policy already exist in `tee-policy.ts`; this lane provides the
chip-side quote producer and the golden-measurement policy generator.

### 3.3 Local-first vs remote verifier

Per the elizaOS local-first model, the **default verifier is on-device**
(`freshness.verifier = "eliza-local-verifier"`, as in the example fixture): the
RoT-rooted key sealing means even a local verifier gains rollback/lifecycle
enforcement. Eliza Cloud is an **optional remote verifier/KMS** for cloud-routed
inference and cross-device key escrow — never required for local operation. This
keeps the device fully functional offline while letting Cloud act as managed KMS
when linked.

### 3.4 elizaOS unseal binding

The data-encryption key is released only when the quote proves the expected
`os`+`agent`+`policy` digests AND `productionLifecycle`+`debugDisabled`. A
tampered OS/agent yields a different `measurements.os`/`agent`, the policy returns
`measurement-mismatch`, the KMS withholds the key, and weights/user data stay
sealed — the negative path is enforced by data unavailability, not by software
checks that could be bypassed.

---

## 4. elizaOS integration

- The agent runtime, local inference, NPU runtime, and all model/user data live
  **inside** the confidential domain. `MILADY_STATE_DIR`/`ELIZA_STATE_DIR`
  (default `~/.milady`) maps to a private, sealed-key-encrypted volume that only
  mounts after attestation-gated key release.
- **"Some stuff on a standard machine" split.** Allowed outside the TEE (untrusted
  by design): UI rendering surfaces, network transport, push/notification relays,
  non-sensitive caches, and Cloud-routed inference *when the user opts in*. The
  mediated channel between in-domain and outside-domain is the `shared`-page
  virtio path: all crossings are explicit copies through shared buffers; no
  private page is ever mapped to a host or non-measured device (the
  `confidential-domain.md` I/O rule). Cloud-routed inference sends only data the
  user has marked exportable; the boundary is a policy field in the in-domain
  policy blob, itself measured into `measurements.policy`.
- The `TeeEvidencePolicy` an elizaOS deployment enforces is selected by topology
  (local-only, desktop+local-agent, mobile+cloud-routed). For local-only the
  policy `required:true` with on-device golden digests; cloud-routed adds
  `allowedProviders` for the Cloud KMS.

---

## 5. Android path + gaps

Sequencing recommendation: **elizaOS Linux first, AOSP later.** Rationale and gaps:

- **riscv64 ABI.** Android 15 CDD permits the riscv64 ABI and targets the RVA23
  profile, but it is not a shipping commercial ABI; treat AOSP-on-E1 as a
  bring-up/CTS track behind Linux.
- **AVF/pKVM is ARM64-only.** The Android Virtualization Framework reference
  implementation (the "guest OS inside a protected pKVM domain" model) does not
  cover riscv64. The E1 confidential-VM model is therefore **CoVE/TSM, not
  AVF/pKVM**; an AVF-equivalent on RISC-V would require either (a) upstreaming a
  CoVE backend behind the AVF/`crosvm` virtualization API, or (b) running AOSP as
  a CoVE TVM directly and exposing a thin AVF-compatible management shim. Option
  (b) is the interim approach; option (a) is the upstream goal.
- **16KB page divergence.** AOSP is moving to 16KB base pages while elizaOS Linux
  bring-up uses 4KB; TVM measurement-region granularity and the IOPMP source-ID
  policy must be validated at both page sizes before an AOSP claim.
- **Verified boot.** Reuse AVB (`docs/security/avb-a-b-ota.md`) for the AOSP
  verified-boot half; the TVM-measurement binding from §2 sits above AVB.

Interim approach: keep AOSP on the existing Cuttlefish/qemu-virt bring-up track
(`docs/android/cuttlefish-riscv64-bringup.md`) with confidentiality **disabled**
and explicitly BLOCKED until a CoVE-capable riscv64 KVM/crosvm path exists.

---

## 6. Verification / evidence (fail-closed)

| Gate | What it proves | Runnable now? |
| --- | --- | --- |
| `tee-attestation-evidence-check` | `TeeEvidence` fixture validates against schema + required measurements/claims | YES (wire existing `check_tee_attestation_evidence.py`) |
| `tee-confidential-domain-contract-check` | confidential-domain contract artifact valid | YES (wire existing `check_tee_confidential_domain_contract.py`) |
| `tee-evidence-policy-fixture-test` | golden + tampered evidence against `evaluateTeeEvidencePolicy` decisions (allowed / measurement-mismatch / security-version-too-low / nonce-mismatch / timestamp-stale) | YES (new pytest, pure data) |
| `tee-image-reproducibility-check` | rebuild from image manifest, assert digest equality | PARTIAL now (manifest schema + digest recompute), full BLOCKED on real image build |
| `tee-measured-launch-map-check` | every measurement in the chain has a named software source (this doc's §2.1 table as data) | YES (new structured manifest + checker) |
| `tee-confidential-boot-smoke` | OS boots as a TVM under Salus on QEMU/Renode and emits a quote | BLOCKED (no riscv64 CoVE QEMU/Salus target in repo; depends on lane 01 TSM + generated AP) |
| `tee-negative-tampered-image` | tampered guest image changes `measurements.os` and fails launch/unseal | BLOCKED (depends on confidential-boot-smoke) |
| `tee-npu-private-queue-attest` | NPU firmware measured + private-queue ownership before inference | BLOCKED (depends on lane 03 secure-I/O) |

Negative tests are first-class: a tampered image MUST fail launch, and a stale or
replayed quote MUST be rejected by policy. The runnable-now gates (data/contract/
policy-fixture) close immediately; the boot/FPGA/silicon gates stay BLOCKED with
named dependencies, matching the repo's fail-closed style.

---

## 7. Work items

All paths are NEW (no edits to existing RTL/firmware/docs). Effort in
person-months (PM). Each item names its `make` gate.

| ID | Work item | New paths | Effort | Risk | `make` gate |
| --- | --- | --- | --- | --- | --- |
| WI-0 | Wire existing TEE checkers + fixtures into a `tee-software-check` aggregate and `smoke` | `scripts/check_tee_software_stack.py` (aggregator), Makefile target additions | 0.25 | low | `tee-software-check` |
| WI-1 | Measured-launch software map as structured data + checker (the §2.1 table) | `docs/spec-db/tee-measured-launch-map.json`, `scripts/check_tee_measured_launch_map.py` | 0.5 | low | `tee-measured-launch-map-check` |
| WI-2 | Extend evidence checker for `monitor`+`npuFirmware`; add golden/tampered policy-fixture pytest | `docs/spec-db/tee-evidence-policy-fixtures.json`, `scripts/test_tee_evidence_policy.py` | 0.5 | low | `tee-evidence-policy-fixture-test` |
| WI-3 | Reproducible guest-image manifest schema + digest-recompute checker | `sw/confidential/image-manifest.schema.json`, `sw/confidential/e1-elizaos-linux.manifest.json`, `scripts/check_tee_image_reproducibility.py` | 1.0 | med | `tee-image-reproducibility-check` |
| WI-4 | Attestation-agent design spec (quote producer, RA-TLS, KMS, reportData binding) | `docs/security/tee-plan/06a-attestation-agent-spec.md` | 0.75 | med | `docs-check` (add to required list) |
| WI-5 | elizaOS unseal/topology-policy spec + sample `TeeEvidencePolicy` per topology | `sw/confidential/policy/*.json`, `scripts/check_tee_topology_policy.py` | 0.75 | med | `tee-topology-policy-check` |
| WI-6 | Salus + CoVE TSM bring-up plan; QEMU/Renode confidential-boot harness scaffold (fail-closed) | `sw/confidential/salus/README.md`, `sw/confidential/qemu-cove/`, `scripts/check_tee_confidential_boot_smoke.py` | 2.5 | high | `tee-confidential-boot-smoke` (BLOCKED) |
| WI-7 | NPU private-queue attestation contract (binds lane 03) | `docs/security/tee-plan/06b-npu-attestation-contract.md`, `scripts/check_tee_npu_attestation.py` | 1.0 | high | `tee-npu-private-queue-attest` (BLOCKED) |
| WI-8 | Android/CoVE gap analysis + interim shim plan (AVF-on-riscv64, 16KB pages) | `docs/security/tee-plan/06c-android-cove-gaps.md` | 0.75 | high | `docs-check` (add to required list) |
| WI-9 | Negative tampered-image launch test harness | `sw/confidential/tests/tampered-image/`, `scripts/check_tee_negative_tamper.py` | 1.0 | high | `tee-negative-tampered-image` (BLOCKED) |

Critical path: WI-0 → WI-1/WI-2 (runnable now) unblock the data/contract floor;
WI-3/WI-4/WI-5 are buildable without silicon; WI-6/WI-7/WI-9 are gated on lane 01
(TSM/monitor) and lane 03 (secure I/O) plus a generated riscv64 CoVE simulation
target, and stay explicitly BLOCKED until those land.
