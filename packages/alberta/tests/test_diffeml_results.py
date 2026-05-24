"""Tests for DiffEML paper-quality result validation."""

from __future__ import annotations

import pytest

from alberta_framework.core.diffeml_results import (
    DatasetInfo,
    DiffEMLResultError,
    DiffEMLResultRecord,
    ExternalBaseline,
    ModelInfo,
    TrainingInfo,
    assert_valid_result_record,
    image_demo_result_record,
    validate_beat_claim,
    validate_result_record,
)


def test_valid_diffeml_logic_record_passes() -> None:
    """A hard/soft DiffEML record with gate counts and baseline provenance passes."""
    record = _valid_record().to_dict()

    assert validate_result_record(record) == ()
    assert_valid_result_record(record)


def test_diffeml_record_rejects_missing_hard_metric() -> None:
    """Paper DiffEML records must include hard evaluation metrics."""
    record = _valid_record().to_dict()
    del record["metrics"]["test_hard_accuracy"]

    errors = validate_result_record(record)

    assert "metrics.test_hard_accuracy must be a number" in errors
    with pytest.raises(DiffEMLResultError):
        assert_valid_result_record(record)


def test_diffeml_record_rejects_missing_packed_metric() -> None:
    """Paper DiffEML records must include packed hard evaluation metrics."""
    record = _valid_record().to_dict()
    del record["metrics"]["packed_hard_test_accuracy"]

    errors = validate_result_record(record)

    assert "metrics.packed_hard_test_accuracy must be a number" in errors


def test_logic_record_rejects_missing_gate_count() -> None:
    """Logic-network comparisons need explicit gate counts."""
    record = _valid_record().to_dict()
    record["model"]["gate_count"] = None

    errors = validate_result_record(record)

    assert "model.gate_count must be a positive integer" in errors


def test_beat_claim_requires_actual_improvement() -> None:
    """Claim validation should reject non-improvements."""
    record = _valid_record(packed_hard_accuracy=0.61, baseline_value=0.6214).to_dict()

    claim = validate_beat_claim(record, "difflogic_cifar_5m")

    assert claim.valid is False
    assert claim.delta == pytest.approx(-0.0114)
    assert any("does not beat" in error for error in claim.errors)


def test_beat_claim_can_require_local_reproduction() -> None:
    """Paper-reported baselines are not enough when local reproduction is required."""
    record = _valid_record(packed_hard_accuracy=0.64, baseline_value=0.6214).to_dict()

    claim = validate_beat_claim(
        record,
        "difflogic_cifar_5m",
        require_local_baseline=True,
    )

    assert claim.valid is False
    assert claim.delta == pytest.approx(0.0186)
    assert any("must be locally reproduced" in error for error in claim.errors)


def test_pending_baseline_blocks_beat_claim() -> None:
    """Pending baselines cannot support a claimed win."""
    record = _valid_record(packed_hard_accuracy=0.64, baseline_value=None).to_dict()
    record["baselines"]["difflogic_cifar_5m"]["provenance"] = "pending"

    claim = validate_beat_claim(record, "difflogic_cifar_5m")

    assert claim.valid is False
    assert any("still pending" in error for error in claim.errors)


def test_image_demo_payload_converts_to_result_record() -> None:
    """Image-demo JSON should become a validated paper-quality record."""
    record = image_demo_result_record(
        {
            "config": {
                "seed": 0,
                "feature_mode": "detector_thresholds",
            },
            "results": [
                {
                    "dataset": "cifar",
                    "data": {
                        "source": "cifar-10-python",
                        "feature_mode": "detector_thresholds",
                        "train_examples": 20000,
                        "test_examples": 5000,
                    },
                    "model": {
                        "gate_mode": "eml_template",
                        "width": 2048,
                        "layers": 6,
                        "wiring_mode": "random",
                        "head_mode": "linear",
                        "nodes": 12288,
                        "active_node_parameters": 196608,
                        "head_parameters": 20490,
                    },
                    "training": {
                        "epochs": 10,
                        "batch_size": 128,
                        "elapsed_s": 254.0,
                    },
                    "metrics": {
                        "train_soft_accuracy": 0.603,
                        "train_hard_accuracy": 0.627,
                        "test_soft_accuracy": 0.445,
                        "test_hard_accuracy": 0.442,
                        "packed_hard_test_accuracy": 0.442,
                        "packed_int8_head_test_accuracy": 0.441,
                    },
                    "baselines": {
                        "mlp_same_features": {
                            "hidden_sizes": [512],
                            "test_accuracy": 0.467,
                        }
                    },
                }
            ],
        },
        source_artifact="runs/cifar.json",
    )

    as_dict = record.to_dict()

    assert validate_result_record(as_dict) == ()
    assert record.run_id == "diffeml_cifar_detector_thresholds_random_w2048_l6_seed0"
    assert record.model.gate_count == 12288
    assert record.model.parameter_count == 217098
    assert record.metrics["packed_hard_test_accuracy"] == 0.442
    assert record.metrics["packed_int8_head_test_accuracy"] == 0.441
    assert record.baselines["mlp_same_features"].value == 0.467
    assert record.artifacts["source"] == "runs/cifar.json"


def _valid_record(
    *,
    test_hard_accuracy: float = 0.63,
    packed_hard_accuracy: float = 0.63,
    baseline_value: float | None = 0.6214,
) -> DiffEMLResultRecord:
    return DiffEMLResultRecord(
        run_id="diffeml_cifar_gate_budget_seed0",
        dataset=DatasetInfo(
            name="cifar10",
            source="cifar-10-python",
            train_examples=50000,
            test_examples=10000,
            seed=0,
            split="official",
        ),
        model=ModelInfo(
            kind="diffeml",
            gate_count=5_120_000,
            parameter_count=82_000_000,
            gate_mode="eml_template",
            topology="random_sparse",
            head="group_sum",
        ),
        training=TrainingInfo(
            optimizer="adam",
            epochs=100,
            batch_size=256,
            seed=0,
        ),
        metrics={
            "train_soft_accuracy": 0.72,
            "train_hard_accuracy": 0.70,
            "test_soft_accuracy": 0.64,
            "test_hard_accuracy": test_hard_accuracy,
            "packed_hard_test_accuracy": packed_hard_accuracy,
        },
        baselines={
            "difflogic_cifar_5m": ExternalBaseline(
                name="DiffLogic CIFAR-10 5.12M gates",
                model_kind="difflogic",
                dataset="cifar10",
                metric="packed_hard_test_accuracy",
                value=baseline_value,
                gate_count=5_120_000,
                provenance="paper_reported",
                source="https://github.com/Felix-Petersen/difflogic",
            )
        },
    )
