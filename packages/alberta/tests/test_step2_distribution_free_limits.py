"""Theory-facing tests for Step 2 distribution-free impossibility boundaries."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from numpy.typing import NDArray

DOC_PATH = (
    Path(__file__).resolve().parents[1]
    / "docs"
    / "research"
    / "step2_distribution_free_limits.md"
)

type History = tuple[tuple[float, float], ...]

REQUIRED_MARKERS = (
    "CLAIM-REJECTED-DISTRIBUTION-FREE-UNIVERSALITY",
    "COUNTEREXAMPLE-CAUSAL-ONLINE-INDISTINGUISHABILITY",
    "COUNTEREXAMPLE-ARBITRARY-ADVERSARIAL-DRIFT",
    "COUNTEREXAMPLE-HIDDEN-CONTEXT-ALIASING",
    "REPLACEMENT-THEOREM-CONDITIONAL-LEARNABILITY",
    "ASSUMPTION-OBSERVATION-SUFFICIENCY",
    "ASSUMPTION-BOUNDED-LOSSES",
    "ASSUMPTION-ADMITTED-FEATURE-CLASS",
    "ASSUMPTION-MODELED-DRIFT",
    "ASSUMPTION-RECURRENCE-EVIDENCE",
    "ASSUMPTION-REGRET-ESTIMATION-GUARANTEE",
)

REPLACEMENT_ASSUMPTIONS = (
    "modeled drift",
    "recurrence/evidence",
    "bounded losses",
    "admitted feature class",
    "regret/estimation guarantee",
)


def _read_doc() -> str:
    return DOC_PATH.read_text(encoding="utf-8")


def _square_losses(prediction: float) -> tuple[float, float]:
    return prediction**2, (1.0 - prediction) ** 2


def _constant_context_mse(targets: NDArray[np.float64]) -> float:
    prediction = float(np.mean(targets))
    return float(np.mean((prediction - targets) ** 2))


def _least_squares_mse(
    design: NDArray[np.float64],
    targets: NDArray[np.float64],
) -> float:
    weights, *_ = np.linalg.lstsq(design, targets, rcond=None)
    residuals = design @ weights - targets
    return float(np.mean(residuals**2))


def _causal_learner(history: History, next_observation: float) -> float:
    """A deterministic causal learner used only to show identical inputs alias."""
    if not history:
        return 0.5 + 0.1 * next_observation
    recent_target_mean = sum(target for _, target in history) / len(history)
    return 0.2 + 0.6 * recent_target_mean + 0.1 * next_observation


def test_distribution_free_limits_doc_contains_required_markers() -> None:
    """The research note exposes every boundary marker requested by Worker 4."""
    text = _read_doc()

    missing = [marker for marker in REQUIRED_MARKERS if marker not in text]

    assert missing == []


def test_counterexamples_are_ordered_before_replacement_theorem() -> None:
    """The doc first rejects universality, then gives the valid theorem shape."""
    text = _read_doc()
    positions = [text.index(marker) for marker in REQUIRED_MARKERS[:5]]

    assert positions == sorted(positions)


def test_replacement_theorem_names_required_assumptions() -> None:
    """The valid theorem includes the five requested learnability conditions."""
    text = _read_doc().lower()

    for assumption in REPLACEMENT_ASSUMPTIONS:
        assert assumption in text


def test_causal_indistinguishability_forces_one_branch_loss() -> None:
    """Two streams with the same causal history cannot both be predicted well."""
    shared_history: History = ((0.0, 0.0), (0.0, 1.0), (0.0, 1.0))
    next_observation = 0.0

    prediction_on_stream_0 = _causal_learner(shared_history, next_observation)
    prediction_on_stream_1 = _causal_learner(shared_history, next_observation)

    assert prediction_on_stream_0 == prediction_on_stream_1

    loss_if_target_0, loss_if_target_1 = _square_losses(prediction_on_stream_0)

    assert max(loss_if_target_0, loss_if_target_1) >= 0.25


def test_binary_square_loss_minimax_lower_bound_is_one_quarter() -> None:
    """For any single prediction, one binary continuation costs at least 1/4."""
    predictions = np.linspace(-1.0, 2.0, 601, dtype=np.float64)
    branch_losses = np.maximum(predictions**2, (1.0 - predictions) ** 2)

    assert float(np.min(branch_losses)) == pytest.approx(0.25)
    assert bool(np.all(branch_losses >= 0.25))


def test_adversarial_drift_flip_after_commit_has_constant_loss() -> None:
    """An adaptive target can flip after prediction and force linear loss."""
    predictions = np.array([0.25, 0.75] * 6, dtype=np.float64)
    targets = np.where(predictions <= 0.5, 1.0, 0.0)
    losses = (predictions - targets) ** 2
    path_variation = float(np.sum(np.abs(np.diff(targets))))

    assert bool(np.all(losses >= 0.25))
    assert float(np.mean(losses)) >= 0.25
    assert path_variation == float(len(targets) - 1)


def test_hidden_context_aliasing_has_irreducible_error_without_context() -> None:
    """A hidden binary context cannot be represented from a constant observation."""
    targets = np.array([0.0, 1.0], dtype=np.float64)
    hidden_context = targets.copy()
    constant_observation_design: NDArray[np.float64] = np.ones(
        (2, 1),
        dtype=np.float64,
    )
    context_encoded_design = np.column_stack(
        [np.ones_like(hidden_context), hidden_context]
    )

    aliasing_mse = _constant_context_mse(targets)
    encoded_mse = _least_squares_mse(context_encoded_design, targets)
    constant_design_mse = _least_squares_mse(constant_observation_design, targets)

    assert aliasing_mse == pytest.approx(0.25)
    assert constant_design_mse == pytest.approx(0.25)
    assert encoded_mse == pytest.approx(0.0, abs=1e-12)


def test_unbounded_losses_violate_replacement_theorem_precondition() -> None:
    """The bounded-loss assumption is necessary for the stated theorem shape."""
    bounded_losses = np.array([0.0, 0.5, 1.0], dtype=np.float64)
    unbounded_losses = np.array([0.0, 0.5, 1.25], dtype=np.float64)

    assert bool(np.all((0.0 <= bounded_losses) & (bounded_losses <= 1.0)))
    assert not bool(np.all((0.0 <= unbounded_losses) & (unbounded_losses <= 1.0)))
