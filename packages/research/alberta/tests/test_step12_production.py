"""Tests for the Step 12 Intelligence Amplification production facade."""

from __future__ import annotations

import chex
import jax.numpy as jnp
import jax.random as jr
import pytest

from alberta_framework.core.intelligence_amplification import (
    ExoCerebellumConfig,
    IAAgent,
    IAArrayResult,
    IAConfig,
    IAState,
    IAUpdateResult,
    RecommendationProtocolConfig,
    init_recommendation_protocol_state,
    update_recommendation_protocol,
)
from alberta_framework.core.oak import OaKConfig
from alberta_framework.core.options import STOMPConfig, SubtaskSpec
from alberta_framework.steps.step12 import (
    Step12IAConfig,
    Step12SmokeResult,
    init_step12_state,
    make_step12_ia_agent,
    run_step12_scan,
    run_step12_smoke,
    step12_update,
)

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

_SPEC0 = SubtaskSpec(feature_index=0, threshold=0.5, pseudo_reward_scale=1.0, max_option_steps=8)
_SPEC1 = SubtaskSpec(feature_index=1, threshold=0.3, pseudo_reward_scale=2.0, max_option_steps=4)


def _make_step12_cfg(
    *,
    specs: tuple[SubtaskSpec, ...] = (_SPEC0,),
    obs_dim: int = 4,
    n_prim: int = 2,
    n_demons: int = 3,
) -> Step12IAConfig:
    return Step12IAConfig(
        subtask_specs=specs,
        observation_dim=obs_dim,
        n_primitive_actions=n_prim,
        n_demons=n_demons,
    )


def _make_ia_config(
    *,
    specs: tuple[SubtaskSpec, ...] = (_SPEC0,),
    obs_dim: int = 4,
    n_prim: int = 2,
    n_demons: int = 3,
) -> IAConfig:
    cerebellum = ExoCerebellumConfig(n_demons=n_demons, obs_dim=obs_dim)
    stomp = STOMPConfig(
        subtask_specs=specs,
        observation_dim=obs_dim,
        n_primitive_actions=n_prim,
    )
    cortex = OaKConfig(stomp=stomp)
    return IAConfig(cerebellum=cerebellum, cortex=cortex)


def _setup(
    cfg: Step12IAConfig | None = None,
    *,
    seed: int = 0,
) -> tuple[IAAgent, IAState]:
    if cfg is None:
        cfg = _make_step12_cfg()
    agent = make_step12_ia_agent(cfg)
    key = jr.key(seed)
    init_obs = jnp.zeros(cfg.observation_dim, dtype=jnp.float32)
    state = init_step12_state(agent, key=key, initial_observation=init_obs)
    return agent, state


# ---------------------------------------------------------------------------
# ExoCerebellumConfig validation
# ---------------------------------------------------------------------------


def test_exo_cerebellum_config_zero_demons_raises() -> None:
    with pytest.raises(ValueError, match="n_demons"):
        ExoCerebellumConfig(n_demons=0, obs_dim=4)


def test_exo_cerebellum_config_zero_obs_dim_raises() -> None:
    with pytest.raises(ValueError, match="obs_dim"):
        ExoCerebellumConfig(n_demons=3, obs_dim=0)


def test_exo_cerebellum_config_nonpositive_step_size_raises() -> None:
    with pytest.raises(ValueError, match="step_size"):
        ExoCerebellumConfig(n_demons=3, obs_dim=4, step_size=0.0)


# ---------------------------------------------------------------------------
# IAConfig validation
# ---------------------------------------------------------------------------


def test_ia_config_obs_dim_mismatch_raises() -> None:
    cerebellum = ExoCerebellumConfig(n_demons=3, obs_dim=4)
    stomp = STOMPConfig(subtask_specs=(_SPEC0,), observation_dim=6)
    cortex = OaKConfig(stomp=stomp)
    with pytest.raises(ValueError, match="obs_dim"):
        IAConfig(cerebellum=cerebellum, cortex=cortex)


