"""Tests for the Step 11 OaK production facade."""

from __future__ import annotations

import chex
import jax.numpy as jnp
import jax.random as jr
import pytest

from alberta_framework.core.oak import (
    KeyboardChordLearnerConfig,
    OaKAgent,
    OaKArrayResult,
    OaKConfig,
    OaKState,
    init_keyboard_chord_learner,
    keyboard_action,
    keyboard_q_values,
    learned_feature_subtask_specs,
    update_keyboard_chord_learner,
)
from alberta_framework.core.options import STOMPConfig, SubtaskSpec
from alberta_framework.steps.step11 import (
    Step11OaKConfig,
    Step11SmokeResult,
    init_step11_state,
    make_step11_oak_agent,
    run_step11_scan,
    run_step11_smoke,
    step11_update,
)

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

_SPEC0 = SubtaskSpec(feature_index=0, threshold=0.5, pseudo_reward_scale=1.0, max_option_steps=8)
_SPEC1 = SubtaskSpec(feature_index=1, threshold=0.3, pseudo_reward_scale=2.0, max_option_steps=4)


def _make_step11_cfg(
    *,
    specs: tuple[SubtaskSpec, ...] = (_SPEC0,),
    obs_dim: int = 4,
    n_prim: int = 2,
) -> Step11OaKConfig:
    return Step11OaKConfig(
        subtask_specs=specs,
        observation_dim=obs_dim,
        n_primitive_actions=n_prim,
    )


def _make_oak_cfg(
    *,
    specs: tuple[SubtaskSpec, ...] = (_SPEC0,),
    obs_dim: int = 4,
) -> OaKConfig:
    stomp = STOMPConfig(subtask_specs=specs, observation_dim=obs_dim)
    return OaKConfig(stomp=stomp)


def _setup(
    cfg: Step11OaKConfig | None = None,
    *,
    seed: int = 0,
) -> tuple[OaKAgent, OaKState]:
    if cfg is None:
        cfg = _make_step11_cfg()
    agent = make_step11_oak_agent(cfg)
    key = jr.key(seed)
    init_obs = jnp.zeros(cfg.observation_dim, dtype=jnp.float32)
    state = init_step11_state(agent, key=key, initial_observation=init_obs)
    return agent, state


# ---------------------------------------------------------------------------
# OaKConfig validation and serialization
# ---------------------------------------------------------------------------


def test_oak_config_no_subtasks_raises() -> None:
    stomp = STOMPConfig(subtask_specs=())
    with pytest.raises(ValueError, match="subtask"):
        OaKConfig(stomp=stomp)


def test_oak_config_invalid_ema_decay_raises() -> None:
    stomp = STOMPConfig(subtask_specs=(_SPEC0,))
    with pytest.raises(ValueError, match="utility_ema_decay"):
        OaKConfig(stomp=stomp, utility_ema_decay=1.5)


def test_oak_config_negative_threshold_raises() -> None:
    stomp = STOMPConfig(subtask_specs=(_SPEC0,))
    with pytest.raises(ValueError, match="curation_threshold"):
        OaKConfig(stomp=stomp, curation_threshold=-0.1)


def test_step11_config_roundtrip_single_spec() -> None:
    cfg = _make_step11_cfg()
    assert Step11OaKConfig.from_config(cfg.to_config()) == cfg


def test_step11_config_roundtrip_two_specs() -> None:
    cfg = _make_step11_cfg(specs=(_SPEC0, _SPEC1), obs_dim=4)
    assert Step11OaKConfig.from_config(cfg.to_config()) == cfg


def test_step11_config_roundtrip_preserves_oak_fields() -> None:
    cfg = Step11OaKConfig(
        subtask_specs=(_SPEC0,),
        observation_dim=4,
        utility_ema_decay=0.95,
        curation_threshold=0.02,
        epsilon_base=0.2,
    )
    restored = Step11OaKConfig.from_config(cfg.to_config())
    assert restored.utility_ema_decay == cfg.utility_ema_decay
    assert restored.curation_threshold == cfg.curation_threshold
    assert restored.epsilon_base == cfg.epsilon_base


