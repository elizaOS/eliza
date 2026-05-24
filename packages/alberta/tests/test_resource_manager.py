"""Tests for learned resource managers."""

from __future__ import annotations

import math

import chex
import jax.numpy as jnp
import jax.random as jr
import numpy as np
import pytest
from numpy.typing import NDArray

from alberta_framework import (
    GeneratorMetaResourceManager,
    LearnedResourceManager,
    finite_candidate_hedge_regret_bound,
    optimal_hedge_learning_rate,
)
from alberta_framework.core.compositional_features import (
    CompositionalFeatureLearner,
    run_compositional_arrays,
)


class TestLearnedResourceManager:
    """Behavioral checks for the contextual Hedge manager."""

    @staticmethod
    def _mixture_loss(
        manager: LearnedResourceManager,
        losses: NDArray[np.float64],
    ) -> float:
        state = manager.init()
        total = 0.0
        for row in losses:
            weights = manager.weights(state)
            total += float(np.dot(np.asarray(weights), row))
            state = manager.update(
                state,
                jnp.asarray(row, dtype=jnp.float32),
            ).state
        return total

    def test_init_shapes_and_uniform_weights(self) -> None:
        manager = LearnedResourceManager(n_actions=3, n_contexts=2)
        state = manager.init()

        chex.assert_shape(state.log_weights, (2, 3))
        chex.assert_shape(state.loss_ema, (2, 3))
        chex.assert_shape(state.action_counts, (2, 3))
        weights = manager.weights(state, 1)
        assert weights.tolist() == pytest.approx([1 / 3, 1 / 3, 1 / 3])

    def test_weights_shift_toward_lower_loss_action(self) -> None:
        manager = LearnedResourceManager(
            n_actions=3,
            learning_rate=2.0,
            discount=1.0,
            exploration=0.0,
        )
        state = manager.init()
        for _ in range(20):
            result = manager.update(state, jnp.asarray([1.0, 0.1, 0.8]))
            state = result.state

        weights = manager.weights(state)
        assert int(jnp.argmax(weights)) == 1
        assert float(weights[1]) > 0.95

    def test_contexts_learn_independently(self) -> None:
        manager = LearnedResourceManager(
            n_actions=2,
            n_contexts=2,
            learning_rate=2.0,
            discount=1.0,
        )
        state = manager.init()
        for _ in range(10):
            state = manager.update(state, jnp.asarray([0.1, 1.0]), context_id=0).state
            state = manager.update(state, jnp.asarray([1.0, 0.1]), context_id=1).state

        assert int(jnp.argmax(manager.weights(state, 0))) == 0
        assert int(jnp.argmax(manager.weights(state, 1))) == 1

    def test_resource_cost_can_break_loss_tie(self) -> None:
        manager = LearnedResourceManager(
            n_actions=2,
            learning_rate=2.0,
            discount=1.0,
            cost_weight=1.0,
        )
        state = manager.init()
        losses = jnp.asarray([0.1, 0.1])
        costs = jnp.asarray([0.0, 1.0])
        for _ in range(10):
            state = manager.update(state, losses, resource_costs=costs).state

        weights = manager.weights(state)
        assert int(jnp.argmax(weights)) == 0
        assert float(weights[0]) > 0.99

    def test_nan_loss_is_ignored(self) -> None:
        manager = LearnedResourceManager(n_actions=2, learning_rate=1.0)
        state = manager.init()
        result = manager.update(state, jnp.asarray([0.1, jnp.nan]))

        assert float(result.advantages[1]) == 0.0
        assert result.state.action_counts[0, 0] == pytest.approx(1.0)
        assert result.state.action_counts[0, 1] == pytest.approx(0.0)

    def test_config_roundtrip(self) -> None:
        manager = LearnedResourceManager(
            n_actions=4,
            n_contexts=3,
            learning_rate=0.7,
            discount=0.9,
            exploration=0.05,
            loss_decay=0.8,
            cost_weight=0.2,
            advantage_clip=3.0,
        )
        clone = LearnedResourceManager.from_config(manager.to_config())

        assert clone.to_config() == manager.to_config()

    def test_fixed_candidate_regret_bound_matches_hedge_theorem(self) -> None:
        losses = np.asarray(
            [
                [0.10, 0.70, 0.40],
                [0.20, 0.60, 0.30],
                [0.15, 0.90, 0.20],
                [0.25, 0.20, 0.50],
                [0.20, 0.30, 0.45],
                [0.10, 0.80, 0.35],
                [0.30, 0.40, 0.40],
                [0.15, 0.70, 0.25],
            ],
            dtype=np.float64,
        )
        horizon, n_actions = losses.shape
        eta = optimal_hedge_learning_rate(n_actions, horizon)
        manager = LearnedResourceManager(
            n_actions=n_actions,
            learning_rate=eta,
            discount=1.0,
            exploration=0.0,
            advantage_clip=10.0,
        )

        mixture_loss = self._mixture_loss(manager, losses)
        best_fixed_loss = float(np.min(np.sum(losses, axis=0)))
        regret = mixture_loss - best_fixed_loss

        assert regret <= manager.fixed_candidate_regret_bound(horizon)
        assert math.isclose(
            manager.fixed_candidate_regret_bound(horizon),
            finite_candidate_hedge_regret_bound(n_actions, horizon, eta),
        )

    def test_regret_helpers_validate_theorem_preconditions(self) -> None:
        assert optimal_hedge_learning_rate(1, 10) == 0.0
        assert finite_candidate_hedge_regret_bound(1, 10, 0.0) == 0.0
        assert math.isinf(finite_candidate_hedge_regret_bound(2, 10, 0.0))

        with pytest.raises(ValueError):
            optimal_hedge_learning_rate(0, 10)
        with pytest.raises(ValueError):
            optimal_hedge_learning_rate(2, 0)
        with pytest.raises(ValueError):
            finite_candidate_hedge_regret_bound(2, 10, -0.1)
        with pytest.raises(ValueError):
            finite_candidate_hedge_regret_bound(2, 10, 0.1, loss_bound=0.0)


