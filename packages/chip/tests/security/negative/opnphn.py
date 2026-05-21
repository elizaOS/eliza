"""Spec-correct OPNPHN01 secure-boot image reference (builder + verifier).

This is the W7 reference model for the E1 mask-ROM secure-boot verifier. It is
written against the SPEC (docs/security/boot-image-format.md, debug-policy.md,
tee-plan/02-root-of-trust.md), NOT against the firmware implementation under
fw/boot-rom/secure/. The shared contract between this model and the RTL/firmware
verifier is the spec: both MUST produce identical accept/reject decisions and
identical halt codes for the same image + OTP state.

Crypto is real, not faked:
  - SHA-256 via hashlib (matches fw/boot-rom/secure/sha256.c FIPS 180-4).
  - Ed25519 (RFC 8032) via PyNaCl (libsodium) — same algorithm the mask ROM
    verifies with fw/boot-rom/secure/ed25519_ct.c. A wrong key or a flipped
    payload byte produces a genuine signature failure, not a stubbed one.

Image layout (boot-image-format.md §2):
  header (256 B) || payload (image_size B) || signature_blob (96 B)

Header (256 B, little-endian) — §2.1:
  0x00  8  magic            ASCII "OPNPHN01"
  0x08  4  header_version   =1
  0x0C  4  image_type       0=bootloader 1=recovery 2=vbmeta 3=vendor_boot
  0x10  8  image_size       payload bytes
  0x18  4  rollback_index   monotonic per image_type
  0x1C  4  rollback_slot    index into OTP rollback bank
  0x20  4  key_id           which authorized key signed this image
  0x24  4  flags            bit0=allow_dev bit1=allow_mfg
  0x28 32  payload_sha256   SHA-256 of payload bytes
  0x48 32  next_stage_pubkey_hash
  0x68  4  min_lifecycle_state
  0x6C 148 reserved         zero-filled, included in signature

Signature blob (96 B) — §2.2:
  0x00 32  pubkey (Ed25519)
  0x20 64  signature over (header || payload)
"""

from __future__ import annotations

import hashlib
import struct
from dataclasses import dataclass, field

from ed25519_ref import Ed25519PrivateKey, ed25519_verify_raw

MAGIC = b"OPNPHN01"
HEADER_LEN = 256
SIG_BLOB_LEN = 96
SUPPORTED_HEADER_VERSION = 1

# Lifecycle one-hot codes (boot-image-format.md §5).
LC_BLANK = 0x01
LC_DEV = 0x02
LC_MFG = 0x04
LC_LOCKED = 0x08
LC_RMA = 0x10
LC_SCRAP = 0x20

# Header flags (§2.1).
FLAG_ALLOW_DEV = 0x1
FLAG_ALLOW_MFG = 0x2


# ---------------------------------------------------------------------------
# Halt record contract (boot-image-format.md §6).
#
# The ROM emits a 32-byte structured halt record on UART when it rejects an
# image. The spec fixes the halt CONDITIONS; this model fixes the binary layout
# the firmware must match. Layout (little-endian):
#
#   0x00  4  halt_magic   ASCII "HALT"
#   0x04  2  record_version (=1)
#   0x06  2  halt_code    (HALT_* below)
#   0x08  4  image_type   from the rejected header (0 if header unreadable)
#   0x0C  4  boot_counter (OTP, anti-replay binding)
#   0x10 16  detail       code-specific (e.g. observed vs expected indices,
#                         offending key_id); zero-padded
#
# ACCEPT is signalled by halt_code == HALT_NONE within an OK record, but a real
# ROM does not emit a halt record on accept; the model emits one with
# HALT_NONE so the positive control has a uniform machine-checkable artifact.
# ---------------------------------------------------------------------------

HALT_MAGIC = b"HALT"
HALT_RECORD_VERSION = 1
HALT_RECORD_LEN = 32