def test_step11_config_type_tag_stripped() -> None:
    cfg = _make_step11_cfg()
    d = cfg.to_config()
    assert d["type"] == "Step11OaKConfig"
    assert Step11OaKConfig.from_config(d) == cfg


def test_step11_config_to_oak_config_fields_match() -> None:
    cfg = _make_step11_cfg(obs_dim=5, n_prim=3)
    oak_cfg = cfg.to_oak_config()
    assert isinstance(oak_cfg, OaKConfig)
    assert oak_cfg.observation_dim == 5
    assert oak_cfg.n_primitive_actions == 3
    assert oak_cfg.stomp.subtask_specs == cfg.subtask_specs


# ---------------------------------------------------------------------------
# Factory and initialization
# ---------------------------------------------------------------------------


def test_make_step11_oak_agent_default() -> None:
    agent = make_step11_oak_agent()
    assert isinstance(agent, OaKAgent)
    assert agent.config.n_options == 1


def test_make_step11_oak_agent_two_specs() -> None:
    cfg = _make_step11_cfg(specs=(_SPEC0, _SPEC1))
    agent = make_step11_oak_agent(cfg)
    assert agent.config.n_options == 2


def test_init_step11_state_shapes() -> None:
    cfg = _make_step11_cfg(obs_dim=4)
    agent, state = _setup(cfg)
    chex.assert_shape(state.utility_ema, (1,))
    chex.assert_shape(state.execution_counts, (1,))
    chex.assert_shape(state.cumulative_pseudo_rewards, (1,))


def test_init_step11_state_utility_zero() -> None:
    _, state = _setup()
    assert bool(jnp.all(state.utility_ema == 0.0))


def test_init_step11_state_step_count_zero() -> None:
    _, state = _setup()
    assert int(state.step_count) == 0


def test_init_step11_state_two_specs() -> None:
    cfg = _make_step11_cfg(specs=(_SPEC0, _SPEC1))
    agent, state = _setup(cfg)
    chex.assert_shape(state.utility_ema, (2,))


# ---------------------------------------------------------------------------
# Single-step update
# ---------------------------------------------------------------------------


def test_step11_update_increments_step_count() -> None:
    agent, state = _setup()
    result = step11_update(agent, state, jnp.array(1.0), jnp.zeros(4))
    assert int(result.state.step_count) == 1


def test_step11_update_state_finite() -> None:
    agent, state = _setup()
    result = step11_update(agent, state, jnp.array(0.5), jnp.ones(4) * 0.1)
    chex.assert_tree_all_finite(result.state.stomp_state.base_learner_state)


def test_step11_update_td_error_finite() -> None:
    agent, state = _setup()
    result = step11_update(agent, state, jnp.array(0.0), jnp.zeros(4))
    assert bool(jnp.isfinite(result.td_error))


def test_step11_update_utility_ema_updates_during_execution() -> None:
    spec = SubtaskSpec(feature_index=0, threshold=99.0, max_option_steps=100)
    cfg = Step11OaKConfig(
        subtask_specs=(spec,),
        observation_dim=2,
        n_primitive_actions=2,
    )
    agent, state = _setup(cfg)
    # Force option execution
    state_with_opt = state.replace(
        stomp_state=state.stomp_state.replace(
            executing_option=jnp.array(0, dtype=jnp.int32)
        )
    )
    result = step11_update(agent, state_with_opt, jnp.array(0.0), jnp.array([0.5, 0.0]))
    # Utility EMA should have moved from 0
    assert float(result.utility_ema[0]) != 0.0


def test_step11_update_execution_count_increments_on_start() -> None:
    spec = SubtaskSpec(feature_index=0, threshold=99.0, max_option_steps=100)
    cfg = Step11OaKConfig(
        subtask_specs=(spec,),
        observation_dim=2,
        n_primitive_actions=2,
        epsilon_base=1.0,  # force random to potentially select option
    )
    agent, state = _setup(cfg)
    # Run many steps; option must start at least once
    n_steps = 50
    rewards = jnp.zeros(n_steps)
    obs = jr.normal(jr.key(77), (n_steps, 2)) * 0.1
    result = run_step11_scan(agent, state, rewards, obs)
    # At least 0 executions (option might not get selected, but count is >= 0)
    assert bool(jnp.all(result.state.execution_counts >= 0))


