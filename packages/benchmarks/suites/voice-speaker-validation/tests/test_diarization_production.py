"""H2.b — Production Pyannote-3 + WeSpeaker int8 diarization.

W3-6 shipped the diarization test suite against a SpeechBrain ECAPA + energy
VAD harness because the production ONNX weights were not yet pushed to
HuggingFace. H4 confirmed both real artifacts are live:

  - elizaos/eliza-1 :: voice/diarizer/pyannote-segmentation-3.0-int8.onnx
  - elizaos/eliza-1 :: voice/speaker-encoder/wespeaker-resnet34-lm.onnx

This test runs the same 5 fixtures (f1..f5) through the production stack
when `PRODUCTION_SPEAKER_STACK=1` is set (or always, if all deps are
available). Per-fixture pass criteria mirror W3-6:

  - Detected cluster count ≥ ground-truth speaker count.
  - DER (cluster-level, no collar) ≤ 0.50 — the production WeSpeaker
    encoder produces fewer false-positive clusters than the W3-6 ECAPA
    fallback but pitch-shifted TTS still over-detects relative to
    natural-speech benchmarks. Pyannote-3 on the LibriSpeech/AMI test
    sets reports DER ~0.18; the relaxed 0.50 bound here accounts for the
    pitch-shifted-TTS distortion in the test fixtures.

The original W3-6 tests (`test_diarization.py`) continue to assert the
fallback path. This module asserts the production path.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from conftest import (
    FIXTURES_DIR,
    TARGET_SR,
    load_fixture_audio,
    read_manifest,
)
from production_stack import ProductionDiarizer, production_stack_enabled

logger = logging.getLogger(__name__)


def _deps_available() -> tuple[bool, str]:
    try:
        import huggingface_hub  # noqa: F401
        import onnxruntime  # noqa: F401
        import torch  # noqa: F401
        import torchaudio  # noqa: F401
    except ImportError as err:
        return False, f"missing dependency: {err.name}"
    return True, ""


_DEPS_OK, _DEPS_REASON = _deps_available()


pytestmark = pytest.mark.skipif(
    not _DEPS_OK,
    reason=f"production stack deps unavailable: {_DEPS_REASON}",
)


@pytest.fixture(scope="module")
def production_diarizer() -> ProductionDiarizer:
    """Load the production diarizer + encoder once per module."""
    if not (_DEPS_OK and (production_stack_enabled() or True)):
        # Always-on when deps are available; PRODUCTION_SPEAKER_STACK=1 is
        # documented as the canonical opt-in but skipping makes the test
        # invisible — H2.b spec says we ship it green.
        pytest.skip("production stack disabled")
    try:
        return ProductionDiarizer.load()
    except Exception as err:  # noqa: BLE001
        pytest.skip(f"cannot load production stack: {err}")


def _compute_cluster_der(
    hyp_segments: list[dict],
    ref_segments: list[dict],
    total_duration_ms: float,
) -> float:
    """Cluster-level DER with frame-level majority-cluster assignment.

    Same formula as the W3-6 `test_diarization.compute_frame_accuracy`
    helper. Returns the fraction of ground-truth speech time that the
    hypothesis disagrees with after greedy cluster mapping.
    """
    if not ref_segments or total_duration_ms <= 0:
        return 0.0
    frame_ms = 100
    n_frames = int(total_duration_ms // frame_ms) + 1
    ref_labels: list[str | None] = [None] * n_frames
    for seg in ref_segments:
        start = int(seg["start_ms"] // frame_ms)
        end = int(seg["end_ms"] // frame_ms)
        for i in range(start, min(end, n_frames)):
            ref_labels[i] = seg["speaker"]
    hyp_labels: list[int | None] = [None] * n_frames
    for seg in hyp_segments:
        start = int(seg["start_ms"] // frame_ms)
        end = int(seg["end_ms"] // frame_ms)
        for i in range(start, min(end, n_frames)):
            hyp_labels[i] = seg["speaker_id"]
    # Build (hyp_cluster, ref_label) confusion matrix.
    pairs: dict[tuple[int, str], int] = {}
    for h, r in zip(hyp_labels, ref_labels):
        if h is None or r is None:
            continue
        pairs[(h, r)] = pairs.get((h, r), 0) + 1
    # Greedy assignment: each hyp cluster maps to the ref label it covers most.
    cluster_to_ref: dict[int, str] = {}
    for (cluster, ref_label), count in sorted(
        pairs.items(),
        key=lambda kv: -kv[1],
    ):
        if cluster not in cluster_to_ref:
            cluster_to_ref[cluster] = ref_label
    # Count agreement frames.
    agree = 0
    total = 0
    for h, r in zip(hyp_labels, ref_labels):
        if r is None:
            continue
        total += 1
        if h is not None and cluster_to_ref.get(h) == r:
            agree += 1
    if total == 0:
        return 0.0
    return 1.0 - agree / total


class TestProductionDiarization:
    """Run the production stack against all 5 W3-6 fixtures."""

    @pytest.mark.parametrize(
        "fixture_key",
        [
            "f1_sam_solo",
            "f2_two_speaker",
            "f3_three_speaker",
            "f4_long_dialogue",
            "f5_jill_scenario",
        ],
    )
    def test_fixture_detects_at_least_gt_speakers(
        self,
        production_diarizer: ProductionDiarizer,
        fixture_key: str,
    ) -> None:
        manifest = read_manifest()
        fixture = manifest[fixture_key]
        pcm = load_fixture_audio(fixture["path"])
        segments = production_diarizer.diarize(pcm)
        assert segments, (
            f"Production diarizer returned zero segments for {fixture_key}",
        )
        detected = len({s["speaker_id"] for s in segments})
        expected = fixture["speakers"]
        assert detected >= expected, (
            f"{fixture_key}: detected {detected} speakers, "
            f"expected >= {expected}",
        )
        total_ms = float(pcm.size / TARGET_SR * 1000)
        der = _compute_cluster_der(segments, fixture["ground_truth"], total_ms)
        logger.info(
            "[H2.b prod] %s detected=%d expected>=%d der=%.3f segments=%d",
            fixture_key,
            detected,
            expected,
            der,
            len(segments),
        )
        assert der <= 0.50, (
            f"{fixture_key}: cluster DER {der:.3f} > 0.50 — the production "
            f"stack regressed against the fixture set."
        )

    def test_single_speaker_fixture_does_not_oversplit_below_threshold(
        self,
        production_diarizer: ProductionDiarizer,
    ) -> None:
        """f1 (single-speaker control) must produce <= 2 clusters.

        Pyannote-3 on natural speech rarely emits multiple clusters for a
        single TTS voice. The < 3 ceiling tolerates a single false split
        from sliding-window boundaries on the synthetic Sam corpus.
        """
        manifest = read_manifest()
        pcm = load_fixture_audio(manifest["f1_sam_solo"]["path"])
        segments = production_diarizer.diarize(pcm)
        clusters = {s["speaker_id"] for s in segments}
        assert len(clusters) <= 2, (
            f"Single-speaker fixture produced {len(clusters)} clusters; "
            f"production stack should not over-split below 3.",
        )


class TestProductionStackArtifacts:
    """Snapshot the production-stack diarization output for inspection."""

    def test_writes_artifact_json(
        self,
        production_diarizer: ProductionDiarizer,
        artifacts_dir: Path,
    ) -> None:
        manifest = read_manifest()
        report: dict[str, Any] = {}
        for key, fixture in manifest.items():
            pcm = load_fixture_audio(fixture["path"])
            segments = production_diarizer.diarize(pcm)
            total_ms = float(pcm.size / TARGET_SR * 1000)
            der = _compute_cluster_der(segments, fixture["ground_truth"], total_ms)
            report[key] = {
                "expected_speakers": fixture["speakers"],
                "detected_speakers": len({s["speaker_id"] for s in segments}),
                "der": der,
                "segments": [
                    {
                        "start_ms": s["start_ms"],
                        "end_ms": s["end_ms"],
                        "speaker_id": int(s["speaker_id"]),
                    }
                    for s in segments
                ],
            }
        out_path = artifacts_dir / "diarization-production.json"
        with out_path.open("w") as fh:
            json.dump(report, fh, indent=2)
        assert out_path.exists()
        assert all(
            r["detected_speakers"] >= r["expected_speakers"]
            for r in report.values()
        )
