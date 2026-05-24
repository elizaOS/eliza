#!/usr/bin/env python3
"""
Build AVB vbmeta test images for the E1 Ed25519-profile verifier KAT harness.

The layout is the real libavb vbmeta image:

  AvbVBMetaImageHeader (256 B, big-endian)
    || authentication block (hash || signature)
    || auxiliary block (public_key || descriptors)

The E1 algorithm profile (docs/security/avb-a-b-ota.md): the authentication
hash is SHA-256 over (header || auxiliary block) with the auth block's hash and
signature regions excluded (they are inside the auth block, not the hashed
span); the signature is Ed25519 (RFC 8032) over that 32-byte hash. Signing uses
the python `cryptography` Ed25519 implementation so the harness cross-checks the
C verifier against an independent codebase. Keys derive from fixed seeds so the
output is byte-for-byte deterministic.

Emits, into the output directory:
  good.bin                valid, accepted
  tampered_descriptor.bin chain-descriptor body byte flipped after signing -> HASH
  wrong_key.bin           signed by a key whose hash != the pinned expected hash
  bad_magic.bin           magic corrupted
  bad_rollback.bin        rollback_index below the OTP floor
  truncated_aux.bin       aux block truncated (declared size exceeds the image)
  bad_hash_descriptor.bin boot partition digest corrupted in the descriptor
  expected.h              C header: pinned key hash, OTP floor, boot image bytes
"""

import hashlib
import struct
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

HEADER_LEN = 256
MAGIC = b"AVB0"

# E1 Ed25519 profile algorithm id (must match avb_verify.h).
ALG_E1_SHA256_ED25519 = 0x4531ED25

HASH_LEN = 32
SIG_LEN = 64
PUBKEY_LEN = 32

# Descriptor tags (AvbDescriptorTag).
TAG_PROPERTY = 0
TAG_HASHTREE = 1
TAG_HASH = 2
TAG_CHAIN_PARTITION = 4

# OTP trust inputs the C test feeds the verifier for the positive case.
OTP_ROLLBACK_MIN = 5
ROLLBACK_INDEX = 7

# A boot partition the hash descriptor protects.
BOOT_IMAGE = b"E1 boot.img: kernel + ramdisk bytes for the AVB KAT harness." * 4
BOOT_SALT = bytes.fromhex("00112233445566778899aabbccddeeff")


def key_from_seed(seed: int) -> Ed25519PrivateKey:
    raw = hashlib.sha256(f"e1-avb-test-key-{seed}".encode()).digest()
    return Ed25519PrivateKey.from_private_bytes(raw)


def pub_raw(key: Ed25519PrivateKey) -> bytes:
    return key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )


def _pad8(b: bytes) -> bytes:
    if len(b) % 8 != 0:
        b = b + b"\x00" * (8 - (len(b) % 8))
    return b


def descriptor(tag: int, body: bytes) -> bytes:
    """Wrap a descriptor body in the 16-byte AvbDescriptor header, 8-aligned."""
    body = _pad8(body)
    return struct.pack(">QQ", tag, len(body)) + body


def hash_descriptor(partition: bytes, image: bytes, salt: bytes,
                    digest: bytes | None = None) -> bytes:
    if digest is None:
        digest = hashlib.sha256(salt + image).digest()
    hash_algorithm = b"sha256".ljust(32, b"\x00")
    body = struct.pack(">Q", len(image))          # image_size
    body += hash_algorithm                          # hash_algorithm[32]
    body += struct.pack(">I", len(partition))      # partition_name_len
    body += struct.pack(">I", len(salt))           # salt_len
    body += struct.pack(">I", len(digest))         # digest_len
    body += struct.pack(">I", 0)                   # flags
    body += b"\x00" * 60                            # reserved
    assert len(body) == 0x74
    body += partition + salt + digest
    return descriptor(TAG_HASH, body)


