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


GENERATED_ARTIFACT_SCORE_IDS = (
    "summary_factuality",
    "action_item_owner_date",
    "decision_extraction",
    "open_question_extraction",
    "memory_entity_correctness",
    "hallucination_rate",
    "omission_rate",
    "source_grounding",
)


def _meeting_generated_artifact_scores() -> list[dict[str, object]]:
    return [
        {
            "id": score_id,
            "observed_score": 0.0 if score_id in {"hallucination_rate", "omission_rate"} else 1.0,
        }
        for score_id in GENERATED_ARTIFACT_SCORE_IDS
    ]


def _meeting_baseline_comparisons() -> list[dict[str, object]]:
    return [
        {"id": "eliza_current_baseline", "comparison_type": "internal_baseline", "run_status": "run"},
        {"id": "otter_product_baseline", "comparison_type": "external_product", "run_status": "not_run"},
        {"id": "granola_product_baseline", "comparison_type": "external_product", "run_status": "not_run"},
        {"id": "zoom_native_notes_baseline", "comparison_type": "external_product", "run_status": "imported"},
        {
            "id": "google_meet_gemini_notes_baseline",
            "comparison_type": "external_product",
            "run_status": "imported",
        },
        {
            "id": "whisperx_pyannote_open_source_baseline",
            "comparison_type": "open_source",
            "run_status": "run",
        },
        {
            "id": "nemo_sortformer_open_source_baseline",
            "comparison_type": "open_source",
            "run_status": "not_run",
        },
    ]


def _meeting_adversarial_cases() -> list[dict[str, object]]:
    return [{"id": f"adv_{index}", "class": f"class_{index}"} for index in range(10)]


def _meeting_qa_checklist() -> list[dict[str, object]]:
    return [{"id": f"qa_{index}", "verdict": "pass", "machine_verdict": "pass"} for index in range(5)]


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
    assert extraction.metrics["speaker_name_provenance_count"] == 0


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
    with pytest.raises(ValueError, match="named evidence"):
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


def _meeting_transcription_real_metrics() -> dict[str, float]:
    return {
        "transcript_quality": 0.91,
        "diarization_quality": 0.82,
        "speaker_identity_quality": 0.77,
        "consent_retention_quality": 1.0,
        "wer": 0.09,
        "cer": 0.04,
        "speaker_attributed_wer": 0.13,
        "der": 0.18,
        "jer": 0.22,
        "overlap_aware_wer": 0.2,
        "active_speaker_accuracy": 0.84,
        "voice_profile_false_accept_rate": 0.03,
        "voice_profile_false_reject_rate": 0.08,
        "end_of_turn_latency_ms": 280,
        "barge_in_latency_ms": 190,
        "p95_end_to_end_latency_ms": 1300,
        "notes_factuality": 0.93,
        "action_item_extraction": 0.89,
        "face_count_accuracy": 0.9,
        "active_speaker_f1": 0.88,
        "active_speaker_map": 0.87,
        "audio_video_association_accuracy": 0.86,
        "off_screen_speaker_detection_accuracy": 0.85,
        "room_feed_heuristic_precision": 0.83,
        "room_feed_heuristic_recall": 0.82,
        "visual_acoustic_disagreement_rate": 0.12,
    }


def _meeting_transcription_real_evidence() -> dict[str, str]:
    return {
        "audio": "/tmp/audio.wav",
        "video": "/tmp/video.mp4",
        "backend_logs": "/tmp/backend.log",
        "frontend_logs": "/tmp/frontend.log",
        "screenshots": "/tmp/screenshots.zip",
        "metrics": "/tmp/metrics.json",
        "model_trajectories": "/tmp/trajectories.jsonl",
        "transcript_artifact": "/tmp/transcript.json",
        "speaker_profile_artifact": "/tmp/speaker-profile.json",
        "consent_record": "/tmp/consent.json",
        "retention_artifact": "/tmp/retention.json",
    }


def _meeting_transcription_parity_lanes() -> list[str]:
    return [
        "browser_web_speech_fallback",
        "cloud_asr_cloud_llm_cloud_tts",
        "cloud_asr_local_llm_local_tts",
        "degraded_network_mode",
        "local_asr_cloud_llm_local_tts",
        "local_asr_local_llm_local_tts",
        "mobile_bridge_local_inference",
        "native_talkmode_stt_tts",
        "offline_mode",
    ]


