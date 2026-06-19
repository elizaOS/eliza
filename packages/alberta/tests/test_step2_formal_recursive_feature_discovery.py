"""Formal-boundary tests for Step 2 recursive feature-discovery claims."""

from __future__ import annotations

import math
from pathlib import Path

import jax.numpy as jnp
import jax.random as jr
import numpy as np
from numpy.typing import NDArray

from alberta_framework.core.associative_memory import AssociativeMemoryConfig
from alberta_framework.core.compositional_features import (
    FEATURE_VALUE_CLIP,
    GENERATION_ROBUST_RECURSIVE,
    OP_PRODUCT,
    OP_RAW,
    CompositionalFeatureLearner,
    _compute_feature_values,
)
from alberta_framework.core.feature_discovery import FixedBudgetFeatureLearner
from alberta_framework.core.upgd import UPGDLearner

DOC_PATH = Path("docs/research/step2_formal_recursive_feature_discovery.md")


def _least_squares_mse(
    design: NDArray[np.float64],
    targets: NDArray[np.float64],
) -> float:
    weights, *_ = np.linalg.lstsq(design, targets, rcond=None)
    residuals = design @ weights - targets
    return float(np.mean(residuals**2))


def _assert_unit_interval(losses: NDArray[np.float64]) -> None:
    if float(np.min(losses)) < 0.0 or float(np.max(losses)) > 1.0:
        raise ValueError("recursive selection theorem assumes losses in [0, 1]")


def _hedge_mixture_loss(losses: NDArray[np.float64], eta: float) -> float:
    _assert_unit_interval(losses)
    n_candidates = losses.shape[1]
    weights = np.full(n_candidates, 1.0 / n_candidates, dtype=np.float64)
    total = 0.0
    for row in losses:
        total += float(np.dot(weights, row))
        weights *= np.exp(-eta * row)
        weights /= float(np.sum(weights))
    return total


def test_formal_note_declares_the_boundary_and_named_learners() -> None:
    text = DOC_PATH.read_text(encoding="utf-8")

    required_phrases = [
        "Theorem 1: Conditional Recursive Feature Selection",
        "Proposition 1: Current UPGD Is A Bounded Local Search Ingredient",
        "Proposition 2: Current Compositional And Fixed-Budget Learners",
        "Proposition 3: Associative Memory Is A Finite Causal Key/Value Mechanism",
        "Proposition 4: Unobservability Gives An Irreducible Gap",
        "What this does not prove",
        "approximation",
        "selector regret",
        "readout regret",
        "evaluation delay",
        "capacity/collision",
        "drift",
        "UPGDLearner",
        "FixedBudgetFeatureLearner",
        "CompositionalFeatureLearner",
        "AssociativeMemoryLearner",
        "do not prove arbitrary recursive feature discovery",
    ]

    for phrase in required_phrases:
        assert phrase in text


def test_current_step2_learners_expose_finite_resource_boundaries() -> None:
    upgd_cfg = UPGDLearner.step2_default(n_heads=3).to_config()
    compositional_cfg = CompositionalFeatureLearner(
        n_features=8,
        n_tasks=2,
        candidate_count=3,
        max_depth=3,
        generation_strategy=GENERATION_ROBUST_RECURSIVE,
    ).to_config()
    fixed_cfg = FixedBudgetFeatureLearner(
        n_features=8,
        n_tasks=2,
        candidate_count=3,
    ).to_config()
    associative_cfg = AssociativeMemoryConfig(
        vocab_size=11,
        block_size=5,
        suffix_length=3,
        max_features=32,
    ).to_config()

    assert upgd_cfg["hidden_sizes"] == [32]
    assert upgd_cfg["loss_normalization"] == "target_structure"
    assert upgd_cfg["perturbation_noise"] == "rademacher"
    assert upgd_cfg["perturbation_sigma"] == 1e-4
    assert upgd_cfg["bounder"] == {"type": "ObGDBounding", "kappa": 0.5}
    assert "candidate_count" not in upgd_cfg
    assert "generation_strategy" not in upgd_cfg

    assert compositional_cfg["n_features"] == 8
    assert compositional_cfg["candidate_count"] == 3
    assert compositional_cfg["max_depth"] == 3
    assert compositional_cfg["generation_strategy"] == GENERATION_ROBUST_RECURSIVE

    assert fixed_cfg["n_features"] == 8
    assert fixed_cfg["candidate_count"] == 3
    assert fixed_cfg["replacement_interval"] >= 0

    assert associative_cfg["max_features"] == 32
    assert associative_cfg["feature_family"] == "token_suffix_pair"


