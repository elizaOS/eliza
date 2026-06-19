"""Production facade tests for Alberta Plan Steps 5, 6, and 7."""

import chex
import jax
import jax.numpy as jnp
import jax.random as jr

from alberta_framework.steps import (
    Step5AverageRewardTDConfig,
    Step6DifferentialSARSAConfig,
    Step7DynaConfig,
    Step8WorldModelConfig,
    init_step6_state,
    init_step7_state,
    make_step5_td_learner,
    make_step6_differential_sarsa_agent,
    make_step7_components,
    run_step5_smoke,
    run_step6_smoke,
    run_step7_scan,
    run_step7_smoke,
    step6_update,
    step7_update,
)
from alberta_framework.steps.step7 import (
    _apply_planning_importance_correction,
    _pop_prioritized_planning_anchor,
    _propagate_predecessor_priorities,
    _select_planning_anchor,
    _update_planning_utility,
)


def test_step5_facade_config_roundtrip_and_smoke() -> None:
    config = Step5AverageRewardTDConfig(
        step_size=0.03,
        average_reward_step_size=0.02,
        trace_decay=0.25,
    )
    learner = make_step5_td_learner(config)
    restored = Step5AverageRewardTDConfig.from_dict(config.to_dict())
    result = run_step5_smoke(config, steps=12, feature_dim=3)

    assert restored == config
    assert learner.config.trace_decay == 0.25
    assert result.finite
    assert result.predictions_shape == (12,)
    assert result.td_errors_shape == (12,)
    assert result.average_rewards_shape == (12,)
    assert result.learner_config["type"] == "DifferentialTDLearner"


def test_step6_facade_config_roundtrip_one_step_and_smoke() -> None:
    config = Step6DifferentialSARSAConfig(
        n_actions=2,
        q_step_size=0.02,
        average_reward_step_size=0.01,
        epsilon_start=0.0,
    )
    agent = make_step6_differential_sarsa_agent(config)
    restored = Step6DifferentialSARSAConfig.from_dict(config.to_dict())
    state = init_step6_state(
        agent,
        feature_dim=2,
        key=jr.key(0),
        initial_features=jnp.array([1.0, 0.0], dtype=jnp.float32),
    )
    one_step = step6_update(
        agent,
        state,
        jnp.array(1.0, dtype=jnp.float32),
        jnp.array([0.0, 1.0], dtype=jnp.float32),
    )
    smoke = run_step6_smoke(config, steps=12, feature_dim=3)

    assert restored == config
    assert int(one_step.state.step_count) == 1
    assert smoke.finite
    assert smoke.q_values_shape == (12, 2)
    assert smoke.td_errors_shape == (12,)
    assert smoke.average_rewards_shape == (12,)
    assert smoke.actions_shape == (12,)
    assert smoke.agent_config["type"] == "DifferentialSARSAAgent"


