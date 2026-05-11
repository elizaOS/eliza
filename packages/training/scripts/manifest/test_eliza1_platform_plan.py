"""Tests for the Eliza-1 GGUF platform release checklist."""

from __future__ import annotations

import json
import sys
from pathlib import Path

_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

from scripts.manifest.eliza1_platform_plan import (  # noqa: E402
    build_plan,
    missing_files,
    plan_to_json,
    release_status_blockers,
    render_readiness,
)


def test_platform_plan_is_json_serializable_and_covers_all_tiers() -> None:
    data = plan_to_json(build_plan())
    assert set(data) == {"0_6b", "1_7b", "9b", "27b", "27b-256k"}
    json.dumps(data, sort_keys=True)


def test_vad_is_sidecar_not_gguf_but_asr_is_gguf() -> None:
    plan = build_plan()
    for tier_plan in plan.values():
        assert "vad/silero-vad-int8.onnx" in tier_plan.required_files
        assert "vad/silero-vad-int8.gguf" not in tier_plan.required_files
        assert "asr/eliza-1-asr.gguf" in tier_plan.required_files
        assert "asr/eliza-1-asr-mmproj.gguf" in tier_plan.required_files


def test_rocm_desktop_platform_evidence_and_dispatch_are_required() -> None:
    tier_plan = build_plan()["9b"]
    assert "evals/rocm_verify.json" in tier_plan.required_files
    assert "evals/rocm_dispatch.json" in tier_plan.required_files
    targets = {target.id: target for target in tier_plan.required_platform_evidence}
    assert targets["linux-x64-rocm"].backend == "rocm"
    assert targets["linux-x64-rocm"].evidence_path == (
        "evidence/platform/linux-x64-rocm.json"
    )


def test_dflash_required_files_match_bundle_layout() -> None:
    tier_plan = build_plan()["9b"]
    assert "dflash/drafter-9b.gguf" in tier_plan.required_files
    assert "dflash/target-meta.json" in tier_plan.required_files
    assert "dflash/eliza-1-drafter-9b.gguf" not in tier_plan.required_files


def test_missing_files_reports_required_paths(tmp_path: Path) -> None:
    plan = build_plan()
    root = tmp_path / "bundles"
    (root / "eliza-1-9b" / "vad").mkdir(parents=True)
    (root / "eliza-1-9b" / "vad" / "silero-vad-int8.onnx").write_bytes(b"vad")
    missing = missing_files(root, plan)
    assert "vad/silero-vad-int8.onnx" not in missing["9b"]
    assert "text/eliza-1-9b-64k.gguf" in missing["9b"]
    assert "evidence/platform/linux-x64-rocm.json" in missing["9b"]


def test_readiness_mentions_vad_sidecar_caveat() -> None:
    text = render_readiness(build_plan(), missing=None)
    assert "VAD is intentionally a sidecar ONNX artifact" in text
    assert "Release evidence must use real final weights" in text


def test_release_status_blockers_detect_local_standin_evidence(tmp_path: Path) -> None:
    plan = build_plan()
    bundle = tmp_path / "bundles" / "eliza-1-1_7b.bundle"
    (bundle / "evidence").mkdir(parents=True)
    (bundle / "evidence" / "release.json").write_text(
        json.dumps(
            {
                "releaseState": "local-standin",
                "publishEligible": False,
                "final": {
                    "weights": False,
                    "hashes": True,
                    "evals": False,
                    "licenses": False,
                    "kernelDispatchReports": False,
                    "platformEvidence": False,
                    "sizeFirstRepoIds": False,
                },
                "hf": {"status": "blocked-local-standin"},
            }
        )
    )
    blockers = release_status_blockers(tmp_path / "bundles", plan)
    assert any("releaseState" in item for item in blockers["1_7b"])
    assert any("final.weights" in item for item in blockers["1_7b"])

    text = render_readiness(plan, missing={}, blockers=blockers)
    assert "Publish-blocking status:" in text