def test_compositional_recursive_dag_is_depth_limited_and_clipped() -> None:
    learner = CompositionalFeatureLearner(
        n_features=6,
        n_tasks=1,
        candidate_count=2,
        max_depth=2,
        generation_strategy=GENERATION_ROBUST_RECURSIVE,
    )
    state = learner.init(feature_dim=3, key=jr.key(0))

    ops = np.asarray(state.ops)
    parent_a = np.asarray(state.parent_a)
    parent_b = np.asarray(state.parent_b)
    depth = np.asarray(state.depth)

    assert np.all(ops[:3] == OP_RAW)
    assert np.all(depth <= 2)
    for slot in range(3, 6):
        assert parent_a[slot] < slot
        assert parent_b[slot] < slot
        assert depth[slot] == max(depth[parent_a[slot]], depth[parent_b[slot]]) + 1

    values = _compute_feature_values(
        state.ops,
        state.parent_a,
        state.parent_b,
        state.theta,
        jnp.asarray([20.0, 20.0, 20.0], dtype=jnp.float32),
    )
    assert float(jnp.max(jnp.abs(values))) <= FEATURE_VALUE_CLIP


def test_missing_recursive_feature_leaves_approximation_term() -> None:
    xs = np.array(
        [[a, b, c] for a in (-1.0, 1.0) for b in (-1.0, 1.0) for c in (-1.0, 1.0)],
        dtype=np.float64,
    )
    target = xs[:, 0] * xs[:, 1] * xs[:, 2]

    raw_and_pair_dictionary = np.column_stack(
        [
            np.ones(xs.shape[0], dtype=np.float64),
            xs,
            xs[:, 0] * xs[:, 1],
            xs[:, 0] * xs[:, 2],
            xs[:, 1] * xs[:, 2],
        ]
    )
    recursive_dictionary = np.column_stack(
        [
            raw_and_pair_dictionary,
            (xs[:, 0] * xs[:, 1]) * xs[:, 2],
        ]
    )

    missing_gap = _least_squares_mse(raw_and_pair_dictionary, target)
    rich_gap = _least_squares_mse(recursive_dictionary, target)

    assert missing_gap > 0.99
    assert rich_gap < 1e-24


def test_bounded_recursive_candidate_selection_has_regret_bound() -> None:
    losses = np.array(
        [
            [0.40, 0.35, 0.08],
            [0.45, 0.32, 0.12],
            [0.38, 0.30, 0.09],
            [0.50, 0.28, 0.10],
            [0.42, 0.34, 0.07],
            [0.48, 0.31, 0.11],
            [0.39, 0.29, 0.08],
            [0.44, 0.33, 0.09],
        ],
        dtype=np.float64,
    )
    horizon, n_candidates = losses.shape
    eta = math.sqrt(8.0 * math.log(n_candidates) / horizon)

    mixture_loss = _hedge_mixture_loss(losses, eta)
    best_fixed_loss = float(np.min(np.sum(losses, axis=0)))
    regret = mixture_loss - best_fixed_loss
    regret_bound = math.log(n_candidates) / eta + eta * horizon / 8.0

    assert regret <= regret_bound

    approximation_error = 0.03
    readout_regret = 0.16
    evaluation_delay_cost = 0.08
    excess_bound = (
        approximation_error
        + regret_bound / horizon
        + readout_regret / horizon
        + evaluation_delay_cost / horizon
    )
    assert excess_bound > approximation_error


def test_selection_theorem_rejects_unbounded_losses() -> None:
    unbounded = np.array([[0.0, 1.2]], dtype=np.float64)

    try:
        _hedge_mixture_loss(unbounded, eta=0.5)
    except ValueError:
        pass
    else:
        raise AssertionError("expected bounded-loss precondition to fail")


def test_unobservable_latent_context_has_irreducible_gap() -> None:
    observations: NDArray[np.float64] = np.zeros((4, 1), dtype=np.float64)
    hidden_context = np.array([-1.0, 1.0, -1.0, 1.0], dtype=np.float64)
    targets = hidden_context.copy()

    observable_only = np.column_stack([np.ones(observations.shape[0]), observations])
    hidden_aware = np.column_stack([observable_only, hidden_context])

    observable_gap = _least_squares_mse(observable_only, targets)
    hidden_aware_gap = _least_squares_mse(hidden_aware, targets)

    assert observable_gap == 1.0
    assert hidden_aware_gap < 1e-24


def test_depth_limited_feature_dag_can_encode_specific_recursive_product() -> None:
    ops = jnp.asarray(
        [OP_RAW, OP_RAW, OP_RAW, OP_PRODUCT, OP_PRODUCT],
        dtype=jnp.int32,
    )
    parent_a = jnp.asarray([0, 1, 2, 0, 3], dtype=jnp.int32)
    parent_b = jnp.asarray([-1, -1, -1, 1, 2], dtype=jnp.int32)
    theta = jnp.zeros((5, 2), dtype=jnp.float32)
    observation = jnp.asarray([2.0, 3.0, 4.0], dtype=jnp.float32)

    values = _compute_feature_values(ops, parent_a, parent_b, theta, observation)

    np.testing.assert_allclose(np.asarray(values), [2.0, 3.0, 4.0, 6.0, 10.0])