class TestGeneratorMetaResourceManager:
    """Behavioral checks for generator-internal meta-resource policies."""

    def test_contexts_learn_independently_from_rewards(self) -> None:
        manager = GeneratorMetaResourceManager(
            policy_names=("product", "tanh"),
            op_ids=(1, 3),
            parent_modes=(1, 3),
            replacement_multipliers=(1.0, 2.0),
            promotion_margin_multipliers=(1.0, 0.8),
            candidate_min_age_multipliers=(1.0, 0.5),
            imprint_scales=(0.0, 1.0),
            n_contexts=2,
            learning_rate=2.0,
            discount=1.0,
            exploration=0.0,
        )
        state = manager.init()

        for _ in range(10):
            state = manager.update(
                state,
                jnp.asarray([1.0, 0.1], dtype=jnp.float32),
                context_id=0,
            ).state
            state = manager.update(
                state,
                jnp.asarray([0.1, 1.0], dtype=jnp.float32),
                context_id=1,
            ).state

        assert int(jnp.argmax(manager.weights(state, 0))) == 0
        assert int(jnp.argmax(manager.weights(state, 1))) == 1

    def test_policy_probabilities_are_normalized_with_priors(self) -> None:
        manager = GeneratorMetaResourceManager(
            policy_names=("safe", "product", "residual"),
            op_ids=(1, 1, 3),
            parent_modes=(0, 2, 3),
            replacement_multipliers=(0.5, 1.0, 2.0),
            promotion_margin_multipliers=(1.25, 1.0, 0.75),
            candidate_min_age_multipliers=(1.5, 1.0, 0.5),
            imprint_scales=(0.0, 0.25, 1.0),
            exploration=0.1,
            initial_preferences=(-1.0, 0.0, 1.0),
        )
        weights = manager.weights(manager.init())

        assert float(jnp.sum(weights)) == pytest.approx(1.0)
        assert jnp.all(weights > 0.0)
        assert int(jnp.argmax(weights)) == 2

    def test_exp3_credit_updates_selected_reward_direction(self) -> None:
        manager = GeneratorMetaResourceManager(
            policy_names=("safe", "residual"),
            op_ids=(1, 3),
            parent_modes=(0, 3),
            replacement_multipliers=(0.5, 2.0),
            promotion_margin_multipliers=(1.25, 0.75),
            candidate_min_age_multipliers=(1.5, 0.5),
            imprint_scales=(0.0, 1.0),
            learning_rate=0.5,
            discount=1.0,
            exploration=0.1,
            update_rule="exp3",
        )
        state = manager.init()
        before = manager.weights(state)
        result = manager.update(
            state,
            jnp.asarray([0.0, 1.0], dtype=jnp.float32),
            selected_action=1,
            selected_probability=before[1],
        )
        after = manager.weights(result.state)

        assert float(after[1]) > float(before[1])
        assert float(result.advantages[1]) > 0.0

    def test_select_returns_policy_knobs(self) -> None:
        manager = GeneratorMetaResourceManager(
            policy_names=("safe", "aggressive"),
            op_ids=(1, 4),
            parent_modes=(0, 3),
            replacement_multipliers=(0.5, 2.0),
            promotion_margin_multipliers=(1.25, 0.75),
            candidate_min_age_multipliers=(1.5, 0.5),
            imprint_scales=(0.0, 1.0),
            exploration=0.0,
        )
        state = manager.init().replace(  # type: ignore[attr-defined]
            log_weights=jnp.asarray([[10.0, -10.0]], dtype=jnp.float32)
        )

        decision = manager.select(state, jr.key(0))

        assert int(decision.action) == 0
        assert int(decision.op_id) == 1
        assert int(decision.parent_mode) == 0
        assert float(decision.replacement_multiplier) == pytest.approx(0.5)
        assert float(decision.promotion_margin_multiplier) == pytest.approx(1.25)
        assert float(decision.candidate_min_age_multiplier) == pytest.approx(1.5)
        assert float(decision.imprint_scale) == pytest.approx(0.0)

    def test_config_roundtrip(self) -> None:
        manager = GeneratorMetaResourceManager(
            policy_names=("a", "b", "c"),
            op_ids=(1, 3, 4),
            parent_modes=(0, 2, 3),
            replacement_multipliers=(0.5, 1.0, 2.0),
            promotion_margin_multipliers=(1.2, 1.0, 0.8),
            candidate_min_age_multipliers=(2.0, 1.0, 0.5),
            imprint_scales=(0.0, 0.5, 1.0),
            n_contexts=3,
            learning_rate=0.7,
            discount=0.9,
            exploration=0.05,
            reward_decay=0.8,
            cost_weight=0.1,
            advantage_clip=2.0,
            update_rule="exp3",
            initial_preferences=(-0.5, 0.0, 0.5),
        )

        clone = GeneratorMetaResourceManager.from_config(manager.to_config())

        assert clone.to_config() == manager.to_config()

    def test_generator_resource_training_metrics_are_finite(self) -> None:
        observations = jnp.asarray(
            [
                [0.2, 0.3, 0.1],
                [0.4, -0.5, 0.2],
                [-0.3, 0.7, -0.1],
                [0.6, 0.2, 0.4],
                [-0.5, -0.4, 0.3],
                [0.1, 0.8, -0.2],
            ],
            dtype=jnp.float32,
        )
        targets = (observations[:, 0] * observations[:, 1])[:, None]
        learner = CompositionalFeatureLearner(
            n_features=8,
            n_tasks=1,
            candidate_count=4,
            replacement_interval=2,
            min_feature_age=1,
            candidate_min_age=1,
            learn_generator_resources=True,
            generator_resource_update_rule="exp3",
            generator_resource_promotion_credit=0.5,
            generator_resource_cost_weight=0.1,
        )
        state = learner.init(feature_dim=3, key=jr.key(123))
        result = run_compositional_arrays(learner, state, observations, targets)

        assert jnp.all(jnp.isfinite(result.metrics))
        assert jnp.all(jnp.isfinite(result.state.generator_resource_state.log_weights))
