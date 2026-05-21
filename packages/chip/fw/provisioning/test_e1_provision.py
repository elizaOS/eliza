#!/usr/bin/env python3
"""Tests for the E1 RoT provisioning model (W9). Fail-closed invariants."""

from __future__ import annotations

import hashlib

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from e1_provision import (
    Lifecycle,
    ProvisioningError,
    ProvisioningSession,
    SecretStore,
    _demo_spec,
    load_fuse_map,
    provision_and_verify,
    sign_rma_auth,
)


@pytest.fixture
def fuse_map():
    return load_fuse_map()


@pytest.fixture
def spec_and_key():
    return _demo_spec()


def _provisioned_locked(fuse_map, spec):
    session, result = provision_and_verify(spec, fuse_map, functional_test_pass=True)
    return session, result


# --- round trip -------------------------------------------------------------


def test_full_provision_readback_roundtrip(fuse_map, spec_and_key):
    spec, _ = spec_and_key
    session, result = _provisioned_locked(fuse_map, spec)
    assert result.lifecycle == "LOCKED"
    assert result.readback_ok is True
    assert "creator_root_key" in result.programmed_partitions
    assert "owner_root_key" in result.programmed_partitions
    assert "debug_auth_pubkey_hash" in result.programmed_partitions
    assert "device_id" in result.programmed_partitions
    # Re-verify after lock; must still pass.
    session.readback_verify(spec)
    assert session.read_rollback() == 2


def test_programmed_value_matches_sha256_of_pubkey(fuse_map, spec_and_key):
    spec, _ = spec_and_key
    session, _ = _provisioned_locked(fuse_map, spec)
    part = fuse_map.by_id("creator_root_key")
    fused = b"".join(
        session.otp.read_word(part.offset + w).to_bytes(4, "big")
        for w in range(part.words)
    )
    assert fused == hashlib.sha256(spec.root_pubkey).digest()


# --- tamper / mismatch readback fails closed --------------------------------


def test_tampered_replica_majority_holds_but_disagreement_detected(fuse_map, spec_and_key):
    spec, _ = spec_and_key
    session, _ = _provisioned_locked(fuse_map, spec)
    part = fuse_map.by_id("creator_root_key")
    # Flip one bit in a single replica row: majority value is unchanged, but the
    # parity check must detect the disagreement and fail closed.
    session.otp.rows[0][part.offset] ^= 0x1
    with pytest.raises(ProvisioningError, match="parity fault"):
        session.readback_verify(spec)


def test_tampered_majority_fails_readback(fuse_map, spec_and_key):
    spec, _ = spec_and_key
    session, _ = _provisioned_locked(fuse_map, spec)
    part = fuse_map.by_id("device_id")
    # Corrupt the value in two replicas so the majority itself shifts.
    for replica in range(2):
        session.otp.rows[replica][part.offset] |= 0x40000000
    with pytest.raises(ProvisioningError, match="readback mismatch|parity fault"):
        session.readback_verify(spec)


# --- illegal transitions ----------------------------------------------------


def test_dev_to_locked_rejected(fuse_map):
    session = ProvisioningSession(fuse_map)
    session.transition(Lifecycle.DEV)
    with pytest.raises(ProvisioningError, match="illegal lifecycle transition"):
        session.transition(Lifecycle.LOCKED, functional_test_pass=True)


def test_mfg_to_locked_requires_functional_test(fuse_map, spec_and_key):
    spec, _ = spec_and_key
    session = ProvisioningSession(fuse_map)
    session.register_rma_key(spec.rma_pubkey, device_binding=spec.device_uid)
    session.begin_mfg()
    session.program_identity(spec)
    session.readback_verify(spec)
    with pytest.raises(ProvisioningError, match="functional-test-pass"):
        session.transition(Lifecycle.LOCKED, functional_test_pass=False)


def test_locked_to_rma_without_signed_auth_rejected(fuse_map, spec_and_key):
    spec, _ = spec_and_key
    session, _ = _provisioned_locked(fuse_map, spec)
    with pytest.raises(ProvisioningError, match="signed OEM authorization"):
        session.transition(Lifecycle.RMA)


def test_locked_to_rma_with_forged_signature_rejected(fuse_map, spec_and_key):
    spec, _ = spec_and_key
    session, _ = _provisioned_locked(fuse_map, spec)
    forged = b"\x00" * 64
    with pytest.raises(ProvisioningError, match="invalid OEM RMA authorization"):
        session.transition(Lifecycle.RMA, rma_auth=forged)


def test_rma_signature_from_wrong_key_rejected(fuse_map, spec_and_key):
    spec, _ = spec_and_key
    session, _ = _provisioned_locked(fuse_map, spec)
    attacker = Ed25519PrivateKey.generate()
    bad_sig = attacker.sign(b"E1-RMA-AUTHv1" + spec.device_uid)
    with pytest.raises(ProvisioningError, match="invalid OEM RMA authorization"):
        session.transition(Lifecycle.RMA, rma_auth=bad_sig)


# --- write-after-LOCKED -----------------------------------------------------


def test_write_locked_field_rejected_after_lock(fuse_map, spec_and_key):
    spec, _ = spec_and_key
    session, _ = _provisioned_locked(fuse_map, spec)
    with pytest.raises(ProvisioningError, match="write-locked|write window"):
        session._program_partition("creator_root_key", [0] * fuse_map.by_id("creator_root_key").words)


