"""Tests for Horde-backed actor-critic integration."""

import chex
import jax
import jax.numpy as jnp
import jax.random as jr
import numpy as np
import pytest

from alberta_framework import HordeActorCriticAgent as TopLevelHordeActorCriticAgent
from alberta_framework.core import HordeActorCriticAgent as CoreHordeActorCriticAgent
from alberta_framework.core.horde import HordeLearner
from alberta_framework.core.horde_actor_critic import (
    HordeActorCriticAgent,
    HordeActorCriticConfig,
    QHordeActorCriticAgent,
    QHordeActorCriticConfig,
    QHordeActorCriticState,
    run_horde_actor_critic_from_arrays,
)
from alberta_framework.core.optimizers import Autostep, ObGDBounding
from alberta_framework.core.types import (
    DemonType,
    GVFSpec,
    create_horde_spec,
)


def _make_agent(n_demons: int = 1) -> HordeActorCriticAgent:
    demons = [
        GVFSpec(  # type: ignore[call-arg]
            name="value",
            demon_type=DemonType.PREDICTION,
            gamma=0.9,
            lamda=0.8,
            cumulant_index=-1,
        )
    ]
    for idx in range(1, n_demons):
        demons.append(
            GVFSpec(  # type: ignore[call-arg]
                name=f"aux_{idx}",
                demon_type=DemonType.PREDICTION,
                gamma=0.0,
                lamda=0.0,
                cumulant_index=-1,
            )
        )
    critic = HordeLearner(
        create_horde_spec(demons),
        hidden_sizes=(),
        step_size=0.1,
        use_layer_norm=False,
    )
    return HordeActorCriticAgent(
        HordeActorCriticConfig(
            n_actions=2,
            actor_step_size=0.05,
            actor_lamda=0.7,
        ),
        critic=critic,
    )


def _make_qhorde_agent(n_actions: int = 2, n_aux: int = 0) -> QHordeActorCriticAgent:
    demons = [
        GVFSpec(  # type: ignore[call-arg]
            name=f"q_{idx}",
            demon_type=DemonType.CONTROL,
            gamma=0.0,
            lamda=0.0,
            cumulant_index=-1,
        )
        for idx in range(n_actions)
    ]
    demons.extend(
        GVFSpec(  # type: ignore[call-arg]
            name=f"aux_{idx}",
            demon_type=DemonType.PREDICTION,
            gamma=0.5,
            lamda=0.0,
            cumulant_index=0,
        )
        for idx in range(n_aux)
    )
    critic = HordeLearner(
        create_horde_spec(demons),
        hidden_sizes=(),
        step_size=0.1,
        use_layer_norm=False,
    )
    return QHordeActorCriticAgent(
        QHordeActorCriticConfig(
            n_actions=n_actions,
            gamma=0.9,
            actor_step_size=0.05,
            actor_lamda=0.7,
        ),
        critic=critic,
    )


def test_horde_actor_critic_value_head_updates_actor_and_critic() -> None:
    agent = _make_agent()
    state = agent.init(feature_dim=2, key=jr.key(0)).replace(  # type: ignore[attr-defined]
        last_observation=jnp.array([1.0, 0.0], dtype=jnp.float32),
        last_action=jnp.array(0, dtype=jnp.int32),
    )

    result = agent.update(
        state,
        reward=jnp.array(1.0, dtype=jnp.float32),
        observation=jnp.array([0.0, 1.0], dtype=jnp.float32),
    )

    assert int(result.state.step_count) == 1
    chex.assert_trees_all_close(result.td_error, result.critic_result.td_errors[0])
    assert not jnp.allclose(result.state.actor_weights, state.actor_weights)
    assert not jnp.allclose(
        agent.critic.predict(result.state.critic_state, state.last_observation)[0],
        agent.critic.predict(state.critic_state, state.last_observation)[0],
    )
    chex.assert_tree_all_finite(
        (
            result.state.actor_weights,
            result.state.actor_bias,
            result.value,
            result.next_value,
            result.td_error,
        )
    )


def test_horde_actor_critic_auxiliary_prediction_demon_updates() -> None:
    agent = _make_agent(n_demons=2)
    state = agent.init(feature_dim=2, key=jr.key(1)).replace(  # type: ignore[attr-defined]
        last_observation=jnp.array([0.5, -1.0], dtype=jnp.float32),
        last_action=jnp.array(1, dtype=jnp.int32),
    )

    result = agent.update(
        state,
        reward=jnp.array(0.25, dtype=jnp.float32),
        observation=jnp.array([1.0, 0.0], dtype=jnp.float32),
        auxiliary_cumulants=jnp.array([2.0], dtype=jnp.float32),
    )

    chex.assert_shape(result.critic_result.td_errors, (2,))
    chex.assert_trees_all_close(
        result.critic_result.td_targets[1],
        jnp.array(2.0, dtype=jnp.float32),
    )
    assert not jnp.allclose(
        agent.critic.predict(result.state.critic_state, state.last_observation)[1],
        agent.critic.predict(state.critic_state, state.last_observation)[1],
    )


