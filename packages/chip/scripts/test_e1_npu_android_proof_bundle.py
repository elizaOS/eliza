#!/usr/bin/env python3
"""Static tests for the Android e1-NPU proof bundle runner."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUNDLE = ROOT / "scripts/android/capture_e1_npu_android_proof_bundle.sh"


def require(text: str, needle: str) -> None:
    if needle not in text:
        raise AssertionError(f"bundle runner missing {needle!r}")


def test_bundle_runs_all_required_capture_stages() -> None:
    text = BUNDLE.read_text(encoding="utf-8")
    for needle in (
        "scripts/android/capture_e1_npu_hal_absent_device.sh",
        'sw/aosp-device/capture-aosp-evidence.sh "$aosp_tree" checkvintf',
        "scripts/android/capture_e1_npu_nnapi_evidence.sh",
        "scripts/android/run_cts_smoke.sh",
        "scripts/android/run_vts_smoke.sh",
        "scripts/assemble_e1_npu_android_proof_manifest.py",
        "scripts/check_e1_npu_nnapi_proof.py --probe-adb",
        "scripts/check_e1_npu_android_proof_manifest.py",
        "scripts/check_e1_npu_android_proof_bundle_preflight.py",
        "scripts/android/build_cts_vts_tradefed.sh",
    ):
        require(text, needle)


def test_bundle_disables_inner_manifest_refresh_until_final_assembly() -> None:
    text = BUNDLE.read_text(encoding="utf-8")
    if text.count("E1_NPU_REFRESH_ANDROID_MANIFEST=0") < 3:
        raise AssertionError("target sub-captures should not repeatedly refresh the manifest")
    require(text, "assemble_rc=$?")
    require(text, "nnapi_check_rc=$?")
    require(text, "manifest_check_rc=$?")
    require(text, '--manifest docs/evidence/android/e1-npu/android-proof-manifest.json')


def main() -> int:
    for test in (
        test_bundle_runs_all_required_capture_stages,
        test_bundle_disables_inner_manifest_refresh_until_final_assembly,
    ):
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
