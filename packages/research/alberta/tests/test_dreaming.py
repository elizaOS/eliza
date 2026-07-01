from __future__ import annotations

from typing import Any

import chex
import jax.numpy as jnp
import jax.random as jr

from alberta_framework.core.dreaming import (
    DreamBehaviorModelPrediction,
    DreamRolloutConfig,
    DreamWorldModelPrediction,
    dream_one_step,
    dream_rollout,
    imagined_rollout_to_gvf_items,
    imagined_rollout_to_sarsa_items,
    imagined_transition_to_gvf_item,
    imagined_transition_to_supervised_item,
    init_dream_rollout_state,
    slice_imagined_transition,
)


def _assert_rollout_state_close(left, right) -> None:  # type: ignore[no-untyped-def]
    chex.assert_trees_all_close(
        (
            left.observation,
            jr.key_data(left.rng_key),
            left.active,
            left.cumulative_confidence,
            left.step_count,
        ),
        (
            right.observation,
            jr.key_data(right.rng_key),
            right.active,
            right.cumulative_confidence,
            right.step_count,
        ),
    )


def _assert_dream_outputs_finite(next_state, transition) -> None:  # type: ignore[no-untyped-def]
    chex.assert_tree_all_finite(
        (
            next_state.observation,
            jr.key_data(next_state.rng_key),
            next_state.active,
            next_state.cumulative_confidence,
            next_state.step_count,
            transition,
        )
    )


@chex.dataclass(frozen=True)
class MockWorldState:
    drift: jnp.ndarray
    reward_bias: jnp.ndarray
    confidence: jnp.ndarray
    model_error: jnp.ndarray


class MockWorldModel:
    def predict(
        self,
        state: MockWorldState,
        observation: jnp.ndarray,
        action: jnp.ndarray,
        key: Any,
    ) -> DreamWorldModelPrediction:
        del key
        action_delta = 0.1 * jnp.asarray(action, dtype=jnp.float32)
        next_observation = observation + state.drift + action_delta
        reward = jnp.sum(next_observation) + state.reward_bias
        return DreamWorldModelPrediction(
            next_observation=next_observation,
            reward=reward,
            discount=jnp.array(0.9, dtype=jnp.float32),
            terminated=jnp.array(False),
            confidence=state.confidence,
            model_error=state.model_error,
        )


@chex.dataclass(frozen=True)
class DeterministicBehaviorState:
    action: jnp.ndarray


class DeterministicBehaviorModel:
    def sample_action(
        self,
        state: DeterministicBehaviorState,
        observation: jnp.ndarray,
        key: Any,
    ) -> DreamBehaviorModelPrediction:
        del observation, key
        return DreamBehaviorModelPrediction(
            action=state.action,
            action_probability=jnp.array(1.0, dtype=jnp.float32),
            log_probability=jnp.array(0.0, dtype=jnp.float32),
        )


@chex.dataclass(frozen=True)
class BernoulliBehaviorState:
    probability: jnp.ndarray


class BernoulliBehaviorModel:
    def sample_action(
        self,
        state: BernoulliBehaviorState,
        observation: jnp.ndarray,
        key: Any,
    ) -> DreamBehaviorModelPrediction:
        del observation
        action = jr.bernoulli(key, state.probability).astype(jnp.int32)
        probability = jnp.where(action == 1, state.probability, 1.0 - state.probability)
        return DreamBehaviorModelPrediction(
            action=action,
            action_probability=probability,
            log_probability=jnp.log(probability),
        )


def _world_state(confidence: float = 1.0, model_error: float = 0.0) -> MockWorldState:
    return MockWorldState(
        drift=jnp.array([0.5, -0.25], dtype=jnp.float32),
        reward_bias=jnp.array(0.25, dtype=jnp.float32),
        confidence=jnp.array(confidence, dtype=jnp.float32),
        model_error=jnp.array(model_error, dtype=jnp.float32),
    )


def test_one_step_dream_is_finite_and_does_not_mutate_model_state() -> None:
    world = MockWorldModel()
    behavior = DeterministicBehaviorModel()
    world_state = _world_state()
    behavior_state = DeterministicBehaviorState(action=jnp.array(1, dtype=jnp.int32))
    rollout_state = init_dream_rollout_state(
        jnp.array([1.0, 2.0], dtype=jnp.float32),
        jr.key(0),
    )

    next_state, transition = dream_one_step(
        world,
        world_state,
        behavior,
        behavior_state,
        rollout_state,
    )

    _assert_dream_outputs_finite(next_state, transition)
    chex.assert_trees_all_equal(world_state, _world_state())
    chex.assert_trees_all_equal(
        behavior_state,
        DeterministicBehaviorState(action=jnp.array(1, dtype=jnp.int32)),
    )
    assert bool(transition.valid)
    chex.assert_trees_all_close(
        transition.next_observation,
        jnp.array([1.6, 1.85], dtype=jnp.float32),
    )
    chex.assert_trees_all_close(transition.reward, jnp.array(3.7, dtype=jnp.float32))