def test_horde_actor_critic_config_roundtrip_and_exports() -> None:
    base_agent = _make_agent(n_demons=2)
    agent = HordeActorCriticAgent(
        HordeActorCriticConfig.from_config(
            {
                **base_agent.config.to_config(),
                "actor_td_error_clip": 0.75,
            }
        ),
        base_agent.critic,
        actor_bounder=ObGDBounding(kappa=1.5),
    )

    reconstructed = HordeActorCriticAgent.from_config(agent.to_config())

    assert reconstructed.config == agent.config
    assert reconstructed.config.actor_td_error_clip == 0.75
    assert reconstructed.critic.n_demons == 2
    assert isinstance(reconstructed.actor_bounder, ObGDBounding)
    assert TopLevelHordeActorCriticAgent is HordeActorCriticAgent
    assert CoreHordeActorCriticAgent is HordeActorCriticAgent


def test_horde_actor_critic_update_is_jittable() -> None:
    agent = _make_agent(n_demons=2)
    state = agent.init(feature_dim=2, key=jr.key(2)).replace(  # type: ignore[attr-defined]
        last_observation=jnp.array([1.0, 0.0], dtype=jnp.float32),
        last_action=jnp.array(0, dtype=jnp.int32),
    )

    update = jax.jit(agent.update)
    result = update(
        state,
        jnp.array(1.0, dtype=jnp.float32),
        jnp.array([0.0, 1.0], dtype=jnp.float32),
        jnp.array([0.5], dtype=jnp.float32),
    )

    chex.assert_shape(result.policy, (2,))
    chex.assert_shape(result.critic_result.td_errors, (2,))
    assert int(result.state.step_count) == 1


def test_run_horde_actor_critic_from_arrays_scan() -> None:
    agent = _make_agent(n_demons=2)
    state = agent.init(feature_dim=2, key=jr.key(3))
    observations = jnp.array(
        [[1.0, 0.0], [0.0, 1.0], [1.0, 1.0]], dtype=jnp.float32
    )
    next_observations = jnp.array(
        [[0.0, 1.0], [1.0, 1.0], [0.5, -0.5]], dtype=jnp.float32
    )
    rewards = jnp.array([1.0, 0.0, -1.0], dtype=jnp.float32)
    aux = jnp.array([[0.5], [1.0], [-0.5]], dtype=jnp.float32)
    actions = jnp.array([0, 1, 0], dtype=jnp.int32)

    result = run_horde_actor_critic_from_arrays(
        agent,
        state,
        observations,
        rewards,
        next_observations,
        actions=actions,
        auxiliary_cumulants=aux,
    )

    chex.assert_shape(result.actions, (3,))
    chex.assert_shape(result.policies, (3, 2))
    chex.assert_shape(result.values, (3,))
    chex.assert_shape(result.td_errors, (3,))
    chex.assert_shape(result.critic_td_errors, (3, 2))
    assert int(result.state.step_count) == 3
    chex.assert_tree_all_finite((result.policies, result.values, result.td_errors))


def test_horde_actor_critic_explicit_discount_controls_value_target() -> None:
    agent = _make_agent(n_demons=1)
    state = agent.init(feature_dim=2, key=jr.key(4)).replace(  # type: ignore[attr-defined]
        last_observation=jnp.array([1.0, 0.0], dtype=jnp.float32),
        last_action=jnp.array(0, dtype=jnp.int32),
    )
    # Make the next-state value non-zero so the explicit discount changes the
    # Horde target.
    head_weights = state.critic_state.head_params.weights
    critic_state = state.critic_state.replace(  # type: ignore[attr-defined]
        head_params=state.critic_state.head_params.replace(  # type: ignore[attr-defined]
            weights=(head_weights[0].at[0, 1].set(2.0), *head_weights[1:])
        )
    )
    state = state.replace(critic_state=critic_state)  # type: ignore[attr-defined]

    result = agent.update(
        state,
        reward=jnp.array(1.0, dtype=jnp.float32),
        observation=jnp.array([0.0, 1.0], dtype=jnp.float32),
        discount=jnp.array(0.0, dtype=jnp.float32),
    )

    chex.assert_trees_all_close(
        result.critic_result.td_targets[0],
        jnp.array(1.0, dtype=jnp.float32),
    )
    chex.assert_trees_all_close(result.state.actor_trace_weights, jnp.zeros((2, 2)))


def test_horde_actor_critic_actor_bounder_hook_runs() -> None:
    base_agent = _make_agent(n_demons=1)
    agent = HordeActorCriticAgent(
        base_agent.config,
        base_agent.critic,
        actor_bounder=ObGDBounding(kappa=10.0),
    )
    state = agent.init(feature_dim=2, key=jr.key(5)).replace(  # type: ignore[attr-defined]
        last_observation=jnp.array([10.0, 0.0], dtype=jnp.float32),
        last_action=jnp.array(0, dtype=jnp.int32),
    )

    result = agent.update(
        state,
        reward=jnp.array(10.0, dtype=jnp.float32),
        observation=jnp.array([0.0, 1.0], dtype=jnp.float32),
    )

    assert float(result.bound_metric) < 1.0
    chex.assert_tree_all_finite((result.state.actor_weights, result.bound_metric))


