# OTP / eFuse Map

Status: pre-silicon specification. No OTP IP is selected; budgets below
assume a 4 kbit antifuse macro or 8 kbit OTP block on the target node.
Field widths are upper bounds — final allocation is locked when the OTP
vendor and the antifuse macro are selected.

Total budget: 4096 bits. Allocation: 2208 bits assigned, 1888 bits reserved
(includes RMA and future-rotation slots).

## 1. Allocation table

| Offset (bit) | Width (bit) | Field | Programming gate | Read by |
|---|---|---|---|---|
| 0 | 256 | `root_key_hash` (SHA-256 of Ed25519 R.pub) | MFG only; locked once `lifecycle >= MFG` | ROM |
| 256 | 256 | `root_key_hash_alt` (reserved for root rotation) | unlocked until programmed; then locked | ROM |
| 512 | 256 | `debug_auth_pubkey_hash` | MFG only | Debug controller |
| 768 | 8 | `lifecycle_state` (one-hot: BLANK/DEV/MFG/LOCKED/RMA/SCRAP + 2 reserved) | Monotonic; bits OR-only | ROM, debug controller, bootloader |
| 776 | 8 | `debug_disable` (per-port kill switch: jtag/swd/etm/rom_uart + 4 reserved) | Any time | Debug controller |
| 784 | 8 | `revoked_key_bitmap` (8 slots) | LOCKED OTA can program | ROM |
| 792 | 8 | `tamper_counter` (saturating) | Hardware on debug-auth failure | Debug controller |
| 800 | 1 | `rma_wipe_done` | HW on completion of RMA erasure | Debug controller |
| 801 | 1 | `unlocked` (mirror; primary is persistent partition) | Fastboot lock flow | Bootloader |
| 802 | 30 | reserved (alignment) | - | - |
| 832 | 32 | `rollback_bl1` (unary) | Bootloader post-success | ROM, bootloader |
| 864 | 32 | `rollback_bl2` (unary) | BL1 post-success | BL1 |
| 896 | 32 | `rollback_vbmeta` (unary) | BL2 post-success | BL2 |
| 928 | 16 | `rollback_recovery` (unary) | BL2 post-recovery-success | BL2 |
| 944 | 16 | `rollback_vendor_boot` (unary) | BL2 post-success | BL2 |
| 960 | 64 | `rollback_reserved` | - | - |
| 1024 | 96 | `device_uid_parity` (PUF/UID parity; UID itself derived from SRAM PUF) | MFG | ROM, attestation |
| 1120 | 64 | `vendor_id / sku_id` | MFG | bootloader, manufacturing flow |
| 1184 | 32 | `boot_counter` (monotonic, capped) | Each reset (RTC-saturating) | Debug-auth nonce |
| 1216 | 32 | `ota_fail_counter` (saturating) | OTA client | OTA client (rate-limit) |
| 1248 | 256 | `attestation_key_hash` (per-device, optional) | MFG | KeyMint |
| 1504 | 256 | `rma_key_hash` (OEM RMA root key) | MFG | Bootloader |
| 1760 | 256 | reserved RMA / re-key slot 1 | - | - |
| 2016 | 192 | reserved | - | - |
| 2208 | 1888 | reserved (future rotation, vendor extensions, ECC, redundant parity) | - | - |

## 2. Field semantics

### lifecycle_state (one-hot)

Bits OR'd over device lifetime. Reader reports the highest set bit. Only the
following bit transitions are permitted by the write controller; any other
write attempt is silently dropped and the attempt logged in
`tamper_counter`:

```
BLANK(0) -> DEV(1)     allowed
BLANK(0) -> MFG(2)     allowed
MFG(2)   -> LOCKED(3)  allowed
LOCKED(3)-> RMA(4)     allowed iff signed RMA authorization present
*        -> SCRAP(5)   allowed always
```

DEV->MFG, DEV->LOCKED, LOCKED->DEV, RMA->LOCKED, anything->BLANK: forbidden.

### Rollback unary encoding

Each rollback slot stores the index as the number of programmed bits
(`popcount`). This allows monotonic advance without read-modify-write of
multi-bit fields and tolerates partial-fuse-blow events. The unary width
caps the maximum rollback index for that image type; image_type designs
must keep `rollback_index <= width`.

### tamper_counter

8-bit saturating; increments on:

- failed debug-auth signature check
- failed OTP write authorization
- JTAG activity observed in LOCKED state (one increment per boot window)

At 0xFF, device enters tamper-throttled state: 24 h cooldown enforced by
RTC; security gates remain fail-closed.

### debug_disable

Per-port kill switch usable in any lifecycle. Once a bit is set, the
matching port is held disabled until SCRAP. Intended for incident response
("brick the debug port on a fielded device via OTA").

## 3. ECC / parity strategy

- Each security-critical field (root hashes, lifecycle, rollback, debug
  hashes) carries 1-of-N replication: write the field three times in
  separate physical rows; reader uses 2-of-3 majority vote.
- Parity-mismatch read raises a hard fault before any signature check uses
  the value; ROM halts with `HALT: code=OTP_PARITY`.
- Total replication overhead is included in "reserved" budget above.

## 4. Write authorization

OTP writes are gated by an internal controller that requires:

1. Lifecycle precondition (per table above).
2. Signed authorization blob for sensitive transitions (LOCKED->RMA, root
   rotation, revocation bitmap programming).
3. A valid one-time write window opened by ROM during MFG flow, closed on
   first reset after MFG->LOCKED transition.

After LOCKED, writes are restricted to:

- `rollback_*` (advance only)
- `revoked_key_bitmap` (OR-only, signed OTA-bound auth)
- `debug_disable` (OR-only, signed auth)
- `tamper_counter`, `boot_counter`, `ota_fail_counter` (HW-driven)
- `unlocked` mirror (persistent partition flow)
- `rma_wipe_done` (HW on RMA wipe completion)
- `lifecycle SCRAP bit`

## 5. Cross-references

- `boot-image-format.md` §3 key ladder, §4 rollback, §5 lifecycle
- `debug-policy.md` §3 fuse-derived enables
- `key-ceremony.md` §5 board identity programming
- `threat-model.md` mitigations M2, M8, M10