def test_ia_config_matching_dims_ok() -> None:
    cfg = _make_ia_config(obs_dim=5)
    assert cfg.cerebellum.obs_dim == cfg.cortex.observation_dim == 5


# ---------------------------------------------------------------------------
# Step12IAConfig serialization
# ---------------------------------------------------------------------------


def test_step12_config_roundtrip_default() -> None:
    cfg = _make_step12_cfg()
    assert Step12IAConfig.from_config(cfg.to_config()) == cfg


def test_step12_config_roundtrip_two_specs() -> None:
    cfg = _make_step12_cfg(specs=(_SPEC0, _SPEC1), obs_dim=4)
    assert Step12IAConfig.from_config(cfg.to_config()) == cfg


def test_step12_config_roundtrip_preserves_all_fields() -> None:
    cfg = Step12IAConfig(
        n_demons=6,
        cerebellum_step_size=0.02,
        subtask_specs=(_SPEC0,),
        observation_dim=5,
        n_primitive_actions=3,
        base_step_size=0.1,
        base_avg_reward_step_size=0.005,
        option_step_size=0.08,
        option_gamma=0.95,
        epsilon_base=0.15,
        utility_ema_decay=0.97,
    )
    restored = Step12IAConfig.from_config(cfg.to_config())
    assert restored == cfg


def test_step12_config_type_tag_stripped() -> None:
    cfg = _make_step12_cfg()
    d = cfg.to_config()
    assert d["type"] == "Step12IAConfig"
    assert Step12IAConfig.from_config(d) == cfg


def test_step12_config_to_ia_config_dims_match() -> None:
    cfg = _make_step12_cfg(obs_dim=5, n_prim=3, n_demons=4)
    ia_cfg = cfg.to_ia_config()
    assert isinstance(ia_cfg, IAConfig)
    assert ia_cfg.cerebellum.obs_dim == 5
    assert ia_cfg.cortex.observation_dim == 5
    assert ia_cfg.cortex.n_primitive_actions == 3
    assert ia_cfg.cerebellum.n_demons == 4


# ---------------------------------------------------------------------------
# Factory and initialization
# ---------------------------------------------------------------------------


def test_make_step12_ia_agent_default() -> None:
    agent = make_step12_ia_agent()
    assert isinstance(agent, IAAgent)
    assert agent.config.cerebellum.n_demons == 4  # default


def test_make_step12_ia_agent_custom() -> None:
    cfg = _make_step12_cfg(n_demons=6, obs_dim=5, n_prim=3)
    agent = make_step12_ia_agent(cfg)
    assert agent.config.cerebellum.n_demons == 6
    assert agent.config.cerebellum.obs_dim == 5


def test_init_step12_state_shapes() -> None:
    cfg = _make_step12_cfg(obs_dim=4, n_demons=3)
    agent, state = _setup(cfg)
    chex.assert_shape(state.cerebellum_state.weights, (3, 4))
    chex.assert_shape(state.cortex_state.utility_ema, (1,))


def test_init_step12_state_step_count_zero() -> None:
    _, state = _setup()
    assert int(state.step_count) == 0


def test_init_step12_state_two_specs() -> None:
    cfg = _make_step12_cfg(specs=(_SPEC0, _SPEC1), n_demons=2)
    agent, state = _setup(cfg)
    chex.assert_shape(state.cortex_state.utility_ema, (2,))
    chex.assert_shape(state.cerebellum_state.weights, (2, 4))


# ---------------------------------------------------------------------------
# Single-step update
# ---------------------------------------------------------------------------


def test_step12_update_returns_update_result() -> None:
    agent, state = _setup()
    obs = jnp.ones(4, dtype=jnp.float32) * 0.1
    reward = jnp.array(0.5)
    next_obs = jnp.ones(4, dtype=jnp.float32) * 0.2
    result = step12_update(agent, state, obs, reward, next_obs)
    assert isinstance(result, IAUpdateResult)


def test_step12_update_predictions_shape() -> None:
    cfg = _make_step12_cfg(n_demons=5)
    agent, state = _setup(cfg)
    obs = jnp.zeros(4, dtype=jnp.float32)
    result = step12_update(agent, state, obs, jnp.array(0.0), obs)
    chex.assert_shape(result.predictions, (5,))