def test_bsuite_horde_ac_pairwise_feature_lift_values() -> None:
    """The adapter's pairwise lift should expose relational actor features."""
    pytest.importorskip("dm_env", reason="dm_env not installed")
    pytest.importorskip("bsuite", reason="bsuite not installed")
    from benchmarks.bsuite.agents.horde_actor_critic import _FeatureLift

    lift = _FeatureLift(raw_dim=3, mode="pairwise")
    features = lift.transform(jnp.array([1.0, 2.0, 3.0], dtype=jnp.float32))

    chex.assert_shape(features, (9,))
    chex.assert_trees_all_close(
        features,
        jnp.array([1.0, 2.0, 3.0, 1.0, 2.0, 3.0, 4.0, 6.0, 9.0]),
    )


def test_bsuite_horde_ac_pairwise_feature_dim_reaches_actor() -> None:
    """Pairwise lift should initialize the core actor on the lifted feature dim."""
    dm_env = pytest.importorskip("dm_env", reason="dm_env not installed")
    pytest.importorskip("bsuite", reason="bsuite not installed")
    from dm_env import specs

    from benchmarks.bsuite.agents import horde_actor_critic

    obs_spec = specs.Array(shape=(4,), dtype=np.float32, name="obs")
    action_spec = specs.DiscreteArray(num_values=3, name="action")
    agent = horde_actor_critic.default_agent(
        obs_spec,
        action_spec,
        hidden_sizes=(8,),
        feature_lift="pairwise",
        max_feature_dim=64,
    )

    assert agent.feature_lift_mode == "pairwise"
    assert agent.state.actor_weights.shape == (3, 14)
    action = agent.select_action(dm_env.restart(jnp.ones((4,), dtype=jnp.float32)))
    assert 0 <= action < 3


def test_bsuite_qhorde_ac_pairwise_feature_dim_reaches_actor() -> None:
    """Q-Horde adapter should initialize core actor on lifted features."""
    dm_env = pytest.importorskip("dm_env", reason="dm_env not installed")
    pytest.importorskip("bsuite", reason="bsuite not installed")
    from dm_env import specs

    from benchmarks.bsuite.agents import qhorde_ac

    obs_spec = specs.Array(shape=(4,), dtype=np.float32, name="obs")
    action_spec = specs.DiscreteArray(num_values=3, name="action")
    agent = qhorde_ac.default_agent(
        obs_spec,
        action_spec,
        hidden_sizes=(8,),
        feature_lift="pairwise",
        max_feature_dim=64,
    )

    assert agent.feature_lift_mode == "pairwise"
    assert agent.state.actor_weights.shape == (3, 14)
    action = agent.select_action(dm_env.restart(jnp.ones((4,), dtype=jnp.float32)))
    assert 0 <= action < 3


def test_qhorde_actor_critic_updates_only_taken_q_head_and_actor() -> None:
    agent = _make_qhorde_agent(n_actions=2)
    state = agent.init(feature_dim=2, key=jr.key(10)).replace(  # type: ignore[attr-defined]
        last_observation=jnp.array([1.0, 0.0], dtype=jnp.float32),
        last_action=jnp.array(1, dtype=jnp.int32),
    )

    result = agent.update(
        state,
        reward=jnp.array(1.0, dtype=jnp.float32),
        observation=jnp.array([0.0, 1.0], dtype=jnp.float32),
        terminated=jnp.array(0.0, dtype=jnp.float32),
    )

    assert isinstance(result.state, QHordeActorCriticState)
    assert int(result.state.step_count) == 1
    chex.assert_trees_all_close(result.critic_result.td_targets[1], result.target)
    assert jnp.isnan(result.critic_result.td_targets[0])
    assert not jnp.allclose(result.state.actor_weights, state.actor_weights)
    chex.assert_tree_all_finite(
        (result.policy, result.q_values, result.next_q_values, result.td_error)
    )


def test_qhorde_actor_critic_auxiliary_prediction_and_terminal_trace_reset() -> None:
    agent = _make_qhorde_agent(n_actions=2, n_aux=1)
    state = agent.init(feature_dim=2, key=jr.key(11)).replace(  # type: ignore[attr-defined]
        last_observation=jnp.array([1.0, 0.0], dtype=jnp.float32),
        last_action=jnp.array(0, dtype=jnp.int32),
    )

    result = agent.update(
        state,
        reward=jnp.array(1.0, dtype=jnp.float32),
        observation=jnp.array([0.0, 1.0], dtype=jnp.float32),
        terminated=jnp.array(1.0, dtype=jnp.float32),
        prediction_cumulants=jnp.array([0.25], dtype=jnp.float32),
    )

    chex.assert_shape(result.critic_result.td_errors, (3,))
    chex.assert_trees_all_close(
        result.critic_result.td_targets[2],
        jnp.array(0.25, dtype=jnp.float32),
    )
    chex.assert_trees_all_close(result.state.actor_trace_weights, jnp.zeros((2, 2)))


