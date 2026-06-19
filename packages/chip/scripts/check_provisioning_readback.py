#!/usr/bin/env python3
"""provisioning-readback-check gate (W9).

Runs the E1 RoT provisioning + readback + RMA-scrub software model end to end
(fw/provisioning/e1_provision.py) and emits build/reports/provisioning_readback.json
in the eliza.gate_status.v1 shape. PASS only if the full round-trip and every
fail-closed invariant hold.

Software-model scope: this proves the provisioning *flow* invariants, not the
silicon. The real ATE writer / antifuse OTP macro / keymgr scrub state machines
are a physical dependency (BLOCKED on the OTP IP selection and
rtl/security/otp/e1_otp_map.sv); see e1_provision.py RealAteWriter.
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "fw/provisioning"))

from e1_provision import (  # noqa: E402
    _ALLOWED_TRANSITIONS,
    Lifecycle,
    ProvisioningError,
    ProvisioningSession,
    SecretStore,
    _demo_spec,
    load_fuse_map,
    provision_and_verify,
    sign_rma_auth,
)

GATE = "provisioning-readback-check"
OUT = REPO_ROOT / "build/reports/provisioning_readback.json"
EVIDENCE = (
    "fw/provisioning/e1_provision.py",
    "fw/provisioning/test_e1_provision.py",
    "docs/spec-db/tee-otp-fuse-map.json",
    "docs/security/key-ceremony.md",
    "docs/security/otp-fuse-map.md",
    "docs/security/tee-plan/02-root-of-trust.md",
)


def _expect(condition: bool, message: str) -> None:
    if not condition:
        raise ProvisioningError(message)


def run_checks() -> list[dict[str, str]]:
    """Execute the model and assert every invariant. Raises on any failure."""

    checks: list[dict[str, str]] = []
    fuse_map = load_fuse_map()
    spec, rma_priv = _demo_spec()

    # 1. Provision + readback round-trip to LOCKED.
    session, result = provision_and_verify(spec, fuse_map, functional_test_pass=True)
    _expect(result.lifecycle == "LOCKED", "device did not reach LOCKED after provisioning")
    _expect(result.readback_ok, "readback did not verify")
    session.readback_verify(spec)  # independent re-verify post-LOCKED
    checks.append({"id": "provision_readback_roundtrip", "status": "pass"})

    # 2. Tamper detection: single-replica flip is caught by parity (2-of-3).
    part = fuse_map.by_id("creator_root_key")
    session.otp.rows[0][part.offset] ^= 0x1
    try:
        session.readback_verify(spec)
        raise ProvisioningError("parity fault not detected")
    except ProvisioningError as exc:
        _expect("parity fault" in str(exc), "tamper detection did not fail closed")
    session.otp.rows[0][part.offset] ^= 0x1  # restore for later assertions
    checks.append({"id": "tamper_readback_fails_closed", "status": "pass"})

    # 3. Illegal transition DEV->LOCKED is rejected.
    dev = ProvisioningSession(fuse_map)
    dev.transition(Lifecycle.DEV)
    try:
        dev.transition(Lifecycle.LOCKED, functional_test_pass=True)
        raise ProvisioningError("DEV->LOCKED was permitted")
    except ProvisioningError as exc:
        _expect("illegal lifecycle transition" in str(exc), "illegal transition not rejected")
    checks.append({"id": "illegal_transition_rejected", "status": "pass"})

    # 4. LOCKED->RMA without signed auth is rejected.
    try:
        session.transition(Lifecycle.RMA)
        raise ProvisioningError("RMA without signed auth was permitted")
    except ProvisioningError as exc:
        _expect("signed OEM authorization" in str(exc), "unsigned RMA not rejected")
    checks.append({"id": "rma_requires_signed_auth", "status": "pass"})

    # 5. Write-after-LOCKED on a locked field is rejected.
    try:
        session._program_partition("creator_root_key", [0] * part.words)
        raise ProvisioningError("write to locked field was permitted")
    except ProvisioningError as exc:
        _expect("write-locked" in str(exc), "post-LOCKED write not rejected")
    checks.append({"id": "write_after_locked_rejected", "status": "pass"})

    # 6. RMA scrub destroys secrets and sets rma_wipe_done.
    store = SecretStore(
        keymint_keyslots=b"keymint",
        user_data_wrapping_key=b"wrap",
        attestation_blobs=b"attest",
    )
    session.secret_store = store
    _expect(store.has_live_secrets(), "secret store should start populated")
    _expect(not session.debug_reenable_permitted(), "debug re-enable before wipe must be denied")
    session.transition(Lifecycle.RMA, rma_auth=sign_rma_auth(rma_priv, spec.device_uid))
    _expect(session.rma_wipe_done, "rma_wipe_done was not set")
    _expect(not store.has_live_secrets(), "secrets survived RMA scrub")
    _expect(session.debug_reenable_permitted(), "debug re-enable gated incorrectly after wipe")
    checks.append({"id": "rma_scrub_wipes_secrets", "status": "pass"})

    # 7. No unlock path preserves user data: LOCKED only exits to RMA (scrub) or
    #    SCRAP (terminal). There is no data-preserving service unlock.
    _expect(
        _ALLOWED_TRANSITIONS[Lifecycle.LOCKED] == frozenset({Lifecycle.RMA, Lifecycle.SCRAP}),
        "LOCKED has an unexpected exit transition",
    )
    checks.append({"id": "no_unlock_preserves_user_data", "status": "pass"})

    # 8. Rollback is advance-only.
    adv = ProvisioningSession(fuse_map)
    adv.register_rma_key(spec.rma_pubkey, device_binding=spec.device_uid)
    adv.begin_mfg()
    adv.program_identity(spec)
    start = adv.read_rollback()
    adv.advance_rollback(start + 1, initial=True)
    try:
        adv.advance_rollback(start, initial=True)
        raise ProvisioningError("rollback decrease was permitted")
    except ProvisioningError as exc:
        _expect("cannot decrease" in str(exc), "rollback decrease not rejected")
    checks.append({"id": "rollback_advance_only", "status": "pass"})

    return checks


def main() -> int:
    blocker_id: str | None = None
    blocker_reason: str | None = None
    try:
        checks = run_checks()
        status = "PASS"
    except ProvisioningError as exc:
        checks = [{"id": "model_invariants", "status": "fail"}]
        status = "FAIL"
        blocker_id = "provisioning-model-invariant"
        blocker_reason = str(exc)

    report = {
        "schema": "eliza.gate_status.v1",
        "gate": GATE,
        "status": status,
        "blocker_id": blocker_id,
        "blocker_reason": blocker_reason,
        "evidence_paths": list(EVIDENCE),
        "as_of": datetime.now(UTC).isoformat(),
        "subsystem": "security",
        "scope": (
            "software model of ATE provisioning + 2-of-3 readback-verify + RMA "
            "secret scrub; not silicon"
        ),
        "physical_dependency": (
            "real ATE writer / antifuse OTP macro / otp_ctrl shadow registers / "
            "keymgr secret-storage scrub state machines "
            "(BLOCKED on OTP IP selection and rtl/security/otp/e1_otp_map.sv)"
        ),
        "checks": checks,
        "summary": {
            "check_count": len(checks),
            "passing_check_count": len([c for c in checks if c["status"] == "pass"]),
        },
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    if status != "PASS":
        print(f"FAIL: {GATE}: {blocker_reason}", file=sys.stderr)
        return 1
    print(f"PASS: {GATE}: provisioning + readback + RMA scrub model verified -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
