"""Contract tests for meeting dataset adapter metadata.

The tests keep QMSum and MeetingBank adapters eval-only, data-free in git, and
strict about publishable scoring requirements.
"""

from __future__ import annotations

from elizaos_meeting_transcription_proof.dataset_adapters import (
    MEETING_ARTIFACT_SCHEMA,
    REQUIRED_SCORE_METRICS,
    build_adapter_contract,
    validate_adapter_contract,
)


def test_qmsum_and_meetingbank_contract_is_valid() -> None:
    contract = build_adapter_contract()

    assert validate_adapter_contract(contract) == []
    assert contract["schema"] == "elizaos.meeting_dataset_adapter.v1"
    assert contract["raw_data_committed"] is False
    assert contract["publishable_run_required"] is True
    assert {adapter["id"] for adapter in contract["adapters"]} == {
        "qmsum_p0_smoke",
        "meetingbank_p0_smoke",
        "zoomgroupstats_p0_smoke",
    }


def test_adapters_record_source_split_hash_and_row_selection_metadata() -> None:
    adapters = {adapter["id"]: adapter for adapter in build_adapter_contract()["adapters"]}

    qmsum = adapters["qmsum_p0_smoke"]
    assert qmsum["source_url"] == "https://github.com/Yale-LILY/QMSum"
    assert qmsum["license_access"]["repo_license"] == "MIT"
    assert qmsum["selected_split"] == {
        "dataset": "QMSum",
        "split": "data/ALL/test",
        "source_domains": ["Academic", "Product", "Committee"],
    }
    assert qmsum["row_selection"]["row_count"] == 10
    assert qmsum["row_selection"]["raw_rows_committed"] is False
    assert {"source_revision", "transcript_sha256", "adapter_config_sha256"} <= set(
        qmsum["required_hashes"]
    )

    meetingbank = adapters["meetingbank_p0_smoke"]
    assert meetingbank["source_url"] == "https://meetingbank.github.io/"
    assert meetingbank["selected_split"]["split"] == "test"
    assert meetingbank["row_selection"]["row_count"] == 5
    assert meetingbank["row_selection"]["raw_rows_committed"] is False
    assert {"agenda_sha256", "reference_summary_sha256", "adapter_config_sha256"} <= set(
        meetingbank["required_hashes"]
    )


def test_adapters_emit_meeting_artifact_and_scenario_runner_metadata() -> None:
    for adapter in build_adapter_contract()["adapters"]:
        assert adapter["output_schema"] == MEETING_ARTIFACT_SCHEMA
        assert adapter["scenario_runner"]["kind"] == "meeting_artifact_eval"
        assert adapter["scenario_runner"]["scenario_id_prefix"]
        assert adapter["scenario_runner"]["input_fields"]
        assert adapter["scenario_runner"]["expected_artifact_fields"]
        # Every adapter carries at least the 5 contract-required metrics; a
        # transcription/diarization adapter (zoomgroupstats) adds more (DER/WER).
        assert REQUIRED_SCORE_METRICS <= set(adapter["score_json"]["metrics"])
        assert adapter["score_json"]["requires_judge_model"] is True
        assert adapter["score_json"]["requires_manual_review"] is True
        assert adapter["score_json"]["publishable_requires_real_provider"] is True


def test_adapters_are_eval_only_until_explicit_training_approval() -> None:
    for adapter in build_adapter_contract()["adapters"]:
        assert adapter["training_eval_separation"]["eval_only"] is True
        assert adapter["training_eval_separation"]["training_allowed"] is False
        assert "training" in adapter["training_eval_separation"]["note"].lower()


def test_zoomgroupstats_adapter_is_transcription_diarization_with_der_wer_baseline() -> None:
    adapters = {a["id"]: a for a in build_adapter_contract()["adapters"]}
    zgs = adapters["zoomgroupstats_p0_smoke"]

    assert zgs["license_access"]["repo_license"] == "MIT"
    assert zgs["task_family"] == "transcription_diarization"
    assert zgs["row_selection"]["raw_rows_committed"] is False
    # Native diarization/transcript metrics on top of the required 5.
    metrics = set(zgs["score_json"]["metrics"])
    assert REQUIRED_SCORE_METRICS <= metrics
    assert {
        "diarization_error_rate",
        "transcript_word_error_rate",
        "speaker_attribution_accuracy",
    } <= metrics
    # Baseline is a reference system (pyannote DER / Whisper WER), not a number.
    baseline = zgs["score_json"]["baseline"]
    assert "pyannote" in baseline["diarization_reference"].lower()
    assert "whisper" in baseline["transcript_reference"].lower()


def test_validator_rejects_publishable_mock_or_raw_data_contracts() -> None:
    contract = build_adapter_contract()
    contract["raw_data_committed"] = True
    contract["adapters"][0]["row_selection"]["raw_rows_committed"] = True
    contract["adapters"][0]["score_json"]["publishable_requires_real_provider"] = False
    contract["adapters"][0]["training_eval_separation"]["training_allowed"] = True

    assert validate_adapter_contract(contract) == [
        "raw_data_committed must be false",
        "adapters[0].row_selection.raw_rows_committed must be false",
        "adapters[0].score_json.publishable_requires_real_provider must be true",
        "adapters[0].training_eval_separation must be eval-only",
    ]


def test_validator_rejects_malformed_nested_sections_without_throwing() -> None:
    contract = build_adapter_contract()
    contract["adapters"][0]["license_access"] = "MIT"
    contract["adapters"][0]["row_selection"] = []
    contract["adapters"][0]["score_json"] = None
    contract["adapters"][0]["training_eval_separation"] = "eval-only"

    errors = validate_adapter_contract(contract)

    assert "adapters[0].license_access must be an object" in errors
    assert "adapters[0].row_selection must be an object" in errors
    assert "adapters[0].score_json must be an object" in errors
    assert "adapters[0].training_eval_separation must be an object" in errors
