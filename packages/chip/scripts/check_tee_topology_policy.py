"""Validate the per-topology TeeEvidencePolicy blobs the E1 device ships (06 WI-5).

Asserts REAL invariants of sw/confidential/policy/{local,desktop,cloud}.json,
fail-closed, against the agent contract in packages/agent/src/services:

  - tee-policy.ts TeeEvidencePolicy: every key present is a known policy field;
    requiredMeasurements/requiredClaims keys are valid TeeMeasurementName /
    TeeClaims keys; digests are sha256:<64 hex>; numeric/boolean fields typed.
  - tee-confidential-inference.ts assertNpuPrivateInferenceAllowed: the
    private-inference gate per topology MUST be present in the policy itself —
        local, desktop -> requiredClaims.npuProtected == true
                          + requiredMeasurements.npuFirmware (non-empty digest)
        cloud          -> requiredClaims.gpuProtected == true
                          + requiredMeasurements.gpuFirmware (non-empty digest)
  - Every topology must require the base measured-launch set (boot/os/policy/
    agent) and the always-true claims (secureBoot/debugDisabled/memoryEncrypted/
    ioProtected) so no policy can release a key against a non-production launch.

This is the chip-side proof that the shipped policy blobs gate exactly what the
agent unseal seam demands; it is not a signed quote and not silicon evidence.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
POLICY_DIR = ROOT / "sw/confidential/policy"
OUT = ROOT / "build/reports/tee_topology_policy.json"

DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")

# Keys from TeeEvidencePolicy (tee-policy.ts).
POLICY_KEYS = {
    "required",
    "allowedKinds",
    "allowedProviders",
    "requiredMeasurements",
    "revokedMeasurements",
    "minSecurityVersion",
    "revokedSecurityVersions",
    "expectedNonce",
    "maxAgeMs",
    "nowMs",
    "requiredClaims",
    "rejectSimulatedEvidence",
}
# TeeMeasurementName (tee-evidence.ts).
MEASUREMENT_KEYS = {
    "boot",
    "os",
    "agent",
    "policy",
    "device",
    "container",
    "compose",
    "monitor",
    "modelWeights",
    "npuFirmware",
    "gpuFirmware",
}
# Keys of TeeClaims (tee-evidence.ts).
CLAIM_KEYS = {
    "debugDisabled",
    "productionLifecycle",
    "secureBoot",
    "memoryEncrypted",
    "ioProtected",
    "gpuProtected",
    "npuProtected",
    "monitorMeasured",
}

BASE_REQUIRED_MEASUREMENTS = {"boot", "os", "policy", "agent"}
BASE_REQUIRED_CLAIMS = {"secureBoot", "debugDisabled", "memoryEncrypted", "ioProtected"}

# assertNpuPrivateInferenceAllowed gate, per topology.
TOPOLOGY_GATE = {
    "local": {"claim": "npuProtected", "firmware": "npuFirmware"},
    "desktop": {"claim": "npuProtected", "firmware": "npuFirmware"},
    "cloud": {"claim": "gpuProtected", "firmware": "gpuFirmware"},
}


def validate_policy(topology: str, blob: dict[str, Any]) -> list[str]:
    errors: list[str] = []

    if blob.get("topology") != topology:
        errors.append(f"{topology}: topology field must equal '{topology}'")
    if not isinstance(blob.get("summary"), str) or not blob["summary"].strip():
        errors.append(f"{topology}: must carry a non-empty summary")

    policy = blob.get("policy")
    if not isinstance(policy, dict):
        errors.append(f"{topology}: policy must be an object")
        return errors

    unknown = set(policy).difference(POLICY_KEYS)
    if unknown:
        errors.append(f"{topology}: unknown TeeEvidencePolicy keys: {', '.join(sorted(unknown))}")

    if policy.get("required") is not True:
        errors.append(f"{topology}: policy.required must be true (shipped device policy)")
    for numeric in ("minSecurityVersion", "maxAgeMs", "nowMs"):
        if numeric in policy and not isinstance(policy[numeric], int):
            errors.append(f"{topology}: policy.{numeric} must be an integer when present")
    for boolean in ("rejectSimulatedEvidence",):
        if boolean in policy and not isinstance(policy[boolean], bool):
            errors.append(f"{topology}: policy.{boolean} must be boolean when present")
    for arr in ("allowedKinds", "allowedProviders"):
        if arr in policy and (
            not isinstance(policy[arr], list) or not all(isinstance(x, str) for x in policy[arr])
        ):
            errors.append(f"{topology}: policy.{arr} must be a list of strings")

    measurements = policy.get("requiredMeasurements")
    if not isinstance(measurements, dict):
        errors.append(f"{topology}: policy.requiredMeasurements must be an object")
        measurements = {}
    else:
        for name, digest in measurements.items():
            if name not in MEASUREMENT_KEYS:
                errors.append(
                    f"{topology}: requiredMeasurements.{name} is not a TeeMeasurementName"
                )
            if not isinstance(digest, str) or not DIGEST.match(digest):
                errors.append(f"{topology}: requiredMeasurements.{name} must be sha256:<64 hex>")

    claims = policy.get("requiredClaims")
    if not isinstance(claims, dict):
        errors.append(f"{topology}: policy.requiredClaims must be an object")
        claims = {}
    else:
        for name, value in claims.items():
            if name not in CLAIM_KEYS:
                errors.append(f"{topology}: requiredClaims.{name} is not a TeeClaims key")
            if not isinstance(value, bool):
                errors.append(f"{topology}: requiredClaims.{name} must be boolean")

    # Base measured-launch floor every topology must gate.
    missing_m = sorted(BASE_REQUIRED_MEASUREMENTS.difference(measurements))
    if missing_m:
        errors.append(f"{topology}: requiredMeasurements missing base set: {', '.join(missing_m)}")
    for claim in sorted(BASE_REQUIRED_CLAIMS):
        if claims.get(claim) is not True:
            errors.append(f"{topology}: requiredClaims.{claim} must be true")

    # Topology-specific private-inference gate (assertNpuPrivateInferenceAllowed).
    gate = TOPOLOGY_GATE[topology]
    if claims.get(gate["claim"]) is not True:
        errors.append(
            f"{topology}: requiredClaims.{gate['claim']} must be true "
            f"(assertNpuPrivateInferenceAllowed('{topology}'))"
        )
    fw_digest = measurements.get(gate["firmware"])
    if not isinstance(fw_digest, str) or not fw_digest.strip():
        errors.append(
            f"{topology}: requiredMeasurements.{gate['firmware']} must be a non-empty digest "
            f"(assertNpuPrivateInferenceAllowed('{topology}'))"
        )

    # The opposite topology's firmware must NOT be gated (no NPU digest in a
    # cloud/GPU policy, no GPU digest in a local/NPU policy): each policy gates
    # exactly its own confidential-I/O lane.
    opposite_fw = "gpuFirmware" if gate["firmware"] == "npuFirmware" else "npuFirmware"
    if opposite_fw in measurements:
        errors.append(
            f"{topology}: must not gate {opposite_fw}; it gates {gate['firmware']} for this topology"
        )

    return errors


def main() -> int:
    errors: list[str] = []
    topologies = sorted(TOPOLOGY_GATE)
    for topology in topologies:
        path = POLICY_DIR / f"{topology}.json"
        if not path.is_file():
            errors.append(f"{topology}: missing policy blob {path}")
            continue
        blob = json.loads(path.read_text(encoding="utf-8"))
        errors.extend(validate_policy(topology, blob))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {
                "schema": "eliza.tee_topology_policy_check.v1",
                "status": "tee_topology_policy_release_blocked",
                "claim_boundary": (
                    "Per-topology TeeEvidencePolicy shape + private-inference-gate "
                    "contract only; the golden digests are placeholders, not bytes "
                    "from a real reproducible build, not a signed quote, not silicon."
                ),
                "topologies": topologies,
                "errors": errors,
                "findings": [
                    {
                        "code": "tee_topology_policy_release_blocked",
                        "message": (
                            "TEE topology policies are shape-checked, but golden digests are placeholders "
                            "rather than bytes from a reproducible build or signed quote."
                        ),
                        "next_step": "replace placeholder topology digests with real reproducible build measurements",
                        "severity": "blocker",
                    }
                ],
                "summary": {
                    "topology_count": len(topologies),
                    "release_claim_allowed": False,
                },
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )

    if errors:
        for error in errors:
            print(f"FAIL: {error}", file=sys.stderr)
        return 1
    print(f"PASS: {len(topologies)} topology policies valid + gate the right confidential-I/O lane")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
