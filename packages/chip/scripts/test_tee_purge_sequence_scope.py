#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECK_PATH = ROOT / "scripts/check_tee_purge_sequence_scope.py"

spec = importlib.util.spec_from_file_location("check_tee_purge_sequence_scope", CHECK_PATH)
if spec is None or spec.loader is None:
    raise SystemExit(f"unable to import {CHECK_PATH}")
check_tee_purge_sequence_scope = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = check_tee_purge_sequence_scope
spec.loader.exec_module(check_tee_purge_sequence_scope)


def test_real_evidence_blockers_emit_findings() -> None:
    report = check_tee_purge_sequence_scope.build_report()
    findings = report.get("findings")
    if not isinstance(findings, list):
        raise AssertionError("findings missing")
    if len(findings) != len(check_tee_purge_sequence_scope.BLOCKED_UNTIL_REAL_EVIDENCE):
        raise AssertionError(findings)
    codes = [finding["code"] for finding in findings]
    if not all(code.startswith("tee_purge_missing_real_evidence_") for code in codes):
        raise AssertionError(codes)
    print("PASS TEE purge real-evidence blockers emit structured findings")


def test_failed_model_check_emits_finding() -> None:
    findings = check_tee_purge_sequence_scope.structured_findings(
        [],
        [
            {
                "id": "purge_sequence_model_positive_negative_vectors",
                "status": "fail",
                "evidence": "scripts/tee/purge_sequence_model.py",
            }
        ],
    )
    codes = [finding["code"] for finding in findings]
    if codes != [
        "tee_purge_model_check_failed_purge_sequence_model_positive_negative_vectors"
    ]:
        raise AssertionError(codes)
    print("PASS TEE purge model failures emit structured findings")


def main() -> None:
    test_real_evidence_blockers_emit_findings()
    test_failed_model_check_emits_finding()


if __name__ == "__main__":
    main()