def test_identity_is_one_time_write(fuse_map, spec_and_key):
    spec, _ = spec_and_key
    session = ProvisioningSession(fuse_map)
    session.register_rma_key(spec.rma_pubkey, device_binding=spec.device_uid)
    session.begin_mfg()
    session.program_identity(spec)
    with pytest.raises(ProvisioningError, match="one-time write"):
        session.program_identity(spec)


# --- RMA scrub --------------------------------------------------------------


def test_rma_scrub_wipes_secrets_and_sets_wipe_done(fuse_map, spec_and_key):
    spec, rma_priv = spec_and_key
    session, _ = _provisioned_locked(fuse_map, spec)
    store = SecretStore(
        keymint_keyslots=b"k",
        user_data_wrapping_key=b"w",
        attestation_blobs=b"a",
    )
    session.secret_store = store
    assert store.has_live_secrets()
    auth = sign_rma_auth(rma_priv, spec.device_uid)
    session.transition(Lifecycle.RMA, rma_auth=auth)
    assert session.lifecycle == Lifecycle.RMA
    assert session.rma_wipe_done is True
    assert store.wiped is True
    assert not store.has_live_secrets()
    # Secret OTP-modeled partitions are scrubbed.
    part = fuse_map.by_id("creator_root_key")
    assert session.otp.read_word(part.offset) == 0


def test_debug_reenable_gated_on_wipe_done(fuse_map, spec_and_key):
    spec, rma_priv = spec_and_key
    session, _ = _provisioned_locked(fuse_map, spec)
    assert session.debug_reenable_permitted() is False  # LOCKED, no RMA
    store = SecretStore(keymint_keyslots=b"k", user_data_wrapping_key=b"w", attestation_blobs=b"a")
    session.secret_store = store
    auth = sign_rma_auth(rma_priv, spec.device_uid)
    session.transition(Lifecycle.RMA, rma_auth=auth)
    assert session.debug_reenable_permitted() is True


def test_no_unlock_path_preserves_user_data(fuse_map, spec_and_key):
    """Prove the only LOCKED-exit (besides SCRAP) destroys secrets first."""
    spec, rma_priv = spec_and_key

    # Enumerate every lifecycle target reachable from LOCKED.
    from e1_provision import _ALLOWED_TRANSITIONS

    targets = _ALLOWED_TRANSITIONS[Lifecycle.LOCKED]
    assert targets == frozenset({Lifecycle.RMA, Lifecycle.SCRAP})

    # RMA wipes secrets before debug re-enable becomes possible.
    session, _ = _provisioned_locked(fuse_map, spec)
    store = SecretStore(keymint_keyslots=b"k", user_data_wrapping_key=b"w", attestation_blobs=b"a")
    session.secret_store = store
    # Before RMA, debug re-enable is impossible and secrets are live.
    assert session.debug_reenable_permitted() is False
    assert store.has_live_secrets()
    session.transition(Lifecycle.RMA, rma_auth=sign_rma_auth(rma_priv, spec.device_uid))
    # After RMA, debug re-enable is permitted ONLY because secrets are gone.
    assert not store.has_live_secrets()
    assert session.debug_reenable_permitted() is True

    # SCRAP destroys the device entirely (terminal, no debug re-enable path).
    session2, _ = _provisioned_locked(fuse_map, spec)
    session2.transition(Lifecycle.SCRAP)
    assert session2.lifecycle == Lifecycle.SCRAP
    assert session2.debug_reenable_permitted() is False


def test_rma_rejected_if_owner_key_swapped(fuse_map, spec_and_key):
    """A device whose fused owner_root_key was tampered cannot enter RMA."""
    spec, rma_priv = spec_and_key
    session, _ = _provisioned_locked(fuse_map, spec)
    # Corrupt the fused owner_root_key across all replicas.
    part = fuse_map.by_id("owner_root_key")
    for replica in range(3):
        session.otp.rows[replica][part.offset] |= 0xFFFFFFFF
    with pytest.raises(ProvisioningError, match="owner_root_key does not match"):
        session.transition(Lifecycle.RMA, rma_auth=sign_rma_auth(rma_priv, spec.device_uid))


# --- rollback advance-only --------------------------------------------------


def test_rollback_advance_only(fuse_map, spec_and_key):
    spec, _ = spec_and_key
    session, _ = _provisioned_locked(fuse_map, spec)
    start = session.read_rollback()
    session.advance_rollback(start + 1)
    assert session.read_rollback() == start + 1
    with pytest.raises(ProvisioningError, match="cannot decrease"):
        session.advance_rollback(start)


def test_rollback_cannot_exceed_field_width(fuse_map, spec_and_key):
    spec, _ = spec_and_key
    session, _ = _provisioned_locked(fuse_map, spec)
    part = fuse_map.by_id("rollback_index")
    with pytest.raises(ProvisioningError, match="exceeds field width"):
        session.advance_rollback(part.bit_width + 1)


def test_run_model_end_to_end():
    from e1_provision import run_model

    result = run_model()
    assert result["lifecycle_after_provision"] == "LOCKED"
    assert result["readback_ok"] is True
    assert result["rma_wipe_done"] is True
    assert result["secrets_wiped"] is True
    assert result["debug_reenable_permitted"] is True