# Halt codes. Order/values are part of the firmware contract — do not renumber.
HALT_NONE = 0x0000  # accept (model-only sentinel)
HALT_MAGIC_MISMATCH = 0x0001
HALT_HEADER_VERSION_UNSUPPORTED = 0x0002
HALT_PAYLOAD_SHA256_MISMATCH = 0x0003
HALT_SIGNATURE_FAILURE = 0x0004
HALT_PUBKEY_HASH_NOT_ROOT = 0x0005
HALT_ROLLBACK_DOWNGRADE = 0x0006
HALT_KEY_ID_REVOKED = 0x0007
HALT_LIFECYCLE_BELOW_MIN = 0x0008
HALT_OTP_PARITY = 0x0009
HALT_LIFECYCLE_SCRAP = 0x000A
# Debug-policy halt codes (debug-policy.md §3/§4).
HALT_DEBUG_LOCKED_NO_UNLOCK = 0x0010
HALT_DEBUG_AUTH_SIGNATURE_FAILURE = 0x0011
HALT_DEBUG_RMA_WIPE_INCOMPLETE = 0x0012

HALT_CODE_NAMES = {
    HALT_NONE: "ACCEPT",
    HALT_MAGIC_MISMATCH: "MAGIC_MISMATCH",
    HALT_HEADER_VERSION_UNSUPPORTED: "HEADER_VERSION_UNSUPPORTED",
    HALT_PAYLOAD_SHA256_MISMATCH: "PAYLOAD_SHA256_MISMATCH",
    HALT_SIGNATURE_FAILURE: "SIGNATURE_FAILURE",
    HALT_PUBKEY_HASH_NOT_ROOT: "PUBKEY_HASH_NOT_ROOT",
    HALT_ROLLBACK_DOWNGRADE: "ROLLBACK_DOWNGRADE",
    HALT_KEY_ID_REVOKED: "KEY_ID_REVOKED",
    HALT_LIFECYCLE_BELOW_MIN: "LIFECYCLE_BELOW_MIN",
    HALT_OTP_PARITY: "OTP_PARITY",
    HALT_LIFECYCLE_SCRAP: "LIFECYCLE_SCRAP",
    HALT_DEBUG_LOCKED_NO_UNLOCK: "DEBUG_LOCKED_NO_UNLOCK",
    HALT_DEBUG_AUTH_SIGNATURE_FAILURE: "DEBUG_AUTH_SIGNATURE_FAILURE",
    HALT_DEBUG_RMA_WIPE_INCOMPLETE: "DEBUG_RMA_WIPE_INCOMPLETE",
}


