#!/usr/bin/env python3
"""Validate the measured-launch source map (06 WI-1).

Asserts REAL invariants of docs/spec-db/tee-measured-launch-map.json, fail-closed:

  1. Every measurement entry names a producing software/boot stage, a fold rule,
     a lane, and a blocked_on dependency — no entry may claim to be evidence.
  2. The map's measurement set matches the agent measurement set exactly:
     required {boot, os, policy, device, agent}, plus monitor and the optional
     {npuFirmware, modelWeights}. No measurement names outside the canonical
     TeeMeasurementName set, and none of the canonical core measurements missing.
  3. The map is consistent with scripts/tee/teeevidence_quote.py: the BASE
     measurement order the serializer always folds is exactly the map's required
     prefix (boot, monitor, os, policy, device, agent), and every measurement the
     serializer's assemble() can emit is described by the map.
  4. monitor is required-when npuProtected/monitorMeasured; npuFirmware is
     required-when npuProtected — matching check_tee_attestation_evidence.py and
     the agent tee-policy claim gates.

This is a contract checker, not a file-exists gate: it cross-checks the map
against the live folding model and the agent type, so the map cannot drift from
the code that produces the quote.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from tee.teeevidence_quote import BASE_MEASUREMENT_ORDER  # noqa: E402

MAP_PATH = ROOT / "docs/spec-db/tee-measured-launch-map.json"
OUT = ROOT / "build/reports/tee_measured_launch_map.json"

# The canonical TeeEvidence measurement set used by the chip-side launch chain,
# mirroring packages/agent/src/services/tee-evidence.ts TeeMeasurementName and the
# chip task scope (boot/monitor/os/policy/device/agent + optional
# npuFirmware/modelWeights). container/compose/gpuFirmware exist in the agent type
# but are not part of the E1 riscv64 in-domain launch chain this map describes.
REQUIRED_MEASUREMENTS = {"boot", "os", "policy", "device", "agent"}
OPTIONAL_MEASUREMENTS = {"monitor", "npuFirmware", "modelWeights"}
ALL_MEASUREMENTS = REQUIRED_MEASUREMENTS | OPTIONAL_MEASUREMENTS

REQUIRED_CLAIMS = {
    "secureBoot",
    "debugDisabled",
    "productionLifecycle",
    "memoryEncrypted",
    "ioProtected",
    "npuProtected",
    "monitorMeasured",
}

# The measurements teeevidence_quote.assemble() always emits, in fold order.
SERIALIZER_BASE_ORDER = ("boot", "monitor", "os", "policy", "device", "agent")
# Optional measurements assemble() can emit on the protected-inference path.
SERIALIZER_OPTIONAL = {"npuFirmware", "modelWeights"}


def validate(data: dict[str, Any]) -> list[str]:
    errors: list[str] = []

    if data.get("schema") != "eliza.tee_measured_launch_map.v1":
        errors.append("schema must be eliza.tee_measured_launch_map.v1")
    boundary = str(data.get("claim_boundary", ""))
    for token in ("not a measured launch", "not secure boot", "not silicon", "BLOCKED"):
        if token not in boundary:
            errors.append(f"claim_boundary must state '{token}'")

    entries = data.get("measurements")
    if not isinstance(entries, list) or not entries:
        errors.append("measurements must be a non-empty list")
        return errors

    seen: dict[str, dict[str, Any]] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            errors.append("each measurement entry must be an object")
            continue
        field = entry.get("field")
        if not isinstance(field, str) or field not in ALL_MEASUREMENTS:
            errors.append(f"measurement field {field!r} is not a known TeeEvidence measurement")
            continue
        if field in seen:
            errors.append(f"measurement {field} is listed more than once")
        seen[field] = entry
        for key in ("produced_by", "when_measured", "fold", "lane", "blocked_on"):
            value = entry.get(key)
            if not isinstance(value, str) or not value.strip():
                errors.append(f"measurement {field} must name a non-empty {key}")
        required = entry.get("required")
        if not isinstance(required, bool):
            errors.append(f"measurement {field} must declare required: bool")
        else:
            expected_required = field in REQUIRED_MEASUREMENTS
            if required != expected_required:
                errors.append(
                    f"measurement {field} required={required} disagrees with the "
                    f"canonical agent set (expected {expected_required})"
                )
        if field in OPTIONAL_MEASUREMENTS and not isinstance(entry.get("required_when"), str):
            errors.append(f"optional measurement {field} must state required_when")

    # Completeness vs the canonical agent measurement set.
    missing_required = sorted(REQUIRED_MEASUREMENTS.difference(seen))
    if missing_required:
        errors.append(f"map missing required measurements: {', '.join(missing_required)}")
    missing_optional = sorted(OPTIONAL_MEASUREMENTS.difference(seen))
    if missing_optional:
        errors.append(f"map missing optional measurements: {', '.join(missing_optional)}")

    # Consistency with the serializer fold model.
    if BASE_MEASUREMENT_ORDER != SERIALIZER_BASE_ORDER:
        errors.append(
            "teeevidence_quote.BASE_MEASUREMENT_ORDER drifted from the expected "
            f"{SERIALIZER_BASE_ORDER}; map invariants must be re-derived"
        )
    fold_order = data.get("fold_order")
    if not isinstance(fold_order, list):
        errors.append("fold_order must be a list")
    else:
        prefix = tuple(fold_order[: len(SERIALIZER_BASE_ORDER)])
        if prefix != SERIALIZER_BASE_ORDER:
            errors.append(
                f"fold_order prefix {prefix} must equal the serializer base order "
                f"{SERIALIZER_BASE_ORDER}"
            )
        for name in SERIALIZER_OPTIONAL:
            if name not in fold_order:
                errors.append(f"fold_order must include serializer-optional measurement {name}")

    # monitor / npuFirmware required-when conditions must reference npuProtected.
    monitor_when = str(seen.get("monitor", {}).get("required_when", ""))
    if "npuProtected" not in monitor_when and "monitorMeasured" not in monitor_when:
        errors.append("monitor required_when must reference npuProtected or monitorMeasured")
    npu_when = str(seen.get("npuFirmware", {}).get("required_when", ""))
    if "npuProtected" not in npu_when:
        errors.append("npuFirmware required_when must reference npuProtected")

    # Claim coverage: every claim that gates a measurement must be described.
    claims = data.get("claims")
    if not isinstance(claims, list):
        errors.append("claims must be a list")
    else:
        named = {c.get("name") for c in claims if isinstance(c, dict)}
        missing_claims = sorted(REQUIRED_CLAIMS.difference(named))
        if missing_claims:
            errors.append(f"claims missing source-of-truth entries: {', '.join(missing_claims)}")
        for claim in claims:
            if not isinstance(claim, dict):
                continue
            for key in ("set_by", "lane"):
                if not isinstance(claim.get(key), str) or not claim[key].strip():
                    errors.append(f"claim {claim.get('name')} must name a non-empty {key}")

    return errors


def main(argv: list[str]) -> int:
    map_path = Path(argv[1]) if len(argv) > 1 else MAP_PATH
    data = json.loads(map_path.read_text(encoding="utf-8"))
    errors = validate(data)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {
                "schema": "eliza.tee_measured_launch_map_check.v1",
                "status": "tee_measured_launch_map_release_blocked",
                "claim_boundary": (
                    "Measurement-source map contract only; not a measured launch, "
                    "not secure boot, not a signed quote, not silicon."
                ),
                "map": map_path.relative_to(ROOT).as_posix()
                if map_path.is_relative_to(ROOT)
                else str(map_path),
                "errors": errors,
                "findings": [
                    {
                        "code": "tee_measured_launch_map_release_blocked",
                        "message": (
                            "Measured-launch map is a contract only; no real measured launch, "
                            "secure boot chain, or signed quote evidence is present."
                        ),
                        "next_step": "capture measured-launch evidence from a real boot chain and attestation quote",
                        "severity": "blocker",
                    }
                ],
                "summary": {
                    "measurement_count": len(data.get("measurements", [])),
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
    print(f"PASS: measured-launch map valid + consistent with serializer/agent: {map_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
