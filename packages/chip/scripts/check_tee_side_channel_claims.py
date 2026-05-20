#!/usr/bin/env python3
"""Validate the TEE side-channel claim matrix."""

from __future__ import annotations

import json
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_MATRIX = REPO_ROOT / "packages/chip/docs/spec-db/tee-side-channel-claim-matrix.json"
REQUIRED_STATE_HANDLING = {"cache", "tlb", "bpu", "prefetcher"}


def validate(matrix: dict[str, object]) -> list[str]:
    errors: list[str] = []
    if matrix.get("schemaVersion") != 1:
        errors.append("schemaVersion must be 1")
    claims = matrix.get("claims")
    if not isinstance(claims, dict):
        errors.append("claims must be an object")
        return errors
    for field in [
        "smtDisabledForConfidentialDomains",
        "pmuDisabledOrVirtualized",
        "highResolutionTimersRestricted",
        "constantTimeCryptoRequired",
        "keyZeroizeOnTeardown",
        "keyZeroizeOnTamper",
    ]:
        if claims.get(field) is not True:
            errors.append(f"claims.{field} must be true")
    for field in [
        "secretDependentTableLookupAllowed",
        "debugCountersAvailableInConfidentialMode",
    ]:
        if claims.get(field) is not False:
            errors.append(f"claims.{field} must be false")
    state_handling = claims.get("domainSwitchStateHandling")
    if not isinstance(state_handling, list):
        errors.append("claims.domainSwitchStateHandling must be a list")
    else:
        missing = sorted(REQUIRED_STATE_HANDLING.difference(state_handling))
        if missing:
            errors.append(
                "claims.domainSwitchStateHandling missing: " + ", ".join(missing)
            )

    generation_claims = matrix.get("generationClaims")
    if not isinstance(generation_claims, dict):
        errors.append("generationClaims must be an object")
        return errors
    v0 = generation_claims.get("v0")
    if not isinstance(v0, dict):
        errors.append("generationClaims.v0 must be an object")
    else:
        if v0.get("physicalTamperResistanceClaimed") is not False:
            errors.append("v0 must not claim physical tamper resistance")
        if v0.get("externalMemoryEncryptionClaimed") is not False:
            errors.append("v0 must not claim external memory encryption")
    v1 = generation_claims.get("v1")
    if not isinstance(v1, dict):
        errors.append("generationClaims.v1 must be an object")
    else:
        required_evidence = v1.get("requiredEvidence")
        if not isinstance(required_evidence, list) or not required_evidence:
            errors.append("v1.requiredEvidence must be a non-empty list")

    return errors


def main(argv: list[str]) -> int:
    matrix_path = Path(argv[1]) if len(argv) > 1 else DEFAULT_MATRIX
    matrix = json.loads(matrix_path.read_text())
    errors = validate(matrix)
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 1
    print(f"TEE side-channel claim matrix valid: {matrix_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
