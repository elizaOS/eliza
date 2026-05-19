# Secure Boot and Lifecycle Evidence

Status: BLOCKED for production secure boot.

This repository currently contains a e1-chip identity ROM, not a secure boot
implementation. The ROM exposes the platform contract words `OPSO`, `CHIP`,
contract version `1`, and a boot-vector placeholder. It has no firmware
authentication or lifecycle enforcement.

## Current Evidence

| Surface | Local evidence | Security result |
|---|---|---|
| Boot ROM identity words | `rtl/bootrom/e1_bootrom.sv` and platform-contract checks | Contract ROM only; not a trust anchor. |
| Boot ROM write behavior | `verify/cocotb/test_e1_lifecycle.py` writes ROM offsets and verifies reads stay fixed | Negative evidence that the current ROM is immutable through the MMIO path. |
| Lifecycle state | No lifecycle RTL, registers, pins, or reset straps | BLOCKED. |
| eFuse/OTP | No fuse macro, fuse shadow registers, or provisioning flow | BLOCKED. |
| Root key material | No key hash, public key, certificate chain, or device-unique key source | BLOCKED. |
| Image authentication | No ROM hash parser, signature verifier, manifest parser, or fail-closed branch | BLOCKED. |
| Rollback protection | No monotonic counter, version fuse, RPMB, or anti-rollback policy | BLOCKED. |
| Debug authentication | Package debug bridge is a bring-up bus master; no lifecycle-gated authentication | BLOCKED for production debug lock. |

## Required Evidence Before Any Secure-Boot Claim

The first claim may only be "development secure boot prototype" after all of
these artifacts exist and are locally reproducible:

- ROM source or ROM image hash with a deterministic build log.
- Machine-readable ROM manifest format covering load address, length, image
  version, hash algorithm, signature algorithm, and key identifier.
- Signature verification implementation and negative tests for corrupted image,
  corrupted signature, wrong key, unsupported algorithm, truncated manifest, and
  rollback version.
- Fail-closed boot behavior proving unauthenticated images cannot transfer
  control to the application CPU.
- Lifecycle state encoding with reset behavior for at least raw, development,
  production, RMA, and invalid states.
- eFuse/OTP model or silicon macro integration evidence, including default
  erased values, programmed values, read visibility, write lock, and redundancy
  or error handling policy.
- Root key provisioning procedure, key ceremony record, custody roles, and test
  vectors using non-production keys.
- Authenticated debug policy showing which lifecycle states permit debug, which
  secrets are scrubbed, and which unlock tokens are accepted or rejected.
- Formal or simulation evidence that lifecycle-invalid encodings fail closed.
- Documentation that explicitly separates development/test keys from production
  keys.

## Non-Claims

Do not claim production secure boot, verified boot, device identity,
hardware-backed key storage, secure debug, anti-rollback, or Android AVB
enforcement from the current RTL. Those are future requirements, not present
features.
