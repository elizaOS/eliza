# 06a — In-Domain Attestation Agent Specification

Date: 2026-05-22
Status: buildable-now design spec (no boot/FPGA/silicon evidence). The agent
described here is the in-domain software that collects measurements and emits the
CoVE quote; its **runtime** is BLOCKED on the confidential-boot smoke (06 WI-6)
and the RoT key ceremony (lane 02). This document specifies the contract; it is
not implementation evidence.

This is the WI-4 companion to [`06-os-on-tee-software.md`](06-os-on-tee-software.md)
§3. It specifies the attestation agent that runs **inside** the confidential
domain: how it collects the measurement set, how it requests a signed CoVE quote
from the M-mode TSM, and how it publishes the resulting `TeeEvidence` to the
elizaOS verifier/key-release client via `ELIZA_TEE_EVIDENCE_PATH`.

Cross-references (authoritative, do not duplicate):

- The canonical evidence type is `TeeEvidence` in
  `packages/agent/src/services/tee-evidence.ts`; the verifier is
  `evaluateTeeEvidencePolicy` in `tee-policy.ts`. This spec does not redefine
  them; it specifies how the in-domain agent populates them.
- The measurement-source map is `docs/spec-db/tee-measured-launch-map.json`
  (06 WI-1) — every field below names its producing stage there.
- The folding model is `scripts/tee/teeevidence_quote.py` (C5); the signed
  on-device producer is the M-mode TSM firmware `fw/dice/cove_quote.c`, mirrored
  byte-exact and gated by `scripts/check_cove_quote.py` (owned elsewhere).

---

## 1. Position in the trust boundary

The attestation agent is an in-domain (VS/VU) userspace process. It is **trusted
relative to the host** (it runs inside the measured TVM) but is **not** part of
the M-mode TCB: it cannot fabricate a measurement and it cannot sign. Its only
privileged operation is the TSM `get-attestation` call, which returns a quote
signed by a key the agent never sees. This keeps signing in the TSM/RoT and lets
the agent be a normal, restartable guest process.

```
in-domain (measured TVM)                         M-mode TCB
  attestation agent                                TSM (CoVE security manager)
    - reads runtime measurement log  ── get-attestation(reportData) ──▶  measurement context
    - assembles TeeEvidence          ◀── signed CoVE quote (DICE cert) ──   + RoT DICE key (lane 02)
    - writes ELIZA_TEE_EVIDENCE_PATH
    - serves RA-TLS (epk in cert)
```

## 2. Measurement collection

The agent does **not** measure boot/monitor/os/policy/device itself — those are
folded by the RoT and the TSM at launch (see the measured-launch map). The agent
is responsible only for the **runtime-extended** measurements:

- `measurements.agent` — SHA-256 of the elizaOS agent image at first run. The
  agent hashes its own loaded image (and, for a containerized deploy, the
  `container`/`compose` bytes) and extends a runtime measurement log. The
  extend is `H(prev || H(segment))`, identical to
  `teeevidence_quote.extend()`.
- `measurements.npuFirmware` — when private inference is enabled, the NPU runtime
  hashes the loaded NPU firmware concatenated with the queue-policy blob
  (`sha256(npu_firmware || npu_queue_policy)`) **before** taking private-queue
  ownership; the agent reads that digest from the NPU runtime.
- `measurements.modelWeights` — when the unseal path binds the weights digest,
  the in-domain runtime supplies `sha256(weights_plaintext)`.

The launch-time measurements (`boot`, `monitor`, `os`, `policy`, `device`) are
read by the agent from the TSM measurement context; the agent copies them into
the `TeeEvidence.measurements` object verbatim. It never recomputes them (it
cannot — the measured pages are launch-frozen).

## 3. Quote request (`reportData` binding)

For each verifier challenge the agent:

