#!/usr/bin/env python3
"""Gate the positive authenticated boot ROM handoff transcript.

The fail-closed ROM transcript proves unauthenticated images halt. This gate is
the separate positive side of the boot contract: with a provisioned test root
and a signed first-stage image, the ROM must authenticate the image, select the
handoff target from the signed manifest, and reach OpenSBI.

Until that transcript exists, this command writes a BLOCKED report. It must not
fabricate success from the negative/fail-closed transcript.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

CHIP_ROOT = Path(__file__).resolve().parents[1]
TRANSCRIPT = (
    Path(os.environ["ELIZA_BOOTROM_POSITIVE_HANDOFF_TRANSCRIPT"])
    if "ELIZA_BOOTROM_POSITIVE_HANDOFF_TRANSCRIPT" in os.environ
    else CHIP_ROOT / "docs/boot-rom/transcripts/e1_secure_bootrom_positive_handoff_qemu_rv64.txt"
)
REPORT_PATH = (
    Path(os.environ["ELIZA_BOOTROM_POSITIVE_HANDOFF_REPORT"])
    if "ELIZA_BOOTROM_POSITIVE_HANDOFF_REPORT" in os.environ
    else CHIP_ROOT / "build/reports/gate-bootrom-positive-handoff-check.json"
)

GATE = "boot.bootrom_positive_handoff"
BLOCKER_ID = "bootrom_positive_handoff_missing_or_missing_markers"
CLAIM_BOUNDARY = (
    "Development simulator transcript of the real secure-boot mask ROM positive "
    "path. Requires a provisioned non-production test root and a signed "
    "first-stage/OpenSBI payload. It proves authenticated handoff in the named "
    "simulator only; it is not silicon secure-boot attestation."
)

REQUIRED_MARKERS: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "capture_claim_boundary_recorded",
        ("claim_boundary: provisioned_test_root_signed_image_simulator_only_not_silicon_attestation",),
    ),
    ("capture_command_exit_zero", ("## command_exit_code: 0",)),
    ("reset_vector_fetch", ("reset-vector-fetch", "<_start>")),
    ("verifier_entrypoint_executed", ("<e1_secure_boot_main>",)),
    ("authenticated_image_verified", ("authenticated-image-verified",)),
    ("handoff_target_loaded_from_manifest", ("handoff-target-loaded-from-manifest",)),
    ("opensbi_entry_reached", ("OpenSBI", "entry")),
)
FALSE_CLAIM_FLAGS = {
    "claim_allowed": False,
    "release_claim_allowed": False,
    "phone_claim_allowed": False,
    "linux_boot_claim_allowed": False,
    "android_boot_claim_allowed": False,
    "silicon_secure_boot_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}
CAPTURE_SCRIPT = "scripts/capture_bootrom_positive_handoff.sh"
DEFAULT_TRANSCRIPT = "docs/boot-rom/transcripts/e1_secure_bootrom_positive_handoff_qemu_rv64.txt"
DEFAULT_REPORT = "build/reports/gate-bootrom-positive-handoff-check.json"


def capture_command_configured() -> bool:
    return bool(os.environ.get("ELIZA_BOOTROM_POSITIVE_HANDOFF_CMD", "").strip())


def next_command_plan() -> list[dict]:
    return [
        {
            "id": "capture_bootrom_positive_handoff",
            "scope": "repo_simulator",
            "claim_boundary": "operator_capture_commands_only_not_secure_boot_evidence",
            "commands": [
                f"{CAPTURE_SCRIPT} plan",
                (
                    "ELIZA_BOOTROM_POSITIVE_HANDOFF_CMD='<real signed-image simulator command>' "
                    f"{CAPTURE_SCRIPT} preflight"
                ),
                (
                    "ELIZA_BOOTROM_POSITIVE_HANDOFF_CMD='<real signed-image simulator command>' "
                    f"{CAPTURE_SCRIPT} run"
                ),
                "python3 scripts/check_bootrom_positive_handoff.py",
                "python3 scripts/check_boot_security_chain_contract.py",
            ],
            "requires": [
                "real secure-boot mask ROM simulator command, not a copied negative transcript",
                "provisioned non-production test root",
                "signed first-stage/OpenSBI payload selected from a signed manifest",
                "reset-vector, verifier-entrypoint, authenticated-image, manifest-target, and OpenSBI-entry markers",
            ],
            "outputs": [DEFAULT_TRANSCRIPT, DEFAULT_REPORT],
        }
    ]


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def rel(path: Path) -> str:
    try:
        return path.relative_to(CHIP_ROOT).as_posix()
    except ValueError:
        return str(path)


def write_report(report: dict) -> None:
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def report_payload(status: str, checks: list[dict], blocker_reason: str | None) -> dict:
    failures = [check["id"] for check in checks if check["status"] != "pass"]
    evidence_paths: list[str] = []
    if TRANSCRIPT.is_file():
        evidence_paths.append(rel(TRANSCRIPT))
    return {
        "schema": "eliza.gate_status.v1",
        "gate": GATE,
        "status": status,
        "blocker_id": None if status == "PASS" else BLOCKER_ID,
        "blocker_reason": blocker_reason,
        "evidence_paths": evidence_paths,
        "as_of": now_iso(),
        "generated_utc": now_iso(),
        "subsystem": "security",
        "false_claim_flags": FALSE_CLAIM_FLAGS,
        "claim_allowed": False,
        "phone_claim_allowed": False,
        "release_claim_allowed": False,
        "linux_boot_claim_allowed": False,
        "android_boot_claim_allowed": False,
        "silicon_secure_boot_claim_allowed": False,
        "production_readiness_claim_allowed": False,
        "claim_boundary": CLAIM_BOUNDARY,
        "summary": {
            "check_count": len(checks),
            "passing_check_count": sum(1 for check in checks if check["status"] == "pass"),
            "failures": failures,
            "capture_command_configured": capture_command_configured(),
            "next_command_batch_count": 0 if status == "PASS" else len(next_command_plan()),
        },
        "capture_preflight": {
            "status": "pass" if capture_command_configured() else "blocked",
            "configured_env": "ELIZA_BOOTROM_POSITIVE_HANDOFF_CMD",
            "command_configured": capture_command_configured(),
            "transcript": rel(TRANSCRIPT),
            "report": rel(REPORT_PATH),
        },
        "next_command_plan": [] if status == "PASS" else next_command_plan(),
        "checks": checks,
    }


def missing_transcript() -> int:
    checks = [
        {
            "id": marker_id,
            "status": "blocked",
            "detail": f"transcript missing at {rel(TRANSCRIPT)}",
        }
        for marker_id, _needles in REQUIRED_MARKERS
    ]
    write_report(report_payload("BLOCKED", checks, f"transcript missing: {rel(TRANSCRIPT)}"))
    print(f"BLOCKED: positive handoff transcript missing at {rel(TRANSCRIPT)}", file=sys.stderr)
    return 2


def main() -> int:
    if not TRANSCRIPT.is_file():
        return missing_transcript()

    lines = TRANSCRIPT.read_text(encoding="utf-8", errors="replace").splitlines()
    checks = []
    for marker_id, needles in REQUIRED_MARKERS:
        present = any(all(needle in line for needle in needles) for line in lines)
        checks.append(
            {
                "id": marker_id,
                "status": "pass" if present else "fail",
                "detail": "found" if present else f"missing markers {needles}",
            }
        )

    failures = [check["id"] for check in checks if check["status"] != "pass"]
    if failures:
        write_report(report_payload("BLOCKED", checks, "; ".join(failures)))
        print(f"BLOCKED: {'; '.join(failures)}", file=sys.stderr)
        return 1

    write_report(report_payload("PASS", checks, None))
    print(f"PASS: bootrom positive handoff gate ({len(checks)} markers); report {rel(REPORT_PATH)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
