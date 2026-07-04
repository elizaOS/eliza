"""Contract tests for the VoiceCodeBench ASR gate.

The suite verifies dataset provenance, eval-only policy, exact entity recovery,
and publishable-report requirements without committing benchmark rows or audio.
"""

from __future__ import annotations

import sys
from pathlib import Path

ASR_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ASR_DIR))

import voice_code_bench_gate as gate  # noqa: E402


def _row(audio_id: str = "contact_routing_001") -> gate.VoiceCodeBenchRow:
    return gate.VoiceCodeBenchRow(
        audio_id=audio_id,
        domain="contact_routing",
        scenario="callback_instructions",
        difficulty="light",
        reference=(
            "Ask GitHub Support to call back at area code four one five "
            "dash two zero one dash nine zero zero zero with code B H seven four two one."
        ),
        entities=(
            gate.VoiceCodeBenchEntity(
                id="e01",
                type="person_or_team_name",
                canonical="GitHub Support",
            ),
            gate.VoiceCodeBenchEntity(
                id="e02",
                type="phone_number",
                canonical="415-201-9000",
            ),
            gate.VoiceCodeBenchEntity(
                id="e03",
                type="spelled_sequence",
                canonical="BH-7421",
            ),
        ),
    )


def test_gate_contract_records_public_dataset_and_eval_only_policy() -> None:
    contract = gate.gate_contract()

    assert contract["source_url"] == "https://huggingface.co/datasets/besimple-ai/voice-code-bench"
    assert contract["license"] == "mit"
    assert contract["split"] == "test"
    assert contract["row_count"] == 300
    assert contract["raw_audio_committed"] is False
    assert contract["cache_policy"] == "download_or_cache_outside_git"
    assert contract["metrics"] == ["ctem", "tsr", "wer", "cer"]
    assert len(contract["entity_types"]) == 26
    assert {"cli_flag", "environment_variable", "ip_address", "reference_id"} <= set(
        contract["entity_types"]
    )
    assert contract["publishable_requires_real_asr"] is True
    assert contract["training_eval_separation"] == {
        "eval_only": True,
        "training_allowed": False,
        "note": "VoiceCodeBench rows must not be used for training without explicit approval.",
    }
    assert {"audio_sha256", "entities_sha256", "adapter_config_sha256"} <= set(
        contract["required_hashes"]
    )


def test_exact_entity_recovery_scores_ctem_and_tsr() -> None:
    row = _row()
    report = gate.score_voice_code_bench_rows(
        [row],
        {
            row.audio_id: (
                "Please have GitHub Support call 415 201 9000 and reference "
                "BH7421 before routing the ticket."
            )
        },
    )

    assert report["publishable"] is False
    assert report["row_count"] == 1
    assert report["metrics"]["ctem"] == 1.0
    assert report["metrics"]["tsr"] == 1.0
    assert report["rows"][0]["ctem"] == 1.0
    assert report["rows"][0]["tsr"] == 1.0
    assert all(entity["matched"] for entity in report["rows"][0]["entities"])


def test_partial_entity_recovery_keeps_task_success_false() -> None:
    row = _row()
    report = gate.score_voice_code_bench_rows(
        [row],
        {row.audio_id: "GitHub Support should call back, but the code was missing."},
    )

    assert report["metrics"]["ctem"] == 1 / 3
    assert report["metrics"]["tsr"] == 0.0
    assert report["rows"][0]["ctem"] == 1 / 3
    assert report["rows"][0]["tsr"] == 0.0


def test_embedded_structured_tokens_do_not_count_as_exact_recovery() -> None:
    row = _row()
    report = gate.score_voice_code_bench_rows(
        [row],
        {
            row.audio_id: (
                "GitHub Support should call 415 201 9000 but use code "
                "XBH7421Y instead."
            )
        },
    )

    assert report["metrics"]["ctem"] == 2 / 3
    assert report["metrics"]["tsr"] == 0.0
    assert report["rows"][0]["entities"][2]["matched"] is False


def test_error_rates_normalize_punctuation_without_hiding_entity_errors() -> None:
    assert gate.word_error_rate("Hello, world!", "hello world") == 0.0
    assert gate.character_error_rate("BH-7421", "BH7421") == 0.0
    assert gate.character_error_rate("BH-7421", "BH7429") > 0.0


def test_publishable_report_requires_real_provider_hashes_and_metrics() -> None:
    bad_report = gate.score_voice_code_bench_rows([_row()], {})
    assert gate.validate_publishable_report(bad_report) == [
        "publishable must be true for real score reports",
        "source_url must match VoiceCodeBench",
        "split must be test",
        "row_count must be 300 for full publishable run",
        "provider_metadata is required",
        "hashes are required",
    ]

    contract = gate.gate_contract()
    good_report = {
        "publishable": True,
        "source_url": gate.DATASET_SOURCE_URL,
        "split": gate.DATASET_SPLIT,
        "row_count": gate.DATASET_ROWS,
        "provider_metadata": {
            "asr_provider": "eliza-local-inference",
            "asr_model": "eliza-1-asr-q4_k_m",
            "artifact_revision": "sha256:abc",
            "sample_rate_hz": 16000,
            "run_started_at": "2026-07-04T12:00:00Z",
        },
        "hashes": {key: f"{key}:hash" for key in contract["required_hashes"]},
        "metrics": {"ctem": 1.0, "tsr": 1.0, "wer": 0.0, "cer": 0.0},
    }

    assert gate.validate_publishable_report(good_report) == []

    bad_provider_type = {
        **good_report,
        "provider_metadata": {
            **good_report["provider_metadata"],
            "asr_provider": 123,
        },
    }
    assert "provider_metadata.asr_provider is required" in gate.validate_publishable_report(
        bad_provider_type
    )

    bad_sample_rate_string = {
        **good_report,
        "provider_metadata": {
            **good_report["provider_metadata"],
            "sample_rate_hz": "16000",
        },
    }
    assert "provider_metadata.sample_rate_hz is required" in gate.validate_publishable_report(
        bad_sample_rate_string
    )

    bad_sample_rate_bool = {
        **good_report,
        "provider_metadata": {
            **good_report["provider_metadata"],
            "sample_rate_hz": True,
        },
    }
    assert "provider_metadata.sample_rate_hz is required" in gate.validate_publishable_report(
        bad_sample_rate_bool
    )