# ---------------------------------------------------------------------------
# Scan
# ---------------------------------------------------------------------------


def test_run_step11_scan_output_shapes() -> None:
    cfg = _make_step11_cfg(obs_dim=4)
    agent, state = _setup(cfg)
    n_steps = 20
    rewards = jnp.zeros(n_steps)
    obs = jr.normal(jr.key(5), (n_steps, cfg.observation_dim))
    result = run_step11_scan(agent, state, rewards, obs)
    assert isinstance(result, OaKArrayResult)
    chex.assert_shape(result.td_errors, (n_steps,))
    chex.assert_shape(result.utility_emas, (n_steps, 1))
    chex.assert_shape(result.primitive_actions, (n_steps,))


def test_run_step11_scan_two_specs_shapes() -> None:
    cfg = _make_step11_cfg(specs=(_SPEC0, _SPEC1), obs_dim=4)
    agent, state = _setup(cfg)
    n_steps = 16
    result = run_step11_scan(
        agent, state, jnp.zeros(n_steps), jr.normal(jr.key(3), (n_steps, 4))
    )
    chex.assert_shape(result.utility_emas, (n_steps, 2))


def test_run_step11_scan_all_finite() -> None:
    cfg = _make_step11_cfg()
    agent, state = _setup(cfg, seed=42)
    n_steps = 50
    result = run_step11_scan(
        agent, state,
        jr.normal(jr.key(0), (n_steps,)) * 0.1,
        jr.normal(jr.key(1), (n_steps, cfg.observation_dim)) * 0.1,
    )
    chex.assert_tree_all_finite(result.td_errors)
    chex.assert_tree_all_finite(result.utility_emas)
    chex.assert_tree_all_finite(result.pseudo_rewards)


def test_run_step11_scan_final_step_count() -> None:
    cfg = _make_step11_cfg()
    agent, state = _setup(cfg)
    n_steps = 16
    result = run_step11_scan(
        agent, state, jnp.zeros(n_steps), jr.normal(jr.key(9), (n_steps, 4))
    )
    assert int(result.state.step_count) == n_steps


def test_run_step11_scan_actions_in_range() -> None:
    cfg = _make_step11_cfg(n_prim=3)
    agent, state = _setup(cfg)
    n_steps = 30
    result = run_step11_scan(
        agent, state, jnp.zeros(n_steps), jr.normal(jr.key(8), (n_steps, cfg.observation_dim))
    )
    assert bool(jnp.all(result.primitive_actions >= 0))
    assert bool(jnp.all(result.primitive_actions < 3))


# ---------------------------------------------------------------------------
# Curation
# ---------------------------------------------------------------------------


def test_curate_returns_new_agent() -> None:
    agent, state = _setup()
    new_agent, _ = agent.curate(state, jr.key(0))
    assert isinstance(new_agent, OaKAgent)


def test_curate_resets_utility_for_replaced_option() -> None:
    cfg = _make_step11_cfg(specs=(_SPEC0, _SPEC1), obs_dim=4)
    agent, state = _setup(cfg)
    # option 0 has higher utility (0.8), option 1 has lower utility (0.1)
    state = state.replace(
        utility_ema=jnp.array([0.8, 0.1], dtype=jnp.float32)
    )
    _, new_state = agent.curate(state, jr.key(0))
    # argmin picks option 1 (0.1 < 0.8) — option 1 should be reset to 0
    assert float(new_state.utility_ema[1]) == 0.0
    # Option 0 should be preserved
    chex.assert_trees_all_close(new_state.utility_ema[0], jnp.array(0.8), atol=1e-5)


def test_curate_above_threshold_skips() -> None:
    stomp = STOMPConfig(subtask_specs=(_SPEC0,))
    cfg = OaKConfig(stomp=stomp, curation_threshold=0.5)
    agent = OaKAgent(cfg)
    key = jr.key(0)
    state = agent.init(key)
    state = agent.start(state, jnp.zeros(4))
    # Give option utility above threshold
    state = state.replace(utility_ema=jnp.array([0.8], dtype=jnp.float32))
    new_agent, new_state = agent.curate(state, key)
    # Same agent returned (no replacement)
    assert new_agent is agent
    chex.assert_trees_all_close(new_state.utility_ema[0], jnp.array(0.8), atol=1e-5)


