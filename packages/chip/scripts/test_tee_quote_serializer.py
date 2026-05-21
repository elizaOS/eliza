#!/usr/bin/env python3
"""Tests for the TeeEvidence quote serializer (C5) and the npuProtected gate.

Positive: the assembled evidence from a measured-launch chain validates against
check_tee_attestation_evidence. Negative: asserting npuProtected without the
monitor or npuFirmware measurement is rejected, and a tampered measured-launch
input changes the os digest (the data-unavailability negative path of 7.2).
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from tee.teeevidence_quote import (  # noqa: E402
    LaunchChain,
    LaunchConditions,
    QuoteRequest,
    assemble,
    fold_os_measurement,
)

_check_path = ROOT / "scripts/check_tee_attestation_evidence.py"
_spec = importlib.util.spec_from_file_location("check_tee_attestation_evidence", _check_path)
if _spec is None or _spec.loader is None:
    raise SystemExit(f"unable to import {_check_path}")
check_evidence = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = check_evidence
_spec.loader.exec_module(check_evidence)


def _chain(*, with_npu: bool) -> LaunchChain:
    return LaunchChain(
        rom=b"rom",
        lifecycle=b"lifecycle",
        bl1=b"bl1",
        bl2=b"bl2",
        tsm=b"tsm-image",
        kernel=b"kernel",
        initramfs=b"initramfs",
        dtb=b"dtb",
        policy=b"policy-blob",
        device_policy=b"iopmp-source-id-map",
        agent=b"agent-image",
        npu_firmware=b"npu-fw" if with_npu else None,
        npu_queue_policy=b"npu-queue-policy" if with_npu else None,
        model_weights=b"weights" if with_npu else None,
    )


def _request() -> QuoteRequest:
    return QuoteRequest(
        nonce="verifier-nonce-abc",
        ephemeral_pubkey=b"ephemeral-pubkey",
        timestamp="2026-05-21T00:00:00.000Z",
    )


def test_protected_inference_evidence_validates() -> None:
    conditions = LaunchConditions(
        secure_boot_verified=True,
        lifecycle_locked=True,
        memory_encryption_active=True,
        iopmp_programmed=True,
        npu_private_queue_owned=True,
    )
    evidence = assemble(_chain(with_npu=True), conditions, _request())
    assert evidence["claims"]["npuProtected"] is True
    errors = check_evidence.validate(evidence)
    if errors:
        raise AssertionError(errors)
    print("PASS protected-inference evidence validates")


def test_npu_protected_requires_monitor_and_npu_firmware() -> None:
    conditions = LaunchConditions(
        secure_boot_verified=True,
        lifecycle_locked=True,
        memory_encryption_active=True,
        iopmp_programmed=True,
        npu_private_queue_owned=True,
    )
    evidence = assemble(_chain(with_npu=True), conditions, _request())
    measurements = evidence["measurements"]
    assert isinstance(measurements, dict)
    measurements.pop("monitor")
    measurements.pop("npuFirmware")
    errors = check_evidence.validate(evidence)
    if not any("monitor" in error for error in errors):
        raise AssertionError(f"expected monitor requirement, got {errors}")
    if not any("npuFirmware" in error for error in errors):
        raise AssertionError(f"expected npuFirmware requirement, got {errors}")
    print("PASS npuProtected requires monitor and npuFirmware")


def test_no_npu_path_omits_npu_measurements() -> None:
    conditions = LaunchConditions(
        secure_boot_verified=True,
        lifecycle_locked=True,
        memory_encryption_active=True,
        iopmp_programmed=True,
        npu_private_queue_owned=False,
    )
    evidence = assemble(_chain(with_npu=False), conditions, _request())
    assert evidence["claims"]["npuProtected"] is False
    measurements = evidence["measurements"]
    assert isinstance(measurements, dict)
    assert "npuFirmware" not in measurements
    errors = check_evidence.validate(evidence)
    if errors:
        raise AssertionError(errors)
    print("PASS no-NPU path omits npuFirmware and validates")


def test_tampered_os_changes_measurement() -> None:
    clean = fold_os_measurement(_chain(with_npu=False))
    tampered_chain = _chain(with_npu=False)
    tampered_chain.kernel = b"kernel-tampered"
    tampered = fold_os_measurement(tampered_chain)
    if clean == tampered:
        raise AssertionError("tampered kernel must change the os measurement digest")
    print("PASS tampered measured-launch input yields a different os digest")


def main() -> int:
    test_protected_inference_evidence_validates()
    test_npu_protected_requires_monitor_and_npu_firmware()
    test_no_npu_path_omits_npu_measurements()
    test_tampered_os_changes_measurement()
    print("PASS: TEE quote serializer tests")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
