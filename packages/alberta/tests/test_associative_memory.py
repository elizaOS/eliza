"""Tests for the Step 2 fixed-budget associative memory."""

import math

import chex
import jax.numpy as jnp
import pytest

from alberta_framework.core.associative_memory import (
    AssociativeMemoryConfig,
    AssociativeMemoryLearner,
    run_associative_memory_arrays,
)
from alberta_framework.steps.step2 import (
    Step2AssociativeConfig,
    make_step2_associative_learner,
    run_step2_associative_smoke,
)


def test_associative_config_roundtrip() -> None:
    config = AssociativeMemoryConfig(
        vocab_size=7,
        block_size=5,
        suffix_length=3,
        feature_family="token_suffix_pair",
        max_features=31,
    )

    restored = AssociativeMemoryConfig.from_config(config.to_config())

    assert restored == config
    learner = AssociativeMemoryLearner(restored)
    assert learner.max_active_features == 8
    chex.assert_shape(learner.init().keys, (31, 5))


def test_associative_prediction_is_before_write() -> None:
    learner = AssociativeMemoryLearner(
        AssociativeMemoryConfig(vocab_size=5, block_size=4, suffix_length=3)
    )
    state = learner.init()
    context = jnp.asarray([1, 2, 3, 4], dtype=jnp.int32)

    before = learner.predict(state, context)
    result = learner.update(state, context, jnp.asarray(2, dtype=jnp.int32))

    chex.assert_trees_all_close(before.probabilities, jnp.full((5,), 0.2))
    chex.assert_trees_all_close(result.predictions, before.probabilities)
    assert int(result.state.step_count) == 1
    assert float(result.metrics[0]) == pytest.approx(math.log(5), abs=1e-5)


def test_associative_scope_controls_are_disabled_by_default() -> None:
    config = AssociativeMemoryConfig(
        vocab_size=5,
        block_size=4,
        suffix_length=3,
        max_features=32,
    )
    learner = AssociativeMemoryLearner(config)
    state = learner.init()
    context = jnp.asarray([1, 2, 3, 4], dtype=jnp.int32)

    result = learner.update(state, context, jnp.asarray(2, dtype=jnp.int32))
    prediction = learner.predict(result.state, context)

    assert not config.adaptive_feature_family
    assert not config.adaptive_window
    assert not config.adaptive_budget
    chex.assert_trees_all_close(result.state.family_logits, state.family_logits)
    chex.assert_trees_all_close(result.state.window_logits, state.window_logits)
    chex.assert_trees_all_close(result.state.budget_logit, state.budget_logit)
    chex.assert_trees_all_close(
        prediction.scope_weights,
        prediction.feature_mask.astype(jnp.float32),
    )
    assert float(prediction.effective_budget) == pytest.approx(config.max_features)


def test_associative_memory_learns_repeated_binding() -> None:
    learner = AssociativeMemoryLearner(
        AssociativeMemoryConfig(
            vocab_size=6,
            block_size=4,
            suffix_length=3,
            max_features=64,
        )
    )
    context = jnp.asarray([1, 2, 3, 4], dtype=jnp.int32)
    contexts = jnp.tile(context[None, :], (32, 1))
    labels = jnp.full((32,), 5, dtype=jnp.int32)

    result = run_associative_memory_arrays(learner, learner.init(), contexts, labels)
    chex.assert_tree_all_finite((result.predictions, result.metrics))

    initial_nll = float(jnp.mean(result.metrics[:4, 0]))
    final_nll = float(jnp.mean(result.metrics[-4:, 0]))
    final_accuracy = float(jnp.mean(result.metrics[-4:, 1]))

    assert final_nll < initial_nll * 0.5
    assert final_accuracy == 1.0


def test_associative_memory_respects_fixed_budget() -> None:
    learner = AssociativeMemoryLearner(
        AssociativeMemoryConfig(
            vocab_size=9,
            block_size=5,
            suffix_length=4,
            max_features=4,
        )
    )
    contexts = jnp.asarray(
        [
            [0, 1, 2, 3, 4],
            [4, 3, 2, 1, 0],
            [1, 3, 5, 7, 8],
        ],
        dtype=jnp.int32,
    )
    labels = jnp.asarray([1, 2, 3], dtype=jnp.int32)

    result = run_associative_memory_arrays(learner, learner.init(), contexts, labels)
    occupied = int(jnp.sum(result.state.counts > 0.0))

    assert occupied <= 4
    assert int(result.state.replacements) > 0


