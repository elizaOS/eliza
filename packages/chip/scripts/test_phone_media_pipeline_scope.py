#!/usr/bin/env python3
from __future__ import annotations

import copy
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECK_PATH = ROOT / "scripts/check_phone_media_pipeline_scope.py"

spec = importlib.util.spec_from_file_location("check_phone_media_pipeline_scope", CHECK_PATH)
if spec is None or spec.loader is None:
    raise SystemExit(f"unable to import {CHECK_PATH}")
check_phone_media_pipeline_scope = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = check_phone_media_pipeline_scope
spec.loader.exec_module(check_phone_media_pipeline_scope)


def expect_error(report: dict, token: str) -> None:
    errors = check_phone_media_pipeline_scope.validate_report(report)
    if not any(token in error for error in errors):
        raise AssertionError(f"expected {token!r} in {errors}")


def test_valid_report_passes() -> None:
    report = check_phone_media_pipeline_scope.build_report()
    errors = check_phone_media_pipeline_scope.validate_report(report)
    if errors:
        raise AssertionError(errors)
    print("PASS valid phone media pipeline scope report")


def test_claim_boundary_drift_fails() -> None:
    report = check_phone_media_pipeline_scope.build_report()
    report["claim_boundary"] = "display scaffold only"
    expect_error(report, "claim boundary")
    print("PASS claim boundary drift rejected")


def test_release_claim_flip_fails() -> None:
    report = check_phone_media_pipeline_scope.build_report()
    report["summary"]["release_claim_allowed"] = True
    expect_error(report, "release_claim_allowed")
    print("PASS release-claim flip rejected")


def test_display_blocker_removal_fails() -> None:
    report = check_phone_media_pipeline_scope.build_report()
    mutated = copy.deepcopy(report)
    mutated["display_scaffold"]["blocked_until_real_evidence"] = ["GPU"]
    expect_error(mutated, "display")
    print("PASS display blocker removal rejected")


def test_camera_blocker_removal_fails() -> None:
    report = check_phone_media_pipeline_scope.build_report()
    mutated = copy.deepcopy(report)
    mutated["camera_isp_scope"]["blocked_until_real_evidence"] = ["sensor"]
    expect_error(mutated, "camera/ISP")
    print("PASS camera blocker removal rejected")


def main() -> None:
    test_valid_report_passes()
    test_claim_boundary_drift_fails()
    test_release_claim_flip_fails()
    test_display_blocker_removal_fails()
    test_camera_blocker_removal_fails()


if __name__ == "__main__":
    main()
