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
        if not assembled.get("generated_utc") or not assembled.get("date_utc"):
            raise AssertionError(json.dumps(assembled, indent=2))
        assembly_report = json.loads(report.read_text(encoding="utf-8"))
        if not assembly_report.get("claim_boundary") or not assembly_report.get("generated_utc"):
            raise AssertionError(json.dumps(assembly_report, indent=2))
        findings = assembly_report.get("findings", [])
        if not findings or not all(finding.get("next_command") for finding in findings):
            raise AssertionError(json.dumps(assembly_report, indent=2))
        command_text = "\n".join(
            command
            for finding in findings
            for command in finding.get("next_commands", [])
        )
        for token in (
            "scripts/android/run_vts_smoke.sh",
            "scripts/android/run_cts_smoke.sh",
            "capture_e1_npu_nnapi_evidence.sh",
            "check_e1_npu_android_proof_manifest.py",
        ):
            if token not in command_text:
                raise AssertionError(command_text)
        command_plan = assembly_report.get("next_command_plan", [])
        if assembly_report.get("summary", {}).get("next_command_batch_count") != len(
            command_plan
        ):
            raise AssertionError(json.dumps(assembly_report, indent=2))
        if len(command_plan) != len(findings):
            raise AssertionError(json.dumps(assembly_report, indent=2))
        plan_by_output = {
            tuple(batch.get("expected_output_files", [])): batch for batch in command_plan
        }
        for finding in findings:
            key = (finding["evidence"],)
            batch = plan_by_output.get(key)
            if batch is None:
                raise AssertionError(json.dumps(command_plan, indent=2))
            if batch.get("commands") != finding.get("next_commands"):
                raise AssertionError(json.dumps(batch, indent=2))
            if (
                batch.get("claim_boundary")
                != "operator_commands_only_not_android_npu_or_release_evidence"
            ):
                raise AssertionError(json.dumps(batch, indent=2))
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
        check_report = json.loads((Path(td) / "check.json").read_text(encoding="utf-8"))
        if not check_report.get("generated_utc"):
            raise AssertionError(json.dumps(check_report, indent=2))
        if "not_android_boot" not in str(check_report.get("claim_boundary", "")):
            raise AssertionError(json.dumps(check_report, indent=2))
        check_plan = check_report.get("next_command_plan", [])
        if check_report.get("summary", {}).get("next_command_batch_count") != len(check_plan):
            raise AssertionError(json.dumps(check_report, indent=2))
        if len(check_plan) != 1:
            raise AssertionError(json.dumps(check_report, indent=2))
        check_batch = check_plan[0]
        if check_batch.get("id") != "capture_e1_npu_android_proof_bundle":
            raise AssertionError(json.dumps(check_batch, indent=2))
        if not any(
            "capture_e1_npu_android_proof_bundle.sh" in command
            for command in check_batch.get("commands", [])
        ):
            raise AssertionError(json.dumps(check_batch, indent=2))


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
        check_report = json.loads((temp_root / "check.json").read_text(encoding="utf-8"))
        if not check_report.get("generated_utc"):
            raise AssertionError(json.dumps(check_report, indent=2))
        if "not_android_boot" not in str(check_report.get("claim_boundary", "")):
            raise AssertionError(json.dumps(check_report, indent=2))


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