def test_qhorde_actor_critic_config_roundtrip_and_exports() -> None:
    base_agent = _make_qhorde_agent(n_actions=2, n_aux=1)
    agent = QHordeActorCriticAgent(
        QHordeActorCriticConfig.from_config(
            {
                **base_agent.config.to_config(),
                "actor_td_error_clip": 0.5,
            }
        ),
        base_agent.critic,
        actor_bounder=ObGDBounding(kappa=1.25),
    )

    restored = QHordeActorCriticAgent.from_config(agent.to_config())

    assert restored.config == agent.config
    assert restored.critic.n_demons == 3
    assert isinstance(restored.actor_bounder, ObGDBounding)
    from alberta_framework import QHordeActorCriticAgent as TopLevelQHordeAC
    from alberta_framework.core import QHordeActorCriticAgent as CoreQHordeAC

    assert TopLevelQHordeAC is QHordeActorCriticAgent
    assert CoreQHordeAC is QHordeActorCriticAgent


def test_qhorde_actor_critic_update_is_jittable() -> None:
    agent = _make_qhorde_agent(n_actions=2, n_aux=1)
    state = agent.init(feature_dim=2, key=jr.key(12)).replace(  # type: ignore[attr-defined]
        last_observation=jnp.array([1.0, 0.0], dtype=jnp.float32),
        last_action=jnp.array(0, dtype=jnp.int32),
    )

    update = jax.jit(agent.update)
    result = update(
        state,
        jnp.array(1.0, dtype=jnp.float32),
        jnp.array([0.0, 1.0], dtype=jnp.float32),
        jnp.array(0.0, dtype=jnp.float32),
        jnp.array([0.5], dtype=jnp.float32),
    )

    chex.assert_shape(result.policy, (2,))
    assert int(result.state.step_count) == 1


def test_qhorde_actor_critic_sampled_target_uses_returned_action() -> None:
    base_agent = _make_qhorde_agent(n_actions=2)
    agent = QHordeActorCriticAgent(
        QHordeActorCriticConfig.from_config(
            {
                **base_agent.config.to_config(),
                "critic_target": "sampled_sarsa",
            }
        ),
        base_agent.critic,
    )
    state = agent.init(feature_dim=2, key=jr.key(13)).replace(  # type: ignore[attr-defined]
        last_observation=jnp.array([1.0, 0.0], dtype=jnp.float32),
        last_action=jnp.array(0, dtype=jnp.int32),
    )
    head_weights = state.critic_state.head_params.weights
    critic_state = state.critic_state.replace(  # type: ignore[attr-defined]
        head_params=state.critic_state.head_params.replace(  # type: ignore[attr-defined]
            weights=(head_weights[0].at[0, 1].set(2.0), *head_weights[1:])
        )
    )
    state = state.replace(critic_state=critic_state)  # type: ignore[attr-defined]

    result = agent.update(
        state,
        reward=jnp.array(1.0, dtype=jnp.float32),
        observation=jnp.array([0.0, 1.0], dtype=jnp.float32),
        terminated=jnp.array(0.0, dtype=jnp.float32),
    )

    expected = 1.0 + 0.9 * result.next_q_values[result.action]
    chex.assert_trees_all_close(result.target, expected)


def test_qhorde_actor_critic_expected_advantage_actor_update() -> None:
    base_agent = _make_qhorde_agent(n_actions=2)
    agent = QHordeActorCriticAgent(
        QHordeActorCriticConfig.from_config(
            {
                **base_agent.config.to_config(),
                "actor_update": "expected_advantage",
            }
        ),
        base_agent.critic,
    )
    state = agent.init(feature_dim=2, key=jr.key(14)).replace(  # type: ignore[attr-defined]
        last_observation=jnp.array([1.0, 0.0], dtype=jnp.float32),
        last_action=jnp.array(0, dtype=jnp.int32),
    )
    head_weights = state.critic_state.head_params.weights
    critic_state = state.critic_state.replace(  # type: ignore[attr-defined]
        head_params=state.critic_state.head_params.replace(  # type: ignore[attr-defined]
            weights=(
                head_weights[0],
                head_weights[1].at[0, 0].set(2.0),
                *head_weights[2:],
            )
        )
    )
    state = state.replace(critic_state=critic_state)  # type: ignore[attr-defined]

    result = agent.update(
        state,
        reward=jnp.array(0.0, dtype=jnp.float32),
        observation=jnp.array([0.0, 1.0], dtype=jnp.float32),
        terminated=jnp.array(0.0, dtype=jnp.float32),
    )

    assert result.state.actor_weights[1, 0] > state.actor_weights[1, 0]
    assert result.state.actor_weights[0, 0] < state.actor_weights[0, 0]


# ===========================================================================
# NonlinearHordeActorCriticAgent tests
# ===========================================================================


