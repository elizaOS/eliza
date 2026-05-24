#!/usr/bin/env python3
"""
Build A/B-slot + OTA test images for the E1 ab_slot/ota_apply harness.

Reuses the libavb vbmeta builder in make_vbmeta.py (same E1 Ed25519 profile,
same AVB key A, same independent python `cryptography` signer) so the slot/OTA
logic is exercised against real, independently-signed vbmeta images — no fakes.

Each slot/OTA image is a full vbmeta with a `boot` hash descriptor over a
per-image boot partition; the boot bytes are emitted alongside so the C harness
can feed them as the avb_verify hash target (the bootloader's pre-kexec boot
digest check). The recovery image uses rollback_index_location 3 (recovery OTP
slot) per boot-image-format.md §4.

Emits, into the output directory:
  slot_a_vbmeta.bin / slot_a_boot.bin      slot A good image (rollback_index 7)
  ota_b_vbmeta.bin  / ota_b_boot.bin       valid OTA for slot B (rollback_index 8)
  ota_downgrade_vbmeta.bin / ..._boot.bin  OTA below the OTP floor -> rejected
  ota_tampered_vbmeta.bin  / ..._boot.bin  OTA with a post-sign vbmeta byte flip
  recovery_vbmeta.bin / recovery_boot.bin  recovery image (rollback slot 3)
  ab_expected.h                            pinned key hash, floors, boot lens
"""

import hashlib
import sys
from pathlib import Path

# Reuse the verified E1 vbmeta builder.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_vbmeta import (  # noqa: E402
    HASH_LEN,
    HEADER_LEN,
    SIG_LEN,
    build_vbmeta,
    hash_descriptor,
    key_from_seed,
    pub_raw,
)

# OTP floors the C harness seeds the controller with.
VBMETA_ROLLBACK_FLOOR = 5      # OTP floor for the vbmeta rollback slot (slot 2)
RECOVERY_ROLLBACK_FLOOR = 1    # OTP floor for the recovery rollback slot (slot 3)

# Per-image rollback indices.
SLOT_A_INDEX = 7
OTA_B_INDEX = 8                # a forward OTA (>= floor): accepted
DOWNGRADE_INDEX = VBMETA_ROLLBACK_FLOOR - 1   # below floor: rejected
RECOVERY_INDEX = 2

BOOT_SALT = bytes.fromhex("a1b2c3d4e5f60718")


def boot_only_descriptors(boot_image: bytes) -> bytes:
    """A minimal descriptor set: just the boot hash descriptor the bootloader
    verifies pre-kexec. Sufficient to exercise slot select + OTA apply."""
    return hash_descriptor(b"boot", boot_image, BOOT_SALT)


def build_slot(
    boot_image: bytes,
    rollback_index: int,
    rollback_index_location: int = 2,
    signing_seed: int = 1,
) -> bytes:
    key = key_from_seed(signing_seed)
    descs = boot_only_descriptors(boot_image)
    return build_vbmeta(
        key,
        descs,
        rollback_index=rollback_index,
        rollback_index_location=rollback_index_location,
    )


def c_array(name: str, data: bytes) -> str:
    body = ", ".join(f"0x{b:02x}" for b in data)
    return f"static const uint8_t {name}[] = {{ {body} }};\n"