def test_step7_dyna_facade_roundtrip_one_step_and_smoke() -> None:
    config = Step7DynaConfig(
        control=Step6DifferentialSARSAConfig(
            n_actions=2,
            q_step_size=0.02,
            average_reward_step_size=0.01,
            epsilon_start=0.0,
        ),
        world_model=Step8WorldModelConfig(
            observation_dim=2,
            n_actions=2,
            hidden_sizes=(),
            step_size=0.05,
            sparsity=0.0,
        ),
        planning_steps=2,
        planning_warmup_steps=0,
    )
    agent, model = make_step7_components(config)
    restored = Step7DynaConfig.from_dict(config.to_dict())
    state = init_step7_state(
        agent,
        model,
        key=jr.key(0),
        initial_observation=jnp.array([1.0, 0.0], dtype=jnp.float32),
    )
    one_step = step7_update(
        config,
        agent,
        model,
        state,
        jnp.array(1.0, dtype=jnp.float32),
        jnp.array([0.0, 1.0], dtype=jnp.float32),
    )
    smoke = run_step7_smoke(config, steps=12, seed=1)

    assert restored == config
    assert int(one_step.state.step_count) == 1
    assert int(one_step.state.world_model_state.step_count) == 1
    assert one_step.planning_td_errors.shape == (2,)
    assert one_step.planning_priorities.shape == (2,)
    assert one_step.planning_anchor_indices.shape == (2,)
    assert one_step.planning_importance_ratios.shape == (2,)
    assert int(one_step.state.memory_count) == 1
    assert bool(jnp.all(one_step.planning_accepted))
    assert smoke.finite
    assert smoke.real_td_errors_shape == (12,)
    assert smoke.planning_td_errors_shape == (12, 2)
    assert smoke.planning_priorities_shape == (12, 2)
    assert smoke.planning_anchor_indices_shape == (12, 2)
    assert smoke.planning_importance_ratios_shape == (12, 2)
    assert smoke.actions_shape == (12,)
    assert smoke.planning_acceptance_count == 24
    assert smoke.control_config["type"] == "DifferentialSARSAAgent"
    assert smoke.world_model_config["type"] == "OneStepWorldModel"


def test_step7_scan_preserves_real_action_context_after_planning() -> None:
    config = Step7DynaConfig(
        control=Step6DifferentialSARSAConfig(n_actions=2, epsilon_start=0.0),
        world_model=Step8WorldModelConfig(
            observation_dim=2,
            n_actions=2,
            hidden_sizes=(),
            sparsity=0.0,
        ),
        planning_steps=3,
        planning_warmup_steps=0,
    )
    agent, model = make_step7_components(config)
    state = init_step7_state(
        agent,
        model,
        key=jr.key(3),
        initial_observation=jnp.array([0.0, 0.0], dtype=jnp.float32),
    )
    next_observations = jnp.array(
        [[1.0, 0.0], [0.0, 1.0], [1.0, 1.0]],
        dtype=jnp.float32,
    )
    rewards = jnp.array([1.0, 0.0, 0.5], dtype=jnp.float32)

    result = run_step7_scan(config, agent, model, state, rewards, next_observations)

    assert int(result.state.step_count) == 3
    assert int(result.state.world_model_state.step_count) == 3
    assert result.planning_td_errors.shape == (3, 3)
    assert result.planning_priorities.shape == (3, 3)
    assert result.planning_anchor_indices.shape == (3, 3)
    assert result.planning_importance_ratios.shape == (3, 3)
    assert bool(jnp.all(result.planning_accepted))
    assert int(result.state.memory_count) == 3
    chex.assert_trees_all_close(
        result.state.memory_observations[:3],
        jnp.array(
            [[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]],
            dtype=jnp.float32,
        ),
    )
    assert int(result.state.control_state.last_action) == int(result.actions[-1])
    chex.assert_trees_all_close(
        result.state.control_state.last_observation,
        next_observations[-1],
    )


def test_step7_short_rollout_depth_spends_multiple_imagined_backups() -> None:
    config = Step7DynaConfig(
        control=Step6DifferentialSARSAConfig(n_actions=2, epsilon_start=0.0),
        world_model=Step8WorldModelConfig(
            observation_dim=2,
            n_actions=2,
            hidden_sizes=(),
            sparsity=0.0,
        ),
        planning_steps=2,
        planning_rollout_depth=3,
        planning_warmup_steps=0,
    )
    agent, model = make_step7_components(config)
    state = init_step7_state(
        agent,
        model,
        key=jr.key(4),
        initial_observation=jnp.array([0.0, 0.0], dtype=jnp.float32),
    )

    result = step7_update(
        config,
        agent,
        model,
        state,
        jnp.array(1.0, dtype=jnp.float32),
        jnp.array([1.0, 0.0], dtype=jnp.float32),
    )

    assert int(result.state.control_state.step_count) == 7
    assert result.planning_td_errors.shape == (2,)
    assert bool(jnp.all(result.planning_accepted))
    chex.assert_trees_all_close(
        result.state.control_state.last_observation,
        jnp.array([1.0, 0.0], dtype=jnp.float32),
    )