from alberta_framework.core.horde_actor_critic import (  # noqa: E402
    NonlinearHordeActorCriticAgent,
    NonlinearHordeActorCriticConfig,
    NonlinearHordeActorCriticState,
    NonlinearQHordeActorCriticAgent,
    NonlinearQHordeActorCriticConfig,
    run_nonlinear_horde_actor_critic_from_arrays,
)

OBS_DIM = 8
N_ACTIONS = 3


def _make_nlhac_agent(
    hidden_sizes: tuple[int, ...] = (32,),
    n_aux: int = 0,
) -> NonlinearHordeActorCriticAgent:
    demons: list[GVFSpec] = [
        GVFSpec(  # type: ignore[call-arg]
            name="value",
            demon_type=DemonType.PREDICTION,
            gamma=0.99,
            lamda=0.0,
            cumulant_index=0,
        )
    ]
    for i in range(n_aux):
        demons.append(
            GVFSpec(  # type: ignore[call-arg]
                name=f"aux_{i}",
                demon_type=DemonType.PREDICTION,
                gamma=float(0.5 + i * 0.1),
                lamda=0.0,
                cumulant_index=0,
            )
        )
    critic = HordeLearner(
        create_horde_spec(demons),
        hidden_sizes=(32,),
        step_size=0.03,
    )
    cfg = NonlinearHordeActorCriticConfig(
        n_actions=N_ACTIONS,
        hidden_sizes=hidden_sizes,
        temperature=0.5,
        actor_lamda=0.9,
    )
    return NonlinearHordeActorCriticAgent(cfg, critic)


def _init_nlhac(
    agent: NonlinearHordeActorCriticAgent,
) -> NonlinearHordeActorCriticState:
    state = agent.init(feature_dim=OBS_DIM, key=jr.key(0))
    state, _, _ = agent.start(state, jnp.zeros(OBS_DIM))
    return state


class TestNonlinearHordeActorCriticConfig:
    def _simple_critic(self) -> HordeLearner:
        spec = create_horde_spec(
            [GVFSpec(  # type: ignore[call-arg]
                name="v", demon_type=DemonType.PREDICTION,
                gamma=0.9, lamda=0.0, cumulant_index=0,
            )]
        )
        return HordeLearner(spec, hidden_sizes=(16,))

    def test_n_actions_positive(self) -> None:
        with pytest.raises(ValueError, match="n_actions"):
            agent = NonlinearHordeActorCriticAgent(
                NonlinearHordeActorCriticConfig(n_actions=0, hidden_sizes=(16,)),
                self._simple_critic(),
            )
            del agent

    def test_temperature_positive(self) -> None:
        with pytest.raises(ValueError, match="temperature"):
            critic = self._simple_critic()
            critic = HordeLearner(
                create_horde_spec(
                    [GVFSpec(  # type: ignore[call-arg]
                        name="v", demon_type=DemonType.PREDICTION,
                        gamma=0.9, lamda=0.0, cumulant_index=0,
                    )]
                ),
                hidden_sizes=(16,),
            )
            NonlinearHordeActorCriticAgent(
                NonlinearHordeActorCriticConfig(
                    n_actions=2, hidden_sizes=(16,), temperature=0.0
                ),
                critic,
            )

    def test_actor_gradient_clip_norm_positive(self) -> None:
        with pytest.raises(ValueError, match="actor_gradient_clip_norm"):
            NonlinearHordeActorCriticAgent(
                NonlinearHordeActorCriticConfig(
                    n_actions=2,
                    hidden_sizes=(16,),
                    actor_gradient_clip_norm=0.0,
                ),
                self._simple_critic(),
            )

    def test_actor_epsilon_bounds(self) -> None:
        with pytest.raises(ValueError, match="actor_epsilon"):
            NonlinearHordeActorCriticAgent(
                NonlinearHordeActorCriticConfig(
                    n_actions=2,
                    hidden_sizes=(16,),
                    actor_epsilon=1.0,
                ),
                self._simple_critic(),
            )

    def test_actor_td_error_normalizer_decay_bounds(self) -> None:
        with pytest.raises(ValueError, match="actor_td_error_normalizer_decay"):
            NonlinearHordeActorCriticAgent(
                NonlinearHordeActorCriticConfig(
                    n_actions=2,
                    hidden_sizes=(16,),
                    actor_td_error_normalizer_decay=1.0,
                ),
                self._simple_critic(),
            )

    def test_config_roundtrip(self) -> None:
        cfg = NonlinearHordeActorCriticConfig(
            n_actions=4,
            hidden_sizes=(64, 32),
            temperature=0.3,
            actor_gradient_clip_norm=0.25,
            actor_epsilon=0.05,
            actor_td_error_normalizer_decay=0.99,
        )
        restored = NonlinearHordeActorCriticConfig.from_config(cfg.to_config())
        assert restored.n_actions == 4
        assert restored.hidden_sizes == (64, 32)
        assert restored.temperature == pytest.approx(0.3)
        assert restored.actor_gradient_clip_norm == pytest.approx(0.25)
        assert restored.actor_epsilon == pytest.approx(0.05)
        assert restored.actor_td_error_normalizer_decay == pytest.approx(0.99)


