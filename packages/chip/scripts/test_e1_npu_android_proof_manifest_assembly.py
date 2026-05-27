#!/usr/bin/env python3
"""Tests for assembling Android e1-NPU proof manifests."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSEMBLE = ROOT / "scripts/assemble_e1_npu_android_proof_manifest.py"
CHECK = ROOT / "scripts/check_e1_npu_android_proof_manifest.py"
TEMPLATE = ROOT / "docs/benchmarks/capabilities/e1_npu_android_proof_manifest.template.json"


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def test_assembly_blocks_with_missing_artifacts() -> None:
    parent = ROOT / "benchmarks/results/test-temp"
    parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=parent) as td:
        temp_root = Path(td)
        template_data = json.loads(TEMPLATE.read_text(encoding="utf-8"))
        for artifact in template_data["artifacts"].values():
            artifact["path"] = str(
                (temp_root / "missing" / Path(artifact["path"]).name).relative_to(ROOT)
            )
        template = temp_root / "template.json"
        template.write_text(json.dumps(template_data, indent=2) + "\n", encoding="utf-8")
        out = temp_root / "android-proof-manifest.json"
        report = temp_root / "assembly.json"
        result = run(
            [
                sys.executable,
                str(ASSEMBLE),
                "--template",
                str(template),
                "--output",
                str(out),
                "--report",
                str(report),
            ]
        )
        if result.returncode != 2:
            raise AssertionError(result.stdout)
        assembled = json.loads(out.read_text())
        if assembled.get("status") != "blocked":
            raise AssertionError(json.dumps(assembled, indent=2))
        check = run(
            [
                sys.executable,
                str(CHECK),
                "--manifest",
                str(out),
                "--require-pass",
                "--status-json",
                str(Path(td) / "check.json"),
            ]
        )
        if check.returncode != 2:
            raise AssertionError(check.stdout)


def test_assembly_passes_with_all_artifacts() -> None:
    parent = ROOT / "benchmarks/results/test-temp"
    parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=parent) as td:
        temp_root = Path(td)
        template_data = json.loads(TEMPLATE.read_text(encoding="utf-8"))
        template = temp_root / "template.json"
        for artifact in template_data["artifacts"].values():
            artifact["path"] = str(
                (temp_root / "android-proof" / Path(artifact["path"]).name).relative_to(ROOT)
            )
        for name, artifact in template_data["artifacts"].items():
            path = ROOT / artifact["path"]
            path.parent.mkdir(parents=True, exist_ok=True)
            markers = template_data["required_markers"][name]
            path.write_text(" ".join(markers) + "\n", encoding="utf-8")
        template.write_text(json.dumps(template_data, indent=2) + "\n", encoding="utf-8")
        out = temp_root / "android-proof-manifest.json"
        report = temp_root / "assembly.json"
        result = run(
            [
                sys.executable,
                str(ASSEMBLE),
                "--template",
                str(template),
                "--output",
                str(out),
                "--report",
                str(report),
                "--generated-by",
                "unit-test",
            ]
        )
        if result.returncode != 0:
            raise AssertionError(result.stdout)
        assembled = json.loads(out.read_text())
        if assembled.get("status") != "passed":
            raise AssertionError(json.dumps(assembled, indent=2))
        check = run(
            [
                sys.executable,
                str(CHECK),
                "--manifest",
                str(out),
                "--require-pass",
                "--status-json",
                str(temp_root / "check.json"),
            ]
        )
        if check.returncode != 0:
            raise AssertionError(check.stdout)


def main() -> int:
    for test in (
        test_assembly_blocks_with_missing_artifacts,
        test_assembly_passes_with_all_artifacts,
    ):
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