def test_associative_adaptive_family_scope_prefers_useful_pairs() -> None:
    learner = AssociativeMemoryLearner(
        AssociativeMemoryConfig(
            vocab_size=4,
            block_size=4,
            suffix_length=3,
            max_features=128,
            adaptive_feature_family=True,
            scope_lr=0.2,
        )
    )
    base_contexts = jnp.asarray(
        [
            [0, 0, 1, 2],
            [0, 0, 1, 3],
            [0, 0, 2, 2],
            [0, 0, 2, 3],
        ],
        dtype=jnp.int32,
    )
    base_labels = jnp.asarray([0, 1, 1, 0], dtype=jnp.int32)
    pattern_ids = jnp.arange(240, dtype=jnp.int32) % base_contexts.shape[0]
    contexts = base_contexts[pattern_ids]
    labels = base_labels[pattern_ids]

    result = run_associative_memory_arrays(learner, learner.init(), contexts, labels)
    prediction = learner.predict(result.state, contexts[-1])

    assert float(result.state.family_logits[1]) > float(result.state.family_logits[0])
    assert float(prediction.family_probs[1]) > 0.80


def test_associative_adaptive_window_scope_prefers_useful_long_window() -> None:
    learner = AssociativeMemoryLearner(
        AssociativeMemoryConfig(
            vocab_size=4,
            block_size=4,
            suffix_length=4,
            feature_family="suffix_pair",
            max_features=512,
            adaptive_window=True,
            scope_lr=0.2,
        )
    )
    contexts_list: list[list[int]] = []
    labels_list: list[int] = []
    for _ in range(3):
        for old_token in (1, 2):
            for middle_a in range(4):
                for middle_b in range(4):
                    for recent_token in range(4):
                        contexts_list.append(
                            [old_token, middle_a, middle_b, recent_token]
                        )
                        labels_list.append(old_token - 1)
    contexts = jnp.asarray(contexts_list, dtype=jnp.int32)
    labels = jnp.asarray(labels_list, dtype=jnp.int32)

    result = run_associative_memory_arrays(learner, learner.init(), contexts, labels)
    prediction = learner.predict(result.state, contexts[-1])

    assert float(result.state.window_logits[-1]) > float(result.state.window_logits[0])
    assert float(prediction.window_probs[-1]) > 0.80


def test_associative_adaptive_budget_expands_under_replacement_pressure() -> None:
    learner = AssociativeMemoryLearner(
        AssociativeMemoryConfig(
            vocab_size=13,
            block_size=4,
            suffix_length=3,
            max_features=64,
            adaptive_budget=True,
            initial_budget_fraction=0.10,
            budget_lr=0.5,
        )
    )
    contexts = (
        jnp.arange(80 * 4, dtype=jnp.int32).reshape(80, 4)
        * jnp.asarray([1, 2, 3, 4], dtype=jnp.int32)
    ) % 13
    labels = (contexts[:, 0] + 2 * contexts[:, 1] + 3 * contexts[:, 2]) % 13
    state = learner.init()
    initial_budget = learner.predict(state, contexts[0]).effective_budget

    result = run_associative_memory_arrays(learner, state, contexts, labels)
    final_budget = learner.predict(result.state, contexts[-1]).effective_budget

    assert int(result.state.replacements) > 0
    assert float(result.state.budget_logit) > float(state.budget_logit)
    assert float(final_budget) > float(initial_budget) + 10.0


def test_step2_associative_facade_smoke_and_roundtrip() -> None:
    config = Step2AssociativeConfig(
        vocab_size=8,
        block_size=5,
        suffix_length=3,
        max_features=128,
        adaptive_feature_family=True,
        adaptive_window=True,
        adaptive_budget=True,
        initial_budget_fraction=0.25,
    )
    restored = Step2AssociativeConfig.from_dict(config.to_dict())
    learner = make_step2_associative_learner(restored)

    assert learner.config == config.to_core_config()
    assert learner.config.adaptive_feature_family
    assert learner.config.adaptive_window
    assert learner.config.adaptive_budget
    assert learner.config.initial_budget_fraction == pytest.approx(0.25)

    result = run_step2_associative_smoke(config, steps=64, seed=0, window=16)
    assert result.finite
    assert result.metrics_shape == (64, 8)
    assert result.final_window_nll < result.initial_window_nll