class TestNonlinearHordeActorCriticInit:
    def test_actor_head_shape(self) -> None:
        agent = _make_nlhac_agent(hidden_sizes=(32,))
        state = agent.init(OBS_DIM, jr.key(0))
        chex.assert_shape(state.actor_head_w, (N_ACTIONS, 32))
        chex.assert_shape(state.actor_head_b, (N_ACTIONS,))

    def test_actor_trunk_shape(self) -> None:
        agent = _make_nlhac_agent(hidden_sizes=(64, 32))
        state = agent.init(OBS_DIM, jr.key(0))
        assert len(state.actor_trunk.weights) == 2
        chex.assert_shape(state.actor_trunk.weights[0], (64, OBS_DIM))
        chex.assert_shape(state.actor_trunk.weights[1], (32, 64))

    def test_traces_zero_at_init(self) -> None:
        agent = _make_nlhac_agent(hidden_sizes=(32,))
        state = agent.init(OBS_DIM, jr.key(0))
        chex.assert_trees_all_close(
            state.actor_head_trace_w, jnp.zeros((N_ACTIONS, 32))
        )

    def test_linear_actor_no_trunk(self) -> None:
        agent = _make_nlhac_agent(hidden_sizes=())
        state = agent.init(OBS_DIM, jr.key(0))
        assert len(state.actor_trunk.weights) == 0
        chex.assert_shape(state.actor_head_w, (N_ACTIONS, OBS_DIM))


class TestNonlinearHordeActorCriticUpdate:
    def test_returns_result(self) -> None:
        agent = _make_nlhac_agent()
        state = _init_nlhac(agent)
        result = agent.update(state, jnp.array(1.0), jnp.ones(OBS_DIM))
        assert isinstance(result.state, NonlinearHordeActorCriticState)

    def test_step_count_increments(self) -> None:
        agent = _make_nlhac_agent()
        state = _init_nlhac(agent)
        result = agent.update(state, jnp.array(0.0), jnp.zeros(OBS_DIM))
        assert int(result.state.step_count) == 1

    def test_td_error_finite(self) -> None:
        agent = _make_nlhac_agent()
        state = _init_nlhac(agent)
        result = agent.update(state, jnp.array(1.0), jnp.ones(OBS_DIM))
        assert jnp.isfinite(result.td_error)

    def test_actor_td_error_normalizer_updates(self) -> None:
        critic = HordeLearner(
            create_horde_spec(
                [GVFSpec(  # type: ignore[call-arg]
                    name="v", demon_type=DemonType.PREDICTION,
                    gamma=0.99, lamda=0.0, cumulant_index=0,
                )]
            ),
            hidden_sizes=(32,),
            step_size=0.03,
        )
        cfg = NonlinearHordeActorCriticConfig(
            n_actions=N_ACTIONS,
            hidden_sizes=(32,),
            actor_td_error_normalizer_decay=0.9,
        )
        agent = NonlinearHordeActorCriticAgent(cfg, critic)
        state = agent.init(OBS_DIM, jr.key(3))
        obs = jr.normal(jr.key(4), (OBS_DIM,))
        state, _, _ = agent.start(state, obs)
        result = agent.update(state, jnp.array(1.0), obs)
        assert float(result.state.actor_td_error_normalizer) > 0.0

    def test_policy_sums_to_one(self) -> None:
        agent = _make_nlhac_agent()
        state = _init_nlhac(agent)
        result = agent.update(state, jnp.array(0.0), jnp.zeros(OBS_DIM))
        chex.assert_trees_all_close(
            jnp.sum(result.policy), jnp.array(1.0), atol=1e-5
        )

    def test_actor_weights_update(self) -> None:
        critic = HordeLearner(
            create_horde_spec(
                [GVFSpec(  # type: ignore[call-arg]
                    name="v", demon_type=DemonType.PREDICTION,
                    gamma=0.99, lamda=0.0, cumulant_index=0,
                )]
            ),
            hidden_sizes=(32,),
            step_size=0.03,
        )
        cfg = NonlinearHordeActorCriticConfig(n_actions=N_ACTIONS, hidden_sizes=(32,))
        agent = NonlinearHordeActorCriticAgent(
            cfg, critic, actor_optimizer=Autostep(initial_step_size=1.0)
        )
        state = agent.init(OBS_DIM, jr.key(0))
        obs = jr.normal(jr.key(42), (OBS_DIM,))
        state, _, _ = agent.start(state, obs)
        before = state.actor_head_w.copy()
        result = agent.update(state, jnp.array(1.0), obs)
        after = result.state.actor_head_w
        assert not jnp.allclose(before, after, atol=1e-6)

    def test_actor_gradient_clip_limits_new_trace_norm(self) -> None:
        critic = HordeLearner(
            create_horde_spec(
                [GVFSpec(  # type: ignore[call-arg]
                    name="v", demon_type=DemonType.PREDICTION,
                    gamma=0.99, lamda=0.0, cumulant_index=0,
                )]
            ),
            hidden_sizes=(32,),
            step_size=0.03,
        )
        cfg = NonlinearHordeActorCriticConfig(
            n_actions=N_ACTIONS,
            hidden_sizes=(32,),
            actor_gradient_clip_norm=0.05,
        )
        agent = NonlinearHordeActorCriticAgent(
            cfg, critic, actor_optimizer=Autostep(initial_step_size=0.01)
        )
        state = agent.init(OBS_DIM, jr.key(9))
        obs = 100.0 * jr.normal(jr.key(10), (OBS_DIM,))
        state, _, _ = agent.start(state, obs)
        result = agent.update(state, jnp.array(1.0), obs)
        trace_norm = jnp.sqrt(
            jnp.sum(jnp.square(result.state.actor_head_trace_w))
            + jnp.sum(jnp.square(result.state.actor_head_trace_b))
            + sum(
                jnp.sum(jnp.square(trace))
                for trace in result.state.actor_trunk_traces
            )
        )
        assert float(trace_norm) <= 0.0501

    def test_trunk_weights_update(self) -> None:
        critic = HordeLearner(
            create_horde_spec(
                [GVFSpec(  # type: ignore[call-arg]
                    name="v", demon_type=DemonType.PREDICTION,
                    gamma=0.99, lamda=0.0, cumulant_index=0,
                )]
            ),
            hidden_sizes=(32,),
            step_size=0.03,
        )
        cfg = NonlinearHordeActorCriticConfig(n_actions=N_ACTIONS, hidden_sizes=(32,))
        agent = NonlinearHordeActorCriticAgent(
            cfg, critic, actor_optimizer=Autostep(initial_step_size=1.0)
        )
        state = agent.init(OBS_DIM, jr.key(7))
        obs = jr.normal(jr.key(7), (OBS_DIM,))
        state, _, _ = agent.start(state, obs)
        before = state.actor_trunk.weights[0].copy()
        result = agent.update(state, jnp.array(1.0), obs)
        after = result.state.actor_trunk.weights[0]
        assert not jnp.allclose(before, after, atol=1e-6)

    def test_jittable(self) -> None:
        agent = _make_nlhac_agent()
        state = _init_nlhac(agent)
        f = jax.jit(agent.update)
        result = f(state, jnp.array(1.0), jnp.ones(OBS_DIM))
        assert jnp.isfinite(result.td_error)


