"""Tests for the Eliza-1 GGUF platform release checklist."""

from __future__ import annotations

import json
import sys
from pathlib import Path

_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

from scripts.manifest.eliza1_manifest import ELIZA_1_TIERS  # noqa: E402
from scripts.manifest.eliza1_platform_plan import (  # noqa: E402
    build_plan,
    missing_files,
    plan_to_json,
    release_status_blockers,
    render_readiness,
)


def test_platform_plan_is_json_serializable_and_covers_all_tiers() -> None:
    data = plan_to_json(build_plan())
    assert set(data) == set(ELIZA_1_TIERS)
    json.dumps(data, sort_keys=True)


def test_vad_is_native_ggml_not_gguf_but_asr_is_gguf() -> None:
    plan = build_plan()
    for tier_plan in plan.values():
        assert "vad/silero-vad-v5.1.2.ggml.bin" in tier_plan.required_files
        assert "vad/silero-vad-int8.onnx" not in tier_plan.required_files
        assert "vad/silero-vad-int8.gguf" not in tier_plan.required_files
        assert "vad/silero-vad-v5.1.2.gguf" not in tier_plan.required_files
        assert tier_plan.optional_files == ("vad/silero-vad-int8.onnx",)
        assert "asr/eliza-1-asr.gguf" in tier_plan.required_files
        assert "asr/eliza-1-asr-mmproj.gguf" in tier_plan.required_files


def test_rocm_desktop_platform_evidence_and_dispatch_are_required() -> None:
    tier_plan = build_plan()["4b"]
    assert "evals/rocm_verify.json" in tier_plan.required_files
    assert "evals/rocm_dispatch.json" in tier_plan.required_files
    targets = {target.id: target for target in tier_plan.required_platform_evidence}
    assert targets["linux-x64-rocm"].backend == "rocm"
    assert targets["linux-x64-rocm"].evidence_path == (
        "evidence/platform/linux-x64-rocm.json"
    )


def test_dflash_required_files_match_bundle_layout() -> None:
    tier_plan = build_plan()["4b"]
    assert "dflash/drafter-4b.gguf" in tier_plan.required_files
    assert "dflash/target-meta.json" in tier_plan.required_files
    assert "dflash/eliza-1-drafter-4b.gguf" not in tier_plan.required_files


def test_voice_artifacts_follow_kokoro_omnivoice_boundary() -> None:
    plan = build_plan()
    assert "tts/kokoro/model_q4.onnx" in plan["0_8b"].required_files
    assert "tts/omnivoice-base-Q4_K_M.gguf" not in plan["0_8b"].required_files
    assert "tts/kokoro/model_q4.onnx" in plan["2b"].required_files
    assert "tts/kokoro/model_q4.onnx" in plan["4b"].required_files
    assert "tts/kokoro/model_q4.onnx" in plan["9b"].required_files
    assert "tts/omnivoice-base-Q8_0.gguf" in plan["9b"].required_files
    assert "tts/kokoro/model_q4.onnx" not in plan["27b"].required_files
    assert "tts/omnivoice-base-Q8_0.gguf" in plan["27b"].required_files


def test_missing_files_reports_required_paths(tmp_path: Path) -> None:
    plan = build_plan()
    root = tmp_path / "bundles"
    (root / "eliza-1-4b" / "vad").mkdir(parents=True)
    (root / "eliza-1-4b" / "vad" / "silero-vad-v5.1.2.ggml.bin").write_bytes(
        b"vad"
    )
    missing = missing_files(root, plan)
    assert "vad/silero-vad-v5.1.2.ggml.bin" not in missing["4b"]
    assert "text/eliza-1-4b-64k.gguf" in missing["4b"]
    assert "evidence/platform/linux-x64-rocm.json" in missing["4b"]


