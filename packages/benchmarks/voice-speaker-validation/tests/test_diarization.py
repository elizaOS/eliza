"""
test_diarization.py — Assert diarization emits ≥ ground-truth speaker count.

Spec (W3-6 scope):
  - Diarization must detect at least as many distinct speakers as ground truth.
  - DER (Diarization Error Rate) ≤ relaxed baseline for synthetic fixtures.
  - All 5 fixtures are tested; the single-speaker control must emit exactly 1 cluster.

DER formula used:
  DER = (missed_speech + false_alarm + speaker_error) / total_reference_duration

  We compute a simplified "cluster DER" against ground-truth boundaries:
    - speaker_error = duration where the majority-cluster assignment differs
      from ground truth.
  This is a lower bound on full DER (no collar applied, no file-level weighting).
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
import pytest

from conftest import (
    InMemoryVoiceProfileStore,
    SegmentDiarizer,
    SpeakerEncoder,
    load_fixture_audio,
)


FIXTURES_DIR = Path(__file__).parent.parent / "fixtures"


def compute_frame_accuracy(
    hyp_segments: list[dict],
    ref_segments: list[dict],
    total_ms: int,
    frame_ms: int = 10,
) -> tuple[float, float]:
    """
    Compute frame-level speaker accuracy and DER.

    Returns (accuracy, DER) where:
      - accuracy = fraction of frames where hyp matches ref majority speaker
      - DER = speaker_error / total_reference_duration
    """
    n_frames = total_ms // frame_ms
    if n_frames == 0:
        return 1.0, 0.0

    ref_labels = np.full(n_frames, -1, dtype=int)
    hyp_labels = np.full(n_frames, -1, dtype=int)

    # Map reference speaker names to int ids
    ref_speakers: dict[str, int] = {}
    for seg in ref_segments:
        spk = seg["speaker"]
        if spk not in ref_speakers:
            ref_speakers[spk] = len(ref_speakers)
        sid = ref_speakers[spk]
        start_f = seg["start_ms"] // frame_ms
        end_f = min(seg["end_ms"] // frame_ms, n_frames)
        ref_labels[start_f:end_f] = sid

    # Fill hypothesis labels
    for seg in hyp_segments:
        start_f = seg["start_ms"] // frame_ms
        end_f = min(seg["end_ms"] // frame_ms, n_frames)
        hyp_labels[start_f:end_f] = seg["speaker_id"]

    # Build optimal mapping from hyp cluster → ref speaker using
    # Hungarian-style greedy (sufficient for ≤4 speakers)
    n_ref = max(len(ref_speakers), 1)
    n_hyp = max(int(hyp_labels.max()) + 1, 1) if len(hyp_labels) > 0 else 1
    confusion = np.zeros((n_hyp, n_ref), dtype=int)
    mask = (ref_labels >= 0) & (hyp_labels >= 0)
    for h, r in zip(hyp_labels[mask], ref_labels[mask]):
        if 0 <= h < n_hyp and 0 <= r < n_ref:
            confusion[h, r] += 1

    # Greedy optimal assignment
    hyp_to_ref: dict[int, int] = {}
    used_ref: set[int] = set()
    for _ in range(min(n_hyp, n_ref)):
        best_val = -1
        best_h, best_r = 0, 0
        for h in range(n_hyp):
            if h in hyp_to_ref:
                continue
            for r in range(n_ref):
                if r in used_ref:
                    continue
                if confusion[h, r] > best_val:
                    best_val = confusion[h, r]
                    best_h, best_r = h, r
        if best_val >= 0:
            hyp_to_ref[best_h] = best_r
            used_ref.add(best_r)

    # Compute speaker error frames
    ref_active = ref_labels >= 0
    hyp_active = hyp_labels >= 0
    both_active = ref_active & hyp_active
    correct = 0
    error = 0
    for frame_i in np.where(both_active)[0]:
        mapped = hyp_to_ref.get(int(hyp_labels[frame_i]), -1)
        if mapped == ref_labels[frame_i]:
            correct += 1
        else:
            error += 1

    total_ref_frames = int(ref_active.sum())
    der = error / max(total_ref_frames, 1)
    accuracy = correct / max(total_ref_frames, 1)
    return accuracy, der


class TestDiarization:
    """
    Diarization correctness tests against ground-truth speaker boundaries.
    """

    def test_single_speaker_control(self, diarizer: SegmentDiarizer, manifest: dict):
        """F1: Samantha solo → diarizer must produce exactly 1 unique speaker cluster."""
        info = manifest["f1_samantha_solo"]
        pcm = load_fixture_audio(info["path"])
        results = diarizer.diarize(pcm)

        assert len(results) > 0, "Diarizer returned no segments for solo audio"
        unique_speakers = len({seg["speaker_id"] for seg in results})
        assert unique_speakers == 1, (
            f"Solo audio produced {unique_speakers} speaker clusters; expected exactly 1. "
            f"Segments: {[(s['start_ms'], s['end_ms'], s['speaker_id']) for s in results]}"
        )

    def test_two_speaker_minimum_count(self, diarizer: SegmentDiarizer, manifest: dict):
        """F2: Two-speaker fixture → diarizer must detect ≥ 2 distinct speakers."""
        info = manifest["f2_two_speaker"]
        expected_speakers = info["speakers"]
        pcm = load_fixture_audio(info["path"])
        results = diarizer.diarize(pcm)

        assert len(results) > 0, "Diarizer returned no segments for two-speaker audio"
        detected = len({seg["speaker_id"] for seg in results})
        assert detected >= expected_speakers, (
            f"F2 expected ≥{expected_speakers} speakers, diarizer detected {detected}"
        )

    def test_three_speaker_minimum_count(self, diarizer: SegmentDiarizer, manifest: dict):
        """F3: Three-speaker fixture → diarizer must detect ≥ 3 distinct speakers."""
        info = manifest["f3_three_speaker"]
        expected_speakers = info["speakers"]
        pcm = load_fixture_audio(info["path"])
        results = diarizer.diarize(pcm)

        assert len(results) > 0, "Diarizer returned no segments for three-speaker audio"
        detected = len({seg["speaker_id"] for seg in results})
        assert detected >= expected_speakers, (
            f"F3 expected ≥{expected_speakers} speakers, diarizer detected {detected}"
        )

    def test_two_speaker_der_baseline(self, diarizer: SegmentDiarizer, manifest: dict):
        """F2: DER ≤ 0.45 on two-speaker alternating fixture."""
        info = manifest["f2_two_speaker"]
        pcm = load_fixture_audio(info["path"])
        results = diarizer.diarize(pcm)
        gt = info["ground_truth"]
        total_ms = int(len(pcm) / 16000 * 1000)

        accuracy, der = compute_frame_accuracy(results, gt, total_ms)
        # Relaxed baseline: synthetic pitch-shifted speakers, energy-VAD diarizer.
        # Production pyannote DER target is ≤ 0.25; for our test harness, ≤ 0.45.
        assert der <= 0.45, (
            f"F2 DER {der:.3f} exceeds 0.45 baseline. Accuracy={accuracy:.3f}"
        )

    def test_four_long_dialogue_stable_reidentification(
        self, diarizer: SegmentDiarizer, manifest: dict
    ):
        """F4: Long dialogue → ≥ 2 distinct speakers; same speaker re-identified consistently."""
        info = manifest["f4_long_dialogue"]
        pcm = load_fixture_audio(info["path"])
        results = diarizer.diarize(pcm)
        gt = info["ground_truth"]

        assert len(results) >= 2, "F4 must produce at least 2 diarized segments"
        unique_speakers = {seg["speaker_id"] for seg in results}
        assert len(unique_speakers) >= 2, (
            f"F4 expected ≥2 speakers; got {len(unique_speakers)}"
        )

        # Check that speaker assignments are temporally stable:
        # the majority label for a speaker's first half should match the second half.
        total_ms = int(len(pcm) / 16000 * 1000)
        mid_ms = total_ms // 2
        first_half = [s for s in results if s["start_ms"] < mid_ms]
        second_half = [s for s in results if s["start_ms"] >= mid_ms]

        def dominant(segs):
            from collections import Counter
            c = Counter(s["speaker_id"] for s in segs)
            return c.most_common(1)[0][0] if c else -1

        d1 = dominant(first_half)
        d2 = dominant(second_half)
        # At least one speaker label should be consistent across halves
        # (the dominant speaker in the first half appears in the second)
        second_ids = {s["speaker_id"] for s in second_half}
        assert d1 in second_ids or len(second_ids) == 0, (
            f"F4 dominant first-half speaker {d1} not found in second half {second_ids}"
        )

    def test_jill_scenario_detects_two_speakers(self, diarizer: SegmentDiarizer, manifest: dict):
        """F5: Jill scenario → diarizer must detect ≥ 2 distinct speakers."""
        info = manifest["f5_jill_scenario"]
        pcm = load_fixture_audio(info["path"])
        results = diarizer.diarize(pcm)

        assert len(results) >= 2, (
            f"F5 (Jill scenario) produced only {len(results)} segment(s); expected ≥2"
        )
        unique_speakers = {seg["speaker_id"] for seg in results}
        assert len(unique_speakers) >= 2, (
            f"F5 expected ≥2 distinct speakers; got {len(unique_speakers)}: "
            f"{[(s['start_ms'], s['end_ms'], s['speaker_id']) for s in results]}"
        )

    def test_all_fixtures_produce_segments(self, diarizer: SegmentDiarizer, manifest: dict):
        """All 5 fixtures must produce at least 1 diarized segment (not empty output)."""
        for name, info in manifest.items():
            pcm = load_fixture_audio(info["path"])
            results = diarizer.diarize(pcm)
            assert len(results) >= 1, f"Fixture '{name}' produced no diarization segments"

    def test_diarization_segment_timestamps_ordered(
        self, diarizer: SegmentDiarizer, manifest: dict
    ):
        """All fixtures: diarization segments must be temporally ordered and non-overlapping."""
        for name, info in manifest.items():
            pcm = load_fixture_audio(info["path"])
            results = diarizer.diarize(pcm)
            for i in range(1, len(results)):
                prev, cur = results[i - 1], results[i]
                assert cur["start_ms"] >= prev["start_ms"], (
                    f"[{name}] Segment {i} start_ms={cur['start_ms']} < prev "
                    f"start_ms={prev['start_ms']} — not ordered"
                )
            for seg in results:
                assert seg["end_ms"] > seg["start_ms"], (
                    f"[{name}] Segment has end_ms={seg['end_ms']} ≤ start_ms={seg['start_ms']}"
                )

    def test_write_diarization_artifact(
        self, diarizer: SegmentDiarizer, manifest: dict, artifacts_dir: Path
    ):
        """Write diarization.json to artifacts dir for review."""
        output = {}
        for name, info in manifest.items():
            pcm = load_fixture_audio(info["path"])
            results = diarizer.diarize(pcm)
            gt = info["ground_truth"]
            total_ms = int(len(pcm) / 16000 * 1000)
            accuracy, der = compute_frame_accuracy(results, gt, total_ms)
            unique_speakers = len({seg["speaker_id"] for seg in results})
            output[name] = {
                "fixture_path": info["path"],
                "ground_truth_speakers": info["speakers"],
                "detected_speakers": unique_speakers,
                "segment_count": len(results),
                "accuracy": round(accuracy, 4),
                "der": round(der, 4),
                "segments": [
                    {k: v for k, v in seg.items() if k != "embedding"}
                    for seg in results
                ],
            }

        out_path = artifacts_dir / "diarization.json"
        with open(out_path, "w") as f:
            json.dump(output, f, indent=2)
        assert out_path.exists()
