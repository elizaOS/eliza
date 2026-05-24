# 06b — NPU Private-Queue Attestation Contract

Date: 2026-05-22
Status: buildable-now contract spec. The RTL it binds (the NPU secure-I/O
re-home and the private-queue ownership FSM) is **BLOCKED** on lane 03; this
document specifies the contract those gates must satisfy. It is not silicon
evidence.

This is the WI-7 companion to [`06-os-on-tee-software.md`](06-os-on-tee-software.md)
§6 and to [`07-hardware-implementation-plan.md`](07-hardware-implementation-plan.md)
§4 Phase D (IO11–IO13). It defines the binding between the NPU as confidential
I/O and the `TeeEvidence` attestation that lets the agent release the model key
for private inference.

Cross-references:

- `claims.npuProtected` and `measurements.npuFirmware` in
  `packages/agent/src/services/tee-evidence.ts`; the unseal gate
  `assertNpuPrivateInferenceAllowed('local')` in `tee-confidential-inference.ts`.
- The measured-launch map entry for `npuFirmware`
  (`docs/spec-db/tee-measured-launch-map.json`, lane 03 source).
- The IOPMP source-ID policy `docs/spec-db/tee-iopmp-source-id-map.json` and
  `check_tee_iopmp_policy.py`.

---

## 1. What `npuProtected` must mean

`claims.npuProtected === true` is a load-bearing claim: the agent's unseal seam
refuses to release the `model-key` for local private inference unless the policy
gates both `npuProtected === true` and a non-empty `npuFirmware` golden digest
(`assertNpuPrivateInferenceAllowed`). The claim is therefore only allowed to be
true when **all** of the following hold at quote time:

1. **NPU firmware + queue policy measured.** The NPU runtime computed
   `measurements.npuFirmware = sha256(npu_firmware || npu_queue_policy)` before
   the NPU took ownership of any private queue (lane 03 IO12).
2. **Private-queue ownership held.** The NPU queue-owner FSM is in
   `assigned(domainX)` for the requesting domain: `unowned → measuring →
   assigned → draining → scrubbing → unowned`. Doorbell, descriptor, and tensor
   memory are gated by the current owner.
3. **Counter guard active.** `PERF_CYCLES`/`PERF_MACS`/`PERF_FALLBACKS` and any
   timing-observable status are monitor-only while owned-private (no host
   counter leakage; the H100 CC-On model), per IO13.
4. **Traffic traverses IOMMU + IOPMP.** NPU DRAM traffic is re-homed off the
   AXI-Lite lite path onto an IOMMU upstream port with the NPU source ID; the
   IOPMP source-ID policy for that ID is installed (`device-assigned` page state
   is legal only after the policy is installed).

A quote that claims `npuProtected` without `monitor` and `npuFirmware`
measurements is rejected by `check_tee_attestation_evidence.py` — this contract
makes the measurement requirement a hard precondition of the claim.

## 2. Page-state binding

NPU private inference uses the `device-assigned` page state from the
confidential-domain contract. The legal sequence is:

```
private ──assign-dev(npu_srcID, iopmp_policy)──▶ device-assigned
device-assigned ──revoke / teardown / fault──▶ scrub-pending ──scrub-done──▶ free
```

`private → device-assigned` is legal **only** after the IOPMP policy for the NPU
source ID is installed (enforced by the lane-01 page-state machine). On teardown
or fault the NPU is drained (via the queue `BARRIER`), the DC + IOPMP region are
revoked, and the pages go to `scrub-pending` until zeroized. There is no path
from `device-assigned` back to `private` that skips a scrub.

## 3. Measurement freshness

`measurements.npuFirmware` is measured **once per ownership grant**, before the
FSM leaves `measuring`. If the NPU firmware or queue policy is reloaded, the FSM
returns to `unowned` and re-measures; a stale digest can never accompany a new
ownership grant. The digest is read by the in-domain attestation agent (06a §2)
and copied into the quote.

## 4. Buildable-now vs BLOCKED

| Surface | Buildable now | Blocked on |
| --- | --- | --- |
| `npuFirmware` folding + `npuProtected` precondition | YES (`teeevidence_quote.py` + `check_tee_attestation_evidence.py`) | — |
| Unseal gate demands `npuProtected` + `npuFirmware` | YES (agent `assertNpuPrivateInferenceAllowed`; chip side `check_tee_topology_policy.py`) | — |
| NPU re-homed behind IOMMU as confidential I/O | NO | `rtl/npu/e1_npu_secure_io.sv` (IO11) |
| Private-queue ownership FSM + counter guard | NO | `rtl/npu/e1_npu_queue_owner.sv` (IO12) + `e1_npu_counter_guard.sv` (IO13) |
| `tee-npu-private-queue-attest` gate | BLOCKED | lane 03 secure-I/O cocotb (`cocotb-npu-secure-io`) |

The RTL gates above stay explicitly BLOCKED; this contract is the spec they must
satisfy when they land.
