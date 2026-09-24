"""Opt-in production diarization evaluation on five synthetic audio fixtures.

Set PRODUCTION_SPEAKER_STACK=1 to require the selected backend and its assets.
Missing dependencies, model download failures and inference errors fail this lane.
The default suite does not claim production coverage from fallback encoders.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import pytest
from conftest import (
    TARGET_SR,
    load_fixture_audio,
    read_manifest,
)
from production_stack import ProductionDiarizer, production_stack_enabled

logger = logging.getLogger(__name__)


pytestmark = pytest.mark.skipif(
    not production_stack_enabled(),
    reason="production stack requires PRODUCTION_SPEAKER_STACK=1 and staged assets",
)


@pytest.fixture(scope="module")
def production_diarizer() -> ProductionDiarizer:
    """Load the requested backend; an unavailable production stack is a failure."""
    return ProductionDiarizer.load()


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
            f"{fixture_key}: detected {detected} speakers, expected >= {expected}"
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
            f"production stack should not over-split below 3."
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
            r["detected_speakers"] >= r["expected_speakers"] for r in report.values()
        )
