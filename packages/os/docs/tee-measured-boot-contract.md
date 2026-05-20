# elizaOS TEE Measured Boot Contract

Date: 2026-05-20

This contract defines the release evidence that Linux and AOSP builds must emit
before the agent can request TEE-gated secrets. It is intentionally independent
of one hardware provider so the same policy can cover dstack on TDX, Android
protected VMs, and a future Eliza RISC-V confidential domain.

## Measurement Set

Every TEE-capable OS artifact must publish a signed measurement manifest with:

- `boot`: bootloader, firmware, AVB metadata, or confidential-VM launcher
  digest.
- `os`: kernel, initramfs, root filesystem, system image, vendor image, product
  image, or AOSP super image digest.
- `agent`: agent package, container image, APK, or protected-agent guest digest.
- `policy`: TEE policy JSON digest, including allowed providers, required
  claims, and key-release rules.
- `device`: platform identity class, lifecycle state, and security-version
  source.
- `container`: dstack compose or Docker image digest when the agent runs in a
  confidential container.
- `npuFirmware`: NPU firmware digest when local inference is allowed to handle
  private user data.

The release pipeline must fail closed when any required digest is absent.

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