def sha256(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


@dataclass
class HaltRecord:
    """The 32-byte structured halt record (or HALT_NONE accept sentinel)."""

    code: int
    image_type: int = 0
    boot_counter: int = 0
    detail: bytes = b""

    @property
    def accepted(self) -> bool:
        return self.code == HALT_NONE

    @property
    def code_name(self) -> str:
        return HALT_CODE_NAMES.get(self.code, f"UNKNOWN_0x{self.code:04X}")

    def to_bytes(self) -> bytes:
        detail = self.detail[:16].ljust(16, b"\x00")
        rec = (
            HALT_MAGIC
            + struct.pack("<HH", HALT_RECORD_VERSION, self.code)
            + struct.pack("<II", self.image_type & 0xFFFFFFFF, self.boot_counter & 0xFFFFFFFF)
            + detail
        )
        assert len(rec) == HALT_RECORD_LEN, len(rec)
        return rec

    def to_hex(self) -> str:
        return self.to_bytes().hex()


# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------


@dataclass
class Header:
    image_type: int = 0
    image_size: int = 0
    rollback_index: int = 0
    rollback_slot: int = 0
    key_id: int = 0
    flags: int = 0
    payload_sha256: bytes = b"\x00" * 32
    next_stage_pubkey_hash: bytes = b"\x00" * 32
    min_lifecycle_state: int = LC_LOCKED
    magic: bytes = MAGIC
    header_version: int = SUPPORTED_HEADER_VERSION
    reserved: bytes = b"\x00" * 148

    def pack(self) -> bytes:
        out = bytearray(HEADER_LEN)
        out[0x00:0x08] = self.magic[:8].ljust(8, b"\x00")
        struct.pack_into("<I", out, 0x08, self.header_version & 0xFFFFFFFF)
        struct.pack_into("<I", out, 0x0C, self.image_type & 0xFFFFFFFF)
        struct.pack_into("<Q", out, 0x10, self.image_size & 0xFFFFFFFFFFFFFFFF)
        struct.pack_into("<I", out, 0x18, self.rollback_index & 0xFFFFFFFF)
        struct.pack_into("<I", out, 0x1C, self.rollback_slot & 0xFFFFFFFF)
        struct.pack_into("<I", out, 0x20, self.key_id & 0xFFFFFFFF)
        struct.pack_into("<I", out, 0x24, self.flags & 0xFFFFFFFF)
        out[0x28:0x48] = self.payload_sha256[:32].ljust(32, b"\x00")
        out[0x48:0x68] = self.next_stage_pubkey_hash[:32].ljust(32, b"\x00")
        struct.pack_into("<I", out, 0x68, self.min_lifecycle_state & 0xFFFFFFFF)
        out[0x6C:0x100] = self.reserved[:148].ljust(148, b"\x00")
        assert len(out) == HEADER_LEN
        return bytes(out)

    @classmethod
    def unpack(cls, raw: bytes) -> Header:
        if len(raw) < HEADER_LEN:
            raise ValueError("header too short")
        return cls(
            magic=raw[0x00:0x08],
            header_version=struct.unpack_from("<I", raw, 0x08)[0],
            image_type=struct.unpack_from("<I", raw, 0x0C)[0],
            image_size=struct.unpack_from("<Q", raw, 0x10)[0],
            rollback_index=struct.unpack_from("<I", raw, 0x18)[0],
            rollback_slot=struct.unpack_from("<I", raw, 0x1C)[0],
            key_id=struct.unpack_from("<I", raw, 0x20)[0],
            flags=struct.unpack_from("<I", raw, 0x24)[0],
            payload_sha256=raw[0x28:0x48],
            next_stage_pubkey_hash=raw[0x48:0x68],
            min_lifecycle_state=struct.unpack_from("<I", raw, 0x68)[0],
            reserved=raw[0x6C:0x100],
        )


# ---------------------------------------------------------------------------
# OTP / device security state (boot-image-format.md §3/§4/§5, otp-fuse-map.md)
# ---------------------------------------------------------------------------


@dataclass
class Otp:
    """Synthetic, non-production OTP security fuse state read by the ROM."""

    root_key_hash: bytes  # SHA-256 of the authorized root Ed25519 pubkey
    lifecycle_state: int = LC_LOCKED
    # Per-slot programmed rollback index (unary-encoded count of fuses).
    rollback: dict[int, int] = field(default_factory=dict)
    revoked_key_bitmap: int = 0  # bitN set => key_id N revoked
    boot_counter: int = 1
    # debug-policy.md §3/§4
    debug_auth_pubkey_hash: bytes = b"\x00" * 32
    debug_disable: int = 0  # sticky per-port kill switch (bit per port)
    rma_wipe_done: bool = False
    # 2-of-3 majority read; flip to model an uncorrectable parity fault.
    parity_fault: bool = False

    def rollback_for(self, slot: int) -> int:
        return self.rollback.get(slot, 0)

    def key_revoked(self, key_id: int) -> bool:
        return bool((self.revoked_key_bitmap >> key_id) & 0x1)


# ---------------------------------------------------------------------------
# Image builder
# ---------------------------------------------------------------------------


class ImageBuilder:
    """Builds OPNPHN01 images with real Ed25519 signatures."""

    def __init__(self, signing_key: Ed25519PrivateKey):
        self.signing_key = signing_key

    @property
    def pubkey(self) -> bytes:
        return self.signing_key.public_bytes()

    def build(
        self,
        payload: bytes,
        *,
        header: Header,
        sign: bool = True,
        override_payload_hash: bytes | None = None,
        override_pubkey: bytes | None = None,
        corrupt_signature: bool = False,
    ) -> bytes:
        """Assemble a (possibly intentionally-broken) image.

        The header's image_size and payload_sha256 are set from the real
        payload unless overridden, so a valid build is genuinely valid.
        """
        header.image_size = len(payload)
        header.payload_sha256 = (
            override_payload_hash if override_payload_hash is not None else sha256(payload)
        )
        header_bytes = header.pack()
        signed_region = header_bytes + payload

        signature = (
            self.signing_key.sign(signed_region) if sign else b"\x00" * ED_SIG_LEN
        )

        if corrupt_signature:
            signature = bytes(b ^ 0x01 if i == 0 else b for i, b in enumerate(signature))

        pubkey = override_pubkey if override_pubkey is not None else self.pubkey
        sig_blob = pubkey[:32].ljust(32, b"\x00") + signature[:64].ljust(64, b"\x00")
        assert len(sig_blob) == SIG_BLOB_LEN
        return signed_region + sig_blob


ED_SIG_LEN = 64
ED_PUBKEY_LEN = 32


# ---------------------------------------------------------------------------
# Verifier — mirrors the §6 halt-condition order exactly.
# ---------------------------------------------------------------------------


def verify_image(image: bytes, otp: Otp) -> HaltRecord:
    """Fail-closed first-stage verifier.

    Returns a HaltRecord. ACCEPT only if every check passes. The check order
    matches docs/security/boot-image-format.md §6 and tee-plan/02 §3 and is
    part of the firmware contract.
    """
    # Pre-flight device-level gates (§3 boot chain, before image parse).
    if otp.parity_fault:
        return HaltRecord(HALT_OTP_PARITY, boot_counter=otp.boot_counter)
    if otp.lifecycle_state == LC_SCRAP:
        return HaltRecord(HALT_LIFECYCLE_SCRAP, boot_counter=otp.boot_counter)

    if len(image) < HEADER_LEN + SIG_BLOB_LEN:
        # Truncated container: treat as a malformed header => magic mismatch.
        return HaltRecord(HALT_MAGIC_MISMATCH, boot_counter=otp.boot_counter)

    header_bytes = image[:HEADER_LEN]
    hdr = Header.unpack(header_bytes)

    # 1. magic
    if hdr.magic[:8] != MAGIC:
        return HaltRecord(HALT_MAGIC_MISMATCH, boot_counter=otp.boot_counter)

    # 2. header_version
    if hdr.header_version != SUPPORTED_HEADER_VERSION:
        return HaltRecord(
            HALT_HEADER_VERSION_UNSUPPORTED,
            image_type=hdr.image_type,
            boot_counter=otp.boot_counter,
            detail=struct.pack("<I", hdr.header_version & 0xFFFFFFFF),
        )

    # Bounds: payload + signature blob must fit the container.
    payload_end = HEADER_LEN + hdr.image_size
    if payload_end + SIG_BLOB_LEN != len(image):
        # Size field disagrees with the container; sha256 cannot match.
        return HaltRecord(
            HALT_PAYLOAD_SHA256_MISMATCH,
            image_type=hdr.image_type,
            boot_counter=otp.boot_counter,
        )

    payload = image[HEADER_LEN:payload_end]
    sig_blob = image[payload_end:]
    pubkey = sig_blob[0:ED_PUBKEY_LEN]
    signature = sig_blob[ED_PUBKEY_LEN : ED_PUBKEY_LEN + ED_SIG_LEN]

    # 3. payload_sha256
    if sha256(payload) != hdr.payload_sha256:
        return HaltRecord(
            HALT_PAYLOAD_SHA256_MISMATCH,
            image_type=hdr.image_type,
            boot_counter=otp.boot_counter,
        )

    # 4. signature verification over (header || payload)
    if not _ed25519_verify(signature, pubkey, header_bytes + payload):
        return HaltRecord(
            HALT_SIGNATURE_FAILURE,
            image_type=hdr.image_type,
            boot_counter=otp.boot_counter,
        )

    # 5. pubkey hash == OTP root (M1, first stage key-ladder pin)
    if sha256(pubkey) != otp.root_key_hash:
        return HaltRecord(
            HALT_PUBKEY_HASH_NOT_ROOT,
            image_type=hdr.image_type,
            boot_counter=otp.boot_counter,
        )

    # 6. rollback_index >= OTP rollback slot (M2)
    slot_value = otp.rollback_for(hdr.rollback_slot)
    if hdr.rollback_index < slot_value:
        return HaltRecord(
            HALT_ROLLBACK_DOWNGRADE,
            image_type=hdr.image_type,
            boot_counter=otp.boot_counter,
            detail=struct.pack("<II", hdr.rollback_index, slot_value),
        )

    # 7. key_id not revoked
    if otp.key_revoked(hdr.key_id):
        return HaltRecord(
            HALT_KEY_ID_REVOKED,
            image_type=hdr.image_type,
            boot_counter=otp.boot_counter,
            detail=struct.pack("<I", hdr.key_id),
        )

    # 8. lifecycle >= min_lifecycle_state
    if _lifecycle_rank(otp.lifecycle_state) < _lifecycle_rank(hdr.min_lifecycle_state):
        return HaltRecord(
            HALT_LIFECYCLE_BELOW_MIN,
            image_type=hdr.image_type,
            boot_counter=otp.boot_counter,
            detail=struct.pack("<II", otp.lifecycle_state, hdr.min_lifecycle_state),
        )

    return HaltRecord(HALT_NONE, image_type=hdr.image_type, boot_counter=otp.boot_counter)


def _ed25519_verify(signature: bytes, pubkey: bytes, msg: bytes) -> bool:
    if len(signature) != ED_SIG_LEN or len(pubkey) != ED_PUBKEY_LEN:
        return False
    return ed25519_verify_raw(signature, pubkey, msg)


# Lifecycle ordering for min_lifecycle_state comparison. The one-hot codes are
# monotonic in production-hardening rank, so a numeric rank derived from the
# bit position is the natural ">=" ordering (boot-image-format.md §5).
_LC_RANK = {
    LC_BLANK: 0,
    LC_DEV: 1,
    LC_MFG: 2,
    LC_LOCKED: 3,
    LC_RMA: 4,
    LC_SCRAP: 5,
}


def _lifecycle_rank(state: int) -> int:
    return _LC_RANK.get(state, -1)


# ---------------------------------------------------------------------------
# Debug-authentication model (debug-policy.md §3/§4/§5)
# ---------------------------------------------------------------------------

DEBUG_MSG_PREFIX = b"OPDBGv1"


def build_debug_auth_msg(device_uid: bytes, nonce: bytes, caps: int) -> bytes:
    """msg = "OPDBGv1" || device_uid(12B) || nonce(16B) || caps(4B,LE)."""
    return (
        DEBUG_MSG_PREFIX
        + device_uid[:12].ljust(12, b"\x00")
        + nonce[:16].ljust(16, b"\x00")
        + struct.pack("<I", caps & 0xFFFFFFFF)
    )


def evaluate_debug_unlock(
    otp: Otp,
    *,
    device_uid: bytes,
    nonce: bytes,
    caps: int,
    auth_signature: bytes | None,
    auth_pubkey: bytes | None,
) -> HaltRecord:
    """Decide whether a debug-unlock request is granted; fail-closed.

    Returns HALT_NONE only if debug is genuinely permitted for this lifecycle
    state and the signed challenge verifies. LOCKED never grants directly: the
    only path to debug is LOCKED->RMA, which requires rma_wipe_done (key
    erasure complete) per debug-policy.md §5.
    """
    state = otp.lifecycle_state

    # debug_disable kill switch forces denial regardless of state (§3).
    if otp.debug_disable != 0:
        return HaltRecord(HALT_DEBUG_LOCKED_NO_UNLOCK, boot_counter=otp.boot_counter)

    # DEV/BLANK: open, no auth (matrix §2). LOCKED: no direct unlock (§2/§5).
    if state in (LC_BLANK, LC_DEV):
        return HaltRecord(HALT_NONE, boot_counter=otp.boot_counter)
    if state == LC_LOCKED:
        return HaltRecord(HALT_DEBUG_LOCKED_NO_UNLOCK, boot_counter=otp.boot_counter)
    if state == LC_SCRAP:
        return HaltRecord(HALT_DEBUG_LOCKED_NO_UNLOCK, boot_counter=otp.boot_counter)

    # MFG/RMA: signed challenge required.
    if state == LC_RMA and not otp.rma_wipe_done:
        # Key erasure must complete before debug becomes satisfiable (§5).
        return HaltRecord(HALT_DEBUG_RMA_WIPE_INCOMPLETE, boot_counter=otp.boot_counter)

    if auth_signature is None or auth_pubkey is None:
        return HaltRecord(HALT_DEBUG_AUTH_SIGNATURE_FAILURE, boot_counter=otp.boot_counter)
    if sha256(auth_pubkey) != otp.debug_auth_pubkey_hash:
        return HaltRecord(HALT_DEBUG_AUTH_SIGNATURE_FAILURE, boot_counter=otp.boot_counter)
    msg = build_debug_auth_msg(device_uid, nonce, caps)
    if not _ed25519_verify(auth_signature, auth_pubkey, msg):
        return HaltRecord(HALT_DEBUG_AUTH_SIGNATURE_FAILURE, boot_counter=otp.boot_counter)
    return HaltRecord(HALT_NONE, boot_counter=otp.boot_counter)