def hashtree_descriptor(partition: bytes, image_size: int, salt: bytes,
                        root_digest: bytes) -> bytes:
    hash_algorithm = b"sha256".ljust(32, b"\x00")
    body = struct.pack(">I", 1)                    # dm_verity_version
    body += struct.pack(">Q", image_size)          # image_size
    body += struct.pack(">Q", image_size)          # tree_offset
    body += struct.pack(">Q", 4096)                # tree_size
    body += struct.pack(">I", 4096)                # data_block_size
    body += struct.pack(">I", 4096)                # hash_block_size
    body += struct.pack(">I", 0)                   # fec_num_roots
    body += struct.pack(">Q", 0)                   # fec_offset
    body += struct.pack(">Q", 0)                   # fec_size
    body += hash_algorithm                          # hash_algorithm[32]
    body += struct.pack(">I", len(partition))      # partition_name_len
    body += struct.pack(">I", len(salt))           # salt_len
    body += struct.pack(">I", len(root_digest))    # root_digest_len
    body += struct.pack(">I", 0)                   # flags
    body += b"\x00" * 60                            # reserved
    assert len(body) == 0xA4
    body += partition + salt + root_digest
    return descriptor(TAG_HASHTREE, body)


def chain_descriptor(partition: bytes, rollback_index_location: int,
                    public_key: bytes) -> bytes:
    body = struct.pack(">I", rollback_index_location)
    body += struct.pack(">I", len(partition))
    body += struct.pack(">I", len(public_key))
    body += struct.pack(">I", 0)                   # flags
    body += b"\x00" * 60                            # reserved
    assert len(body) == 0x4C
    body += partition + public_key
    return descriptor(TAG_CHAIN_PARTITION, body)


def property_descriptor(key: bytes, value: bytes) -> bytes:
    body = struct.pack(">QQ", len(key), len(value))
    body += key + b"\x00" + value + b"\x00"
    return descriptor(TAG_PROPERTY, body)


def build_vbmeta(
    signing_key: Ed25519PrivateKey,
    descriptors: bytes,
    rollback_index: int = ROLLBACK_INDEX,
    rollback_index_location: int = 2,
    flags: int = 0,
    algorithm_type: int = ALG_E1_SHA256_ED25519,
) -> bytes:
    pubkey = pub_raw(signing_key)

    # Auxiliary block: public_key followed by descriptors (8-aligned blocks).
    pk_off = 0
    desc_off = len(pubkey)
    aux = pubkey + descriptors
    aux = _pad8(aux)
    aux_size = len(aux)

    # Authentication block: hash (32) then signature (64).
    hash_off = 0
    sig_off = HASH_LEN
    auth_size = HASH_LEN + SIG_LEN

    header = bytearray(HEADER_LEN)
    header[0x00:0x04] = MAGIC
    struct.pack_into(">I", header, 0x04, 1)                 # required major
    struct.pack_into(">I", header, 0x08, 0)                 # required minor
    struct.pack_into(">Q", header, 0x0C, auth_size)
    struct.pack_into(">Q", header, 0x14, aux_size)
    struct.pack_into(">I", header, 0x1C, algorithm_type)
    struct.pack_into(">Q", header, 0x20, hash_off)
    struct.pack_into(">Q", header, 0x28, HASH_LEN)
    struct.pack_into(">Q", header, 0x30, sig_off)
    struct.pack_into(">Q", header, 0x38, SIG_LEN)
    struct.pack_into(">Q", header, 0x40, pk_off)
    struct.pack_into(">Q", header, 0x48, len(pubkey))
    struct.pack_into(">Q", header, 0x50, 0)                 # pk metadata off
    struct.pack_into(">Q", header, 0x58, 0)                 # pk metadata size
    struct.pack_into(">Q", header, 0x60, desc_off)
    struct.pack_into(">Q", header, 0x68, len(descriptors))
    struct.pack_into(">Q", header, 0x70, rollback_index)
    struct.pack_into(">I", header, 0x78, flags)
    struct.pack_into(">I", header, 0x7C, rollback_index_location)
    header[0x80:0x80 + 14] = b"e1-avb-1.0\x00\x00\x00\x00"
    # 0xB0..0x100 padding stays zero.

    auth_hash = hashlib.sha256(bytes(header) + aux).digest()
    signature = signing_key.sign(auth_hash)
    assert len(signature) == SIG_LEN
    auth = auth_hash + signature

    return bytes(header) + auth + aux


def standard_descriptors(chain_pubkey: bytes) -> bytes:
    """A representative descriptor set: hash (boot), hashtree (system),
    chain (vendor_boot), property."""
    d = b""
    d += hash_descriptor(b"boot", BOOT_IMAGE, BOOT_SALT)
    d += hashtree_descriptor(b"system", 0x4000, BOOT_SALT[:8],
                            hashlib.sha256(b"system-root").digest())
    d += chain_descriptor(b"vendor_boot", 4, chain_pubkey)
    d += property_descriptor(b"com.android.build.boot.fingerprint",
                            b"eliza/e1/e1:14/UQ1A/userdebug")
    return d