class TestNonlinearHordeActorCriticScan:
    def test_scan_shapes(self) -> None:
        agent = _make_nlhac_agent()
        state = _init_nlhac(agent)
        n_steps = 15
        obs = jnp.zeros((n_steps, OBS_DIM))
        rews = jnp.ones(n_steps)
        result = run_nonlinear_horde_actor_critic_from_arrays(
            agent, state, obs, rews, obs
        )
        chex.assert_shape(result.actions, (n_steps,))
        chex.assert_shape(result.values, (n_steps,))
        chex.assert_shape(result.td_errors, (n_steps,))
        chex.assert_shape(result.policies, (n_steps, N_ACTIONS))

    def test_scan_td_errors_finite(self) -> None:
        agent = _make_nlhac_agent()
        state = _init_nlhac(agent)
        n_steps = 20
        obs = jr.normal(jr.key(5), (n_steps, OBS_DIM))
        rews = jr.normal(jr.key(6), (n_steps,))
        result = run_nonlinear_horde_actor_critic_from_arrays(
            agent, state, obs, rews, obs
        )
        chex.assert_tree_all_finite(result.td_errors)

    def test_scan_step_count_final(self) -> None:
        agent = _make_nlhac_agent()
        state = _init_nlhac(agent)
        n_steps = 10
        obs = jnp.zeros((n_steps, OBS_DIM))
        result = run_nonlinear_horde_actor_critic_from_arrays(
            agent, state, obs, jnp.zeros(n_steps), obs
        )
        assert int(result.state.step_count) == n_steps

    def test_200_step_fineness(self) -> None:
        agent = _make_nlhac_agent(hidden_sizes=(32,))
        state = _init_nlhac(agent)
        n_steps = 200
        obs = jr.normal(jr.key(99), (n_steps, OBS_DIM))
        rews = jr.normal(jr.key(100), (n_steps,))
        result = run_nonlinear_horde_actor_critic_from_arrays(
            agent, state, obs, rews, obs
        )
        chex.assert_tree_all_finite(result.td_errors)
        assert int(result.state.step_count) == n_steps

    def test_auxiliary_demons_work(self) -> None:
        agent = _make_nlhac_agent(n_aux=2)
        state = _init_nlhac(agent)
        n_steps = 10
        obs = jnp.zeros((n_steps, OBS_DIM))
        aux = jnp.ones((n_steps, 2))
        result = run_nonlinear_horde_actor_critic_from_arrays(
            agent, state, obs, jnp.ones(n_steps), obs, auxiliary_cumulants=aux
        )
        chex.assert_shape(result.critic_td_errors, (n_steps, 3))


