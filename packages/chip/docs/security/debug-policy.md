# Debug Authentication Policy

Status: pre-silicon specification. JTAG/SWD gating logic remains a hardware
bring-up requirement.

## 1. Goals

- JTAG/SWD must be the strongest physical surface; gate it per lifecycle state.
- Debug must never be available on a LOCKED device without an authenticated
  unlock signed by an OEM-controlled key.
- Factory wipe and RMA entry must erase all KeyMint/user keys before debug
  becomes accessible.

## 2. Per-lifecycle matrix

| Lifecycle | JTAG TAP | SWD | CoreSight ETM/ETB | Boot ROM UART | Debug-auth required | Key-erasure on debug-enable |
|---|---|---|---|---|---|---|
| BLANK | open | open | open | verbose | no | n/a |
| DEV | open | open | open | verbose | no | no |
| MFG | gated | gated | gated | structured | yes (mfg key) | no |
| LOCKED | disabled | disabled | disabled | halt records only | n/a (must transition to RMA) | yes |
| RMA | gated | gated | gated | structured | yes (RMA key) | yes (on RMA entry) |
| SCRAP | hard-tied low | hard-tied low | hard-tied low | none | n/a | n/a |

"gated" = TAP responds to IDCODE only; functional scan chains held in reset
until debug-authentication challenge succeeds.

## 3. Fuse-based gating logic

The debug controller reads three OTP fields at reset:

1. lifecycle_state (8 fuses, one-hot)
2. debug_auth_pubkey_hash (32 B)
3. debug_disable (8 fuses) — sticky per-port

Derived enable signals are combinational from these fuses; NOT software-writable.

```
jtag_enable     = (state==DEV)
               | (state==BLANK)
               | ((state==MFG | state==RMA) & debug_auth_valid)
swd_enable      = jtag_enable
etm_enable      = jtag_enable
rom_uart_full   = (state==DEV) | (state==BLANK)
```

If debug_disable[port] is programmed, that port is forced disabled regardless
of state (one-way kill switch for incident response).

## 4. Debug-authentication challenge

Used in MFG and RMA states.

1. Debugger asserts TRST and reads device_uid (96 bits) and a 128-bit
   ROM-generated nonce from IDCODE-adjacent scan registers.
2. Debugger constructs msg = "OPDBGv1" || device_uid || nonce || requested_caps.
3. Debugger signs msg with Ed25519 key whose pubkey hashes to
   OTP.debug_auth_pubkey_hash.
4. On-chip verifier checks signature; on success, releases debug_auth_valid
   for one boot cycle.
5. requested_caps may restrict access; on-chip controller enforces the
   minimum of granted and requested.

Nonce includes boot_counter to prevent cross-power-cycle replay.

## 5. LOCKED -> RMA transition

LOCKED devices cannot be debugged directly.

1. Service tool issues `oem rma-request` over fastboot with OEM-signed
   authorization for the specific device UID.
2. Bootloader verifies authorization, programs the RMA lifecycle bit.
3. Programming RMA fuse triggers hardware-driven erasure of:
   - All keyslots in KeyMint TEE storage.
   - User-data encryption key wrapping material.
   - Persistent attestation key blobs.
4. Erasure must complete before next reset re-enables JTAG; `rma_wipe_done`
   fuse recorded for idempotence.
5. Only after rma_wipe_done == 1 does debug_auth_valid become satisfiable.

There is no "service unlock" that preserves user data.

## 6. Factory wipe / fastboot unlock (user-initiated)

A user on a LOCKED device may invoke `fastboot oem unlock`:

- Requires "OEM unlocking allowed" toggle in Settings (signed userdata flag).
- On confirmation, bootloader sets `unlocked` flag, erases all KeyMint keys
  and user data, then reboots.
- Device remains LOCKED in lifecycle sense (no JTAG); accepts user-signed
  boot images. Verified-boot state reported as ORANGE per AVB convention.
- Re-locking (`fastboot oem lock`) requires another full wipe.

## 7. Halt and tamper logging

Any failed debug-auth attempt increments a saturating 8-bit counter in OTP.
After 16 failures, device emits tamper log entry and refuses further auth
attempts for 24 h (RTC-gated). A LOCKED device observing JTAG activity logs
a halt record but otherwise ignores it.

## 8. Cross-references

- `threat-model.md` mitigations M7, M8, M12
- `boot-image-format.md` §5 lifecycle states
- `otp-fuse-map.md` debug fuse allocation
- `test-plan.md` cases TC-DEBUG-*
