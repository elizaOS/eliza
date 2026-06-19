#!/usr/bin/env python3
"""Lane-01 fail-closed scope gate (W8/C6).

Mirrors check_security_lifecycle_scope.py: enumerates what is buildable now for
the TEE core lane versus what stays BLOCKED on FPGA/simulator/silicon, keeps
release_claim_allowed false, and asserts REAL invariants of the evidence artifact
docs/evidence/security/tee-core-evidence-gate.yaml, fail-closed:

  1. Status/claim-boundary stay release-blocked.
  2. Every buildable_now row references an artifact that actually exists on disk
     and a proving_command whose script exists — so the gate cannot list a
     phantom buildable item.
  3. Every blocked_claims row names a current_gap, a missing_dependency,
     required_evidence, and a proving_command — so no blocked hardware claim can
     leak into product grade without a named transcript.
  4. The four core blocked claims (confidential-VM isolation, memory encryption,
     measured launch, signed quote) are all enumerated.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from chip_utils import load_yaml_object  # noqa: E402

GATE = ROOT / "docs/evidence/security/tee-core-evidence-gate.yaml"
OUT = ROOT / "build/reports/tee_core_scope.json"

REQUIRED_BLOCKED_CLAIMS = {
    "confidential_vm_isolation",
    "tsm_wall_integrity",
    "memory_encryption",
    "measured_launch",
    "attestation_quote_signed",
}
FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "confidential_vm_isolation_claim_allowed": False,
    "memory_encryption_claim_allowed": False,
    "measured_launch_claim_allowed": False,
    "signed_quote_claim_allowed": False,
    "silicon_tee_claim_allowed": False,
}

# Extract `scripts/<name>.py` referenced in a proving command, if any.
SCRIPT_RE = re.compile(r"(scripts/[A-Za-z0-9_./-]+\.py)")


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else str(path)


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def artifact_exists(spec: str) -> bool:
    """An artifact spec is a path, possibly with a brace-set like {a,b,c}.json."""
    match = re.match(r"^(.*?)\{([^}]+)\}(.*)$", spec)
    if match:
        prefix, options, suffix = match.groups()
        return all((ROOT / f"{prefix}{opt}{suffix}").exists() for opt in options.split(","))
    return (ROOT / spec).exists()


def validate(gate: dict[str, Any]) -> list[str]:
    errors: list[str] = []

    if gate.get("schema") != "eliza.tee_core_evidence_gate.v1":
        errors.append("schema must be eliza.tee_core_evidence_gate.v1")
    if gate.get("status") != "tee_core_scope_release_blocked":
        errors.append("status must be tee_core_scope_release_blocked")
    boundary = str(gate.get("claim_boundary", ""))
    if "not_confidential_vm_silicon_evidence" not in boundary:
        errors.append("claim_boundary must state the buildable floor is not silicon evidence")

    buildable = gate.get("buildable_now")
    if not isinstance(buildable, list) or not buildable:
        errors.append("buildable_now must be a non-empty list")
        buildable = []
    for item in buildable:
        if not isinstance(item, dict):
            errors.append("buildable_now entries must be objects")
            continue
        artifact = item.get("artifact")
        if not isinstance(artifact, str) or not artifact_exists(artifact):
            errors.append(f"buildable_now {item.get('id')} artifact missing on disk: {artifact}")
        command = str(item.get("proving_command", ""))
        script_match = SCRIPT_RE.search(command)
        if script_match and not (ROOT / script_match.group(1)).exists():
            errors.append(
                f"buildable_now {item.get('id')} proving_command references "
                f"missing script: {script_match.group(1)}"
            )
        elif not command.strip():
            errors.append(f"buildable_now {item.get('id')} must name a proving_command")

    blocked = gate.get("blocked_claims")
    if not isinstance(blocked, list) or not blocked:
        errors.append("blocked_claims must be a non-empty list")
        blocked = []
    blocked_ids = set()
    for claim in blocked:
        if not isinstance(claim, dict):
            errors.append("blocked_claims entries must be objects")
            continue
        blocked_ids.add(claim.get("id"))
        if claim.get("status") != "blocked":
            errors.append(f"blocked claim {claim.get('id')} must have status blocked")
        for key in ("current_gap", "missing_dependency", "proving_command"):
            if not str(claim.get(key, "")).strip():
                errors.append(f"blocked claim {claim.get('id')} must name {key}")
        ev = claim.get("required_evidence")
        if not isinstance(ev, list) or not ev:
            errors.append(f"blocked claim {claim.get('id')} must list required_evidence")
    missing = sorted(REQUIRED_BLOCKED_CLAIMS.difference(blocked_ids))
    if missing:
        errors.append(f"blocked_claims missing required core claims: {', '.join(missing)}")

    return errors


def main() -> int:
    gate = load_yaml_object(GATE)
    errors = validate(gate)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {
                "schema": "eliza.tee_core_scope.v1",
                "status": "tee_core_scope_release_blocked",
                "generated_utc": utc_now(),
                "claim_boundary": (
                    "TEE core lane scope audit only; not confidential-VM isolation, "
                    "not memory encryption, not measured launch, not a signed quote, "
                    "and not silicon TEE evidence."
                ),
                "evidence_gate": rel(GATE),
                "buildable_now": [item.get("id") for item in gate.get("buildable_now", [])],
                "blocked_claims": [c.get("id") for c in gate.get("blocked_claims", [])],
                "errors": errors,
                "false_claim_flags": FALSE_CLAIM_FLAGS,
                "findings": [
                    {
                        "code": "tee_core_scope_release_blocked",
                        "message": (
                            "TEE core release claims remain blocked pending confidential-VM "
                            "isolation, memory encryption, measured launch, and signed quote evidence."
                        ),
                        "next_step": "capture real TEE core release evidence before enabling release claims",
                        "severity": "blocker",
                    }
                ],
                "summary": {
                    "buildable_now_count": len(gate.get("buildable_now", [])),
                    "blocked_claim_count": len(gate.get("blocked_claims", [])),
                    "release_claim_allowed": False,
                    "false_claim_flags": FALSE_CLAIM_FLAGS,
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
    print(f"PASS: TEE core scope gate valid + release-blocked: {rel(GATE)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