def test_readiness_mentions_vad_native_ggml_caveat() -> None:
    text = render_readiness(build_plan(), missing=None)
    assert "VAD is a native GGML artifact" in text
    assert "It is not GGUF" in text
    assert "vad/silero-vad-int8.onnx" in text
    assert "Qwen3.5 0.8B (`0_8b`)" in text
    assert "Qwen3.5 2B (`2b`)" in text
    assert "Qwen3.5 4B (`4b`)" in text
    assert "published Qwen3-ASR 0.6B / 1.7B GGUF repos" in text
    assert "Qwen3-Embedding-0.8B/2B repo IDs" in text
    assert "not evaluated in plan-only mode" in text
    assert "VAD latency/boundary/endpoint/false-barge-in" in text
    assert "Release evidence must use real final hashes" in text
    assert "No-larp release readiness" in text
    # v1 release shape is documented in the readiness ledger.
    assert "releaseState=base-v1" in text
    assert "NOT fine-tuned" in text


def test_release_status_blockers_detect_missing_canonical_bundle(
    tmp_path: Path,
) -> None:
    blockers = release_status_blockers(tmp_path / "bundles", build_plan())
    assert any("missing canonical local bundle" in item for item in blockers["0_8b"])
    assert any("release.json" in item and "missing" in item for item in blockers["0_8b"])


def test_release_status_blockers_detect_local_standin_evidence(tmp_path: Path) -> None:
    plan = build_plan()
    bundle = tmp_path / "bundles" / "eliza-1-2b.bundle"
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
    assert any("releaseState" in item for item in blockers["2b"])
    assert any("final.weights" in item for item in blockers["2b"])
    assert any("hf.status" in item for item in blockers["2b"])
    assert any("hf.uploadEvidence missing" in item for item in blockers["2b"])

    text = render_readiness(plan, missing={}, blockers=blockers)
    assert "Publish-blocking status:" in text


def test_release_status_blockers_accept_base_v1_uploaded_evidence(
    tmp_path: Path,
) -> None:
    """A `base-v1` bundle (upstream base models, GGUF + fully optimized,
    NOT fine-tuned) with all the runnable-on-base evidence present is
    treated as a satisfiable release shape — `final.weights` is NOT a
    blocker for `base-v1` because the bytes are the upstream base GGUFs by
    design (recorded via `sourceModels`)."""
    plan = build_plan()
    bundle = tmp_path / "bundles" / "eliza-1-2b.bundle"
    (bundle / "evidence").mkdir(parents=True)
    required_weights = sorted(
        rel
        for rel in plan["2b"].required_files
        if rel.split("/", 1)[0]
        in {"text", "tts", "asr", "vad", "vision", "dflash"}
    )
    (bundle / "evidence" / "release.json").write_text(
        json.dumps(
            {
                "releaseState": "base-v1",
                "publishEligible": True,
                "finetuned": False,
                "sourceModels": {
                    "text": {"repo": "Qwen/Qwen3.5-2B"},
                    "voice": {"repo": "Serveurperso/OmniVoice-GGUF"},
                    "asr": {"repo": "ggml-org/Qwen3-ASR-0.6B-GGUF"},
                    "vad": {"repo": "ggml-org/whisper-vad"},
                    "embedding": {"repo": "Qwen/Qwen3-Embedding-0.6B-GGUF"},
                    "drafter": {"repo": "elizaos/eliza-1", "file": "bundles/2b/dflash/drafter-2b.gguf"},
                },
                "final": {
                    # weights are the upstream base GGUFs by design — not a
                    # trained Eliza-1 checkpoint, not a blocker for base-v1.
                    "weights": False,
                    "hashes": True,
                    "evals": True,
                    "licenses": True,
                    "kernelDispatchReports": True,
                    "platformEvidence": True,
                    "sizeFirstRepoIds": True,
                },
                "weights": required_weights,
                "checksumManifest": "checksums/SHA256SUMS",
                "hf": {
                    "repoId": "elizaos/eliza-1",
                    "repoPath": "bundles/2b",
                    "status": "uploaded",
                    "uploadEvidence": {
                        "repoId": "elizaos/eliza-1",
                        "pathPrefix": "bundles/2b",
                        "status": "uploaded",
                        "commit": "abc123",
                        "url": "https://huggingface.co/elizaos/eliza-1/commit/abc123",
                        "uploadedPaths": required_weights,
                    },
                },
            }
        )
    )
    blockers = release_status_blockers(tmp_path / "bundles", plan)
    assert blockers["2b"] == []


