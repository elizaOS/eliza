"""Theory-facing tests for Step 2 compositional no-regret claims."""

from __future__ import annotations

import math
from pathlib import Path

import jax.numpy as jnp
import numpy as np
from numpy.typing import NDArray

from alberta_framework.core.compositional_features import CompositionalFeatureLearner
from alberta_framework.core.resource_manager import (
    LearnedResourceManager,
    finite_candidate_hedge_regret_bound,
    optimal_hedge_learning_rate,
)

DOC_PATH = Path("docs/research/step2_compositional_no_regret.md")


def _mixture_loss(
    manager: LearnedResourceManager,
    losses: NDArray[np.float64],
) -> tuple[float, NDArray[np.float64]]:
    state = manager.init()
    total = 0.0
    final_weights = np.full(losses.shape[1], 1.0 / losses.shape[1], dtype=np.float64)
    for row in losses:
        weights = np.asarray(manager.weights(state), dtype=np.float64)
        final_weights = weights
        total += float(np.dot(weights, row))
        state = manager.update(state, jnp.asarray(row, dtype=jnp.float32)).state
    return total, final_weights


def test_note_rejects_heuristic_no_regret_and_names_selector_abstraction() -> None:
    text = DOC_PATH.read_text(encoding="utf-8")

    required = [
        "Theorem 1: Finite Compositional Candidate Hedge",
        "Counterexample 1: Promotion Utility Is Not A No-Regret Proof",
        "The current utility/promote heuristic is no-regret. | Not proved.",
        "finite_candidate_hedge_regret_bound",
        "optimal_hedge_learning_rate",
        "LearnedResourceManager.fixed_candidate_regret_bound",
        "approximation error",
        "readout regret",
        "generation delay",
        "promotion delay",
        "deletion/retention cost",
        "capacity/collision cost",
        "drift cost",
    ]

    for phrase in required:
        assert phrase in text


def test_hedge_selector_probabilities_normalize_and_shift_to_better_candidate() -> None:
    losses = np.asarray(
        [
            [0.7, 0.2, 0.5],
            [0.8, 0.1, 0.6],
            [0.6, 0.2, 0.4],
            [0.9, 0.1, 0.5],
        ],
        dtype=np.float64,
    )
    manager = LearnedResourceManager(
        n_actions=3,
        learning_rate=2.0,
        discount=1.0,
        exploration=0.0,
    )

    _, final_weights = _mixture_loss(manager, losses)

    assert math.isclose(float(np.sum(final_weights)), 1.0, rel_tol=1e-6)
    assert int(np.argmax(final_weights)) == 1
    assert float(final_weights[1]) > float(final_weights[0])
    assert float(final_weights[1]) > float(final_weights[2])


def test_finite_candidate_hedge_bound_applies_to_bounded_compositional_losses() -> None:
    losses = np.asarray(
        [
            [0.30, 0.55, 0.10],
            [0.35, 0.50, 0.12],
            [0.32, 0.52, 0.08],
            [0.40, 0.45, 0.09],
            [0.31, 0.58, 0.11],
            [0.36, 0.48, 0.10],
        ],
        dtype=np.float64,
    )
    assert float(np.min(losses)) >= 0.0
    assert float(np.max(losses)) <= 1.0

    horizon, n_actions = losses.shape
    eta = optimal_hedge_learning_rate(n_actions, horizon)
    manager = LearnedResourceManager(
        n_actions=n_actions,
        learning_rate=eta,
        discount=1.0,
        exploration=0.0,
        advantage_clip=10.0,
    )

    mixture_loss, _ = _mixture_loss(manager, losses)
    best_fixed_loss = float(np.min(np.sum(losses, axis=0)))
    regret = mixture_loss - best_fixed_loss
    bound = finite_candidate_hedge_regret_bound(n_actions, horizon, eta)

    assert regret <= bound
    assert bound == manager.fixed_candidate_regret_bound(horizon)


def test_compositional_learner_default_remains_heuristic_path() -> None:
    config = CompositionalFeatureLearner(
        n_features=8,
        n_tasks=1,
        candidate_count=2,
    ).to_config()

    assert config["learn_generator_resources"] is False
    assert config["replacement_interval"] > 0
    assert config["promotion_margin"] > 0.0
    assert "finite_candidate_hedge_regret_bound" not in config


def test_no_regret_helpers_reject_invalid_theorem_parameters() -> None:
    for args in ((0, 10, 1.0), (2, 0, 1.0), (2, 10, 0.0)):
        n_actions, horizon, loss_bound = args
        try:
            optimal_hedge_learning_rate(n_actions, horizon, loss_bound)
        except ValueError:
            pass
        else:
            raise AssertionError("expected invalid Hedge learning-rate precondition")

    try:
        finite_candidate_hedge_regret_bound(2, 10, -0.1)
    except ValueError:
        pass
    else:
        raise AssertionError("expected invalid regret-bound precondition")
