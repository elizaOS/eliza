#!/usr/bin/env python3
"""Gate the secure-boot mask ROM simulator transcript.

Regenerates the transcript by executing the real ROM image in QEMU
(scripts/run_bootrom_sim_transcript.sh) and asserts the captured trace contains
the expected reset/verify/handoff markers:

  1. reset-vector fetch into the ROM image (_start),
  2. mtvec programmed to the local trap handler,
  3. the C secure-boot entrypoint (e1_secure_boot_main) is called,
  4. the fail-closed WFI trap (e1_bootrom_trap) is reached.

Writes an eliza.gate_status.v1 report. A missing simulator or unbuilt ROM is
BLOCKED (fail-closed), not PASS. The transcript is a development simulator trace
and is NOT a silicon secure-boot claim; see the transcript header and
docs/boot-rom/release-evidence.md.
"""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

CHIP_ROOT = Path(__file__).resolve().parents[1]
RUNNER = CHIP_ROOT / "scripts/run_bootrom_sim_transcript.sh"
TRANSCRIPT = CHIP_ROOT / "docs/boot-rom/transcripts/e1_secure_bootrom_qemu_rv64.txt"
ROM_BIN = CHIP_ROOT / "build/boot-rom/e1_secure_boot_rom.bin"
REPORT_PATH = CHIP_ROOT / "build/reports/gate-bootrom-sim-transcript-check.json"

GATE = "boot.bootrom_sim_transcript"
BLOCKER_ID = "bootrom_sim_transcript_missing_or_missing_markers"

# (marker id, required substring(s) — all must be present on a single line).
REQUIRED_MARKERS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("reset_vector_fetch", ("reset-vector-fetch", "<_start>")),
    ("mtvec_setup", ("mtvec-setup", "mtvec")),
    ("verifier_call", ("verifier-call", "jalr")),
    ("fail_closed_trap", ("fail-closed-trap", "<e1_bootrom_trap>", "WFI")),
    ("verifier_entrypoint_executed", ("<e1_secure_boot_main>",)),
)


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def write_report(report: dict) -> None:
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


def blocked(reason: str) -> int:
    write_report(
        {
            "schema": "eliza.gate_status.v1",
            "gate": GATE,
            "status": "BLOCKED",
            "blocker_id": BLOCKER_ID,
            "blocker_reason": reason,
            "evidence_paths": [],
            "as_of": now_iso(),
            "subsystem": "security",
        }
    )
    print(f"BLOCKED: {reason}", file=sys.stderr)
    return 2


def regenerate() -> tuple[bool, str]:
    if not RUNNER.is_file():
        return False, f"missing runner {RUNNER.relative_to(CHIP_ROOT)}"
    result = subprocess.run(["sh", str(RUNNER)], cwd=CHIP_ROOT, text=True, capture_output=True)
    detail = (result.stdout + result.stderr).strip().splitlines()
    last = detail[-1] if detail else ""
    if result.returncode == 2:
        return False, f"simulator/ROM unavailable: {last}"
    if result.returncode != 0:
        return False, f"runner failed (rc={result.returncode}): {last}"
    return True, last


def main() -> int:
    if not ROM_BIN.is_file():
        return blocked("secure ROM image not built: run 'make -C fw/boot-rom secure-rom'")

    ok, detail = regenerate()
    if not ok:
        return blocked(detail)

    if not TRANSCRIPT.is_file():
        return blocked(f"transcript not produced at {TRANSCRIPT.relative_to(CHIP_ROOT)}")

    lines = TRANSCRIPT.read_text(encoding="utf-8").splitlines()

    checks = []
    for marker_id, needles in REQUIRED_MARKERS:
        present = any(all(n in line for n in needles) for line in lines)
        checks.append(
            {
                "id": marker_id,
                "status": "pass" if present else "fail",
                "detail": "found" if present else f"missing markers {needles}",
            }
        )

    failures = [c["id"] for c in checks if c["status"] != "pass"]
    passed = not failures

    report = {
        "schema": "eliza.gate_status.v1",
        "gate": GATE,
        "status": "PASS" if passed else "BLOCKED",
        "blocker_id": None if passed else BLOCKER_ID,
        "blocker_reason": None if passed else "; ".join(failures),
        "evidence_paths": [
            TRANSCRIPT.relative_to(CHIP_ROOT).as_posix(),
            RUNNER.relative_to(CHIP_ROOT).as_posix(),
        ],
        "as_of": now_iso(),
        "subsystem": "security",
        "claim_boundary": (
            "Development simulator (qemu-system-riscv64) trace of the real "
            "rv64imac secure-boot mask ROM image. Proves the reset vector "
            "executes the ROM, mtvec is programmed, the C verifier entrypoint "
            "runs, and with no provisioned OTP root hash and no signed image "
            "the boot fails closed in the WFI trap. This is NOT a silicon "
            "secure-boot attestation; the OTP/PUF root and the signed image "
            "window are physical/provisioning dependencies."
        ),
        "summary": {
            "check_count": len(checks),
            "passing_check_count": sum(1 for c in checks if c["status"] == "pass"),
            "failures": failures,
        },
        "checks": checks,
    }
    write_report(report)

    if passed:
        print(
            f"PASS: bootrom sim transcript gate ({len(checks)} markers); "
            f"report {REPORT_PATH.relative_to(CHIP_ROOT)}"
        )
        return 0
    print(f"BLOCKED: {'; '.join(failures)}", file=sys.stderr)
    for c in checks:
        if c["status"] != "pass":
            print(f"  - {c['id']}: {c['detail']}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
