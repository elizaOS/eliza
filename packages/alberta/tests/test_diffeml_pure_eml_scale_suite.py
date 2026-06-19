"""Tests for the pure-deployable DiffEML scale/evidence suite."""

from __future__ import annotations

import sys
from pathlib import Path
from types import ModuleType

import numpy as np
import pytest
from conftest import load_script

_SUITE_PATH = (
    Path(__file__).resolve().parents[1]
    / "examples"
    / "The Alberta Plan"
    / "Step2"
    / "step2_diffeml_pure_eml_scale_suite.py"
)
_IMAGE_DEMO_PATH = (
    Path(__file__).resolve().parents[1]
    / "examples"
    / "The Alberta Plan"
    / "Step2"
    / "step2_diffeml_image_demo.py"
)

SUITE: ModuleType = load_script(_SUITE_PATH, "step2_diffeml_pure_eml_scale_suite")
IMAGE_DEMO_CLI: ModuleType = load_script(_IMAGE_DEMO_PATH, "step2_diffeml_image_demo_cli")


def test_full_boolean_specs_cover_every_two_input_gate() -> None:
    """Full scale should include every two-input Boolean target mask."""
    specs = SUITE.build_boolean_specs(scale="full", seeds=(3,))

    assert len(specs) == 16
    assert {spec.target_mask for spec in specs} == set(range(16))
    assert all(spec.run_id.endswith("_seed3") for spec in specs)


def test_smoke_matrix_requires_pure_readouts_for_trainable_circuits() -> None:
    """Planned trainable circuits should reject linear deployed heads by default."""
    matrix = SUITE.build_matrix(scale="smoke", seeds=(0,))

    assert matrix["schema_version"] == "diffeml.pure_eml_scale_suite.v1"
    assert matrix["anti_larp_contract"]["forbidden_deployed_readout"] == "linear"
    assert {row["dataset"] for row in matrix["image_smoke_specs"]} == {"digits", "cifar"}
    assert {row["wiring_mode"] for row in matrix["continuous_threshold_specs"]} == {
        "random",
        "affine_expander",
    }
    assert {row["wiring_mode"] for row in matrix["image_smoke_specs"]} == {
        "random",
        "affine_expander",
        "butterfly_class_bank",
    }

    for row in matrix["continuous_threshold_specs"]:
        checks = row["config_checks"]
        assert checks["pure_readout_only"] is True
        assert checks["executable_eml_templates"] is True
        assert checks["packed_hard_eval_required"] is True
        assert checks["linear_head_forbidden"] is True
        assert checks["flags"] == []

    for row in matrix["image_smoke_specs"]:
        checks = row["config_checks"]
        assert checks["pure_readout_only"] is True
        assert checks["linear_head_forbidden"] is True
        assert row["head_mode"] in SUITE.PURE_READOUT_MODES
        assert f"--head-mode {row['head_mode']}" in row["command"]
        assert f"--wiring-mode {row['wiring_mode']}" in row["command"]
        assert "--packed-eval" in row["command"]
        assert "--compare-mlp" in row["command"]


def test_image_demo_cli_accepts_scaled_structured_wiring_modes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Generated structured-topology commands should be accepted by the image CLI."""
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "step2_diffeml_image_demo.py",
            "--datasets",
            "digits",
            "--wiring-mode",
            "affine_expander",
        ],
    )
    affine_args = IMAGE_DEMO_CLI.parse_args()
    assert affine_args.wiring_mode == "affine_expander"

    monkeypatch.setattr(
        sys,
        "argv",
        [
            "step2_diffeml_image_demo.py",
            "--datasets",
            "digits",
            "--wiring-mode",
            "butterfly_class_bank",
        ],
    )
    butterfly_args = IMAGE_DEMO_CLI.parse_args()
    assert butterfly_args.wiring_mode == "butterfly_class_bank"


def test_boolean_runner_reports_hard_eml_deployment_metrics() -> None:
    """The cheapest runnable evidence should learn XOR as a hard EML gate."""
    spec = SUITE.BooleanGateSpec(
        run_id="boolean_xor_seed0",
        target_mask=6,
        seed=0,
        num_steps=60,
    )

    row = SUITE.run_boolean_case(spec)

    assert row["selected"]["mask"] == 6
    assert row["metrics"]["hard_accuracy"] == 1.0
    assert row["metrics"]["pure_readout_only"] is True
    assert row["metrics"]["no_float_head_deployed"] is True
    assert row["metrics"]["circuit_byte_count"] == 1
    assert row["anti_larp"]["hard_matches_target"] is True
    assert row["anti_larp"]["uses_executable_eml_expression"] is True
    assert row["baselines"]["majority_accuracy"] == 0.5


def test_continuous_threshold_config_and_split_are_testable_and_pure() -> None:
    """Synthetic threshold tasks should use the same pure hard deployable path."""
    spec = SUITE.build_continuous_specs(scale="smoke", seeds=(5,))[0]
    config = SUITE.continuous_config(spec)
    split = SUITE.make_continuous_split(spec)

    assert config.gate_mode == "eml_template"
    assert config.head_mode == "class_vote"
    assert config.packed_eval is True
    assert config.compare_mlp is False
    assert config.feature_mode == "threshold_pixels"
    assert set(np.unique(split.y_train)).issubset({0, 1})
    assert set(np.unique(split.y_test)).issubset({0, 1})
    assert 0.5 <= SUITE.majority_baseline_accuracy(split.y_test) <= 1.0


def test_extract_anti_larp_metrics_flags_missing_or_mismatched_hard_evidence() -> None:
    """Metric extraction should make soft-only or mismatched claims visible."""
    result = {
        "metrics": {
            "test_soft_accuracy": 0.90,
            "test_hard_accuracy": 0.80,
            "packed_hard_test_accuracy": 0.79,
        },
        "model": {
            "head_mode": "class_vote",
            "compiled_storage": {
                "head_fp32_bytes": 0,
                "compiled_packed_bytes": 123,
                "soft_train_bytes": 1000,
                "soft_to_compiled_packed_compression": 8.13,
            },
        },
    }

    metrics = SUITE.extract_anti_larp_metrics(result)

    assert metrics["soft_vs_hard_gap"] == pytest.approx(0.10)
    assert metrics["packed_vs_hard_gap"] == pytest.approx(0.01)
    assert metrics["pure_readout_only"] is True
    assert metrics["no_float_head_deployed"] is True
    assert metrics["compiled_packed_bytes"] == 123
    assert "large_soft_hard_gap" in metrics["flags"]
    assert "packed_hard_mismatch" in metrics["flags"]


def test_extract_anti_larp_metrics_uses_prediction_disagreement_for_packed_match() -> None:
    """Float32 accuracy rounding should not look like a packed circuit mismatch."""
    result = {
        "metrics": {
            "test_soft_accuracy": 0.10,
            "test_hard_accuracy": np.float32(49 / 300),
            "packed_hard_test_accuracy": 49 / 300,
            "test_hard_packed_prediction_disagreement": 0.0,
        },
        "model": {
            "head_mode": "class_vote",
            "compiled_storage": {
                "head_fp32_bytes": 0,
                "compiled_packed_bytes": 123,
                "soft_train_bytes": 1000,
                "soft_to_compiled_packed_compression": 8.13,
            },
        },
    }

    metrics = SUITE.extract_anti_larp_metrics(result)

    assert metrics["packed_vs_hard_gap"] < 1e-6
    assert "packed_hard_mismatch" not in metrics["flags"]