def main() -> int:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent
    out.mkdir(parents=True, exist_ok=True)

    avb_key_a = key_from_seed(1)
    attacker_key = key_from_seed(99)
    pinned_hash = hashlib.sha256(pub_raw(avb_key_a)).digest()

    # Distinct boot images so a slot/OTA mix-up would be caught by the digest.
    slot_a_boot = b"E1 slot A boot: kernel+ramdisk (known-good, rollback 7)." * 4
    ota_b_boot = b"E1 slot B boot: OTA payload kernel+ramdisk (rollback 8)." * 4
    downgrade_boot = b"E1 downgrade OTA boot: stale image (rollback 4)." * 4
    recovery_boot = b"E1 recovery boot: minimal initramfs + sideload UI." * 4

    # Slot A: the known-good resident image (signed by AVB key A).
    (out / "slot_a_vbmeta.bin").write_bytes(build_slot(slot_a_boot, SLOT_A_INDEX))
    (out / "slot_a_boot.bin").write_bytes(slot_a_boot)

    # Valid forward OTA for slot B (rollback_index 8 >= floor 5): accepted.
    (out / "ota_b_vbmeta.bin").write_bytes(build_slot(ota_b_boot, OTA_B_INDEX))
    (out / "ota_b_boot.bin").write_bytes(ota_b_boot)

    # Downgrade OTA (rollback_index 4 < floor 5): rejected pre-write.
    (out / "ota_downgrade_vbmeta.bin").write_bytes(
        build_slot(downgrade_boot, DOWNGRADE_INDEX)
    )
    (out / "ota_downgrade_boot.bin").write_bytes(downgrade_boot)

    # Tampered OTA: valid image with a vbmeta auth-block-covered byte flipped
    # after signing (a descriptor-region byte). The auth hash now fails.
    good_b = build_slot(ota_b_boot, OTA_B_INDEX)
    tampered = bytearray(good_b)
    aux_start = HEADER_LEN + HASH_LEN + SIG_LEN
    # Flip a byte in the descriptor region (past the 32-byte pubkey).
    tampered[aux_start + 32 + 16] ^= 0x01
    (out / "ota_tampered_vbmeta.bin").write_bytes(bytes(tampered))
    (out / "ota_tampered_boot.bin").write_bytes(ota_b_boot)

    # Wrong-key OTA: structurally valid, self-consistent, signed by an attacker
    # key whose hash != the pinned AVB key A hash. Rejected at the key pin.
    (out / "ota_wrongkey_vbmeta.bin").write_bytes(
        build_slot(ota_b_boot, OTA_B_INDEX, signing_seed=99)
    )
    (out / "ota_wrongkey_boot.bin").write_bytes(ota_b_boot)
    _ = attacker_key  # documented: seed 99 is the attacker key

    # Recovery image (rollback slot 3, signed by AVB key A).
    (out / "recovery_vbmeta.bin").write_bytes(
        build_slot(recovery_boot, RECOVERY_INDEX, rollback_index_location=3)
    )
    (out / "recovery_boot.bin").write_bytes(recovery_boot)

    pinned_hex = ", ".join(f"0x{b:02x}" for b in pinned_hash)
    header = out / "ab_expected.h"
    header.write_text(
        "/* Generated by make_ab_images.py — do not edit. */\n"
        "#ifndef E1_AB_TEST_EXPECTED_H\n#define E1_AB_TEST_EXPECTED_H\n\n"
        "#include <stdint.h>\n#include <stddef.h>\n\n"
        f"static const uint8_t AB_PINNED_KEY_HASH[32] = {{ {pinned_hex} }};\n"
        f"#define AB_VBMETA_ROLLBACK_FLOOR {VBMETA_ROLLBACK_FLOOR}u\n"
        f"#define AB_RECOVERY_ROLLBACK_FLOOR {RECOVERY_ROLLBACK_FLOOR}u\n"
        f"#define AB_SLOT_A_INDEX {SLOT_A_INDEX}u\n"
        f"#define AB_OTA_B_INDEX {OTA_B_INDEX}u\n"
        f"#define AB_RECOVERY_INDEX {RECOVERY_INDEX}u\n"
        f"{c_array('AB_SLOT_A_BOOT', slot_a_boot)}"
        f"#define AB_SLOT_A_BOOT_LEN {len(slot_a_boot)}u\n"
        f"{c_array('AB_OTA_B_BOOT', ota_b_boot)}"
        f"#define AB_OTA_B_BOOT_LEN {len(ota_b_boot)}u\n"
        f"{c_array('AB_DOWNGRADE_BOOT', downgrade_boot)}"
        f"#define AB_DOWNGRADE_BOOT_LEN {len(downgrade_boot)}u\n"
        f"{c_array('AB_RECOVERY_BOOT', recovery_boot)}"
        f"#define AB_RECOVERY_BOOT_LEN {len(recovery_boot)}u\n\n"
        "#endif\n"
    )
    print(f"wrote A/B + OTA test images + ab_expected.h to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