def test_step12_update_recommendation_in_range() -> None:
    cfg = _make_step12_cfg(n_prim=3)
    agent, state = _setup(cfg)
    obs = jnp.zeros(4, dtype=jnp.float32)
    result = step12_update(agent, state, obs, jnp.array(0.0), obs)
    assert 0 <= int(result.recommendation) < 3


def test_step12_update_augmented_obs_shape() -> None:
    cfg = _make_step12_cfg(obs_dim=4, n_demons=3)
    agent, state = _setup(cfg)
    obs = jnp.zeros(4, dtype=jnp.float32)
    result = step12_update(agent, state, obs, jnp.array(0.0), obs)
    # augmented = concat(obs, predictions) → shape (4 + 3,)
    chex.assert_shape(result.augmented_obs, (7,))


def test_step12_update_augmented_obs_is_concat() -> None:
    cfg = _make_step12_cfg(obs_dim=4, n_demons=3)
    agent, state = _setup(cfg)
    obs = jnp.array([1.0, 2.0, 3.0, 4.0], dtype=jnp.float32)
    result = step12_update(agent, state, obs, jnp.array(0.0), obs)
    # First 4 elements should equal obs
    chex.assert_trees_all_close(result.augmented_obs[:4], obs, atol=1e-5)
    # Last 3 elements should equal predictions
    chex.assert_trees_all_close(result.augmented_obs[4:], result.predictions, atol=1e-5)


def test_step12_update_state_finite() -> None:
    agent, state = _setup()
    obs = jnp.ones(4) * 0.3
    result = step12_update(agent, state, obs, jnp.array(1.0), obs * 1.1)
    chex.assert_tree_all_finite(result.state.cerebellum_state.weights)
    chex.assert_tree_all_finite(result.state.cortex_state.stomp_state.base_learner_state)


def test_step12_update_step_count_increments() -> None:
    agent, state = _setup()
    obs = jnp.zeros(4)
    result = step12_update(agent, state, obs, jnp.array(0.0), obs)
    assert int(result.state.step_count) == 1


def test_step12_update_recommendation_is_int32() -> None:
    agent, state = _setup()
    obs = jnp.zeros(4)
    result = step12_update(agent, state, obs, jnp.array(0.0), obs)
    assert result.recommendation.dtype == jnp.int32


# ---------------------------------------------------------------------------
# Scan
# ---------------------------------------------------------------------------


def test_run_step12_scan_output_shapes() -> None:
    cfg = _make_step12_cfg(obs_dim=4, n_demons=3, n_prim=2)
    agent, state = _setup(cfg)
    n_steps = 20
    obs = jr.normal(jr.key(1), (n_steps, 4))
    rewards = jnp.zeros(n_steps)
    next_obs = jr.normal(jr.key(2), (n_steps, 4))
    result = run_step12_scan(agent, state, obs, rewards, next_obs)
    assert isinstance(result, IAArrayResult)
    chex.assert_shape(result.predictions, (n_steps, 3))
    chex.assert_shape(result.cerebellum_errors, (n_steps, 3))
    chex.assert_shape(result.recommendations, (n_steps,))
    chex.assert_shape(result.augmented_obs, (n_steps, 7))  # 4 + 3
    chex.assert_shape(result.cortex_td_errors, (n_steps,))


def test_run_step12_scan_two_specs_shapes() -> None:
    cfg = _make_step12_cfg(specs=(_SPEC0, _SPEC1), obs_dim=4, n_demons=2, n_prim=2)
    agent, state = _setup(cfg)
    n_steps = 16
    obs = jr.normal(jr.key(3), (n_steps, 4))
    result = run_step12_scan(
        agent,
        state,
        obs,
        jnp.zeros(n_steps),
        jr.normal(jr.key(4), (n_steps, 4)),
    )
    chex.assert_shape(result.predictions, (n_steps, 2))
    chex.assert_shape(result.augmented_obs, (n_steps, 6))  # 4 + 2


