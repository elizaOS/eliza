# Boot ROM specification

Status: spec for the v0 boot ROM that lives in `rtl/bootrom/` and `fw/boot-rom/`.
The current `rtl/bootrom/e1_bootrom.sv` is an identity/contract ROM; this
document specifies the executable replacement and the OTP, secure-boot, debug,
and OpenSBI hand-off contracts around it. Until the executable ROM is wired to
the production CPU wrapper, treat this document as the contract that any change
to either side must keep stable.

## Reset vector

| Item | Value |
| --- | --- |
| Architectural reset PC | `0x0000_1000` |
| ROM aperture | `0x0000_0000 .. 0x0000_FFFF` (64 KiB, read-only) |
| ROM word width | 32 bits, little-endian |
| First instruction | `_reset` symbol in `fw/boot-rom/reset.S` (RV64 `csrr t0, mhartid`) |
| Reset state | `mstatus.MIE=0`, `mie=0`, `mip=0`, `pmpcfg0=0`, `satp=0`, hart 0 only released |

The ROM aperture mirrors the Rocket BootROM aperture default so the Chipyard
generator can be pointed at this binary unmodified via
`BootROMParams.contentFileName` and `BootROMParams.address = 0x10000` truncated
to the Eliza reset vector.

`reset_pc` exported by the CPU wrapper **must** equal `0x0000_1000`. Any
divergence is a release blocker.

## OTP / fuse layout

The OTP block is fail-closed: any read that crosses a locked region returns
zeros, and any unwritten word reads as all-ones (`0xFFFF_FFFF`). The boot ROM
treats all-ones as "not provisioned" and falls back to the development policy
(debug allowed, signature check skipped with loud banner) only when the
lifecycle word is in the `DEV` state.

| Offset | Width | Field | Notes |
| --- | --- | --- | --- |
| `0x000` | 32 | `OTP_MAGIC` (`0x4F50_5F4F`, "OP_O") | Hard-magic; mismatch halts. |
| `0x004` | 32 | `LIFECYCLE` | `0xA5A5_A5A5`=DEV, `0x5A5A_5A5A`=PROD, `0x0000_0000`=RMA. |
| `0x008` | 32 | `ROLLBACK_INDEX` | Monotonic counter; ROM rejects images with lower index. |
| `0x00C` | 32 | `AB_SLOT_PREF` | 0 = slot A preferred, 1 = slot B preferred. |
| `0x010` | 256 | `ROOT_PUBKEY_HASH` (SHA-256 of root pubkey) | Compared against pubkey embedded in firmware header. |
| `0x030` | 32 | `DEBUG_POLICY` | Bit 0 = allow JTAG, bit 1 = allow DMI, bit 2 = allow halt-on-reset, bit 3 = OTP-window disable latch. |
| `0x034` | 32 | `KEY_ERASE_LATCH` | Sticky one-shot; once written, root pubkey hash reads as zero. |
| `0x040` | 64 | `CHIP_ID` | Per-die unique ID for attestation / debug binding. |
| `0x080` | 256 | `RECOVERY_PUBKEY_HASH` | Used only for recovery slot validation. |

OTP is exposed to the boot ROM through a dedicated MMIO window at
`0x0000_3000` (read-only from M-mode, blocked from S/U). The window is
disabled by writing `DEBUG_POLICY.bit3` before jumping to OpenSBI.

## Secure-boot signature verification (stub)

The v0 implementation is a verification **stub** that establishes the call
sites and the failure semantics. The cryptographic primitive is a placeholder
that returns "valid" only for an all-zero signature when `LIFECYCLE == DEV`,
and always returns "invalid" otherwise. The point of the stub is that the
control flow, banners, and fail-closed reset path are testable today.

Firmware image header (lives at the start of slot A/B in flash, copied to
DRAM by the boot ROM):

```text
offset 0x000  magic       "OPFW"
offset 0x004  header_size u32 (bytes)
offset 0x008  image_size  u32 (bytes, excluding header + signature)
offset 0x00C  rollback    u32 (must be >= OTP_ROLLBACK_INDEX)
offset 0x010  load_addr   u64 (DRAM physical, must be in 0x80000000+ range)
offset 0x018  entry_addr  u64 (M-mode entry, must equal load_addr for v0)
offset 0x020  pubkey      32 bytes (SHA-256 must equal OTP_ROOT_PUBKEY_HASH)
offset 0x040  signature   64 bytes (Ed25519 over header[0..0x40] || image)
offset 0x080  image bytes
```