def test_step7_scan_is_jittable() -> None:
    config = Step7DynaConfig(
        control=Step6DifferentialSARSAConfig(n_actions=2, epsilon_start=0.0),
        world_model=Step8WorldModelConfig(
            observation_dim=2,
            n_actions=2,
            hidden_sizes=(),
            sparsity=0.0,
        ),
        planning_steps=2,
        planning_warmup_steps=0,
    )
    agent, model = make_step7_components(config)
    state = init_step7_state(
        agent,
        model,
        key=jr.key(5),
        initial_observation=jnp.array([0.0, 0.0], dtype=jnp.float32),
    )
    rewards = jnp.array([1.0, 0.0], dtype=jnp.float32)
    next_observations = jnp.array([[1.0, 0.0], [0.0, 1.0]], dtype=jnp.float32)

    result = jax.jit(
        lambda s: run_step7_scan(config, agent, model, s, rewards, next_observations)
    )(state)

    chex.assert_shape(result.real_td_errors, (2,))
    chex.assert_shape(result.planning_td_errors, (2, 2))
    chex.assert_shape(result.planning_priorities, (2, 2))
    chex.assert_shape(result.planning_anchor_indices, (2, 2))
    chex.assert_shape(result.planning_importance_ratios, (2, 2))
    chex.assert_tree_all_finite(
        (
            result.real_td_errors,
            result.planning_td_errors,
            result.planning_priorities,
            result.planning_importance_ratios,
        )
    )


def test_step7_reward_search_control_selects_high_reward_model_action() -> None:
    config = Step7DynaConfig(
        control=Step6DifferentialSARSAConfig(n_actions=2, epsilon_start=0.0),
        world_model=Step8WorldModelConfig(
            observation_dim=2,
            n_actions=2,
            hidden_sizes=(),
            sparsity=0.0,
        ),
        planning_steps=2,
        planning_warmup_steps=0,
        planning_strategy="reward",
    )
    agent, model = make_step7_components(config)
    state = init_step7_state(
        agent,
        model,
        key=jr.key(11),
        initial_observation=jnp.zeros(2, dtype=jnp.float32),
    )
    learner_state = state.world_model_state.learner_state
    head_weights = list(learner_state.head_params.weights)
    # Input layout is [obs0, obs1, action0, action1]; head 0 is reward.
    head_weights[0] = jnp.array([[0.0, 0.0, 0.0, 3.0]], dtype=jnp.float32)
    learner_state = learner_state.replace(  # type: ignore[attr-defined]
        head_params=learner_state.head_params.replace(  # type: ignore[attr-defined]
            weights=tuple(head_weights)
        )
    )
    state = state.replace(  # type: ignore[attr-defined]
        world_model_state=state.world_model_state.replace(  # type: ignore[attr-defined]
            learner_state=learner_state,
            step_count=jnp.array(1, dtype=jnp.int32),
        )
    )

    result = step7_update(
        config,
        agent,
        model,
        state,
        jnp.array(0.0, dtype=jnp.float32),
        jnp.zeros(2, dtype=jnp.float32),
    )

    chex.assert_trees_all_equal(
        result.planning_actions,
        jnp.ones((2,), dtype=jnp.int32),
    )
    assert bool(jnp.all(result.planning_priorities > 0.0))