def _meeting_transcription_parity_matrix() -> list[dict[str, object]]:
    return [
        {
            "id": lane,
            "status": "pass",
            "scenario_ids": ["zoom_bot_free"],
            "artifact_schema": [
                "baseline_comparison",
                "metrics_json",
                "privacy_mode",
                "resource_logs",
                "transcript_artifact",
            ],
            "baseline": {
                "baseline_id": "meeting-parity-2026-07",
                "comparison_report": f"baseline-comparison-{lane}.json",
                "regression": False,
            },
            "evidence": ["baseline_comparison", "metrics_json", "resource_logs"],
            "evidence_platforms": ["cloud", "desktop", "mobile"],
        }
        for lane in _meeting_transcription_parity_lanes()
    ]


def _meeting_transcription_real_report() -> dict[str, object]:
    return {
        "kind": "meeting_transcription_proof_report",
        "lane": "real_product",
        "publishable": True,
        "provider_mode": "zoom-meet-live",
        "score": 0.77,
        "metrics": _meeting_transcription_real_metrics(),
        "evidence_files": _meeting_transcription_real_evidence(),
        "scenarios": [{"id": "zoom_bot_free"}],
        "dataset_sources": [{"id": "ami"}],
        "capture_paths": [{"id": "google_meet_bot_free"}],
        "speaker_operations": [{"id": "speaker_name_correction"}],
        "speaker_name_provenance": [{} for _ in range(8)],
        "audio_visual_cases": [{} for _ in range(7)],
        "generated_artifact_scores": _meeting_generated_artifact_scores(),
        "baseline_comparisons": _meeting_baseline_comparisons(),
        "adversarial_cases": _meeting_adversarial_cases(),
        "qa_review_checklist": _meeting_qa_checklist(),
        "parity_matrix": _meeting_transcription_parity_matrix(),
        "parity_matrix_summary": {
            "required_lane_count": 9,
            "pass_count": 9,
            "fail_count": 0,
            "skip_count": 0,
            "publishable": True,
            "evidence_platforms": ["cloud", "desktop", "mobile"],
        },
    }


def test_meeting_transcription_real_lane_requires_metadata_sections() -> None:
    report = _meeting_transcription_real_report()
    report.pop("capture_paths")

    with pytest.raises(ValueError, match="capture_paths"):
        _score_from_meeting_transcription_proof_json(report)


def test_meeting_transcription_real_lane_requires_detailed_metrics() -> None:
    report = _meeting_transcription_real_report()
    metrics = report["metrics"]
    assert isinstance(metrics, dict)
    metrics.pop("speaker_attributed_wer")

    with pytest.raises(ValueError, match="detailed metrics"):
        _score_from_meeting_transcription_proof_json(report)


def test_meeting_transcription_real_lane_requires_speaker_name_provenance() -> None:
    # Passes the named-evidence/sections/metrics gates but under-provides provenance,
    # so it must fail on the #12498 speaker-name-provenance requirement specifically.
    report = _meeting_transcription_real_report()
    report["speaker_name_provenance"] = [{} for _ in range(7)]

    with pytest.raises(ValueError, match="speaker name provenance"):
        _score_from_meeting_transcription_proof_json(report)


def test_meeting_transcription_real_lane_requires_audio_visual_cases() -> None:
    report = _meeting_transcription_real_report()
    report["audio_visual_cases"] = [{} for _ in range(6)]

    with pytest.raises(ValueError, match="audio_visual_cases"):
        _score_from_meeting_transcription_proof_json(report)


def test_meeting_transcription_real_lane_requires_audio_visual_metrics() -> None:
    report = _meeting_transcription_real_report()
    metrics = report["metrics"]
    assert isinstance(metrics, dict)
    metrics.pop("active_speaker_f1")

    with pytest.raises(ValueError, match="audio-visual metrics"):
        _score_from_meeting_transcription_proof_json(report)


def test_meeting_transcription_real_lane_requires_generated_artifact_scores() -> None:
    report = _meeting_transcription_real_report()
    report["generated_artifact_scores"] = _meeting_generated_artifact_scores()[:-1]

    with pytest.raises(ValueError, match="generated artifact scores"):
        _score_from_meeting_transcription_proof_json(report)


def test_meeting_transcription_real_lane_requires_baseline_comparisons() -> None:
    report = _meeting_transcription_real_report()
    report["baseline_comparisons"] = _meeting_baseline_comparisons()[:6]

    with pytest.raises(ValueError, match="baseline comparisons"):
        _score_from_meeting_transcription_proof_json(report)