def main() -> int:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent
    out.mkdir(parents=True, exist_ok=True)

    avb_key_a = key_from_seed(1)          # E1 AVB key A (pinned by boot stage)
    attacker_key = key_from_seed(99)
    chain_key = key_from_seed(2)          # vendor_boot vbmeta key (chained)

    pinned_hash = hashlib.sha256(pub_raw(avb_key_a)).digest()
    descs = standard_descriptors(pub_raw(chain_key))

    good = build_vbmeta(avb_key_a, descs)
    (out / "good.bin").write_bytes(good)

    # Tampered descriptor: flip a byte inside the aux block (descriptor region),
    # after signing. The auth hash over (header||aux) must now fail.
    tampered = bytearray(good)
    aux_start = HEADER_LEN + HASH_LEN + SIG_LEN
    tampered[aux_start + PUBKEY_LEN + 32] ^= 0x01
    (out / "tampered_descriptor.bin").write_bytes(bytes(tampered))

    # Wrong key: a structurally valid, correctly self-signed image whose key
    # hash does not match the pinned expected hash.
    (out / "wrong_key.bin").write_bytes(build_vbmeta(attacker_key, descs))

    bad_magic = bytearray(good)
    bad_magic[0] = ord("X")
    (out / "bad_magic.bin").write_bytes(bytes(bad_magic))

    (out / "bad_rollback.bin").write_bytes(
        build_vbmeta(avb_key_a, descs, rollback_index=OTP_ROLLBACK_MIN - 1)
    )

    # Truncated aux: declare the real aux size but drop the trailing bytes so
    # header.auxiliary_data_block_size overflows the image.
    truncated = bytearray(good)
    del truncated[-16:]
    (out / "truncated_aux.bin").write_bytes(bytes(truncated))

    # Corrupted hash descriptor: build with a wrong boot digest, then re-sign so
    # the auth hash passes — the failure must surface at the hash-descriptor
    # partition check, not the auth hash.
    bad_digest = bytearray(hashlib.sha256(BOOT_SALT + BOOT_IMAGE).digest())
    bad_digest[0] ^= 0xFF
    descs_bad = b""
    descs_bad += hash_descriptor(b"boot", BOOT_IMAGE, BOOT_SALT, bytes(bad_digest))
    descs_bad += hashtree_descriptor(b"system", 0x4000, BOOT_SALT[:8],
                                    hashlib.sha256(b"system-root").digest())
    descs_bad += chain_descriptor(b"vendor_boot", 4, pub_raw(chain_key))
    (out / "bad_hash_descriptor.bin").write_bytes(build_vbmeta(avb_key_a, descs_bad))

    header_h = out / "expected.h"
    pinned_hex = ", ".join(f"0x{b:02x}" for b in pinned_hash)
    boot_hex = ", ".join(f"0x{b:02x}" for b in BOOT_IMAGE)
    chain_hash = hashlib.sha256(pub_raw(chain_key)).digest()
    chain_hex = ", ".join(f"0x{b:02x}" for b in chain_hash)
    header_h.write_text(
        "/* Generated by make_vbmeta.py — do not edit. */\n"
        "#ifndef E1_AVB_TEST_EXPECTED_H\n#define E1_AVB_TEST_EXPECTED_H\n\n"
        "#include <stdint.h>\n#include <stddef.h>\n\n"
        f"static const uint8_t TEST_AVB_PINNED_KEY_HASH[32] = {{ {pinned_hex} }};\n"
        f"static const uint8_t TEST_AVB_CHAIN_KEY_HASH[32] = {{ {chain_hex} }};\n"
        f"static const uint8_t TEST_BOOT_IMAGE[] = {{ {boot_hex} }};\n"
        f"#define TEST_BOOT_IMAGE_LEN {len(BOOT_IMAGE)}u\n"
        f"#define TEST_AVB_ROLLBACK_MIN {OTP_ROLLBACK_MIN}u\n"
        f"#define TEST_AVB_ROLLBACK_INDEX {ROLLBACK_INDEX}u\n\n"
        "#endif\n"
    )
    print(f"wrote vbmeta test images + expected.h to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
