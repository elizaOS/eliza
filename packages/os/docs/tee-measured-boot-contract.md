# elizaOS TEE Measured Boot Contract

Date: 2026-05-20

This contract defines the release evidence that Linux and AOSP builds must emit
before the agent can request TEE-gated secrets. It is intentionally independent
of one hardware provider so the same policy can cover dstack on TDX, Android
protected VMs, and a future Eliza RISC-V confidential domain.

## Measurement Set

Every TEE-capable OS artifact must publish a signed measurement manifest with:

Required (always present in a TEE-capable measurement set):

- `boot`: bootloader, firmware, AVB metadata, or confidential-VM launcher
  digest.
- `os`: kernel, initramfs, root filesystem, system image, vendor image, product
  image, or AOSP super image digest.
- `agent`: agent package, container image, APK, or protected-agent guest digest.
- `policy`: TEE policy JSON digest, including allowed providers, required
  claims, and key-release rules.

Optional (present per substrate / capability):

- `device`: platform identity class, lifecycle state, and security-version
  source.
- `container`: agent container image digest when the agent runs in a
  confidential container.
- `compose`: dstack `app-compose.json` / `docker-compose.yaml` digest measured
  into RTMR3 (cloud TDX) or the in-domain compose blob (E1).
- `monitor`: tiny-TCB monitor digest — the TDX module / SEAM measurement on
  cloud, the M-mode TSM / security-manager measurement on E1.
- `gpuFirmware`: confidential-GPU firmware/attestation-report digest (NVIDIA
  H100/Blackwell) when weights run on a confidential GPU.
- `npuFirmware`: NPU firmware + queue-policy digest when on-device inference is
  allowed to handle private user data.
- `modelWeights`: golden digest of the local model weights bound into the
  measured image for on-device inference.

These names mirror the agent's canonical `TeeMeasurementName` union
(`packages/agent/src/services/tee-evidence.ts`); `modelWeights` and `monitor`
are OS-side additions accepted by the agent's open `(string & {})` fallback. The
agent lane owns the TS type; the OS lane owns this schema/fixture/contract.

The release pipeline must fail closed when any required digest is absent.

When any inference-bearing measurement (`gpuFirmware`, `npuFirmware`,
`modelWeights`) is declared, the manifest MUST also assert
`requiredClaims.npuProtected = true` and `requiredClaims.ioProtected = true`;
`validate-tee-measurements.mjs` / `validate-release-manifest.mjs` fail closed
otherwise.

## Evidence Format

The OS release manifest must include:

```json
{
  "tee": {
    "enabled": true,
    "policyDigest": "sha256:<hex>",
    "measurements": {
      "boot": "sha256:<hex>",
      "os": "sha256:<hex>",
      "agent": "sha256:<hex>",
      "policy": "sha256:<hex>"
    },
    "requiredClaims": {
      "debugDisabled": true,
      "secureBoot": true,
      "memoryEncrypted": true
    },
    "providers": ["dstack", "tdx", "cove", "eliza-vault"]
  }
}
```

Provider-specific quotes may carry stronger fields, but the agent only consumes
the normalized `TeeEvidence` shape from `packages/agent/src/services/tee-evidence.ts`.

## Linux Path

The Linux live image must add a protected-agent profile:

1. Build the root filesystem with a dstack/protected-agent guest package.
2. Generate an image manifest for kernel, initramfs, rootfs, agent container,
   policy, and NPU firmware.
3. Sign the manifest with the release key.
4. Install the manifest at `/usr/share/elizaos/tee/measurements.json`.
5. Expose the active evidence through either:
   - `ELIZA_TEE_EVIDENCE_PATH=/run/elizaos/tee/evidence.json`
   - `ELIZA_TEE_EVIDENCE_URL=http://127.0.0.1:<port>/tee/evidence`

On macOS, only manifest generation and schema validation are expected. Booting
the image and collecting a real hardware quote is deferred to Linux hardware.

## AOSP Path

The AOSP image must add a protected-agent profile:

1. Include the TEE policy manifest in `/product/etc/eliza/tee-policy.json`.
2. Include the release measurement manifest in
   `/product/etc/eliza/tee-measurements.json`.
3. Gate privileged protected-agent binder/vsock access through sepolicy.
4. Export pVM or secure-service quote evidence to the agent through a privileged
   local service.
5. Keep Play/cloud builds stripped of protected-agent privileged controls.

Cuttlefish can validate packaging and service registration on macOS-adjacent CI.
Real pKVM/AVF quote validation is deferred to supported Android/Linux hosts.

## Key Release Rules

Key release is allowed only when:

- Evidence kind is in the release policy allowlist.
- Freshness nonce matches the verifier challenge.
- Timestamp is within the verifier freshness window.
- `debugDisabled`, `secureBoot`, and required memory/I/O claims match policy.
- `agent` and `policy` measurements match the release manifest.
- Rollback/security version meets the minimum allowed version.

Missing, stale, debug, or mismatched evidence must block plugin sync, signing,
model key release, and high-value capability calls.

## Runtime Evidence Bridge

The in-domain bridge transforms the platform quote into the normalized
`TeeEvidence` document consumed by
`packages/agent/src/services/dstack-tee-provider.ts`. It is exposed through:

- `ELIZA_TEE_EVIDENCE_PATH=/run/elizaos/tee/evidence.json`, or
- `ELIZA_TEE_EVIDENCE_URL=http://127.0.0.1:<port>/tee/evidence`.

`packages/os/scripts/tee-evidence-bridge.mjs` produces this document. On real
hardware it parses MRTD/RTMR0–3 (TDX) or the DICE-folded CoVE measurements (E1);
**that hardware path is BLOCKED** — see the gate below. Until then it emits MOCK
fixtures (`packages/os/release/schema/tee-evidence.mock.json` and
`tee-evidence.tampered.mock.json`) bound to the golden measurement manifest so
the agent provider can be exercised locally. The bridge fails closed if any
runtime measurement does not equal the signed golden
`tee-measurements.json`.

> **Gate `tdx-cvm-boot-smoke` / `confidential-gpu-attest` (BLOCKED):** real quote
> collection needs a 4th/5th-gen Xeon TDX host (and a CC-GPU host for
> `gpuFirmware`). Proving command, once a host exists:
> `node packages/os/scripts/tee-evidence-bridge.mjs --quote-source tappd --socket /var/run/dstack.sock`.

## dstack Hardening Pins

Before dstack is trusted in a high-assurance stack it must be pinned/hardened per
`packages/os/linux/confidential/dstack-pins.json` (the data form of the plan
§2.3 table): a pinned post-Feb-2026 release, DevMode and dev-KMS forbidden,
mandatory QE-identity + TCB-status enforcement, TLS verification ON, no
client-controlled PCCS URL, and an on-chain `AppAuth` code-hash allowlist. The
root of trust is the platform RoT + our signed golden measurements, never dstack
alone. Open upstream tracking: issues **#608** and **#609**.
