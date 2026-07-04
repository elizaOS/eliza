from __future__ import annotations

import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT.parent))

from registry.scores import (  # noqa: E402
    _score_from_hermes_env_json,
    _score_from_meeting_transcription_proof_json,
)


def test_hermes_env_placeholder_only_score_is_not_publishable() -> None:
    with pytest.raises(ValueError, match="placeholder-only"):
        _score_from_hermes_env_json(
            {
                "score": 0.0,
                "higher_is_better": True,
                "metrics": {"placeholder": 0.0},
                "env_id_public": "hermes_swe_env",
            }
        )


def test_hermes_env_real_metric_with_placeholder_is_publishable() -> None:
    extraction = _score_from_hermes_env_json(
        {
            "score": 0.25,
            "higher_is_better": True,
            "metrics": {"placeholder": 0.0, "pass_rate": 0.25},
            "env_id_public": "hermes_terminalbench_2",
        }
    )

    assert extraction.score == pytest.approx(0.25)
    assert extraction.metrics["pass_rate"] == pytest.approx(0.25)


def test_hermes_env_all_incomplete_zero_is_not_publishable() -> None:
    with pytest.raises(ValueError, match="incomplete"):
        _score_from_hermes_env_json(
            {
                "score": 0.0,
                "higher_is_better": True,
                "metrics": {
                    "pass_rate": 0.0,
                    "total_tasks": 1,
                    "sample_rows": 1,
                    "incomplete_rollouts": 1,
                },
                "env_id_public": "hermes_tblite",
            }
        )


def test_meeting_transcription_mock_lane_is_non_publishable_smoke_score() -> None:
    extraction = _score_from_meeting_transcription_proof_json(
        {
            "kind": "meeting_transcription_proof_report",
            "lane": "mocked_plumbing",
            "publishable": False,
            "provider_mode": "mock",
            "score": 1.0,
            "metrics": {
                "transcript_quality": 1.0,
                "diarization_quality": 1.0,
                "speaker_identity_quality": 1.0,
                "consent_retention_quality": 1.0,
            },
            "evidence_files": {},
        }
    )

    assert extraction.score == pytest.approx(1.0)
    assert extraction.metrics["lane"] == "mocked_plumbing"
    assert extraction.metrics["publishable"] is False


def test_meeting_transcription_mock_lane_cannot_claim_publishable() -> None:
    with pytest.raises(ValueError, match="mocked lane cannot be publishable"):
        _score_from_meeting_transcription_proof_json(
            {
                "kind": "meeting_transcription_proof_report",
                "lane": "mocked_plumbing",
                "publishable": True,
                "score": 1.0,
                "metrics": {},
                "evidence_files": {},
            }
        )


def test_meeting_transcription_real_lane_requires_complete_evidence() -> None:
    with pytest.raises(ValueError, match="complete evidence"):
        _score_from_meeting_transcription_proof_json(
            {
                "kind": "meeting_transcription_proof_report",
                "lane": "real_product",
                "publishable": True,
                "score": 0.8,
                "metrics": {},
                "evidence_files": {"audio": "/tmp/audio.wav"},
            }
        )


def test_meeting_transcription_real_lane_score_is_publishable_with_evidence() -> None:
    evidence_files = {f"evidence_{index}": f"/tmp/evidence-{index}.txt" for index in range(11)}
    extraction = _score_from_meeting_transcription_proof_json(
        {
            "kind": "meeting_transcription_proof_report",
            "lane": "real_product",
            "publishable": True,
            "provider_mode": "zoom-meet-live",
            "score": 0.77,
            "metrics": {
                "transcript_quality": 0.91,
                "diarization_quality": 0.82,
                "speaker_identity_quality": 0.77,
                "consent_retention_quality": 1.0,
            },
            "evidence_files": evidence_files,
        }
    )

    assert extraction.score == pytest.approx(0.77)
    assert extraction.metrics["lane"] == "real_product"
    assert extraction.metrics["publishable"] is True
    assert extraction.metrics["evidence_file_count"] == 11
