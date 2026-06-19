# Secure Boot and Lifecycle Evidence

Status: development secure-boot prototype — host and simulation evidence
complete; production (silicon) secure boot is not claimed (see Non-Claims).

The repository now implements the OPNPHN01 secure-boot chain in firmware and
RTL with reproducible host/simulation evidence: a constant-time mask-ROM
verifier, a one-hot lifecycle controller, an OTP controller model, a DICE
measurement chain, ATE provisioning + readback, and negative-evidence
rejection transcripts. Production secure boot still depends on silicon — the
OTP macro, the OpenTitan crypto blocks, and on-die entropy — and is not
asserted from this evidence.

## Current Evidence

| Surface | Local evidence | Security result |
|---|---|---|
| Mask-ROM verifier | `fw/boot-rom/secure/{verify,ed25519_ct,sha256,measure}.c`; host KATs `fw/boot-rom/secure/tests/`; `fw/pmc/src/secure_boot.c` | Constant-time Ed25519 + SHA-256 OPNPHN01 verifier; distinct fail-closed halt code per reject path. |
| Secure-boot negative evidence | `tests/security/negative/` (`secure-boot-negative-evidence-check`) | Reproducible rejection transcripts: unsigned, tampered payload, wrong key, corrupt header, rollback downgrade, revoked key, lifecycle-below-min, debug-locked unlock denial. |
| Lifecycle state | `rtl/security/lc/e1_lc_ctrl.sv` + `verify/cocotb/test_e1_lc_ctrl.py` (`security-lifecycle-scope-check`) | One-hot BLANK/DEV/MFG/LOCKED/RMA/SCRAP; permitted-transition enforcement + signed debug-auth; sim-verified. Silicon lifecycle controller integration tracked in rot-integration-check. |
| eFuse/OTP | `rtl/security/otp/e1_otp_map.sv` + `fw/provisioning/e1_provision.py` (`otp-rtl-check`, `provisioning-readback-check`) | 2-of-3 majority read, write-auth controller, parity-fault halt; provisioning + readback model. Silicon OTP macro BLOCKED. |
| Root key material / DICE | `fw/dice/cdi.c`; `docs/sw/security/dice-chain.md` (`dice-measurement-chain-check`) | UDS->CDI ladder, DeviceID/Alias key derivation, KAT-validated. UDS silicon entropy (SRAM PUF / keymgr) BLOCKED. |
| Rollback protection | OTP unary rollback slots in `e1_otp_map.sv` + verifier rollback check | Advance-only monotonic counters; verifier rejects downgrade (negative evidence above). |
| Debug authentication | `e1_lc_ctrl.sv` signed challenge-response (RoT-verified Ed25519, no XOR) | Lifecycle-gated; LOCKED denies direct debug; sim-verified. RoT crypto binding tracked in rot-integration-check. |
| RoT integration spine | `rtl/security/rot/e1_rot_top.sv` (`rot-integration-check`) | Ibex + OTP + lifecycle + mailbox + reset-sequencer elaborate and test clean. OpenTitan crypto-block integration BLOCKED (named missing dependency). |

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
enforcement from this host/simulation prototype. The verifier, lifecycle, OTP,
DICE, and rollback logic above are development evidence only; production secure
boot requires silicon (the OTP macro, the OpenTitan crypto blocks, and on-die
entropy) and the manufacturing key ceremony (`key-ceremony.md`). Android AVB
enforcement is not yet implemented.