def test_meeting_transcription_real_lane_requires_open_source_baseline_run() -> None:
    report = _meeting_transcription_real_report()
    report["baseline_comparisons"] = [
        {**row, "run_status": "not_run"}
        if row.get("comparison_type") == "open_source"
        else row
        for row in _meeting_baseline_comparisons()
    ]

    with pytest.raises(ValueError, match="open-source baseline run"):
        _score_from_meeting_transcription_proof_json(report)


def test_meeting_transcription_real_lane_requires_current_eliza_baseline() -> None:
    report = _meeting_transcription_real_report()
    report["baseline_comparisons"] = [
        row for row in _meeting_baseline_comparisons() if row["id"] != "eliza_current_baseline"
    ] + [{"id": "replacement_internal", "comparison_type": "internal_baseline", "run_status": "run"}]

    with pytest.raises(ValueError, match="current Eliza baseline"):
        _score_from_meeting_transcription_proof_json(report)


def test_meeting_transcription_real_lane_requires_adversarial_and_qa_rows() -> None:
    report = _meeting_transcription_real_report()
    report["adversarial_cases"] = []

    with pytest.raises(ValueError, match="adversarial cases"):
        _score_from_meeting_transcription_proof_json(report)

    report = _meeting_transcription_real_report()
    report["qa_review_checklist"] = _meeting_qa_checklist()[:4]

    with pytest.raises(ValueError, match="QA checklist"):
        _score_from_meeting_transcription_proof_json(report)


def test_meeting_transcription_real_lane_requires_passing_qa_verdicts() -> None:
    report = _meeting_transcription_real_report()
    qa = _meeting_qa_checklist()
    qa[0] = {**qa[0], "machine_verdict": "fail"}
    report["qa_review_checklist"] = qa

    with pytest.raises(ValueError, match="passing QA checklist"):
        _score_from_meeting_transcription_proof_json(report)


def test_meeting_transcription_real_lane_requires_parity_matrix() -> None:
    report = _meeting_transcription_real_report()
    report.pop("parity_matrix")

    with pytest.raises(ValueError, match="parity_matrix"):
        _score_from_meeting_transcription_proof_json(report)


def test_meeting_transcription_real_lane_rejects_skipped_parity_lanes() -> None:
    report = _meeting_transcription_real_report()
    summary = report["parity_matrix_summary"]
    assert isinstance(summary, dict)
    summary["pass_count"] = 8
    summary["skip_count"] = 1
    summary["publishable"] = False

    with pytest.raises(ValueError, match="complete parity matrix"):
        _score_from_meeting_transcription_proof_json(report)


def test_meeting_transcription_real_lane_rejects_malformed_parity_rows() -> None:
    report = _meeting_transcription_real_report()
    parity_matrix = report["parity_matrix"]
    assert isinstance(parity_matrix, list)
    first = parity_matrix[0]
    assert isinstance(first, dict)
    first.pop("status")

    with pytest.raises(ValueError, match="status"):
        _score_from_meeting_transcription_proof_json(report)


def test_meeting_transcription_real_lane_score_is_publishable_with_evidence() -> None:
    extraction = _score_from_meeting_transcription_proof_json(_meeting_transcription_real_report())

    assert extraction.score == pytest.approx(0.77)
    assert extraction.metrics["lane"] == "real_product"
    assert extraction.metrics["publishable"] is True
    assert extraction.metrics["evidence_file_count"] == 11
    assert extraction.metrics["speaker_name_provenance_count"] == 8
    assert extraction.metrics["audio_visual_case_count"] == 7
    assert extraction.metrics["active_speaker_f1"] == pytest.approx(0.88)
    assert extraction.metrics["visual_acoustic_disagreement_rate"] == pytest.approx(0.12)
    assert extraction.metrics["summary_factuality"] == pytest.approx(1.0)
    assert extraction.metrics["hallucination_rate"] == pytest.approx(0.0)
    assert extraction.metrics["baseline_comparison_count"] == 7
    assert extraction.metrics["open_source_baseline_run_count"] == 1
    assert extraction.metrics["internal_baseline_count"] == 1
    assert extraction.metrics["adversarial_case_count"] == 10
    assert extraction.metrics["qa_checklist_count"] == 5
    assert extraction.metrics["qa_machine_pass_count"] == 5
    assert extraction.metrics["qa_human_pass_count"] == 5
    assert extraction.metrics["parity_pass_count"] == 9
    assert extraction.metrics["parity_skip_count"] == 0