def test_rollout_is_reproducible_under_prng_keys() -> None:
    world = MockWorldModel()
    behavior = BernoulliBehaviorModel()
    world_state = _world_state()
    behavior_state = BernoulliBehaviorState(probability=jnp.array(0.35, dtype=jnp.float32))
    config = DreamRolloutConfig(rollout_horizon=5)
    initial_a = init_dream_rollout_state(jnp.array([0.0, 0.0], dtype=jnp.float32), jr.key(7))
    initial_b = init_dream_rollout_state(jnp.array([0.0, 0.0], dtype=jnp.float32), jr.key(7))

    rollout_a = dream_rollout(world, world_state, behavior, behavior_state, initial_a, config)
    rollout_b = dream_rollout(world, world_state, behavior, behavior_state, initial_b, config)

    _assert_rollout_state_close(rollout_a.state, rollout_b.state)
    chex.assert_trees_all_close(rollout_a.transitions, rollout_b.transitions)
    chex.assert_shape(rollout_a.transitions.reward, (5,))
    chex.assert_shape(rollout_a.transitions.next_observation, (5, 2))


def test_model_confidence_gating_marks_invalid_and_stops_rollout() -> None:
    world = MockWorldModel()
    behavior = DeterministicBehaviorModel()
    world_state = _world_state(confidence=0.2, model_error=0.8)
    behavior_state = DeterministicBehaviorState(action=jnp.array(0, dtype=jnp.int32))
    config = DreamRolloutConfig(
        rollout_horizon=3,
        confidence_threshold=0.9,
        max_model_error=0.1,
    )
    initial = init_dream_rollout_state(jnp.array([1.0, 1.0], dtype=jnp.float32), jr.key(11))

    rollout = dream_rollout(world, world_state, behavior, behavior_state, initial, config)

    assert not bool(rollout.transitions.valid[0])
    assert not bool(rollout.state.active)
    chex.assert_trees_all_close(
        rollout.state.observation,
        jnp.array([1.0, 1.0], dtype=jnp.float32),
    )
    gvf_items = imagined_rollout_to_gvf_items(rollout)
    chex.assert_trees_all_close(gvf_items.weights, jnp.zeros((3,), dtype=jnp.float32))


def test_training_item_conversions_have_expected_targets() -> None:
    world = MockWorldModel()
    behavior = DeterministicBehaviorModel()
    world_state = _world_state()
    behavior_state = DeterministicBehaviorState(action=jnp.array(1, dtype=jnp.int32))
    initial = init_dream_rollout_state(jnp.array([1.0, 2.0], dtype=jnp.float32), jr.key(13))
    _, transition = dream_one_step(world, world_state, behavior, behavior_state, initial)

    supervised = imagined_transition_to_supervised_item(
        transition,
        n_actions=2,
        target="reward_next_observation",
    )
    chex.assert_trees_all_close(
        supervised.inputs,
        jnp.array([1.0, 2.0, 0.0, 1.0], dtype=jnp.float32),
    )
    chex.assert_trees_all_close(
        supervised.targets,
        jnp.array([3.7, 1.6, 1.85], dtype=jnp.float32),
    )
    chex.assert_trees_all_close(supervised.weights, jnp.array(1.0, dtype=jnp.float32))

    gvf = imagined_transition_to_gvf_item(transition)
    chex.assert_trees_all_close(gvf.cumulants, jnp.array([3.7], dtype=jnp.float32))
    chex.assert_trees_all_close(gvf.discounts, jnp.array([0.9], dtype=jnp.float32))


def test_rollout_to_sarsa_items_shift_actions_and_mask_last_without_bootstrap() -> None:
    world = MockWorldModel()
    behavior = BernoulliBehaviorModel()
    world_state = _world_state()
    behavior_state = BernoulliBehaviorState(probability=jnp.array(0.5, dtype=jnp.float32))
    config = DreamRolloutConfig(rollout_horizon=4)
    initial = init_dream_rollout_state(jnp.array([0.0, 0.0], dtype=jnp.float32), jr.key(17))

    rollout = dream_rollout(world, world_state, behavior, behavior_state, initial, config)
    sarsa = imagined_rollout_to_sarsa_items(rollout)
    first = slice_imagined_transition(rollout.transitions, 0)

    chex.assert_shape(sarsa.actions, (4,))
    chex.assert_trees_all_equal(sarsa.next_actions[:-1], sarsa.actions[1:])
    chex.assert_trees_all_close(sarsa.weights[-1], jnp.array(0.0, dtype=jnp.float32))
    chex.assert_trees_all_close(sarsa.rewards[0], first.reward)

    bootstrapped = imagined_rollout_to_sarsa_items(
        rollout,
        bootstrap_action=jnp.array(1, dtype=jnp.int32),
    )
    chex.assert_trees_all_equal(
        bootstrapped.next_actions[-1],
        jnp.array(1, dtype=jnp.int32),
    )
    chex.assert_trees_all_close(bootstrapped.weights, rollout.transitions.valid.astype(jnp.float32))