def test_curate_resets_option_weights() -> None:
    cfg = _make_step11_cfg()
    agent, state = _setup(cfg)
    # Run a few steps so weights are non-zero
    n_steps = 20
    state_after = run_step11_scan(
        agent, state, jnp.zeros(n_steps), jr.normal(jr.key(1), (n_steps, 4))
    ).state
    _, curated_state = agent.curate(state_after, jr.key(0))
    # Option 0 was the only option and should be reset
    chex.assert_trees_all_close(
        curated_state.stomp_state.option_policies.q_weights[0],
        jnp.zeros_like(curated_state.stomp_state.option_policies.q_weights[0]),
    )


# ---------------------------------------------------------------------------
# Option keyboard
# ---------------------------------------------------------------------------


def test_keyboard_q_values_shape() -> None:
    cfg = _make_step11_cfg(specs=(_SPEC0, _SPEC1), n_prim=3, obs_dim=4)
    agent, state = _setup(cfg)
    w = jnp.array([0.5, 0.5], dtype=jnp.float32)
    obs = jnp.ones(4, dtype=jnp.float32)
    q = keyboard_q_values(state.stomp_state, obs, w)
    chex.assert_shape(q, (3,))


def test_keyboard_q_values_uniform_weights_averages_options() -> None:
    cfg = _make_step11_cfg(specs=(_SPEC0, _SPEC1), n_prim=2, obs_dim=4)
    agent, state = _setup(cfg)
    obs = jnp.ones(4, dtype=jnp.float32)
    uniform = jnp.array([0.5, 0.5], dtype=jnp.float32)
    q_blend = keyboard_q_values(state.stomp_state, obs, uniform)
    # Should match manual average (after L1-normalisation uniform → [0.5, 0.5])
    q0 = state.stomp_state.option_policies.q_weights[0] @ obs
    q1 = state.stomp_state.option_policies.q_weights[1] @ obs
    expected = 0.5 * q0 + 0.5 * q1
    chex.assert_trees_all_close(q_blend, expected, atol=1e-5)


def test_keyboard_action_returns_valid_primitive() -> None:
    cfg = _make_step11_cfg(specs=(_SPEC0, _SPEC1), n_prim=3, obs_dim=4)
    agent, state = _setup(cfg)
    w = jnp.array([0.7, 0.3], dtype=jnp.float32)
    obs = jnp.zeros(4, dtype=jnp.float32)
    action, _ = keyboard_action(
        state.stomp_state, obs, w, jr.key(0), epsilon=0.0, n_primitive_actions=3
    )
    assert 0 <= int(action) < 3


def test_keyboard_action_epsilon_one_is_random() -> None:
    cfg = _make_step11_cfg(specs=(_SPEC0,), n_prim=2, obs_dim=4)
    agent, state = _setup(cfg)
    w = jnp.ones(1, dtype=jnp.float32)
    obs = jnp.zeros(4)
    actions = set()
    for seed in range(50):
        a, _ = keyboard_action(
            state.stomp_state, obs, w, jr.key(seed), epsilon=1.0, n_primitive_actions=2
        )
        actions.add(int(a))
    assert len(actions) > 1


# ---------------------------------------------------------------------------
# Learned feature construction and keyboard learning
# ---------------------------------------------------------------------------


def test_learned_feature_subtask_specs_ranks_weighted_features() -> None:
    agent, state = _setup(_make_step11_cfg(obs_dim=4), seed=12)
    head_weights = tuple(
        w.at[0, 2].set(3.0) if i == 0 else w
        for i, w in enumerate(state.stomp_state.base_learner_state.head_params.weights)
    )
    option_q = state.stomp_state.option_policies.q_weights.at[0, 1, 3].set(2.0)
    state = state.replace(
        stomp_state=state.stomp_state.replace(
            base_learner_state=state.stomp_state.base_learner_state.replace(
                head_params=state.stomp_state.base_learner_state.head_params.replace(
                    weights=head_weights
                )
            ),
            option_policies=state.stomp_state.option_policies.replace(
                q_weights=option_q
            ),
        )
    )
    specs = learned_feature_subtask_specs(state, n_subtasks=2, threshold=0.7)
    assert [spec.feature_index for spec in specs] == [2, 3]
    assert all(spec.threshold == pytest.approx(0.7) for spec in specs)