1. Receives the verifier `nonce`.
2. Generates an ephemeral keypair `(esk, epk)` for the RA-TLS channel.
3. Computes `reportData = sha256(nonce || epk)` (matching
   `teeevidence_quote.report_data()`), so the quote is bound to both the
   challenge and the live channel and is non-replayable.
4. Calls the TSM `get-attestation(reportData)`. The TSM returns a CoVE quote
   signed by the RoT-derived DICE Alias key, with the DICE cert chain.

The agent MUST refuse to serve evidence whose `reportData` does not equal
`sha256(nonce || epk)` for the channel it is currently negotiating — a mismatch
means the quote is stale or for a different channel and is rejected before it
ever reaches the verifier.

## 4. `TeeEvidence` assembly

The agent assembles exactly the `TeeEvidence` shape:

- `kind: "cove"` (shape-A fallback `"eliza-vault"`/`"keystone"` only when the
  TSM reports a non-CoVE launch).
- `provider: "eliza-riscv"`, `hardwareVendor: "eliza"`, `platformVersion`
  from the RoT ROM/lifecycle version.
- `securityVersion` from the RoT rollback counter.
- `measurements` = launch set (from the TSM context) + runtime set (§2).
- `freshness = { nonce, timestamp (RFC3339), verifier }`. Default
  `verifier = "eliza-local-verifier"` (local-first; §3.3 of doc 06).
- `claims` copied from the TSM-reported launch conditions: a claim is true only
  when the owning component asserts it (the agent cannot set a claim true on its
  own).
- `quote` = base64 CoVE evidence; `certificatePem` = DICE Alias cert chain;
  `reportData` from §3.

The assembled object MUST pass `scripts/check_tee_attestation_evidence.py`
(which mirrors `normalizeTeeEvidence`), including the rule that a true
`claims.npuProtected` requires the `monitor` and `npuFirmware` measurements.

## 5. Publication: `ELIZA_TEE_EVIDENCE_PATH`

The agent writes the canonical-JSON `TeeEvidence` to the path named by the
`ELIZA_TEE_EVIDENCE_PATH` environment variable (the same variable the elizaOS
agent's `DstackTeeProvider` / `tee-key-release` client reads). The write is
atomic (write-temp + rename) so a reader never sees a partial document. The file
lives on the in-domain private volume; it is regenerated on each verifier
challenge (the `freshness.nonce`/`timestamp` differ per challenge) and is never
written to a shared/host-visible page.

The elizaOS key-release client then runs `evaluateTeeEvidencePolicy(evidence,
policy)` with the shipped per-topology policy (`sw/confidential/policy/*.json`,
06 WI-5). On `trusted`, the KMS releases the data-encryption key wrapped to
`epk`; the agent unseals weights/user data. On any non-`allowed` reason the key
is withheld and the private volume stays sealed — the negative path is enforced
by data unavailability, not a software flag.

## 6. Failure modes (fail-closed)

- TSM `get-attestation` failure → the agent emits **no** evidence file; the
  key-release client sees `missing-evidence` and refuses to unseal.
- `reportData` mismatch → evidence is not served (§3).
- Measurement-log read failure → the agent aborts; it never substitutes a
  default or zero digest for a missing measurement.
- Restart → the agent re-reads the launch measurements from the TSM context and
  re-derives the runtime measurements; it does not cache a prior quote across a
  new challenge.

## 7. Buildable-now vs BLOCKED

| Surface | Buildable now | Blocked on |
| --- | --- | --- |
| `TeeEvidence` assembly + `reportData` binding model | YES (`scripts/tee/teeevidence_quote.py`, C5) | — |
| Evidence validates against the agent shape | YES (`check_tee_attestation_evidence.py`) | — |
| Signed CoVE quote from a real TSM | NO | M-mode CoVE TSM (06 WI-6) + RoT DICE key (lane 02) |
| `ELIZA_TEE_EVIDENCE_PATH` end-to-end unseal | NO | confidential-boot smoke (06 WI-6) |