Verification algorithm (executed by ROM in M-mode):

1. Read header, check `magic == "OPFW"` and `header_size >= 0x80`.
2. Read OTP. If `MAGIC` wrong, halt to debug catch (`wfi` loop after writing
   fail code `0xDEAD_0001` to `0x0000_2000`).
3. Compute SHA-256 of `pubkey`, compare against `OTP_ROOT_PUBKEY_HASH`.
   Mismatch -> fail code `0xDEAD_0002`, halt.
4. Compare `rollback >= OTP_ROLLBACK_INDEX`. Mismatch -> fail `0xDEAD_0003`.
5. Verify Ed25519 signature over `header[0..0x40] || image`.
   Stub returns true only if `LIFECYCLE == DEV && signature == 0`.
   Failure -> fail `0xDEAD_0004`.
6. Select A/B slot per `OTP_AB_SLOT_PREF` and recovery fallback policy.
7. Copy `image` to `load_addr`, set up handoff state, jump to `entry_addr`.

Fail codes are written to the boot status mailbox at `0x0000_2000` before the
ROM enters `wfi` with interrupts masked. They are visible through the existing
debug MMIO bridge so simulation can assert on them.

Required negative cases (mirroring `docs/arch/security.md`):
unsigned, tampered, wrong-key, corrupt-header, rollback-too-low,
slot-A-bad-fallback-to-B-bad-final-halt. All six must appear as cocotb tests
once the executable ROM lands.

## OpenSBI handoff ABI

The boot ROM hands off to OpenSBI (loaded as the slot payload) following the
standard RISC-V firmware-to-firmware ABI:

| Register | Value at jump | Notes |
| --- | --- | --- |
| `pc` | `header.entry_addr` (M-mode) | Validated to equal `load_addr` for v0. |
| `a0` | hart id (0 for v0) | Same value as `mhartid`. |
| `a1` | physical address of FDT blob | FDT placed at `0x8000_0000 + image_size`, rounded up to 2 MiB. |
| `a2` | 0 | Reserved. |
| `mstatus` | `MIE=0`, `MPIE=0`, `MPP=11` (M-mode) | OpenSBI takes over privilege transitions. |
| `mtvec` | `0x0000_1080` (ROM trap shim) | OpenSBI overwrites immediately. |
| `mie` | 0 | OpenSBI enables what it wants. |
| `satp` | 0 | MMU off. |
| `pmpcfg0..15` | 0 | OpenSBI configures PMP. |
| `mscratch` | 0 | Reserved. |
| caches | invalidated (`fence.i`, `fence rw,rw`) | Required before hand-off. |
| OTP MMIO window | disabled via `DEBUG_POLICY.bit3` write | Prevents OpenSBI/Linux from reading raw fuses. |

If OpenSBI traps before installing its own `mtvec`, the ROM trap shim at
`0x0000_1080` writes `0xDEAD_BEEF` to the boot status mailbox and halts.

## Debug-lock policy

| Lifecycle | JTAG | DMI | Halt-on-reset | Notes |
| --- | --- | --- | --- | --- |
| DEV (`0xA5A5_A5A5`) | allowed | allowed | allowed | Unsigned firmware permitted; loud banner. |
| PROD (`0x5A5A_5A5A`) | allowed iff `DEBUG_POLICY.bit0` | allowed iff `bit1` | allowed iff `bit2` | All signature checks enforced. |
| RMA (`0x0000_0000`) | gated by attestation challenge | gated | denied | ROM writes `KEY_ERASE_LATCH` before unlocking debug; root pubkey hash is then read-as-zero. |

Debug unlock policy applies before the ROM jumps to OpenSBI. After hand-off,
the debug module must enforce the same gating in hardware; the ROM cannot
re-tighten it.

Required negative evidence (carried from `docs/arch/security.md`):
debug-unlock-denied-in-PROD, key-erasure-on-RMA-unlock,
lifecycle-RMA-policy-transcript. All three must be cocotb/formal targets
before any release claims "debug locked".

## Cross-references

- RTL aperture: `rtl/bootrom/e1_bootrom.sv` (current identity ROM) and
  `fw/boot-rom/reset.S` (executable replacement stub).
- CPU integration: `docs/rtl/cpu-config-selection.md`.
- Interrupts/CLINT/PLIC: `docs/arch/interrupts.md`.
- Security gates: `docs/arch/security.md`.
- Open gaps tracker: `verify/rtl_gap_work_order.yaml` (`bootrom-firmware-handoff`).