class TestNonlinearHordeActorCriticExport:
    def test_exported_from_core(self) -> None:
        from alberta_framework.core import NonlinearHordeActorCriticAgent as Cls

        assert Cls is NonlinearHordeActorCriticAgent

    def test_to_config_roundtrip(self) -> None:
        agent = _make_nlhac_agent()
        cfg = agent.to_config()
        restored = NonlinearHordeActorCriticAgent.from_config(cfg)
        assert restored.config.n_actions == agent.config.n_actions
        assert restored.config.hidden_sizes == agent.config.hidden_sizes


class TestNonlinearQHordeActorCritic:
    def _agent(self) -> NonlinearQHordeActorCriticAgent:
        demons = [
            GVFSpec(  # type: ignore[call-arg]
                name=f"q_{action}",
                demon_type=DemonType.CONTROL,
                gamma=0.0,
                lamda=0.0,
                cumulant_index=-1,
            )
            for action in range(N_ACTIONS)
        ]
        critic = HordeLearner(
            create_horde_spec(demons),
            hidden_sizes=(16,),
            step_size=0.03,
        )
        cfg = NonlinearQHordeActorCriticConfig(
            n_actions=N_ACTIONS,
            hidden_sizes=(16,),
            actor_td_error_clip=1.0,
            actor_gradient_clip_norm=1.0,
        )
        return NonlinearQHordeActorCriticAgent(
            cfg,
            critic,
            actor_optimizer=Autostep(initial_step_size=0.01),
        )

    def test_update_returns_finite_q_values(self) -> None:
        agent = self._agent()
        state = agent.init(OBS_DIM, jr.key(11))
        obs = jr.normal(jr.key(12), (OBS_DIM,))
        state, _, _ = agent.start(state, obs)
        result = agent.update(
            state,
            jnp.array(1.0),
            jr.normal(jr.key(13), (OBS_DIM,)),
            jnp.array(0.0),
        )
        chex.assert_shape(result.q_values, (N_ACTIONS,))
        chex.assert_tree_all_finite(result.q_values)
        assert int(result.state.step_count) == 1

    def test_requires_control_heads(self) -> None:
        critic = HordeLearner(
            create_horde_spec(
                [GVFSpec(  # type: ignore[call-arg]
                    name="v",
                    demon_type=DemonType.PREDICTION,
                    gamma=0.9,
                    lamda=0.0,
                    cumulant_index=0,
                )]
            ),
            hidden_sizes=(16,),
        )
        with pytest.raises(ValueError, match="control demon"):
            NonlinearQHordeActorCriticAgent(
                NonlinearQHordeActorCriticConfig(n_actions=1),
                critic,
            )

    def test_config_roundtrip(self) -> None:
        cfg = NonlinearQHordeActorCriticConfig(
            n_actions=4,
            hidden_sizes=(32, 16),
            actor_gradient_clip_norm=0.25,
            critic_target="sampled_sarsa",
            actor_update="expected_advantage",
        )
        restored = NonlinearQHordeActorCriticConfig.from_config(cfg.to_config())
        assert restored.n_actions == 4
        assert restored.hidden_sizes == (32, 16)
        assert restored.actor_gradient_clip_norm == pytest.approx(0.25)
        assert restored.critic_target == "sampled_sarsa"
        assert restored.actor_update == "expected_advantage"

    def test_expected_advantage_actor_update_moves_toward_better_action(self) -> None:
        demons = [
            GVFSpec(  # type: ignore[call-arg]
                name=f"q_{action}",
                demon_type=DemonType.CONTROL,
                gamma=0.0,
                lamda=0.0,
                cumulant_index=-1,
            )
            for action in range(2)
        ]
        critic = HordeLearner(
            create_horde_spec(demons),
            hidden_sizes=(),
            step_size=0.03,
        )
        cfg = NonlinearQHordeActorCriticConfig(
            n_actions=2,
            hidden_sizes=(),
            actor_sparsity=0.0,
            actor_update="expected_advantage",
        )
        agent = NonlinearQHordeActorCriticAgent(
            cfg,
            critic,
            actor_optimizer=Autostep(initial_step_size=0.1),
        )
        obs = jnp.array([1.0, 0.0], dtype=jnp.float32)
        state = agent.init(2, jr.key(18)).replace(  # type: ignore[attr-defined]
            last_observation=obs,
            last_action=jnp.array(0, dtype=jnp.int32),
        )
        head_weights = state.critic_state.head_params.weights
        critic_state = state.critic_state.replace(  # type: ignore[attr-defined]
            head_params=state.critic_state.head_params.replace(  # type: ignore[attr-defined]
                weights=(
                    head_weights[0],
                    head_weights[1].at[0, 0].set(2.0),
                )
            )
        )
        state = state.replace(critic_state=critic_state)  # type: ignore[attr-defined]

        before = agent.policy(state, obs)
        result = agent.update(
            state,
            jnp.array(0.0, dtype=jnp.float32),
            obs,
            jnp.array(0.0, dtype=jnp.float32),
        )
        after = agent.policy(result.state, obs)

        assert after[1] > before[1]
        assert after[0] < before[0]
