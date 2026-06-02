#!/usr/bin/env python3
"""Check the generated Chipyard artifacts against the next boot-payload path.

This gate is intentionally narrower than a Linux boot claim. It verifies that
the generated DTS/artifacts are present enough to be handed to external
OpenSBI/U-Boot/Linux work, then reports the missing evidence that still blocks
any on-chip/RTL boot claim.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from cpu_ap_evidence_lib import load_evidence_manifest, transcript_specs

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "build/chipyard/eliza_rocket"
GENERATED_SRC = OUT / "generated-src"
DTS = OUT / "eliza-e1.dts"
VERILOG = OUT / "eliza_rocket_ap.v"
SIMULATOR = OUT / "simulator"
GENERATED_MANIFEST = OUT / "ElizaRocketConfig.manifest.json"
REPORT = Path(
    os.environ.get("CHIPYARD_PAYLOAD_PATH_REPORT", "build/reports/chipyard_payload_path.json")
)
if not REPORT.is_absolute():
    REPORT = ROOT / REPORT
FALSE_CLAIM_FLAGS = {
    "phone_claim_allowed": False,
    "release_claim_allowed": False,
    "rtl_boot_claim_allowed": False,
    "linux_boot_claim_allowed": False,
    "android_boot_claim_allowed": False,
    "silicon_claim_allowed": False,
    "generated_ap_completion_claim_allowed": False,
}

REQUIRED_DTS_TOKENS = {
    "cpu": "cpu@0",
    "memory": "memory@80000000",
    "clint": "clint@2000000",
    "plic": "interrupt-controller@c000000",
    "serial": "serial@10001000",
    "chosen_stdout": "stdout-path",
}


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def artifact_status(path: Path, *, min_bytes: int = 1) -> dict[str, Any]:
    status: dict[str, Any] = {
        "path": rel(path),
        "exists": path.exists(),
    }
    if path.exists():
        status["kind"] = "directory" if path.is_dir() else "file"
        if path.is_file():
            status["bytes"] = path.stat().st_size
            status["ok"] = path.stat().st_size >= min_bytes
        else:
            files = [child for child in path.rglob("*") if child.is_file()]
            status["file_count"] = len(files)
            status["ok"] = bool(files)
    else:
        status["ok"] = False
    return status


def main() -> int:
    errors: list[str] = []
    blockers: list[dict[str, str]] = []

    artifacts = {
        "generated_src": artifact_status(GENERATED_SRC),
        "dts": artifact_status(DTS, min_bytes=512),
        "verilog": artifact_status(VERILOG, min_bytes=1024),
        "simulator": artifact_status(SIMULATOR),
        "generated_manifest": artifact_status(GENERATED_MANIFEST, min_bytes=512),
    }
    for name, artifact in artifacts.items():
        if not artifact.get("ok"):
            if name == "generated_manifest":
                blockers.append(
                    {
                        "name": "generated_manifest",
                        "detail": f"missing or invalid {rel(GENERATED_MANIFEST)}",
                        "next": "python3 scripts/generate_chipyard_eliza.py after firtool/RISCV environment is available, or regenerate/import with a complete external Chipyard flow",
                    }
                )
            else:
                blockers.append(
                    {
                        "name": name,
                        "detail": f"generated artifact {name} is missing or invalid: {artifact['path']}",
                        "next": "python3 scripts/check_chipyard_verilator_preflight.py, then generate/import the ElizaRocketConfig artifacts",
                    }
                )

    dts_checks: dict[str, bool] = {}
    if DTS.is_file():
        text = DTS.read_text(errors="ignore")
        for name, token in REQUIRED_DTS_TOKENS.items():
            dts_checks[name] = token in text
            if token not in text:
                errors.append(f"generated DTS missing {name} token: {token}")
    else:
        for name in REQUIRED_DTS_TOKENS:
            dts_checks[name] = False

    evidence_manifest = load_evidence_manifest(errors)
    evidence_status: dict[str, dict[str, Any]] = {}
    for name, spec in transcript_specs(evidence_manifest).items():
        rel_path = spec.get("path")
        next_value = spec.get("capture_command")
        if not isinstance(rel_path, str) or not rel_path.startswith("build/evidence/cpu_ap/"):
            errors.append(f"CPU/AP evidence spec {name} has invalid path: {rel_path!r}")
            continue
        if not isinstance(next_value, str) or not next_value:
            errors.append(f"CPU/AP evidence spec {name} lacks capture_command")
            continue
        path = ROOT / rel_path
        exists = path.is_file()
        evidence_status[name] = {
            "path": rel(path),
            "exists": exists,
            "next": next_value,
        }
        if not exists:
            blockers.append(
                {
                    "name": name,
                    "detail": f"missing {rel(path)}",
                    "next": next_value,
                }
            )

    if errors:
        status = "fail"
        code = 1
    elif blockers:
        status = "blocked"
        code = 2
    else:
        status = "pass"
        code = 0

    report = {
        "schema": "eliza.chipyard_payload_path.v1",
        "generated_utc": datetime.now(UTC).isoformat(),
        "status": status,
        "claim_boundary": "generated_chipyard_artifacts_only_not_rtl_boot_claim",
        **FALSE_CLAIM_FLAGS,
        "summary": "Generated Chipyard artifacts may feed the next external OpenSBI/U-Boot/Linux payload path, but do not prove RTL boot.",
        "capture_wrapper": "scripts/capture_chipyard_linux_evidence.sh",
        "capture_preflight": "scripts/capture_chipyard_linux_evidence.sh preflight",
        "artifacts": artifacts,
        "dts_checks": dts_checks,
        "evidence": evidence_status,
        "blockers": blockers,
        "errors": errors,
        "next_smallest_step": "Complete generated import manifest, then capture OpenSBI handoff before U-Boot/Linux boot evidence.",
    }
    report_path: Path | None = REPORT
    try:
        REPORT.parent.mkdir(parents=True, exist_ok=True)
        REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    except OSError as exc:
        report_path = None
        errors.append(f"could not write report {rel(REPORT)}: {exc}")

    if status == "fail":
        print("STATUS: FAIL chipyard.payload_path - generated artifacts are not usable")
        for error in errors:
            print(f"  - {error}")
    elif status == "blocked":
        print("STATUS: BLOCKED chipyard.payload_path - boot payload evidence is incomplete")
        print("  capture preflight: scripts/capture_chipyard_linux_evidence.sh preflight")
        for blocker in blockers:
            print(f"  - {blocker['detail']}")
            print(f"    next: {blocker['next']}")
    else:
        print("STATUS: PASS chipyard.payload_path - generated payload path evidence is complete")
    if report_path is not None:
        print(f"REPORT: {rel(report_path)}")
    else:
        print(f"REPORT: not written ({rel(REPORT)} is unavailable)")
    return code


if __name__ == "__main__":
    sys.exit(main())
