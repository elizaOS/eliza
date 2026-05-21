#!/usr/bin/env python3
"""Validate chip TEE attestation evidence against the agent TeeEvidence shape."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_EVIDENCE = (
    REPO_ROOT / "packages/chip/docs/spec-db/tee-attestation-evidence.example.json"
)
SHA256 = re.compile(r"^sha256:[a-f0-9]{64}$")
REQUIRED_MEASUREMENTS = {"boot", "os", "agent", "policy", "device"}
NPU_PROTECTED_MEASUREMENTS = {"monitor", "npuFirmware"}
REQUIRED_TRUE_CLAIMS = {"debugDisabled", "secureBoot", "ioProtected"}
ALLOWED_KINDS = {
    "tdx",
    "sev-snp",
    "nitro",
    "cove",
    "keystone",
    "optee",
    "dstack",
    "eliza-vault",
}


def validate(evidence: dict[str, object]) -> list[str]:
    errors: list[str] = []
    if evidence.get("kind") not in ALLOWED_KINDS:
        errors.append("kind must be a known TEE evidence kind")
    for field in ["provider", "hardwareVendor", "platformVersion"]:
        if not isinstance(evidence.get(field), str) or not evidence.get(field):
            errors.append(f"{field} must be a non-empty string")
    if not isinstance(evidence.get("securityVersion"), int):
        errors.append("securityVersion must be an integer")

    measurements = evidence.get("measurements")
    if not isinstance(measurements, dict):
        errors.append("measurements must be an object")
    else:
        missing = sorted(REQUIRED_MEASUREMENTS.difference(measurements))
        if missing:
            errors.append(f"measurements missing required entries: {', '.join(missing)}")
        for name, digest in measurements.items():
            if not isinstance(digest, str) or not SHA256.match(digest):
                errors.append(f"measurements.{name} must be sha256:<64 lowercase hex>")

    freshness = evidence.get("freshness")
    if not isinstance(freshness, dict):
        errors.append("freshness must be an object")
    else:
        if not isinstance(freshness.get("nonce"), str) or not freshness.get("nonce"):
            errors.append("freshness.nonce must be a non-empty string")
        if not isinstance(freshness.get("timestamp"), str) or not freshness.get("timestamp"):
            errors.append("freshness.timestamp must be a non-empty string")

    claims = evidence.get("claims")
    if not isinstance(claims, dict):
        errors.append("claims must be an object")
    else:
        for claim in REQUIRED_TRUE_CLAIMS:
            if claims.get(claim) is not True:
                errors.append(f"claims.{claim} must be true")
        if evidence.get("kind") == "cove" and claims.get("memoryEncrypted") is not True:
            errors.append("claims.memoryEncrypted must be true for cove evidence")
        # Section 7.2: a true npuProtected claim is meaningless without the TSM
        # monitor measurement and the measured NPU firmware/queue-policy digest.
        if claims.get("npuProtected") is True and isinstance(measurements, dict):
            for required in NPU_PROTECTED_MEASUREMENTS:
                value = measurements.get(required)
                if not isinstance(value, str) or not SHA256.match(value):
                    errors.append(
                        f"measurements.{required} must be sha256:<64 hex> "
                        "when claims.npuProtected is true"
                    )

    report_data = evidence.get("reportData")
    if report_data is not None and (not isinstance(report_data, str) or not SHA256.match(report_data)):
        errors.append("reportData must be sha256:<64 lowercase hex> when present")

    return errors


def main(argv: list[str]) -> int:
    evidence_path = Path(argv[1]) if len(argv) > 1 else DEFAULT_EVIDENCE
    evidence = json.loads(evidence_path.read_text())
    errors = validate(evidence)
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 1
    print(f"TEE attestation evidence valid: {evidence_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
