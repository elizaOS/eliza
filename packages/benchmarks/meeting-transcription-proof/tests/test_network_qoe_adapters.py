"""Contract tests for the network-QoE video-conferencing adapters (VCAPurdue).

Keeps VCAPurdue honestly typed as a non-transcript modality, data-free in git,
eval-only, and reference-baseline'd — separate from the meeting-artifact contract.
"""

from __future__ import annotations

from elizaos_meeting_transcription_proof.network_qoe_adapters import (
    REQUIRED_QOE_METRICS,
    VC_QOE_ADAPTER_SCHEMA,
    build_qoe_adapter_contract,
    validate_qoe_adapter_contract,
)


def test_vca_purdue_qoe_contract_is_valid_and_data_free() -> None:
    contract = build_qoe_adapter_contract()
    assert validate_qoe_adapter_contract(contract) == []
    assert contract["schema"] == VC_QOE_ADAPTER_SCHEMA
    assert contract["raw_data_committed"] is False
    assert {a["id"] for a in contract["adapters"]} == {"vca_purdue_qoe"}


def test_vca_purdue_is_network_qoe_not_transcription() -> None:
    vca = build_qoe_adapter_contract()["adapters"][0]
    assert vca["modality"] == "network_qoe"
    assert vca["transcription_usable"] is False
    assert "no audio" in vca["usability_note"].lower()
    assert set(vca["apps_covered"]) == {"webex", "google_meet", "microsoft_teams", "zoom"}
    assert REQUIRED_QOE_METRICS <= set(vca["metrics"])
    # Baseline is the dataset's measured per-app behavior, not a fixed number.
    assert vca["baseline"]["kind"] == "reference_system_per_app"


def test_vca_purdue_is_eval_only_and_raw_data_uncommitted() -> None:
    vca = build_qoe_adapter_contract()["adapters"][0]
    assert vca["row_selection"]["raw_rows_committed"] is False
    assert vca["training_eval_separation"]["eval_only"] is True
    assert vca["training_eval_separation"]["training_allowed"] is False


def test_qoe_validator_rejects_committed_raw_data_and_wrong_modality() -> None:
    contract = build_qoe_adapter_contract()
    contract["raw_data_committed"] = True
    contract["adapters"][0]["modality"] = "transcript"
    contract["adapters"][0]["row_selection"]["raw_rows_committed"] = True

    errors = validate_qoe_adapter_contract(contract)
    assert "raw_data_committed must be false" in errors
    assert "adapters[0].modality must be network_qoe" in errors
    assert "adapters[0].row_selection.raw_rows_committed must be false" in errors
