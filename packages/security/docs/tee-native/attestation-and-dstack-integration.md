# Eliza E1 — End-to-End Attestation Chain and dstack Integration

Date: 2026-05-21
Lane: cross-cutting / synthesis-spine. Companion to
[`threat-model-and-sidechannel.md`](threat-model-and-sidechannel.md).

This document defines the **single** attestation chain that threads silicon → OS
→ agent for both the on-device RISC-V lane and the cloud TDX+GPU lane, and how
[dstack](https://github.com/Dstack-TEE/dstack) ("our friends made it") fits per
layer and per substrate. It cites the exact `TeeEvidence` fields the layers must
agree on (`packages/core/src/types/tee.ts`, normalized in
`packages/agent/src/services/tee-evidence.ts`, verified by
`packages/agent/src/services/tee-policy.ts`).

> **Fail-closed.** Hardware/lab-dependent links in the chain are marked
> **`BLOCKED`** until FPGA / silicon / real-TDX evidence exists. The normalized
> `TeeEvidence` contract, the policy verifier, the release-policy mapping, and the
> key-release client are **real, working code today**; the silicon mechanisms that
> would emit a *genuine* quote are not.

## 1. The dstack model (precise)

dstack (Phala / Dstack-TEE) is an **open framework for confidential AI**: it runs
ordinary `docker-compose` workloads inside a TEE confidential VM, gives each app a
hardware-attested identity, and releases deterministic per-app keys only after
verifying the app's measured identity. Components:

| Component | Role |
|---|---|
| **VMM** | Runs on a bare-metal Intel TDX host. Parses `docker-compose` directly (no app changes), boots a CVM from a reproducible OS image, allocates CPU/RAM/confidential-GPU. |
| **Guest agent** (`dstack-guest-agent`; legacy `tappd`, socket `/var/run/tappd.sock` → now `dstack.sock`) | Runs **inside** each CVM. Generates the TDX attestation quote (extends app data into RTMR3), provisions per-app keys from KMS, encrypts local disk, exposes the app interface over the unix socket. |
| **KMS** | Runs in its **own** TEE. Verifies the CVM's TDX quote, enforces authorization via on-chain smart contracts, and derives **deterministic** per-app keys bound to the app's attested identity. Root key is TEE-protected (acknowledged single point of failure; MPC-KMS is the planned fix). |
| **Gateway** | Terminates TLS at the edge, auto-provisions ACME certs, routes to CVMs, uses **RA-TLS** for mutual attestation on internal hops. |
| **meta-dstack** | Yocto layer producing the **reproducible** guest OS image, so the image hash (MRTD + RTMR0–2) is deterministic and verifiable. |

**Identity / key binding.** App identity = `compose-hash` (SHA-256 of the
docker-compose) recorded in **RTMR3**, plus image hash (MRTD/RTMR0–2 from the
reproducible image), plus args/env. The KMS derives keys deterministically from
that identity, so the *same* attested app always gets the *same* key, and any
change to compose/image/args/env yields a *different* key (fail-closed against
substitution). Instance-level secrets (e.g., disk-encryption keys) mix in an
instance ID.

**RA-TLS.** Follows the Gramine RA-TLS model: the attestation quote binds the
**TLS certificate's public key** to the TEE measurements (not to a session), so a
client validating the cert is transitively validating the enclave identity.

**Substrates.** Intel TDX (4th/5th-gen Xeon); NVIDIA Confidential Computing
(H100, Blackwell) via NVIDIA Remote Attestation Service (NRAS) for the GPU half.

### 1.1 dstack known open security issues + audit history

dstack was audited by **zkSecurity** (May 26 – Jun 13 2025; report
`phala.com/dstack/dstack-audit.pdf`). The headline finding: dstack used **OVMF
Configuration A**, which *trusts the VMM*; the fix moved to **Configuration B**,
placing the VMM outside the TCB (implemented). The GitHub security issue tracker
shows the rest of the attack surface — **treat every one of these as a hardening
checklist item before we layer dstack onto our RoT:**

| # | Issue | Class | Status | Implication for us |
|---|---|---|---|---|
| #609 | `get_kms_key` bypasses attestation when `quote_enabled=false` | **KMS attestation bypass** | **OPEN** | Must pin `quote_enabled=true`; never accept a no-quote key path. |
| #608 | DevMode auth API unconditionally allows all apps + KMS replication | **permissive DevMode auth** | **OPEN** | DevMode must be **compile-time impossible** in our production image. |
| #619 | KMS temporary CA returns private key without auth | cert/key exposure | closed | Verify fix is in our pinned KMS version. |
| #618 | Disk encryption disable-able via kernel cmdline, **unmeasured in RTMR** | unmeasured config | closed | Kernel cmdline MUST be measured; see field-mapping gap §3. |
| #617 | Guest agent exposes raw private keys to all local processes | world-readable keys | closed | Single-tenant helps, but socket perms must be locked; agent is the only client. |
| #616 | Host-controlled Docker registry mirror → image substitution | supply chain | closed | Pin image by digest in the measured compose; never trust host mirror. |
| #615 | Host-supplied system config unmeasured but security-relevant | unmeasured config | closed | All security-relevant config must extend an RTMR. |
| #614 | VMM `no_tee` flag launches VMs without TDX | fake/disabled TEE | closed | Forbid `no_tee`; policy must require a real quote (`kind != none`). |
| #613 | 10-year default cert validity undermines attestation freshness | freshness | closed | Pin short cert/quote validity; our policy `maxAgeMs` enforces freshness independently. |
| #612 | Gateway `register_cvm` prefers stale `app_info` over live attestation | stale evidence | closed | Always verify **live** evidence; our verifier re-checks freshness nonce + timestamp. |
| #611 | Unauthenticated `/finish` can shut down KMS onboard | DoS | closed | Network-isolate KMS control plane. |
| #610 | Unauthenticated bootstrap can overwrite root keys | root-key takeover | closed | Bootstrap endpoint must be authenticated + one-shot. |

There is also a follow-up "attestation pipeline hardening" update from Phala. A
research paper ("Dstack: A Zero Trust Framework for Confidential Containers",
arXiv 2509.11555) documents the design.

### 1.2 On-device RISC-V vs cloud x86 — the hardening verdict

> **Cloud x86 lane (Intel TDX + H100):** dstack is usable close to as-is, with
> the issue list above pinned/hardened. The TDX hardware + NRAS is the root of
> trust; dstack's VMM/KMS/gateway/guest-agent provide the orchestration and key
> ladder. Our agent treats the dstack-issued evidence as a `TeeEvidence` of
> `kind: "tdx"`/`"dstack"` and applies our own policy on top.
>
> **On-device RISC-V lane:** dstack is a **higher-layer framework layered on our
> own RoT**, *not* the root. Our **OpenTitan-class RoT + DICE UDS→CDI key ladder
> is the root of trust**, and the **M-mode CoVE/AP-TEE TSM** is the measured-launch
> authority. dstack-style components (a guest-agent equivalent emitting the quote,
> a KMS-style deterministic key derivation) may be *reused as patterns*, but: the
> TDX-specific quote path is **replaced** by the CoVE quote; the dstack KMS, if
> used at all, derives only *application-layer* keys and is **subordinate** to the
> device RoT key (it can never be the device secret); DevMode/`no_tee`/`quote_enabled=false`
> paths are **removed at build time**; the OVMF-Config-A trust-the-VMM issue is
> moot because there is no untrusted VMM in the appliance model — the TSM is the
> launch authority.

The invariant in both lanes: **our RoT key-ladder remains the device root even
when dstack KMS is layered on top.** dstack KMS keys are *app-scoped and
derivable*; the device identity / unseal key for the model weights and user data
chains to the silicon DICE secret, never to a cloud KMS root (which dstack itself
documents as a single point of failure — §1.1 #610, the MPC-KMS upgrade path).

## 2. The one end-to-end attestation chain

One chain, two substrate variants that converge on the **same normalized
`TeeEvidence`** the agent verifies. The agent code path is **identical** across
substrates — only the quote producer differs.

### 2.1 Numbered flow

1. **Silicon RoT power-on (device lane).** OpenTitan-class RoT (Ibex) holds the
   CVA6/application cluster in reset. ROM verifies the next stage; a **DICE** UDS
   (Unique Device Secret, fused) is combined with the first measured stage to
   derive **CDI** (Compound Device Identifier). *(Cloud lane: skip to step 4 —
   TDX hardware is the root.)* **BLOCKED** (silicon RoT; today `secure_boot.c`
   returns 0, `e1_lifecycle.sv` uses development test keys).
2. **Measured boot chain (device).** Each stage measures the next before
   releasing it: ROM → BL1/BL2 → OpenSBI → **M-mode TSM** → guest. Each
   measurement extends a measurement register (RoT-held), forming the boot/os
   chain. The TSM performs **measured launch** of the confidential domain (page
   states `measured` → frozen, per `confidential-domain.md`). **BLOCKED** (FPGA/silicon).
3. **TSM produces a CoVE/AP-TEE quote (device).** The monitor signs a quote over
   {boot, os, agent, policy, device, npuFirmware, model-weights} measurements +
   the verifier nonce in `reportData`, using the DICE-derived attestation key.
   **BLOCKED** (CoVE TSM bring-up).
   **— OR (cloud) —**
   4. **TDX + GPU quote (cloud).** dstack guest-agent collects the **TDX quote**
      (MRTD + RTMR0–3, with compose-hash in RTMR3) and the **NVIDIA GPU
      attestation** (via NRAS). dstack KMS verifies the quote and releases the
      deterministic app key. **BLOCKED** (real TDX host).
5. **Normalize to `TeeEvidence`.** Whichever quote was produced is mapped into the
   provider-neutral shape `packages/core/src/types/tee.ts` →
   `normalizeTeeEvidence()`:
   - `kind`: `"cove"` (device) or `"tdx"`/`"dstack"` (cloud) — *required*.
   - `measurements`: `{ boot, os, agent, policy, device, container, compose,
     npuFirmware, gpuFirmware }` (subset present per lane).
   - `claims`: `{ debugDisabled, secureBoot, memoryEncrypted, ioProtected,
     npuProtected, gpuProtected, productionLifecycle }`.
   - `freshness`: `{ nonce, timestamp, verifier }`.
   - `securityVersion`, `quote`, `certificatePem`, `reportData`.
6. **dstack KMS deterministic app-key release (where dstack is used).** The KMS
   derives the app key from (compose digest + image hash + args + env). On-device,
   this is *subordinate* to the RoT — app-layer keys only (§1.2).
7. **Agent policy verify** — `evaluateTeeEvidencePolicy()` in
   `tee-policy.ts`, with a policy built from the release manifest by
   `teePolicyFromReleaseManifest()` (`tee-release-policy.ts`). Checks, in order:
   `kind ∈ allowedKinds` → `provider ∈ allowedProviders` → each
   `requiredMeasurements` digest matches (`teeMeasurementDigestMatches`, sha256-prefix
   tolerant) → no `revokedMeasurements` → `securityVersion ≥ minSecurityVersion`
   and not revoked → freshness `nonce === expectedNonce` → `timestamp` within
   `maxAgeMs` (and not >60s in the future) → each `requiredClaims` boolean matches.
   Any failure → `trusted:false` with a typed `reason`. **Runnable today** against
   fixtures.
8. **Unseal.** Only on `trusted:true` does `LocalTeeKeyReleaseClient.releaseKey()`
   (`tee-key-release.ts`) derive key material — `HMAC-SHA256(masterSecret, keyId ‖
   context ‖ agent ‖ policy ‖ device measurements)` — used to unseal model weights
   and user-data / secrets. A rejected evidence **throws**; nothing is released.
   (`HttpTeeKeyReleaseClient` is the remote variant against `/v1/tee/key-release`.)

### 2.2 Diagram

```
 DEVICE LANE (RISC-V appliance)                 CLOUD LANE (TDX + H100)
 ──────────────────────────────                 ───────────────────────
 [1] OpenTitan RoT: UDS ──DICE──> CDI            [4] dstack VMM boots CVM
       │ holds cluster in reset                        from reproducible
       ▼                                                meta-dstack image
 [2] measured boot:                                     │
   ROM→BL1/BL2→OpenSBI→TSM→guest                  TDX HW: MRTD + RTMR0..3
   (each extends a measurement reg)                 (compose-hash in RTMR3)
       │                                              │   + NVIDIA NRAS GPU quote
       ▼                                              ▼
 [3] M-mode TSM signs CoVE quote                 dstack guest-agent collects
   over {boot,os,agent,policy,                     TDX+GPU quote; dstack KMS
    device,npuFirmware,weights}                     verifies → deterministic
   with DICE attestation key                        app key (compose+image+args+env)
       │                                              │
       └───────────────┬──────────────────────────────┘
                       ▼
         [5] normalizeTeeEvidence()  →  TeeEvidence  (ONE shape)
              kind / measurements / claims / freshness / securityVersion / quote
                       │
                       ▼
         [7] evaluateTeeEvidencePolicy(evidence, policyFromReleaseManifest)
              kind→provider→measurements→revocation→secVer→nonce→ts→claims
                       │  trusted:true (else throw, release nothing)
                       ▼
         [8] releaseKey(): HMAC(masterSecret, keyId‖ctx‖agent‖policy‖device)
                       │
                       ▼
              unseal model weights + user data + secrets
```

## 3. Field-level mapping table + gaps

Silicon measurement registers / RoT claims ↔ OS `tee-measurements.json` ↔
`TeeEvidence` fields + policy `requiredClaims`.

| Silicon / RoT source | OS manifest key (`tee-measurements.json`) | `TeeEvidence` field | Policy gate |
|---|---|---|---|
| ROM + lifecycle state, BL1/BL2/OpenSBI digest; TDX MRTD/RTMR0 | `boot` | `measurements.boot` | `requiredMeasurements.boot` |
| Kernel + initramfs + rootfs/system image + device tree; TDX RTMR1/2 | `os` | `measurements.os` | `requiredMeasurements.os` |
| Agent package / container / APK / protected-agent guest digest | `agent` | `measurements.agent` | `requiredMeasurements.agent` |
| TEE policy JSON digest (allowed providers, claims, key-release rules) | `policy` | `measurements.policy` | `requiredMeasurements.policy` |
| Platform identity class + lifecycle + security-version source | `device` | `measurements.device` (+ `securityVersion`) | `minSecurityVersion`, `revokedSecurityVersions` |
| dstack/Docker image digest (cloud container) | `container` | `measurements.container` | `requiredMeasurements.container` |
| dstack compose-hash (RTMR3, cloud) | *(gap — see below)* | `measurements.compose` | `requiredMeasurements.compose` |
| NPU firmware + queue-policy digest | `npuFirmware` | `measurements.npuFirmware` | `requiredMeasurements.npuFirmware` |
| GPU firmware / NRAS (cloud H100) | *(gap)* | `measurements.gpuFirmware` | `requiredMeasurements.gpuFirmware` |
| Debug fuse / lifecycle = LOCKED/production | (claim source) | `claims.debugDisabled`, `claims.productionLifecycle` | `requiredClaims.debugDisabled`, `productionLifecycle` |
| Secure-boot verified chain | (claim source) | `claims.secureBoot` | `requiredClaims.secureBoot` |
| MEE active (counter-mode + integrity tree) | (claim source) | `claims.memoryEncrypted` | `requiredClaims.memoryEncrypted` |
| IOMMU/IOPMP default-deny active | (claim source) | `claims.ioProtected` | `requiredClaims.ioProtected` |
| NPU behind IOMMU, private queues, no PMU leak | (claim source) | `claims.npuProtected` | `requiredClaims.npuProtected` |
| Confidential GPU (TDX-bound H100) | (claim source) | `claims.gpuProtected` | `requiredClaims.gpuProtected` |

### 3.1 Gaps found (act on these — especially for confidential AI)

1. **`compose` measurement is not in the OS manifest set.** `TeeEvidence`
   (`tee.ts`) already defines `compose` as a `TeeMeasurementName`, but the OS
   measured-boot contract (`tee-measured-boot-contract.md`) and
   `tee-measurements.example.json` list only `container`, not `compose`. dstack
   binds app identity to the **compose-hash in RTMR3** — without measuring
   `compose` we cannot reproduce dstack's identity binding in our policy. **Add
   `compose` to the OS manifest measurement set and to the example fixture.**
2. **`gpuFirmware` measurement and `gpuProtected` claim are typed but absent from
   the OS contract.** `tee.ts` defines both; the measured-boot contract doc does
   not enumerate `gpuFirmware`. For the cloud H100 confidential-AI lane the GPU
   attestation (NRAS) is *the* thing proving the model runs on a confidential GPU.
   **Add `gpuFirmware` to the OS manifest set + key-release rules.**
3. **No model-weights digest measurement (the central confidential-AI gap).** The
   product's whole point is private model weights, yet there is **no
   `modelWeights` measurement name** in `tee.ts` and no manifest key. The chip
   `confidential-domain.md` attests "model data" abstractly but nothing pins the
   *weights digest*. **Recommendation: add a `modelWeights` (or `weights`)
   `TeeMeasurementName`** so the agent can require the unsealed weights match an
   attested digest — otherwise a swapped/poisoned model passes attestation. This
   is the single most important confidential-AI addition. *(Doc-only
   recommendation here; the code change is for the agent/core lane.)*
4. **`npuProtected` / `productionLifecycle` claims** exist in `tee.ts` and the
   release-policy normalizer (`tee-release-policy.ts`) but are **not in the OS
   contract's `requiredClaims` example** (which lists only `debugDisabled`,
   `secureBoot`, `memoryEncrypted`). For on-device confidential inference,
   `npuProtected` should be a *required* claim. **Add `npuProtected` and
   `ioProtected` to the device-lane required-claims policy.**
5. **Kernel cmdline / system-config measurement (dstack #618, #615).** dstack was
   bitten by an *unmeasured* kernel cmdline that could disable disk encryption.
   Our `boot`/`os` measurements must explicitly cover the kernel command line and
   any security-relevant host-supplied config, or fold them into `boot`. **Make
   the OS measurement generator include cmdline in the `boot`/`os` digest and
   document it.**

These five are the concrete deltas between the typed contract and what
confidential AI actually needs. Items 1, 2, 4 are present in `tee.ts` but missing
from the OS contract doc/fixture (cheap to close); item 3 is a genuine new field;
item 5 is a generator hardening.

## 4. dstack's exact role, per layer × substrate

| Layer | Cloud (TDX + H100) | On-device (RISC-V) |
|---|---|---|
| **Root of trust** | TDX hardware + NRAS (GPU). dstack does **not** root trust; it orchestrates. | **Our OpenTitan-class RoT + DICE.** dstack is *not* the root. |
| **Launch authority** | dstack VMM (after OVMF Config-B, VMM outside TCB) | **M-mode CoVE/AP-TEE TSM.** No untrusted VMM. |
| **Quote producer** | dstack guest-agent (TDX quote, RTMR3 = compose-hash) | TSM (CoVE quote). dstack guest-agent *pattern* may be reused for the socket/API surface, but the TDX-specific path is replaced. |
| **Key derivation** | dstack KMS (deterministic, compose+image+args+env) — pinned per §1.1 | RoT key ladder is root; dstack-style KMS, if used, derives **app-layer** keys only, subordinate to the device DICE key. |
| **Service exposure** | dstack gateway + RA-TLS (Gramine model) | RA-TLS pattern reusable; cert key bound to CoVE measurements. |
| **Image** | meta-dstack (Yocto) reproducible image | elizaOS-Linux reproducible image; `os` digest is our equivalent of MRTD/RTMR0–2. |
| **Hardening required** | Pin `quote_enabled=true` (#609); remove DevMode (#608); forbid `no_tee` (#614); short cert validity (#613); verify live not stale evidence (#612); measure cmdline/config (#615/#618); pin image digest, no host mirror (#616); auth bootstrap/finish (#610/#611); plan for MPC-KMS (root-key SPOF). | All of the above are **moot or build-time-removed** in the appliance model; the device RoT key never leaves the die and never chains to a cloud KMS root. |

## 5. Residual-risk register and fail-closed gate list

### 5.1 Residual risks (carried, not closed)

| ID | Residual | Owner | Disposition |
|---|---|---|---|
| RR1 | Cloud KMS root key is a single point of failure (dstack documents this) | cloud lane | Accept for cloud lane only; never let device unseal key chain to it; track dstack MPC-KMS. |
| RR2 | Attestation verifies *identity*, not *code correctness* (dstack's own caveat) | agent | Pair attestation with the agent's capability/policy layer; an attested-but-buggy agent is RR-app. |
| RR3 | A new single-stepping bypass after a "fixed" detector (TDXdown→TDXploit history; AEX-NStep) | silicon+OS | Primary control is AEX-Notify-style deterministic re-entry, not detection; re-test each campaign. |
| RR4 | Physical decap/microprobe of in-package die-to-die memory | package | Out of scope (threat-model R3); deterred by package + economics. |
| RR5 | Supply-chain substitution of weights/image before measurement | OS+agent | Reproducible images + measured digests + the §3.3 model-weights measurement (once added). |

### 5.2 Fail-closed gate list (stays BLOCKED until evidence)

| Gate / claim | Stays BLOCKED until | Can run today? |
|---|---|---|
| Genuine on-device CoVE quote | CoVE TSM bring-up on FPGA/silicon | no |
| Genuine TDX+GPU quote | real TDX host + H100 + NRAS | no |
| `memoryEncrypted` claim is *true* (MEE counter-mode live) | LPDDR5X MEE in silicon | no |
| `secureBoot`/`debugDisabled` claims are *true* | RoT silicon + fused keys (today: stubs/placeholders) | no |
| dstack issue-list hardening verified in pinned version | pinned dstack build + config audit | partial (config audit can run) |
| `TeeEvidence` normalization + policy verify + key-release logic | — | **yes** (fixtures + unit tests exist) |
| Release-manifest → policy mapping (incl. new `compose`/`gpuFirmware`/`modelWeights` keys) | — | **yes** (schema + fixture work) |
| End-to-end signed-evidence acceptance with a *real* quote | silicon or real TDX | no |

The verifier, normalizer, release-policy mapper, and key-release client are the
parts that are real and testable now; **every link that asserts a hardware
property is BLOCKED by design** until the corresponding FPGA / silicon / real-TDX
transcript exists.

## 6. Sources

- dstack repo + docs (VMM, guest-agent/tappd, KMS, gateway, meta-dstack, RA-TLS):
  https://github.com/Dstack-TEE/dstack ; guest-agent core:
  https://phalanetwork.mintlify.app/docs/concepts/core-guest-agent ; SDK
  (Tappd→Dstack client migration): https://www.npmjs.com/package/@phala/dstack-sdk
- dstack security model / CVM boundaries / best practices:
  https://github.com/Dstack-TEE/dstack/blob/master/docs/security/security-model.md
- zkSecurity audit (OVMF Config A→B, VMM out of TCB): https://phala.com/posts/dstack-completes-security-audit-a-milestone-for-confidential-cloud ; report https://phala.com/dstack/dstack-audit.pdf ; docs https://docs.phala.com/dstack/security-audit
- dstack security issues #608–#619 (KMS attestation bypass, DevMode auth,
  no_tee, unmeasured cmdline, world-readable keys, registry substitution, stale
  evidence, cert validity, unauth bootstrap/finish):
  https://github.com/Dstack-TEE/dstack/issues
- attestation pipeline hardening update: https://phala.com/posts/dstack-security-update-attestation-pipeline-hardening
- dstack zero-trust framework paper: https://arxiv.org/pdf/2509.11555
- RA-TLS / attested TLS background (Gramine model): https://gramine.readthedocs.io/en/stable/attestation.html
- CoVE spec: https://arxiv.org/pdf/2304.06167 ; ACE embedded RISC-V CoVE TSM: https://arxiv.org/html/2505.12995v1
- In-repo contracts: `packages/core/src/types/tee.ts`,
  `packages/agent/src/services/tee-evidence.ts`,
  `packages/agent/src/services/tee-policy.ts`,
  `packages/agent/src/services/tee-release-policy.ts`,
  `packages/agent/src/services/tee-key-release.ts`,
  `packages/os/docs/tee-measured-boot-contract.md`,
  `packages/chip/docs/security/confidential-domain.md`.