def test_release_status_blockers_base_v1_blocks_pending_upload(
    tmp_path: Path,
) -> None:
    plan = build_plan()
    bundle = tmp_path / "bundles" / "eliza-1-2b.bundle"
    (bundle / "evidence").mkdir(parents=True)
    required_weights = sorted(
        rel
        for rel in plan["2b"].required_files
        if rel.split("/", 1)[0]
        in {"text", "tts", "asr", "vad", "vision", "dflash"}
    )
    (bundle / "evidence" / "release.json").write_text(
        json.dumps(
            {
                "releaseState": "base-v1",
                "publishEligible": True,
                "finetuned": False,
                "sourceModels": {"text": {"repo": "Qwen/Qwen3.5-2B"}},
                "final": {
                    "weights": False,
                    "hashes": True,
                    "evals": True,
                    "licenses": True,
                    "kernelDispatchReports": True,
                    "platformEvidence": True,
                    "sizeFirstRepoIds": True,
                },
                "weights": required_weights,
                "checksumManifest": "checksums/SHA256SUMS",
                "hf": {
                    "repoId": "elizaos/eliza-1",
                    "repoPath": "bundles/2b",
                    "status": "pending-upload",
                },
            }
        )
    )
    blockers = release_status_blockers(tmp_path / "bundles", plan)
    assert any("hf.status" in item for item in blockers["2b"])
    assert any("hf.uploadEvidence missing" in item for item in blockers["2b"])


def test_release_status_blockers_base_v1_rejects_fake_qwen_component_repos(
    tmp_path: Path,
) -> None:
    plan = build_plan()
    bundle = tmp_path / "bundles" / "eliza-1-2b.bundle"
    (bundle / "evidence").mkdir(parents=True)
    (bundle / "evidence" / "release.json").write_text(
        json.dumps(
            {
                "releaseState": "base-v1",
                "publishEligible": True,
                "finetuned": False,
                "sourceModels": {
                    "text": {"repo": "Qwen/Qwen3.5-2B"},
                    "asr": {"repo": "ggml-org/Qwen3-ASR-2B-GGUF"},
                    "embedding": {"repo": "Qwen/Qwen3-Embedding-0.8B-GGUF"},
                },
                "final": {
                    "weights": False,
                    "hashes": True,
                    "evals": True,
                    "licenses": True,
                    "kernelDispatchReports": True,
                    "platformEvidence": True,
                    "sizeFirstRepoIds": True,
                },
                "weights": [],
                "checksumManifest": "checksums/SHA256SUMS",
                "hf": {
                    "repoId": "elizaos/eliza-1",
                    "status": "pending-upload",
                },
            }
        )
    )

    blockers = release_status_blockers(tmp_path / "bundles", plan)

    assert any("Qwen3-ASR-2B-GGUF" in item for item in blockers["2b"])
    assert any("Qwen3-Embedding-0.8B-GGUF" in item for item in blockers["2b"])


def test_release_status_blockers_base_v1_requires_finetuned_false(
    tmp_path: Path,
) -> None:
    plan = build_plan()
    bundle = tmp_path / "bundles" / "eliza-1-2b.bundle"
    (bundle / "evidence").mkdir(parents=True)
    (bundle / "evidence" / "release.json").write_text(
        json.dumps(
            {
                "releaseState": "base-v1",
                "publishEligible": True,
                "finetuned": True,  # contradicts base-v1
                "sourceModels": {"text": {"repo": "Qwen/Qwen3.5-2B"}},
                "final": {
                    "weights": False,
                    "hashes": True,
                    "evals": True,
                    "licenses": True,
                    "kernelDispatchReports": True,
                    "platformEvidence": True,
                    "sizeFirstRepoIds": True,
                },
                "hf": {"status": "pending-upload"},
            }
        )
    )
    blockers = release_status_blockers(tmp_path / "bundles", plan)
    assert any("finetuned" in item for item in blockers["2b"])
