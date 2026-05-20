# Protected Agent VM Plan

Date: 2026-05-20

This plan is the macOS-feasible OS bridge between the agent-level TEE provider
and future bare-metal Linux/AOSP validation. It does not claim that the host OS
is confidential. It defines the protected lane that will later run under dstack,
AVF/pKVM, CoVE, or an Eliza chip confidential domain.

## Runtime Shape

```text
host elizaOS / AOSP
  |
  | binder, vsock, or local HTTPS capability bridge
  v
protected guest / CVM
  |
  | agent container, local model runtime, remote capability server
  v
TEE evidence provider + key-release client
```

The host may provide UI, networking, storage brokering, and update orchestration.
The protected guest owns agent secrets, signing keys, decrypted model keys, and
private tool output.

## Host-to-Guest Contract

Allowed calls:

- `plugin.modules.list`
- approved remote plugin action/provider/evaluator calls
- file reads/writes only under assigned workspace paths
- terminal execution only when the TEE policy allows the endpoint
- signing requests through `RemoteSigningService`

Denied by default:

- host filesystem escape
- raw device access
- unmeasured plugin loading
- unsigned policy mutation
- secret export to host logs, env dumps, crash reports, or analytics

## macOS Validation Scope

Can validate now:

- agent TEE evidence parsing and policy tests
- dstack/mock evidence collection from JSON or HTTP
- remote endpoint fail-closed behavior before plugin sync
- release manifest generation and schema checks
- local mock protected-agent capability server

Deferred to Linux or Android hardware:

- real dstack CVM launch
- Intel TDX/AMD SEV-SNP quote verification
- NVIDIA confidential GPU attestation
- Android AVF/pKVM protected VM boot
- IOMMU/IOPMP or NPU DMA isolation

## Implementation Gates

- Agent must refuse high-value secrets when `ELIZA_TEE_REQUIRED=true` and no
  trusted evidence is present.
- Protected-agent endpoint registration must bind to an expected agent image
  digest and policy digest.
- Linux/AOSP release manifests must carry the same digest values used by the
  agent TEE policy.
- Debug/dev evidence must be accepted only by explicit development policies and
  never by production key-release policies.
