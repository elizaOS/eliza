"""Tests for the D20 multi-prototype OPMNIST learner."""

from __future__ import annotations

from pathlib import Path
from types import ModuleType

import numpy as np
from conftest import load_script

_SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "examples"
    / "The Alberta Plan"
    / "Step2"
    / "new_directions"
    / "d20_multiprototype_opmnist.py"
)


def load_module() -> ModuleType:
    return load_script(_SCRIPT_PATH, "d20_multiprototype_test")


def test_allocates_multiple_same_class_prototypes_for_novel_views() -> None:
    """Novel observations for one class should occupy separate memory slots."""
    module = load_module()
    config = module.MultiPrototypeConfig(
        slots_per_class=3,
        update_rate=0.5,
        novelty_threshold=0.05,
        bandwidth=0.1,
    )
    learner = module.MultiPrototypeClassifier(feature_dim=2, config=config, n_classes=2)
    state = learner.init()
    target = np.asarray([1.0, 0.0], dtype=np.float64)

    learner.update(state, np.asarray([0.0, 0.0]), target)
    learner.update(state, np.asarray([1.0, 1.0]), target)

    assert int(np.sum(state.counts[0] > 0.0)) == 2


def test_prediction_uses_nearest_class_prototype() -> None:
    """Predictions should favor the class with the closest active prototype."""
    module = load_module()
    config = module.MultiPrototypeConfig(
        slots_per_class=2,
        update_rate=0.5,
        novelty_threshold=0.1,
        bandwidth=0.01,
    )
    learner = module.MultiPrototypeClassifier(feature_dim=2, config=config, n_classes=2)
    state = learner.init()
    learner.update(
        state,
        np.asarray([0.0, 0.0]),
        np.asarray([1.0, 0.0]),
    )
    learner.update(
        state,
        np.asarray([1.0, 1.0]),
        np.asarray([0.0, 1.0]),
    )

    prediction = learner.predict(state, np.asarray([0.9, 1.0]))

    assert int(np.argmax(prediction)) == 1
