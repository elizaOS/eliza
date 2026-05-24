"""Tests for the D18 OPMNIST bridge helpers."""

from __future__ import annotations

from pathlib import Path
from types import ModuleType
from typing import Any

import numpy as np
import pytest
from conftest import load_script

_SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "examples"
    / "The Alberta Plan"
    / "Step2"
    / "new_directions"
    / "d18_opmnist_bridge.py"
)


def load_bridge_module() -> ModuleType:
    return load_script(_SCRIPT_PATH, "d18_opmnist_bridge_test")


class FixedPredictionLearner:
    """Minimal learner exposing the D18-style predict API."""

    def __init__(self, predictions: np.ndarray) -> None:
        self._predictions = predictions
        self._idx = 0

    def predict(self, _state: Any, _observation: np.ndarray) -> np.ndarray:
        """Return the next fixed prediction row."""
        prediction = self._predictions[self._idx]
        self._idx += 1
        return prediction


def test_softmax_deployment_transform_preserves_argmax_and_normalizes() -> None:
    """Softmax calibration should not change classification decisions."""
    module = load_bridge_module()
    preds = np.asarray([[4.0, 1.0, -2.0], [-1.0, 2.0, 1.0]], dtype=np.float64)

    transformed = module.apply_deployment_transform(preds, "softmax")

    np.testing.assert_allclose(np.sum(transformed, axis=1), np.ones(2))
    np.testing.assert_array_equal(np.argmax(transformed, axis=1), np.argmax(preds, axis=1))


def test_d18_evaluator_reports_raw_and_deployment_metrics() -> None:
    """The bridge should expose raw metrics separately from deployment metrics."""
    module = load_bridge_module()
    predictions = np.zeros((2, module.N_CLASSES), dtype=np.float64)
    predictions[0, 0] = 2.0
    predictions[1, 1] = 2.0
    learner = FixedPredictionLearner(predictions)
    test_views: np.ndarray = np.zeros((1, 2, 3), dtype=np.float64)
    y_test = np.asarray([0, 1], dtype=np.int32)

    metrics = module.evaluate_d18_classifier_views(
        learner,
        None,
        test_views,
        y_test,
        deployment_transform="softmax",
    )

    assert metrics["test_accuracy"] == pytest.approx(1.0)
    assert metrics["deployment_test_accuracy"] == pytest.approx(1.0)
    assert metrics["deployment_test_mse"] != pytest.approx(metrics["test_mse"])
