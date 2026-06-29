# Confidential compute: host verdict and routing

This doc records the verified verdict for **where confidential (memory-encrypted,
hardware-attested) workloads run** in the elizaOS Cloud stack, so nobody assumes
the Hetzner control/data plane can host them.

## Verdict: Hetzner ships no managed confidential-compute product

Hetzner Cloud offers **no SEV-SNP, no TDX, no memory-encryption, and no remote
attestation** product. There is no Hetzner-managed confidential-VM SKU, no
attestation service, and no enclave primitive to target.

This is verifiable against the IaC in this repo. Grepping the entire Hetzner
Terraform tree returns **zero hits** for every confidential-compute keyword:

```bash
grep -rniE 'confidential|sev|snp|tdx|attestation|enclave' \
  packages/cloud/infra/cloud/terraform/hetzner/
# → 0 matches
```

The strongest isolation any Hetzner server type in this repo provides is the
**dedicated-vCPU `ccx`** line (e.g. `ccx23` = 4 dedicated vCPU / 16 GB, used for
the apps data-plane that runs untrusted user containers; see
[`apps-data-plane/variables.tf`](./terraform/hetzner/apps-data-plane/variables.tf)).
Dedicated vCPU means **dedicated physical cores** — no CPU steal from noisy
neighbors, which reduces (does not eliminate) cross-tenant timing side-channel
exposure. It is **scheduling isolation, not cryptographic isolation**:

- RAM is **not** encrypted against the host/hypervisor. A compromised or
  malicious host can read guest memory in cleartext.
- There is **no measured launch and no attestation quote** — nothing proves to a
  remote party which code/firmware/policy actually booted.

`ccx23` is therefore the right choice for "don't let other tenants steal my CPU,"
and the wrong choice for "the cloud operator must be unable to read my model
weights, prompts, KV-cache, or signing keys." Confidential compute requires
**hardware memory encryption plus remote attestation** — AMD **SEV-SNP** or Intel
**TDX** at the CPU level (and, for confidential GPU inference, NVIDIA H100
confidential computing). Hetzner provides none of these.

## Where confidential workloads route: Phala dStack CVM (Intel TDX)

Confidential workloads route to **Phala dStack Confidential VMs on Intel TDX**,
**not** to Hetzner:

- **Deploy as-is.** dStack runs an existing `docker-compose.yml` inside a TDX
  CVM with no app rewrite — the same compose this stack already produces.
- **Built-in remote attestation.** The CVM emits a TDX quote that binds the
  **image hash, launch arguments, and environment** of what actually booted, so a
  remote verifier can confirm the measured workload before trusting it.
- **KMS-in-TEE, attestation-gated.** dStack's decentralized KMS **verifies the
  TDX quote before releasing** deterministic, per-app keys. Keys are released
  *only* against a quote that matches the expected measurements — fail-closed by
  data unavailability, not by a software check that could be patched out.
- **Optional confidential GPU.** For GPU inference, dStack supports an NVIDIA
  confidential-GPU (H100 CC) path so weights/activations stay encrypted on the
  GPU as well.

These are the exact hardware properties Hetzner lacks: **SEV-SNP / TDX hardware
attestation** (measured launch + signed quote + memory encryption) is the
non-negotiable requirement for confidential compute, and only the TDX platform
under dStack satisfies it here.

## Division of responsibility

| Plane | Runs on | Confidential? |
| --- | --- | --- |
| Control plane (orchestrator, routing, monitoring) | Hetzner `cpx`/`ccx` VMs | No — non-confidential by design |
| Data plane (agent sandboxes, app workers) | Hetzner `cpx`/`ccx` VMs | No — dedicated vCPU isolation only |
| Confidential workloads (sealed weights, attested key release, private inference) | **Phala dStack CVM (Intel TDX)** | **Yes — hardware attestation + memory encryption** |

Hetzner stays the **non-confidential control/data plane**. Anything that needs
the operator to be unable to read in-domain secrets routes to dStack TDX.

## Agent-side trust contract

The agent never trusts a workload as "confidential" because of where it runs. The
provider-neutral evidence + trust-decision contract is enforced in code:

- `packages/agent/src/services/tee-evidence.ts` — normalized `TeeEvidence` shape.
- `packages/agent/src/services/tee-policy.ts` — `evaluateTeeEvidencePolicy`, the
  single fail-closed trust-decision path (kind/provider allowlist, measurement
  match, security-version floor, nonce + freshness, required claims).
- `packages/agent/src/services/tee-boot-gate.ts` — boots fail-closed: no trusted
  evidence ⇒ no model-key release, no signing, no remote-plugin sync.

**Not yet hardware-verified (BLOCKED on hardware):** real TDX quote-signature /
RTMR / `report_data` verification, the dStack guest agent, RA-TLS KMS, and H100
GPU attestation are not implemented here and stay BLOCKED. Until they land the
agent verifies a *signed evidence document*, not a hardware quote, and must not
claim hardware-verified trust. See
[`packages/agent/docs/tee-agent-implementation-plan.md`](../../../agent/docs/tee-agent-implementation-plan.md)
Phase B/C for the blocked items and their hardware dependencies.