def test_step7_planning_records_target_behavior_policy_ratios() -> None:
    config = Step7DynaConfig(
        control=Step6DifferentialSARSAConfig(
            n_actions=2,
            epsilon_start=0.2,
            epsilon_end=0.2,
        ),
        world_model=Step8WorldModelConfig(
            observation_dim=2,
            n_actions=2,
            hidden_sizes=(),
            sparsity=0.0,
        ),
        planning_steps=1,
        planning_warmup_steps=0,
        planning_strategy="random",
    )
    agent, model = make_step7_components(config)
    state = init_step7_state(
        agent,
        model,
        key=jr.key(13),
        initial_observation=jnp.array([1.0, 0.0], dtype=jnp.float32),
    )

    result = step7_update(
        config,
        agent,
        model,
        state,
        jnp.array(0.0, dtype=jnp.float32),
        jnp.array([0.0, 1.0], dtype=jnp.float32),
    )

    chex.assert_trees_all_close(
        result.planning_behavior_probs,
        jnp.array([0.5], dtype=jnp.float32),
    )
    assert bool(jnp.all(result.planning_target_probs > 0.0))
    assert bool(jnp.all(result.planning_importance_ratios > 0.0))
    assert bool(
        jnp.all(result.planning_importance_ratios <= config.planning_importance_ratio_clip)
    )


def test_step7_importance_correction_scales_imagined_update_delta() -> None:
    config = Step7DynaConfig(
        control=Step6DifferentialSARSAConfig(n_actions=2, epsilon_start=0.0),
        world_model=Step8WorldModelConfig(
            observation_dim=2,
            n_actions=2,
            hidden_sizes=(),
            sparsity=0.0,
        ),
    )
    agent, model = make_step7_components(config)
    old_state = init_step7_state(
        agent,
        model,
        key=jr.key(15),
        initial_observation=jnp.array([1.0, 0.0], dtype=jnp.float32),
    ).control_state
    planned_state = old_state.replace(  # type: ignore[attr-defined]
        q_weights=old_state.q_weights + 4.0,
        q_bias=old_state.q_bias + 2.0,
        q_trace_weights=old_state.q_trace_weights + 3.0,
        q_trace_bias=old_state.q_trace_bias + 1.0,
        average_reward=old_state.average_reward + 6.0,
    )

    corrected = _apply_planning_importance_correction(
        old_state,
        planned_state,
        jnp.array(0.25, dtype=jnp.float32),
    )

    chex.assert_trees_all_close(corrected.q_weights, old_state.q_weights + 1.0)
    chex.assert_trees_all_close(corrected.q_bias, old_state.q_bias + 0.5)
    chex.assert_trees_all_close(corrected.q_trace_weights, old_state.q_trace_weights + 0.75)
    chex.assert_trees_all_close(corrected.q_trace_bias, old_state.q_trace_bias + 0.25)
    chex.assert_trees_all_close(corrected.average_reward, old_state.average_reward + 1.5)
    chex.assert_trees_all_equal(corrected.last_observation, planned_state.last_observation)
    chex.assert_trees_all_equal(corrected.last_action, planned_state.last_action)


def test_step7_predecessor_search_control_selects_matching_memory_anchor() -> None:
    observations = jnp.array(
        [[0.0, 0.0], [4.0, 0.0], [8.0, 0.0]],
        dtype=jnp.float32,
    )
    rewards = jnp.array([0.1, 0.2, 0.3], dtype=jnp.float32)
    next_observations = jnp.array(
        [[1.0, 0.0], [5.0, 0.0], [9.0, 0.0]],
        dtype=jnp.float32,
    )
    priorities = jnp.array([0.1, 0.2, 0.3], dtype=jnp.float32)
    utilities = jnp.array([0.0, 0.0, 0.0], dtype=jnp.float32)

    anchor, index, score = _select_planning_anchor(
        observations,
        rewards,
        next_observations,
        priorities,
        utilities,
        jnp.array(3, dtype=jnp.int32),
        jnp.array([5.05, 0.0], dtype=jnp.float32),
        jr.key(0),
        "predecessor",
    )

    chex.assert_trees_all_close(anchor, observations[1])
    assert int(index) == 1
    assert float(score) > float(priorities[1])