def test_run_step12_scan_all_finite() -> None:
    cfg = _make_step12_cfg(obs_dim=4, n_demons=3)
    agent, state = _setup(cfg, seed=7)
    n_steps = 50
    obs = jr.normal(jr.key(5), (n_steps, 4)) * 0.1
    rewards = jr.normal(jr.key(6), (n_steps,)) * 0.1
    next_obs = jr.normal(jr.key(7), (n_steps, 4)) * 0.1
    result = run_step12_scan(agent, state, obs, rewards, next_obs)
    chex.assert_tree_all_finite(result.predictions)
    chex.assert_tree_all_finite(result.cerebellum_errors)
    chex.assert_tree_all_finite(result.cortex_td_errors)
    chex.assert_tree_all_finite(result.augmented_obs)


def test_run_step12_scan_final_step_count() -> None:
    cfg = _make_step12_cfg()
    agent, state = _setup(cfg)
    n_steps = 16
    obs = jr.normal(jr.key(8), (n_steps, 4))
    result = run_step12_scan(
        agent,
        state,
        obs,
        jnp.zeros(n_steps),
        jr.normal(jr.key(9), (n_steps, 4)),
    )
    assert int(result.state.step_count) == n_steps


def test_run_step12_scan_recommendations_in_range() -> None:
    cfg = _make_step12_cfg(n_prim=3)
    agent, state = _setup(cfg)
    n_steps = 30
    obs = jr.normal(jr.key(10), (n_steps, 4))
    result = run_step12_scan(
        agent,
        state,
        obs,
        jnp.zeros(n_steps),
        jr.normal(jr.key(11), (n_steps, 4)),
    )
    assert bool(jnp.all(result.recommendations >= 0))
    assert bool(jnp.all(result.recommendations < 3))


def test_run_step12_scan_recommendations_are_int32() -> None:
    cfg = _make_step12_cfg(n_prim=2)
    agent, state = _setup(cfg)
    n_steps = 8
    obs = jr.normal(jr.key(12), (n_steps, 4))
    result = run_step12_scan(
        agent,
        state,
        obs,
        jnp.zeros(n_steps),
        jr.normal(jr.key(13), (n_steps, 4)),
    )
    assert result.recommendations.dtype == jnp.int32


# ---------------------------------------------------------------------------
# Cerebellum learns over time
# ---------------------------------------------------------------------------


def test_cerebellum_prediction_error_finite() -> None:
    cfg = _make_step12_cfg(obs_dim=4, n_demons=4)
    agent, state = _setup(cfg)
    obs = jnp.array([0.1, 0.2, 0.3, 0.4])
    result = step12_update(agent, state, obs, jnp.array(0.0), obs * 1.1)
    assert bool(jnp.all(jnp.isfinite(result.cerebellum_errors)))


def test_cerebellum_weights_change_after_update() -> None:
    cfg = _make_step12_cfg(obs_dim=4, n_demons=3, n_prim=2)
    agent, state = _setup(cfg)
    obs = jnp.array([1.0, 0.0, 0.0, 0.0])
    next_obs = jnp.array([0.0, 1.0, 0.0, 0.0])
    result = step12_update(agent, state, obs, jnp.array(0.0), next_obs)
    assert not bool(
        jnp.all(result.state.cerebellum_state.weights == state.cerebellum_state.weights)
    )


# ---------------------------------------------------------------------------
# Recommendation acceptance / rejection protocol
# ---------------------------------------------------------------------------


def test_recommendation_protocol_config_roundtrip() -> None:
    cfg = RecommendationProtocolConfig(acceptance_ema_decay=0.5)
    assert RecommendationProtocolConfig.from_config(cfg.to_config()) == cfg


def test_recommendation_protocol_invalid_decay_raises() -> None:
    with pytest.raises(ValueError, match="acceptance_ema_decay"):
        RecommendationProtocolConfig(acceptance_ema_decay=1.0)


