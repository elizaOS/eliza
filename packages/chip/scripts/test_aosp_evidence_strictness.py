#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECK = ROOT / "scripts/check_android_sim_boot.py"
BOOT = ROOT / "scripts/boot_android_simulator.sh"
REPORT = ROOT / "build/reports/android_sim_boot.json"
LOG_EVIDENCE_MANIFEST = ROOT / "docs/android/bsp-log-evidence-manifest.json"


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def test_checker_rejects_virtual_smoke_manifest_without_schema_metadata() -> None:
    saved_report = REPORT.read_bytes() if REPORT.is_file() else None
    saved_manifest = LOG_EVIDENCE_MANIFEST.read_bytes()
    try:
        run([str(BOOT)])
        manifest = json.loads(saved_manifest)
        qemu_spec = manifest["logs"]["docs/evidence/android/qemu_riscv64_smoke.log"]
        qemu_spec["required_metadata"] = [
            item
            for item in qemu_spec.get("required_metadata", [])
            if item != "SCHEMA=docs/android/boot-transcript.schema.json"
        ]
        LOG_EVIDENCE_MANIFEST.write_text(json.dumps(manifest, indent=2, sort_keys=True))
        result = run([sys.executable, str(CHECK)])
        expected = (
            "AOSP virtual smoke spec for docs/evidence/android/qemu_riscv64_smoke.log "
            "must require SCHEMA=docs/android/boot-transcript.schema.json"
        )
        if result.returncode != 1 or expected not in result.stdout:
            raise AssertionError(
                "expected checker to fail on unsafe virtual-smoke manifest\n"
                f"returncode={result.returncode}\n{result.stdout}"
            )
    finally:
        LOG_EVIDENCE_MANIFEST.write_bytes(saved_manifest)
        if saved_report is None:
            REPORT.unlink(missing_ok=True)
        else:
            REPORT.parent.mkdir(parents=True, exist_ok=True)
            REPORT.write_bytes(saved_report)


def main() -> int:
    test_checker_rejects_virtual_smoke_manifest_without_schema_metadata()
    print("PASS test_checker_rejects_virtual_smoke_manifest_without_schema_metadata")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