def test_step7_learned_search_control_selects_high_utility_anchor() -> None:
    observations = jnp.array(
        [[0.0, 0.0], [4.0, 0.0], [8.0, 0.0]],
        dtype=jnp.float32,
    )
    rewards = jnp.array([0.1, 0.2, 0.3], dtype=jnp.float32)
    next_observations = jnp.array(
        [[1.0, 0.0], [5.0, 0.0], [9.0, 0.0]],
        dtype=jnp.float32,
    )
    priorities = jnp.array([0.1, 0.2, 0.3], dtype=jnp.float32)
    utilities = jnp.array([0.0, 5.0, 0.0], dtype=jnp.float32)

    anchor, index, score = _select_planning_anchor(
        observations,
        rewards,
        next_observations,
        priorities,
        utilities,
        jnp.array(3, dtype=jnp.int32),
        jnp.array([9.0, 0.0], dtype=jnp.float32),
        jr.key(0),
        "learned",
    )

    chex.assert_trees_all_close(anchor, observations[1])
    assert int(index) == 1
    assert float(score) > 5.0


def test_step7_planning_utility_tracks_backup_td_signal() -> None:
    utilities = jnp.array([1.0, 2.0, 3.0], dtype=jnp.float32)

    updated = _update_planning_utility(
        utilities,
        jnp.array(1, dtype=jnp.int32),
        jnp.array(-10.0, dtype=jnp.float32),
        0.25,
    )

    chex.assert_trees_all_close(updated[0], utilities[0])
    chex.assert_trees_all_close(updated[1], jnp.array(4.0, dtype=jnp.float32))
    chex.assert_trees_all_close(updated[2], utilities[2])


def test_step7_prioritized_queue_pops_highest_priority_anchor() -> None:
    observations = jnp.array(
        [[0.0, 0.0], [4.0, 0.0], [8.0, 0.0]],
        dtype=jnp.float32,
    )
    priorities = jnp.array([0.1, 2.5, 0.3], dtype=jnp.float32)

    anchor, index, priority, queue = _pop_prioritized_planning_anchor(
        observations,
        priorities,
        jnp.array(3, dtype=jnp.int32),
    )

    chex.assert_trees_all_close(anchor, observations[1])
    assert int(index) == 1
    assert float(priority) == 2.5
    assert float(queue[1]) == 0.0
    chex.assert_trees_all_close(queue[jnp.array([0, 2])], priorities[jnp.array([0, 2])])


def test_step7_prioritized_queue_propagates_to_predecessors() -> None:
    next_observations = jnp.array(
        [[1.0, 0.0], [5.0, 0.0], [9.0, 0.0]],
        dtype=jnp.float32,
    )
    priorities = jnp.array([0.1, 0.0, 0.2], dtype=jnp.float32)

    propagated = _propagate_predecessor_priorities(
        next_observations,
        priorities,
        jnp.array(3, dtype=jnp.int32),
        jnp.array([5.0, 0.0], dtype=jnp.float32),
        jnp.array(-3.0, dtype=jnp.float32),
        1.0,
    )

    assert float(propagated[1]) == 3.0
    assert float(propagated[0]) > float(priorities[0])
    assert float(propagated[2]) > float(priorities[2])