def test_recommendation_protocol_accepts_matching_action() -> None:
    cfg = RecommendationProtocolConfig(acceptance_ema_decay=0.5)
    state = init_recommendation_protocol_state()
    result = update_recommendation_protocol(
        cfg,
        state,
        jnp.array(1, dtype=jnp.int32),
        jnp.array(1, dtype=jnp.int32),
    )
    assert bool(result.accepted)
    assert int(result.effective_action) == 1
    assert int(result.state.accepted_count) == 1
    assert int(result.state.rejected_count) == 0
    assert float(result.state.acceptance_ema) == pytest.approx(0.5)


def test_recommendation_protocol_rejects_different_action() -> None:
    cfg = RecommendationProtocolConfig(acceptance_ema_decay=0.5)
    state = init_recommendation_protocol_state()
    result = update_recommendation_protocol(
        cfg,
        state,
        jnp.array(1, dtype=jnp.int32),
        jnp.array(0, dtype=jnp.int32),
    )
    assert not bool(result.accepted)
    assert int(result.effective_action) == 0
    assert int(result.state.accepted_count) == 0
    assert int(result.state.rejected_count) == 1


# ---------------------------------------------------------------------------
# Smoke test
# ---------------------------------------------------------------------------


def test_run_step12_smoke_defaults() -> None:
    result = run_step12_smoke()
    assert isinstance(result, Step12SmokeResult)
    assert result.finite
    assert result.steps == 64
    assert result.predictions_shape == (64, 4)  # n_demons=4 default
    assert result.augmented_obs_shape == (64, 8)  # 4 obs + 4 demons


def test_run_step12_smoke_custom_config() -> None:
    cfg = Step12IAConfig(
        n_demons=3,
        subtask_specs=(_SPEC0, _SPEC1),
        observation_dim=4,
        n_primitive_actions=2,
    )
    result = run_step12_smoke(cfg, steps=32, seed=1)
    assert result.finite
    assert result.predictions_shape == (32, 3)
    assert result.augmented_obs_shape == (32, 7)  # 4 + 3


def test_run_step12_smoke_to_dict_roundtrip() -> None:
    result = run_step12_smoke(steps=8)
    d = result.to_dict()
    assert isinstance(d["agent_config"], dict)
    assert d["finite"] is True
    assert isinstance(d["predictions_shape"], list)
    assert isinstance(d["augmented_obs_shape"], list)


def test_run_step12_smoke_zero_steps_raises() -> None:
    with pytest.raises(ValueError, match="steps"):
        run_step12_smoke(steps=0)


def test_run_step12_smoke_cerebellum_errors_shape() -> None:
    result = run_step12_smoke(steps=16)
    assert result.cerebellum_errors_shape == (16, 4)


def test_run_step12_smoke_recommendations_shape() -> None:
    result = run_step12_smoke(steps=16)
    assert result.recommendations_shape == (16,)


# ---------------------------------------------------------------------------
# Long-horizon fineness
# ---------------------------------------------------------------------------


def test_step12_state_stays_finite_200_steps() -> None:
    cfg = Step12IAConfig(
        n_demons=4,
        cerebellum_step_size=0.01,
        subtask_specs=(SubtaskSpec(feature_index=0, threshold=0.3, max_option_steps=4),),
        observation_dim=4,
        n_primitive_actions=2,
        base_step_size=0.01,
        option_step_size=0.01,
        utility_ema_decay=0.95,
    )
    agent, state = _setup(cfg, seed=5)
    n_steps = 200
    obs = jr.normal(jr.key(20), (n_steps, 4)) * 0.1
    rewards = jr.normal(jr.key(21), (n_steps,)) * 0.1
    next_obs = jr.normal(jr.key(22), (n_steps, 4)) * 0.1
    result = run_step12_scan(agent, state, obs, rewards, next_obs)
    chex.assert_tree_all_finite(result.state.cerebellum_state.weights)
    chex.assert_tree_all_finite(result.state.cortex_state.stomp_state.base_learner_state)
    chex.assert_tree_all_finite(result.predictions)
    chex.assert_tree_all_finite(result.cortex_td_errors)