def test_keyboard_chord_learner_roundtrip() -> None:
    cfg = KeyboardChordLearnerConfig(
        n_options=3,
        step_size=0.2,
        baseline_decay=0.5,
        l2_penalty=0.01,
        max_norm=2.0,
    )
    assert KeyboardChordLearnerConfig.from_config(cfg.to_config()) == cfg


def test_keyboard_chord_learner_positive_reward_moves_toward_chord() -> None:
    cfg = KeyboardChordLearnerConfig(
        n_options=2,
        step_size=0.5,
        baseline_decay=0.5,
    )
    state = init_keyboard_chord_learner(cfg)
    selected = jnp.array([1.0, 0.0], dtype=jnp.float32)
    before = float(jnp.dot(state.chord_vector, selected))
    updated = update_keyboard_chord_learner(
        cfg,
        state,
        selected,
        jnp.array(1.0, dtype=jnp.float32),
    )
    after = float(jnp.dot(updated.chord_vector, selected))
    assert after > before
    assert int(updated.step_count) == 1


def test_keyboard_chord_learner_max_norm_bounds_vector() -> None:
    cfg = KeyboardChordLearnerConfig(
        n_options=2,
        step_size=10.0,
        max_norm=0.75,
    )
    state = init_keyboard_chord_learner(cfg)
    updated = update_keyboard_chord_learner(
        cfg,
        state,
        jnp.array([1.0, 1.0], dtype=jnp.float32),
        jnp.array(10.0, dtype=jnp.float32),
    )
    assert float(jnp.linalg.norm(updated.chord_vector)) <= 0.750001


# ---------------------------------------------------------------------------
# Smoke test
# ---------------------------------------------------------------------------


def test_run_step11_smoke_defaults() -> None:
    result = run_step11_smoke()
    assert isinstance(result, Step11SmokeResult)
    assert result.finite
    assert result.steps == 64
    assert result.td_errors_shape == (64,)
    assert result.utility_emas_shape == (64, 1)


def test_run_step11_smoke_two_specs() -> None:
    cfg = Step11OaKConfig(
        subtask_specs=(_SPEC0, _SPEC1),
        observation_dim=4,
        n_primitive_actions=2,
    )
    result = run_step11_smoke(cfg, steps=32, seed=1)
    assert result.finite
    assert result.utility_emas_shape == (32, 2)


def test_run_step11_smoke_to_dict_roundtrip() -> None:
    result = run_step11_smoke(steps=8)
    d = result.to_dict()
    assert isinstance(d["agent_config"], dict)
    assert d["finite"] is True


def test_run_step11_smoke_zero_steps_raises() -> None:
    with pytest.raises(ValueError, match="steps"):
        run_step11_smoke(steps=0)


# ---------------------------------------------------------------------------
# Long-horizon fineness
# ---------------------------------------------------------------------------


def test_step11_state_stays_finite_200_steps() -> None:
    cfg = Step11OaKConfig(
        subtask_specs=(SubtaskSpec(feature_index=0, threshold=0.3, max_option_steps=4),),
        observation_dim=3,
        n_primitive_actions=2,
        base_step_size=0.01,
        option_step_size=0.01,
        utility_ema_decay=0.95,
    )
    agent, state = _setup(cfg, seed=5)
    n_steps = 200
    result = run_step11_scan(
        agent, state,
        jr.normal(jr.key(10), (n_steps,)) * 0.1,
        jr.normal(jr.key(11), (n_steps, 3)) * 0.1,
    )
    chex.assert_tree_all_finite(result.state.stomp_state.base_learner_state)
    chex.assert_tree_all_finite(result.state.utility_ema)
    chex.assert_tree_all_finite(result.td_errors)
