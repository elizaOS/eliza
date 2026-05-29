#!/usr/bin/env python3
"""Static tests for Android CTS/VTS smoke result artifact wiring."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CTS = ROOT / "scripts/android/run_cts_smoke.sh"
VTS = ROOT / "scripts/android/run_vts_smoke.sh"


def require(text: str, needle: str, label: str) -> None:
    if needle not in text:
        raise AssertionError(f"{label} missing {needle!r}")


def test_cts_emits_manifest_ready_result_json() -> None:
    text = CTS.read_text(encoding="utf-8")
    require(text, "RESULT_JSON=\"${CTS_RESULT_JSON:-docs/evidence/android/e1-npu/cts-result.json}\"", "CTS")
    require(text, "REFRESH_ANDROID_MANIFEST=\"${E1_NPU_REFRESH_ANDROID_MANIFEST:-1}\"", "CTS")
    require(text, "scripts/assemble_e1_npu_android_proof_manifest.py", "CTS")
    require(text, "--module CtsNNAPITestCases", "CTS")
    require(text, "TRADEFED_RC=${PIPESTATUS[0]}", "CTS")
    for marker in (
        '"schema": "eliza.e1_npu_android_cts_smoke_result.v1"',
        '"CTS_SCOPE"',
        '"NNAPI"',
        '"RESULT=0"',
        "cts_smoke_only_not_full_android_compatibility_claim",
    ):
        require(text, marker, "CTS")


def test_vts_emits_manifest_ready_result_json() -> None:
    text = VTS.read_text(encoding="utf-8")
    require(text, "RESULT_JSON=\"${VTS_RESULT_JSON:-docs/evidence/android/e1-npu/vts-result.json}\"", "VTS")
    require(text, "REFRESH_ANDROID_MANIFEST=\"${E1_NPU_REFRESH_ANDROID_MANIFEST:-1}\"", "VTS")
    require(text, "scripts/assemble_e1_npu_android_proof_manifest.py", "VTS")
    require(text, "TRADEFED_RC=${PIPESTATUS[0]}", "VTS")
    require(text, "vendor\\.eliza\\.e1_npu\\|e1_npu", "VTS")
    for marker in (
        '"schema": "eliza.e1_npu_android_vts_smoke_result.v1"',
        '"VTS_SCOPE"',
        '"e1_npu"',
        '"RESULT=0"',
        "vts_smoke_only_not_full_android_compatibility_claim",
    ):
        require(text, marker, "VTS")


def main() -> int:
    for test in (
        test_cts_emits_manifest_ready_result_json,
        test_vts_emits_manifest_ready_result_json,
    ):
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
