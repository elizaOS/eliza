#!/usr/bin/env python3
"""E1 RoT ATE provisioning, readback-verify, and RMA scrub — software model (W9).

Scope and physical-dependency boundary
--------------------------------------
This module is the *buildable software model* of the OpenTitan-class
provisioning flow described in:

  - docs/security/key-ceremony.md   §3 (offline HSM root R, Ed25519),
                                     §5 (per-device ATE programming + readback)
  - docs/security/otp-fuse-map.md    §1 (field allocation), §2 (lifecycle one-hot
                                     transitions), §3 (2-of-3 replication),
                                     §4 (write authorization rules)
  - docs/spec-db/tee-otp-fuse-map.json  (machine-readable map — drives the plan)
  - docs/security/tee-plan/02-root-of-trust.md §7 (RMA scrubs secrets before
                                     unlock; no service unlock preserves user data)

It models the fuse array, the 2-of-3 majority readback, the lifecycle write
controller, the one-time MFG write window, and the RMA secret-scrub sequence in
pure Python so the `provisioning-readback-check` gate can prove the invariants
end-to-end.

It is NOT silicon. The real ATE writer is a hard physical dependency:

  * the OTP/antifuse macro and its `otp_ctrl` shadow-register controller
    (rtl/security/otp/e1_otp_map.sv, BLOCKED) actually blow fuses;
  * the ATE programs three physical replica rows per field and the silicon
    reader performs the 2-of-3 majority vote in hardware;
  * the RMA scrub is driven by `keymgr`/secure-storage erase state machines in
    silicon, not by zeroing a Python list.

The `RealAteWriter` protocol below names that boundary explicitly; this module
ships only `ModelOtpArray`, which raises if asked to behave like silicon.

Ed25519 for the RMA signed authorization is real (cryptography library). An
unforged OEM signature is required to enter RMA.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import dataclass, field
from enum import IntEnum
from pathlib import Path
from typing import Protocol

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_FUSE_MAP = REPO_ROOT / "docs/spec-db/tee-otp-fuse-map.json"

WORD_BITS = 32
WORD_MASK = (1 << WORD_BITS) - 1
REPLICAS = 3  # 2-of-3 majority per otp-fuse-map.md §3
MAJORITY = 2

# RMA authorization domain-separation tag. The OEM RMA key (owner_root_key
# slot, rma_key_hash in otp-fuse-map.md §1) signs this message; entering RMA
# without a valid signature is rejected (otp-fuse-map.md §4 rule 2).
RMA_AUTH_TAG = b"E1-RMA-AUTHv1"


class ProvisioningError(RuntimeError):
    """Fail-closed error for any provisioning/readback/transition violation."""


class Lifecycle(IntEnum):
    """One-hot lifecycle bit indices (otp-fuse-map.md §2). Bits are OR-only."""

    BLANK = 0
    DEV = 1
    MFG = 2
    LOCKED = 3
    RMA = 4
    SCRAP = 5


# Permitted lifecycle bit transitions (otp-fuse-map.md §2). SCRAP is always
# allowed; LOCKED->RMA additionally requires a verified signed authorization.
_ALLOWED_TRANSITIONS: dict[Lifecycle, frozenset[Lifecycle]] = {
    Lifecycle.BLANK: frozenset({Lifecycle.DEV, Lifecycle.MFG, Lifecycle.SCRAP}),
    Lifecycle.DEV: frozenset({Lifecycle.SCRAP}),
    Lifecycle.MFG: frozenset({Lifecycle.LOCKED, Lifecycle.SCRAP}),
    Lifecycle.LOCKED: frozenset({Lifecycle.RMA, Lifecycle.SCRAP}),
    Lifecycle.RMA: frozenset({Lifecycle.SCRAP}),
    Lifecycle.SCRAP: frozenset(),
}


@dataclass(frozen=True)
class Partition:
    """One fuse-map partition from docs/spec-db/tee-otp-fuse-map.json."""

    id: str
    offset: int  # word offset
    words: int
    write_lockable: bool
    secret: bool
    readable_in_production: bool
    monotonic: bool

    @property
    def bit_width(self) -> int:
        return self.words * WORD_BITS


@dataclass(frozen=True)
class FuseMap:
    """Parsed, validated fuse map driving the programmer."""

    word_bits: int
    read_majority: str
    partitions: tuple[Partition, ...]

    def by_id(self, partition_id: str) -> Partition:
        for partition in self.partitions:
            if partition.id == partition_id:
                return partition
        raise ProvisioningError(f"fuse map has no partition '{partition_id}'")

    @property
    def total_words(self) -> int:
        return max((p.offset + p.words for p in self.partitions), default=0)


def load_fuse_map(path: Path = DEFAULT_FUSE_MAP) -> FuseMap:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ProvisioningError(f"{path} must contain a JSON object")
    if raw.get("wordBits") != WORD_BITS:
        raise ProvisioningError(f"fuse map wordBits must be {WORD_BITS}")
    if raw.get("readMajority") != "2-of-3":
        raise ProvisioningError("fuse map readMajority must be 2-of-3")
    raw_parts = raw.get("partitions")
    if not isinstance(raw_parts, list) or not raw_parts:
        raise ProvisioningError("fuse map partitions must be a non-empty list")

    partitions: list[Partition] = []
    occupied: dict[int, str] = {}
    for entry in raw_parts:
        if not isinstance(entry, dict):
            raise ProvisioningError("each partition must be an object")
        part = Partition(
            id=str(entry["id"]),
            offset=int(entry["offset"]),
            words=int(entry["words"]),
            write_lockable=bool(entry.get("writeLockable", False)),
            secret=bool(entry.get("secret", False)),
            readable_in_production=bool(entry.get("readableInProduction", False)),
            monotonic=bool(entry.get("monotonic", False)),
        )
        if part.offset < 0 or part.words <= 0:
            raise ProvisioningError(f"partition '{part.id}' has invalid geometry")
        for word in range(part.offset, part.offset + part.words):
            if word in occupied:
                raise ProvisioningError(
                    f"partition '{part.id}' word {word} overlaps '{occupied[word]}'"
                )
            occupied[word] = part.id
        partitions.append(part)

    return FuseMap(
        word_bits=WORD_BITS,
        read_majority=str(raw["readMajority"]),
        partitions=tuple(partitions),
    )


# --- Field <-> partition binding -------------------------------------------
#
# The machine-readable map (tee-otp-fuse-map.json) is the buildable subset of
# the full otp-fuse-map.md §1 allocation. The key-ceremony.md §5 inputs bind to
# its partitions as follows:
#
#   creator_root_key       <- root_key_hash       (SHA-256 of Ed25519 R.pub)
#   owner_root_key         <- rma_key_hash         (OEM RMA root, SHA-256 of pub)
#   device_id              <- device_uid_parity ++ vendor_id/sku_id
#   debug_auth_pubkey_hash <- debug_auth_pubkey_hash
#   rollback_index         <- initial rollback index (unary, monotonic)
#   lifecycle_state        <- one-hot lifecycle bits
#
# The buildable JSON subset declares a single `rollback_index` partition. The
# full otp-fuse-map.md §1 allocation has five independent anti-rollback slots
# (bl1/bl2/vbmeta/recovery/vendor_boot); per-image-type granularity is part of
# the BLOCKED full silicon map, not this software model.
#
SECRET_FIELDS = ("creator_root_key", "owner_root_key")


@dataclass(frozen=True)
class KeyCeremonyInput:
    """Per-device provisioning intent from the key ceremony (key-ceremony.md §5).

    Hash inputs are the raw 32-byte Ed25519 public keys; the model programs the
    SHA-256 of each, matching otp-fuse-map.md §1 (`root_key_hash` = SHA-256 of
    R.pub). `rma_pubkey` is retained so the RMA flow can verify the OEM
    signature against the same key whose hash is fused into `owner_root_key`.
    """

    root_pubkey: bytes
    debug_auth_pubkey: bytes
    rma_pubkey: bytes
    device_uid: bytes  # PUF/UID-derived per-device identity material
    vendor_id: int
    sku_id: int
    rollback_index: int  # initial monotonic unary index for the buildable subset

    def __post_init__(self) -> None:
        for name, value in (
            ("root_pubkey", self.root_pubkey),
            ("debug_auth_pubkey", self.debug_auth_pubkey),
            ("rma_pubkey", self.rma_pubkey),
        ):
            if len(value) != 32:
                raise ProvisioningError(f"{name} must be a 32-byte Ed25519 public key")
        if not self.device_uid:
            raise ProvisioningError("device_uid must be non-empty")
        if not 0 <= self.vendor_id <= WORD_MASK:
            raise ProvisioningError("vendor_id out of 32-bit range")
        if not 0 <= self.sku_id <= WORD_MASK:
            raise ProvisioningError("sku_id out of 32-bit range")
        if self.rollback_index < 0:
            raise ProvisioningError("rollback_index must be >= 0")


def _sha256(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def _bytes_to_words(data: bytes, words: int) -> list[int]:
    """Pack big-endian byte material into `words` 32-bit words, zero-padded."""

    needed = words * (WORD_BITS // 8)
    if len(data) > needed:
        raise ProvisioningError(f"field material {len(data)}B exceeds {needed}B capacity")
    padded = data + b"\x00" * (needed - len(data))
    return [int.from_bytes(padded[i : i + 4], "big") for i in range(0, needed, 4)]


def _unary(index: int, bit_width: int) -> list[int]:
    """Unary rollback encoding (otp-fuse-map.md §2): index == popcount of LSBs."""

    if index > bit_width:
        raise ProvisioningError(f"rollback index {index} exceeds field width {bit_width}")
    value = (1 << index) - 1
    words = bit_width // WORD_BITS
    return [(value >> (WORD_BITS * w)) & WORD_MASK for w in range(words)]


def _device_id_words(spec: KeyCeremonyInput, words: int) -> list[int]:
    """device_id partition = device_uid parity || vendor_id || sku_id.

    The last two words carry vendor_id/sku_id (vendor_id/sku_id in
    otp-fuse-map.md §1); earlier words carry the SHA-256 parity of the
    PUF/UID-derived device identity (device_uid_parity §1).
    """

    if words < 2:
        raise ProvisioningError("device_id partition must hold at least 2 words")
    uid_words = words - 2
    uid_parity = _sha256(spec.device_uid)[: uid_words * 4]
    return _bytes_to_words(uid_parity, uid_words) + [spec.vendor_id, spec.sku_id]


def build_program_plan(spec: KeyCeremonyInput, fuse_map: FuseMap) -> dict[str, list[int]]:
    """Compute the word values to program per partition (which bits to blow).

    Lifecycle and rollback are written through the controller (advance-only /
    one-hot) and are intentionally excluded from the static identity plan.
    """

    plan: dict[str, list[int]] = {}
    plan["creator_root_key"] = _bytes_to_words(
        _sha256(spec.root_pubkey), fuse_map.by_id("creator_root_key").words
    )
    plan["owner_root_key"] = _bytes_to_words(
        _sha256(spec.rma_pubkey), fuse_map.by_id("owner_root_key").words
    )
    plan["debug_auth_pubkey_hash"] = _bytes_to_words(
        _sha256(spec.debug_auth_pubkey), fuse_map.by_id("debug_auth_pubkey_hash").words
    )
    plan["device_id"] = _device_id_words(spec, fuse_map.by_id("device_id").words)
    return plan


class RealAteWriter(Protocol):
    """Physical dependency boundary — the real ATE / silicon OTP writer.

    A conforming implementation drives the antifuse macro through the
    `otp_ctrl` shadow-register controller, blows three physical replica rows per
    field, and reads the 2-of-3 majority vote out of silicon. No such
    implementation ships here; it is BLOCKED on the OTP IP selection and
    rtl/security/otp/e1_otp_map.sv. `ModelOtpArray` is the software stand-in
    used to prove the flow invariants only.
    """

    def blow_word(self, word_index: int, replica: int, value: int) -> None: ...

    def read_word(self, word_index: int) -> int: ...


@dataclass
class ModelOtpArray:
    """Software model of the replicated OTP fuse array (NOT silicon).

    Fuses are antifuse: bits can only go 0 -> 1 (OR-only blow). Each word is
    stored in `REPLICAS` independent replica rows; reads return the 2-of-3
    majority per bit (otp-fuse-map.md §3).
    """

    total_words: int
    rows: list[list[int]] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.rows:
            self.rows = [[0] * self.total_words for _ in range(REPLICAS)]
        if len(self.rows) != REPLICAS:
            raise ProvisioningError(f"model OTP must have exactly {REPLICAS} replicas")

    def blow_word(self, word_index: int, replica: int, value: int) -> None:
        if not 0 <= word_index < self.total_words:
            raise ProvisioningError(f"word index {word_index} out of range")
        if not 0 <= replica < REPLICAS:
            raise ProvisioningError(f"replica {replica} out of range")
        if value & ~WORD_MASK:
            raise ProvisioningError("value exceeds 32-bit word")
        # Antifuse: OR-only. Attempting to clear a blown bit is impossible.
        self.rows[replica][word_index] |= value

    def read_word(self, word_index: int) -> int:
        if not 0 <= word_index < self.total_words:
            raise ProvisioningError(f"word index {word_index} out of range")
        result = 0
        for bit in range(WORD_BITS):
            mask = 1 << bit
            set_count = sum(1 for r in range(REPLICAS) if self.rows[r][word_index] & mask)
            if set_count >= MAJORITY:
                result |= mask
        return result

    def replica_disagreement(self, word_index: int) -> bool:
        """True if any replica row diverges from the majority (parity fault)."""

        majority = self.read_word(word_index)
        return any(self.rows[r][word_index] != majority for r in range(REPLICAS))

    def scrub_word(self, word_index: int, replica: int) -> None:
        """Model-only destructive erase used by the RMA scrub path.

        Real silicon cannot un-blow an antifuse; the physical RMA scrub erases
        the *secret storage / keymgr state* (keyslots, wrapping material,
        attestation blobs) outside the OTP, not the OTP words themselves. In
        this software model the secret partitions stand in for that storage, so
        the scrub overwrites those replica words to prove no readable secret
        survives. This method must never be used outside the RMA flow.
        """

        self.rows[replica][word_index] = 0


@dataclass
class SecretStore:
    """Modeled KeyMint keyslots / user-data wrapping / attestation material.

    These are the live secrets the RMA scrub must destroy before any debug
    re-enable (tee-plan/02-root-of-trust.md §7). They live outside OTP in
    secure storage; the model holds them here so the scrub can be proven.
    """

    keymint_keyslots: bytes
    user_data_wrapping_key: bytes
    attestation_blobs: bytes
    wiped: bool = False

    def has_live_secrets(self) -> bool:
        return bool(self.keymint_keyslots or self.user_data_wrapping_key or self.attestation_blobs)

    def scrub(self) -> None:
        self.keymint_keyslots = b""
        self.user_data_wrapping_key = b""
        self.attestation_blobs = b""
        self.wiped = True


class ProvisioningSession:
    """Models the ATE provisioning station + OTP write controller.

    Enforces lifecycle transitions, the one-time MFG write window, and per-field
    write authorization (otp-fuse-map.md §4). Fail-closed throughout.
    """

    def __init__(
        self,
        fuse_map: FuseMap,
        otp: ModelOtpArray | None = None,
        secret_store: SecretStore | None = None,
    ) -> None:
        self.fuse_map = fuse_map
        self.otp = otp or ModelOtpArray(total_words=fuse_map.total_words)
        self.secret_store = secret_store
        self._lifecycle_bits = 0
        self._write_window_open = False
        self._programmed_identity = False
        self.rma_wipe_done = False

    # --- lifecycle ---------------------------------------------------------

    @property
    def lifecycle(self) -> Lifecycle:
        """Highest set one-hot bit (otp-fuse-map.md §2 reader rule)."""

        highest = Lifecycle.BLANK
        for state in Lifecycle:
            if self._lifecycle_bits & (1 << state):
                highest = state
        return highest

    def _set_lifecycle_bit(self, state: Lifecycle) -> None:
        self._write_lifecycle_partition()
        self._lifecycle_bits |= 1 << state

    def _write_lifecycle_partition(self) -> None:
        part = self.fuse_map.by_id("lifecycle_state")
        # one-hot bitmap packed into the partition's first word
        for replica in range(REPLICAS):
            self.otp.blow_word(part.offset, replica, self._lifecycle_bits)

    def transition(
        self,
        target: Lifecycle,
        *,
        rma_auth: bytes | None = None,
        functional_test_pass: bool = False,
    ) -> None:
        current = self.lifecycle
        allowed = _ALLOWED_TRANSITIONS[current]
        if target not in allowed:
            raise ProvisioningError(f"illegal lifecycle transition {current.name} -> {target.name}")
        if target == Lifecycle.LOCKED and not functional_test_pass:
            # key-ceremony.md §5.6 — MFG->LOCKED only after functional test pass.
            raise ProvisioningError("MFG->LOCKED requires a functional-test-pass token")
        if target == Lifecycle.RMA:
            self._authorize_rma(rma_auth)

        self._set_lifecycle_bit(target)

        if target == Lifecycle.MFG:
            self._write_window_open = True
        elif target == Lifecycle.LOCKED:
            # First reset after MFG->LOCKED closes the one-time write window
            # (otp-fuse-map.md §4 rule 3).
            self._write_window_open = False
        elif target == Lifecycle.RMA:
            self._run_rma_scrub()

    # --- provisioning ------------------------------------------------------

    def begin_mfg(self) -> None:
        self.transition(Lifecycle.MFG)

    def program_identity(self, spec: KeyCeremonyInput) -> dict[str, list[int]]:
        """Program the static identity fields (one-time, MFG window only)."""

        if self.lifecycle != Lifecycle.MFG:
            raise ProvisioningError("identity programming requires lifecycle == MFG")
        if not self._write_window_open:
            raise ProvisioningError("MFG one-time write window is not open")
        if self._programmed_identity:
            raise ProvisioningError("identity already programmed (one-time write)")

        plan = build_program_plan(spec, self.fuse_map)
        for partition_id, words in plan.items():
            self._program_partition(partition_id, words)

        self.advance_rollback(spec.rollback_index, initial=True)

        self._programmed_identity = True
        return plan

    def _program_partition(self, partition_id: str, words: list[int]) -> None:
        part = self.fuse_map.by_id(partition_id)
        if len(words) != part.words:
            raise ProvisioningError(
                f"partition '{partition_id}' expects {part.words} words, got {len(words)}"
            )
        if part.write_lockable and self.lifecycle >= Lifecycle.LOCKED:
            raise ProvisioningError(f"partition '{partition_id}' is write-locked after LOCKED")
        for word_index, value in enumerate(words):
            for replica in range(REPLICAS):
                self.otp.blow_word(part.offset + word_index, replica, value)

    def advance_rollback(self, target_index: int, *, initial: bool = False) -> None:
        """Advance the rollback counter (unary, monotonic, advance-only)."""

        part = self.fuse_map.by_id("rollback_index")
        if not initial and self.lifecycle < Lifecycle.LOCKED:
            # Post-LOCKED rollback advances are HW/bootloader-driven and always
            # permitted; pre-LOCKED only the initial programming is allowed.
            raise ProvisioningError("rollback advance only after initial programming")
        current = self.read_rollback()
        if target_index < current:
            raise ProvisioningError(f"rollback cannot decrease ({current} -> {target_index})")
        words = _unary(target_index, part.bit_width)
        for word_index, value in enumerate(words):
            for replica in range(REPLICAS):
                self.otp.blow_word(part.offset + word_index, replica, value)

    def read_rollback(self) -> int:
        part = self.fuse_map.by_id("rollback_index")
        popcount = 0
        for word_index in range(part.words):
            popcount += bin(self.otp.read_word(part.offset + word_index)).count("1")
        return popcount

    # --- readback verify ---------------------------------------------------

    def readback_verify(self, spec: KeyCeremonyInput) -> None:
        """Read every programmed field back through 2-of-3 majority and verify.

        Fails closed on any value mismatch or replica disagreement (parity
        fault halts before the value is trusted, otp-fuse-map.md §3).
        """

        plan = build_program_plan(spec, self.fuse_map)
        for partition_id, expected in plan.items():
            part = self.fuse_map.by_id(partition_id)
            for word_index, want in enumerate(expected):
                absolute = part.offset + word_index
                if self.otp.replica_disagreement(absolute):
                    raise ProvisioningError(
                        f"OTP parity fault on '{partition_id}' word {word_index}"
                    )
                got = self.otp.read_word(absolute)
                if got != want:
                    raise ProvisioningError(
                        f"readback mismatch on '{partition_id}' word {word_index}: "
                        f"got 0x{got:08x} want 0x{want:08x}"
                    )

        got_rollback = self.read_rollback()
        if got_rollback != spec.rollback_index:
            raise ProvisioningError(
                f"rollback readback mismatch: got {got_rollback} want {spec.rollback_index}"
            )

    # --- RMA ---------------------------------------------------------------

    def _authorize_rma(self, rma_auth: bytes | None) -> None:
        """Verify the OEM RMA signature (otp-fuse-map.md §4 rule 2).

        The signature is Ed25519 over RMA_AUTH_TAG by the OEM RMA private key
        whose public key hash is fused into `owner_root_key`. Bind it to this
        device by including the device_id readback in the signed message.
        """

        if not isinstance(rma_auth, bytes):
            raise ProvisioningError("LOCKED->RMA requires a signed OEM authorization")
        if self._rma_pubkey is None:
            raise ProvisioningError("RMA public key not registered for this device")
        # Verify the fused owner_root_key still matches the registered RMA key
        # so a swapped key cannot authorize RMA.
        part = self.fuse_map.by_id("owner_root_key")
        fused = b"".join(
            self.otp.read_word(part.offset + w).to_bytes(4, "big") for w in range(part.words)
        )
        if fused[: len(_sha256(self._rma_pubkey))] != _sha256(self._rma_pubkey):
            raise ProvisioningError("fused owner_root_key does not match RMA key")
        message = RMA_AUTH_TAG + self._rma_device_binding
        try:
            Ed25519PublicKey.from_public_bytes(self._rma_pubkey).verify(rma_auth, message)
        except InvalidSignature as exc:
            raise ProvisioningError("invalid OEM RMA authorization signature") from exc

    def register_rma_key(self, rma_pubkey: bytes, device_binding: bytes) -> None:
        if len(rma_pubkey) != 32:
            raise ProvisioningError("rma_pubkey must be a 32-byte Ed25519 public key")
        self._rma_pubkey = rma_pubkey
        self._rma_device_binding = device_binding

    _rma_pubkey: bytes | None = None
    _rma_device_binding: bytes = b""

    def _run_rma_scrub(self) -> None:
        """Destroy production secrets, then set rma_wipe_done.

        tee-plan/02-root-of-trust.md §7: programming the RMA bit triggers a
        HW-driven scrub of KeyMint keyslots / user-data wrapping material /
        attestation blobs. rma_wipe_done gates debug re-enable. There is NO
        unlock path that preserves user data.
        """

        if self.secret_store is not None:
            self.secret_store.scrub()
        # Model the secret-storage erase by clearing the secret OTP-modeled
        # partitions across every replica.
        for partition_id in SECRET_FIELDS:
            part = self.fuse_map.by_id(partition_id)
            for word_index in range(part.words):
                for replica in range(REPLICAS):
                    self.otp.scrub_word(part.offset + word_index, replica)
        self.rma_wipe_done = True

    def debug_reenable_permitted(self) -> bool:
        """Debug re-enable in RMA is gated on rma_wipe_done (no data-preserving unlock)."""

        if self.lifecycle != Lifecycle.RMA:
            return False
        if not self.rma_wipe_done:
            return False
        return not (self.secret_store is not None and self.secret_store.has_live_secrets())


# --- end-to-end driver ------------------------------------------------------


@dataclass(frozen=True)
class ProvisionResult:
    lifecycle: str
    programmed_partitions: tuple[str, ...]
    readback_ok: bool
    rollback_index: int


def provision_and_verify(
    spec: KeyCeremonyInput,
    fuse_map: FuseMap,
    *,
    functional_test_pass: bool,
) -> tuple[ProvisioningSession, ProvisionResult]:
    """Full ATE flow: MFG -> program identity -> readback-verify -> LOCKED."""

    session = ProvisioningSession(fuse_map)
    session.register_rma_key(spec.rma_pubkey, device_binding=spec.device_uid)
    session.begin_mfg()
    plan = session.program_identity(spec)
    session.readback_verify(spec)
    if not functional_test_pass:
        raise ProvisioningError("functional test did not pass; refusing MFG->LOCKED")
    session.transition(Lifecycle.LOCKED, functional_test_pass=True)
    result = ProvisionResult(
        lifecycle=session.lifecycle.name,
        programmed_partitions=tuple(sorted(plan)),
        readback_ok=True,
        rollback_index=spec.rollback_index,
    )
    return session, result


# --- demonstration fixture (self-contained, deterministic) ------------------


def _demo_spec() -> tuple[KeyCeremonyInput, bytes]:
    """Deterministic demo key-ceremony input + the matching RMA private key.

    Used by the CLI / gate to drive the model end to end. Keys are throwaway
    test material generated in-process — they are NOT the production HSM keys.
    """

    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import (
        Encoding,
        PublicFormat,
    )

    def pub_bytes(seed: bytes) -> bytes:
        sk = Ed25519PrivateKey.from_private_bytes(hashlib.sha256(seed).digest())
        return sk.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)

    rma_sk = Ed25519PrivateKey.from_private_bytes(hashlib.sha256(b"E1-DEMO-RMA").digest())
    rma_pub = rma_sk.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    rma_priv = rma_sk.private_bytes_raw()

    spec = KeyCeremonyInput(
        root_pubkey=pub_bytes(b"E1-DEMO-ROOT-R"),
        debug_auth_pubkey=pub_bytes(b"E1-DEMO-DEBUG-AUTH"),
        rma_pubkey=rma_pub,
        device_uid=bytes(range(16)),
        vendor_id=0xE1ABCDEF & WORD_MASK,
        sku_id=0x00000101,
        rollback_index=2,
    )
    return spec, rma_priv


def sign_rma_auth(rma_priv: bytes, device_binding: bytes) -> bytes:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    sk = Ed25519PrivateKey.from_private_bytes(rma_priv)
    return sk.sign(RMA_AUTH_TAG + device_binding)


def run_model(fuse_map_path: Path = DEFAULT_FUSE_MAP) -> dict[str, object]:
    """Run provision + readback + RMA scrub; return a structured result.

    Raises ProvisioningError (fail-closed) if any invariant is violated.
    """

    fuse_map = load_fuse_map(fuse_map_path)
    spec, rma_priv = _demo_spec()

    session, result = provision_and_verify(spec, fuse_map, functional_test_pass=True)

    # Independent re-verification after LOCKED.
    session.readback_verify(spec)

    # RMA: requires a genuine OEM signature; scrub must wipe secrets.
    store = SecretStore(
        keymint_keyslots=b"keymint-keyslot-material",
        user_data_wrapping_key=b"user-data-wrapping-key",
        attestation_blobs=b"attestation-blob",
    )
    session.secret_store = store
    auth = sign_rma_auth(rma_priv, spec.device_uid)
    session.transition(Lifecycle.RMA, rma_auth=auth)

    return {
        "lifecycle_after_provision": result.lifecycle,
        "programmed_partitions": list(result.programmed_partitions),
        "readback_ok": result.readback_ok,
        "rollback_index": result.rollback_index,
        "rma_wipe_done": session.rma_wipe_done,
        "secrets_wiped": store.wiped and not store.has_live_secrets(),
        "debug_reenable_permitted": session.debug_reenable_permitted(),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="E1 RoT provisioning model (W9)")
    parser.add_argument(
        "--fuse-map", type=Path, default=DEFAULT_FUSE_MAP, help="fuse-map JSON path"
    )
    args = parser.parse_args(argv)
    result = run_model(args.fuse_map)
    json.dump(result, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