def test_step7_prioritized_planning_updates_priority_queue() -> None:
    config = Step7DynaConfig(
        control=Step6DifferentialSARSAConfig(
            n_actions=2,
            q_step_size=0.1,
            average_reward_step_size=0.0,
            epsilon_start=0.0,
        ),
        world_model=Step8WorldModelConfig(
            observation_dim=2,
            n_actions=2,
            hidden_sizes=(),
            sparsity=0.0,
        ),
        planning_steps=2,
        planning_warmup_steps=0,
        planning_strategy="prioritized",
    )
    agent, model = make_step7_components(config)
    state = init_step7_state(
        agent,
        model,
        key=jr.key(17),
        initial_observation=jnp.array([1.0, 0.0], dtype=jnp.float32),
    )
    state = state.replace(  # type: ignore[attr-defined]
        memory_observations=jnp.array(
            [[0.0, 0.0], [1.0, 0.0], [2.0, 0.0]],
            dtype=jnp.float32,
        ),
        memory_actions=jnp.array([0, 0, 1], dtype=jnp.int32),
        memory_rewards=jnp.array([0.0, 0.0, 0.0], dtype=jnp.float32),
        memory_next_observations=jnp.array(
            [[1.0, 0.0], [2.0, 0.0], [3.0, 0.0]],
            dtype=jnp.float32,
        ),
        memory_priorities=jnp.array([0.2, 3.0, 0.4], dtype=jnp.float32),
        memory_utilities=jnp.array([0.2, 3.0, 0.4], dtype=jnp.float32),
        memory_count=jnp.array(3, dtype=jnp.int32),
        memory_position=jnp.array(2, dtype=jnp.int32),
        world_model_state=state.world_model_state.replace(  # type: ignore[attr-defined]
            step_count=jnp.array(10, dtype=jnp.int32),
        ),
    )

    result = step7_update(
        config,
        agent,
        model,
        state,
        jnp.array(2.0, dtype=jnp.float32),
        jnp.array([2.0, 0.0], dtype=jnp.float32),
    )

    assert result.planning_anchor_indices.shape == (2,)
    assert int(result.planning_anchor_indices[0]) == 2
    assert bool(jnp.all(result.planning_accepted))
    assert bool(jnp.any(result.state.memory_priorities != state.memory_priorities))


def test_step7_learned_strategy_updates_selected_memory_utility() -> None:
    config = Step7DynaConfig(
        control=Step6DifferentialSARSAConfig(
            n_actions=2,
            q_step_size=0.1,
            average_reward_step_size=0.0,
            epsilon_start=0.0,
        ),
        world_model=Step8WorldModelConfig(
            observation_dim=2,
            n_actions=2,
            hidden_sizes=(),
            sparsity=0.0,
        ),
        planning_steps=1,
        planning_warmup_steps=0,
        planning_strategy="learned",
        planning_utility_step_size=1.0,
    )
    agent, model = make_step7_components(config)
    state = init_step7_state(
        agent,
        model,
        key=jr.key(19),
        initial_observation=jnp.array([1.0, 0.0], dtype=jnp.float32),
    )
    state = state.replace(  # type: ignore[attr-defined]
        memory_observations=jnp.array(
            [[0.0, 0.0], [1.0, 0.0], [2.0, 0.0]],
            dtype=jnp.float32,
        ),
        memory_actions=jnp.array([0, 0, 1], dtype=jnp.int32),
        memory_rewards=jnp.array([0.0, 0.0, 0.0], dtype=jnp.float32),
        memory_next_observations=jnp.array(
            [[1.0, 0.0], [2.0, 0.0], [3.0, 0.0]],
            dtype=jnp.float32,
        ),
        memory_priorities=jnp.array([0.1, 0.2, 0.3], dtype=jnp.float32),
        memory_utilities=jnp.array([0.1, 5.0, 0.3], dtype=jnp.float32),
        memory_count=jnp.array(3, dtype=jnp.int32),
        memory_position=jnp.array(2, dtype=jnp.int32),
        world_model_state=state.world_model_state.replace(  # type: ignore[attr-defined]
            step_count=jnp.array(10, dtype=jnp.int32),
        ),
    )

    result = step7_update(
        config,
        agent,
        model,
        state,
        jnp.array(2.0, dtype=jnp.float32),
        jnp.array([2.0, 0.0], dtype=jnp.float32),
    )

    assert int(result.planning_anchor_indices[0]) == 1
    assert bool(result.planning_accepted[0])
    assert float(result.state.memory_utilities[1]) != 5.0


def test_step7_rejects_unknown_planning_strategy() -> None:
    try:
        Step7DynaConfig(planning_strategy="unknown")  # type: ignore[arg-type]
    except ValueError as exc:
        assert "planning_strategy" in str(exc)
    else:
        raise AssertionError("expected invalid planning strategy to be rejected")
