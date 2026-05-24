"""Tests for the PrototypeAgent integrating all 12 Alberta Plan steps."""

from __future__ import annotations

import chex
import jax.numpy as jnp
import jax.random as jr
import pytest

from alberta_framework.core.dreaming import DreamingConfig
from alberta_framework.core.intelligence_amplification import IAConfig
from alberta_framework.core.oak import OaKConfig
from alberta_framework.core.options import STOMPConfig, SubtaskSpec
from alberta_framework.core.prototype_agent import (
    PrototypeAgent,
    PrototypeAgentConfig,
    PrototypeAgentState,
    PrototypeArrayResult,
    PrototypeUpdateResult,
    feature_to_subtask_specs,
)
from alberta_framework.core.types import DemonType, GVFSpec, create_horde_spec
from alberta_framework.core.world_model import ActionConditionedWorldModelConfig

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

_SPEC0 = SubtaskSpec(
    feature_index=0,
    threshold=0.5,
    pseudo_reward_scale=1.0,
    max_option_steps=8,
)
_SPEC1 = SubtaskSpec(
    feature_index=1,
    threshold=0.3,
    pseudo_reward_scale=2.0,
    max_option_steps=4,
)

OBS_DIM = 4
N_PRIM = 2


def _oak_cfg(
    specs: tuple[SubtaskSpec, ...] = (_SPEC0,),
    obs_dim: int = OBS_DIM,
    n_prim: int = N_PRIM,
) -> OaKConfig:
    stomp = STOMPConfig(
        subtask_specs=specs,
        observation_dim=obs_dim,
        n_primitive_actions=n_prim,
    )
    return OaKConfig(stomp=stomp)


def _wm_cfg(
    obs_dim: int = OBS_DIM,
    n_actions: int = N_PRIM,
) -> ActionConditionedWorldModelConfig:
    return ActionConditionedWorldModelConfig(
        observation_dim=obs_dim,
        n_actions=n_actions,
        hidden_sizes=(),  # linear for speed
        step_size=0.1,
        error_decay=0.99,
    )


def _minimal_config() -> PrototypeAgentConfig:
    """OaK-only, no world model, no horde, no IA."""
    return PrototypeAgentConfig(oak=_oak_cfg())


def _full_config(n_dreams: int = 2) -> PrototypeAgentConfig:
    """All components enabled."""
    horde_spec = create_horde_spec(
        [
            GVFSpec(
                name="v0.9",
                demon_type=DemonType.PREDICTION,
                cumulant_index=0,
                gamma=0.9,
                lamda=0.0,
            ),
            GVFSpec(
                name="r",
                demon_type=DemonType.PREDICTION,
                cumulant_index=0,
                gamma=0.0,
                lamda=0.0,
            ),
        ]
    )
    from alberta_framework.core.intelligence_amplification import ExoCerebellumConfig

    ia_cortex = OaKConfig(
        stomp=STOMPConfig(
            subtask_specs=(_SPEC0,),
            observation_dim=OBS_DIM,
            n_primitive_actions=N_PRIM,
        )
    )
    ia_cfg = IAConfig(
        cerebellum=ExoCerebellumConfig(n_demons=2, obs_dim=OBS_DIM, step_size=0.05),
        cortex=ia_cortex,
    )
    return PrototypeAgentConfig(
        oak=_oak_cfg(),
        world_model=_wm_cfg(),
        dreaming=DreamingConfig(warmup_steps=1, max_model_error_ema=1e6),
        buffer_capacity=20,
        n_dreams_per_step=n_dreams,
        horde_spec=horde_spec,
        horde_hidden_sizes=(),
        horde_step_size=0.1,
        ia=ia_cfg,
    )


# ---------------------------------------------------------------------------
# Config validation
# ---------------------------------------------------------------------------


class TestPrototypeAgentConfigValidation:
    def test_buffer_capacity_positive(self) -> None:
        with pytest.raises(ValueError, match="buffer_capacity"):
            PrototypeAgentConfig(oak=_oak_cfg(), buffer_capacity=0)

    def test_n_dreams_non_negative(self) -> None:
        with pytest.raises(ValueError, match="n_dreams_per_step"):
            PrototypeAgentConfig(oak=_oak_cfg(), n_dreams_per_step=-1)

    def test_dreams_require_world_model(self) -> None:
        with pytest.raises(ValueError, match="world_model"):
            PrototypeAgentConfig(oak=_oak_cfg(), n_dreams_per_step=2, world_model=None)

    def test_ia_obs_dim_must_match_oak(self) -> None:
        from alberta_framework.core.intelligence_amplification import ExoCerebellumConfig

        bad_cortex = OaKConfig(
            stomp=STOMPConfig(
                subtask_specs=(_SPEC0,),
                observation_dim=OBS_DIM + 1,  # mismatched
                n_primitive_actions=N_PRIM,
            )
        )
        ia_bad = IAConfig(
            cerebellum=ExoCerebellumConfig(n_demons=2, obs_dim=OBS_DIM + 1, step_size=0.05),
            cortex=bad_cortex,
        )
        with pytest.raises(ValueError, match="observation_dim"):
            PrototypeAgentConfig(oak=_oak_cfg(obs_dim=OBS_DIM), ia=ia_bad)

    def test_horde_step_size_positive(self) -> None:
        with pytest.raises(ValueError, match="horde_step_size"):
            PrototypeAgentConfig(oak=_oak_cfg(), horde_step_size=0.0)


# ---------------------------------------------------------------------------
# Config roundtrip
# ---------------------------------------------------------------------------


class TestPrototypeAgentConfigRoundtrip:
    def test_minimal_roundtrip(self) -> None:
        cfg = _minimal_config()
        restored = PrototypeAgentConfig.from_config(cfg.to_config())
        assert restored.oak.observation_dim == cfg.oak.observation_dim
        assert restored.world_model is None
        assert restored.horde_spec is None
        assert restored.ia is None

    def test_full_roundtrip(self) -> None:
        cfg = _full_config()
        restored = PrototypeAgentConfig.from_config(cfg.to_config())
        assert restored.oak.observation_dim == cfg.oak.observation_dim
        assert restored.world_model is not None
        assert restored.horde_spec is not None
        assert restored.ia is not None
        assert restored.n_dreams_per_step == cfg.n_dreams_per_step
        assert restored.buffer_capacity == cfg.buffer_capacity


# ---------------------------------------------------------------------------
# Init and start
# ---------------------------------------------------------------------------


class TestPrototypeAgentInit:
    def test_init_minimal_state_shapes(self) -> None:
        agent = PrototypeAgent(_minimal_config())
        state = agent.init(jr.key(0))
        assert isinstance(state, PrototypeAgentState)
        assert state.world_model_state is None
        assert state.buffer_state is None
        assert state.horde_state is None
        assert state.ia_state is None
        assert state.step_count == 0

    def test_init_oak_state_present(self) -> None:
        agent = PrototypeAgent(_minimal_config())
        state = agent.init(jr.key(0))
        n_total = N_PRIM + 1  # 1 option
        bls = state.oak_state.stomp_state.base_learner_state
        assert len(bls.head_params.weights) == n_total

    def test_init_full_state_shapes(self) -> None:
        agent = PrototypeAgent(_full_config())
        state = agent.init(jr.key(0))
        assert state.world_model_state is not None
        assert state.buffer_state is not None
        assert state.horde_state is not None
        assert state.ia_state is not None

    def test_start_primes_oak(self) -> None:
        agent = PrototypeAgent(_minimal_config())
        state = agent.init(jr.key(0))
        obs = jnp.ones(OBS_DIM)
        primed = agent.start(state, obs)
        chex.assert_trees_all_close(primed.oak_state.stomp_state.base_last_obs, obs, atol=1e-6)

    def test_start_primes_ia(self) -> None:
        agent = PrototypeAgent(_full_config())
        state = agent.init(jr.key(0))
        obs = jnp.ones(OBS_DIM)
        primed = agent.start(state, obs)
        assert primed.ia_state is not None
        chex.assert_trees_all_close(
            primed.ia_state.cortex_state.stomp_state.base_last_obs, obs, atol=1e-6
        )


# ---------------------------------------------------------------------------
# Act
# ---------------------------------------------------------------------------


class TestPrototypeAgentAct:
    def test_act_returns_valid_action(self) -> None:
        agent = PrototypeAgent(_minimal_config())
        state = agent.start(agent.init(jr.key(0)), jnp.zeros(OBS_DIM))
        obs = jnp.zeros(OBS_DIM)
        action = agent.act(state, obs)
        chex.assert_shape(action, ())
        assert int(action) < N_PRIM


# ---------------------------------------------------------------------------
# Update: minimal (OaK only)
# ---------------------------------------------------------------------------


class TestPrototypeAgentUpdateMinimal:
    @pytest.fixture
    def minimal_state(self) -> tuple[PrototypeAgent, PrototypeAgentState]:
        agent = PrototypeAgent(_minimal_config())
        state = agent.start(agent.init(jr.key(0)), jnp.zeros(OBS_DIM))
        return agent, state

    def test_update_returns_result(
        self, minimal_state: tuple[PrototypeAgent, PrototypeAgentState]
    ) -> None:
        agent, state = minimal_state
        result = agent.update(state, jnp.array(1.0), jnp.ones(OBS_DIM))
        assert isinstance(result, PrototypeUpdateResult)

    def test_update_step_count_increments(
        self, minimal_state: tuple[PrototypeAgent, PrototypeAgentState]
    ) -> None:
        agent, state = minimal_state
        result = agent.update(state, jnp.array(0.0), jnp.zeros(OBS_DIM))
        assert int(result.state.step_count) == 1

    def test_update_action_shape(
        self, minimal_state: tuple[PrototypeAgent, PrototypeAgentState]
    ) -> None:
        agent, state = minimal_state
        result = agent.update(state, jnp.array(0.0), jnp.zeros(OBS_DIM))
        chex.assert_shape(result.action, ())

    def test_update_oak_td_error_finite(
        self, minimal_state: tuple[PrototypeAgent, PrototypeAgentState]
    ) -> None:
        agent, state = minimal_state
        result = agent.update(state, jnp.array(1.0), jnp.ones(OBS_DIM))
        assert jnp.isfinite(result.oak_td_error)

    def test_update_no_world_model_fields_none(
        self, minimal_state: tuple[PrototypeAgent, PrototypeAgentState]
    ) -> None:
        agent, state = minimal_state
        result = agent.update(state, jnp.array(0.0), jnp.zeros(OBS_DIM))
        assert result.world_model_error is None
        assert result.dream_td_errors is None
        assert result.horde_td_errors is None
        assert result.ia_augmented_obs is None
        assert result.ia_recommendation is None

    def test_update_mutiple_steps_state_changes(
        self, minimal_state: tuple[PrototypeAgent, PrototypeAgentState]
    ) -> None:
        agent, state = minimal_state
        for _ in range(10):
            result = agent.update(state, jnp.array(0.5), jnp.ones(OBS_DIM))
            state = result.state
        assert int(state.step_count) == 10


# ---------------------------------------------------------------------------
# Update: full agent (world model + dreaming + horde + IA)
# ---------------------------------------------------------------------------


class TestPrototypeAgentUpdateFull:
    @pytest.fixture
    def full_state(self) -> tuple[PrototypeAgent, PrototypeAgentState]:
        agent = PrototypeAgent(_full_config(n_dreams=2))
        state = agent.start(agent.init(jr.key(0)), jnp.zeros(OBS_DIM))
        return agent, state

    def test_update_world_model_error_finite(
        self, full_state: tuple[PrototypeAgent, PrototypeAgentState]
    ) -> None:
        agent, state = full_state
        result = agent.update(state, jnp.array(1.0), jnp.ones(OBS_DIM))
        assert result.world_model_error is not None
        assert jnp.isfinite(result.world_model_error)

    def test_update_dream_td_errors_shape(
        self, full_state: tuple[PrototypeAgent, PrototypeAgentState]
    ) -> None:
        agent, state = full_state
        result = agent.update(state, jnp.array(0.0), jnp.zeros(OBS_DIM))
        assert result.dream_td_errors is not None
        chex.assert_shape(result.dream_td_errors, (2,))

    def test_update_horde_td_errors_shape(
        self, full_state: tuple[PrototypeAgent, PrototypeAgentState]
    ) -> None:
        agent, state = full_state
        result = agent.update(state, jnp.array(0.0), jnp.zeros(OBS_DIM))
        assert result.horde_td_errors is not None
        chex.assert_shape(result.horde_td_errors, (2,))  # 2 demons

    def test_update_ia_augmented_obs_shape(
        self, full_state: tuple[PrototypeAgent, PrototypeAgentState]
    ) -> None:
        agent, state = full_state
        result = agent.update(state, jnp.array(0.0), jnp.zeros(OBS_DIM))
        assert result.ia_augmented_obs is not None
        chex.assert_shape(result.ia_augmented_obs, (OBS_DIM + 2,))  # obs + 2 cerebellum demons

    def test_update_ia_recommendation_valid(
        self, full_state: tuple[PrototypeAgent, PrototypeAgentState]
    ) -> None:
        agent, state = full_state
        result = agent.update(state, jnp.array(0.0), jnp.zeros(OBS_DIM))
        assert result.ia_recommendation is not None
        chex.assert_shape(result.ia_recommendation, ())

    def test_update_buffer_grows(
        self, full_state: tuple[PrototypeAgent, PrototypeAgentState]
    ) -> None:
        agent, state = full_state
        result = agent.update(state, jnp.array(0.0), jnp.ones(OBS_DIM))
        assert int(result.state.buffer_state.size) == 1

    def test_update_world_model_step_count_increments(
        self, full_state: tuple[PrototypeAgent, PrototypeAgentState]
    ) -> None:
        agent, state = full_state
        result = agent.update(state, jnp.array(0.0), jnp.zeros(OBS_DIM))
        assert int(result.state.world_model_state.step_count) == 1

    def test_update_horde_cumulants_broadcast(
        self, full_state: tuple[PrototypeAgent, PrototypeAgentState]
    ) -> None:
        agent, state = full_state
        # Explicit cumulants
        cumulants = jnp.array([0.5, 0.3], dtype=jnp.float32)
        result = agent.update(state, jnp.array(0.0), jnp.zeros(OBS_DIM), cumulants)
        assert result.horde_td_errors is not None
        chex.assert_shape(result.horde_td_errors, (2,))


# ---------------------------------------------------------------------------
# Scan
# ---------------------------------------------------------------------------


class TestPrototypeAgentScan:
    def test_scan_minimal_shapes(self) -> None:
        agent = PrototypeAgent(_minimal_config())
        state = agent.start(agent.init(jr.key(0)), jnp.zeros(OBS_DIM))
        n_steps = 10
        rewards = jnp.zeros(n_steps)
        next_obs = jnp.zeros((n_steps, OBS_DIM))
        result = agent.scan(state, rewards, next_obs)
        assert isinstance(result, PrototypeArrayResult)
        chex.assert_shape(result.actions, (n_steps,))
        chex.assert_shape(result.oak_td_errors, (n_steps,))
        chex.assert_shape(result.oak_average_rewards, (n_steps,))

    def test_scan_step_count_final(self) -> None:
        agent = PrototypeAgent(_minimal_config())
        state = agent.start(agent.init(jr.key(0)), jnp.zeros(OBS_DIM))
        n_steps = 5
        result = agent.scan(state, jnp.zeros(n_steps), jnp.zeros((n_steps, OBS_DIM)))
        assert int(result.state.step_count) == n_steps

    def test_scan_td_errors_finite(self) -> None:
        agent = PrototypeAgent(_minimal_config())
        state = agent.start(agent.init(jr.key(0)), jnp.zeros(OBS_DIM))
        n_steps = 8
        rewards = jr.normal(jr.key(42), (n_steps,))
        next_obs = jr.normal(jr.key(43), (n_steps, OBS_DIM))
        result = agent.scan(state, rewards, next_obs)
        chex.assert_tree_all_finite(result.oak_td_errors)

    def test_scan_matches_sequential(self) -> None:
        agent = PrototypeAgent(_minimal_config())
        init_state = agent.start(agent.init(jr.key(0)), jnp.zeros(OBS_DIM))
        n_steps = 5
        rewards = jnp.array([0.1, 0.2, 0.0, -0.1, 0.5])
        next_obs = jnp.ones((n_steps, OBS_DIM)) * jnp.arange(
            n_steps,
            dtype=jnp.float32,
        )[:, None]

        # Sequential
        state = init_state
        seq_actions = []
        for i in range(n_steps):
            result = agent.update(state, rewards[i], next_obs[i])
            seq_actions.append(int(result.action))
            state = result.state
        seq_final_step = int(state.step_count)

        # Scan
        scan_result = agent.scan(init_state, rewards, next_obs)
        scan_final_step = int(scan_result.state.step_count)

        assert seq_final_step == scan_final_step == n_steps

    def test_scan_world_model_config_update(self) -> None:
        """Scan with world model enabled runs without error."""
        cfg = PrototypeAgentConfig(
            oak=_oak_cfg(),
            world_model=_wm_cfg(),
            dreaming=DreamingConfig(warmup_steps=100),  # warmup prevents dreaming
            n_dreams_per_step=0,
        )
        agent = PrototypeAgent(cfg)
        state = agent.start(agent.init(jr.key(0)), jnp.zeros(OBS_DIM))
        n_steps = 6
        result = agent.scan(state, jnp.zeros(n_steps), jnp.zeros((n_steps, OBS_DIM)))
        assert int(result.state.world_model_state.step_count) == n_steps


# ---------------------------------------------------------------------------
# Curation
# ---------------------------------------------------------------------------


class TestPrototypeAgentCurate:
    def test_curate_returns_new_agent_and_state(self) -> None:
        agent = PrototypeAgent(_minimal_config())
        state = agent.start(agent.init(jr.key(0)), jnp.zeros(OBS_DIM))
        # Run a few steps to build utility EMA
        for _ in range(20):
            result = agent.update(state, jnp.array(0.0), jnp.ones(OBS_DIM))
            state = result.state
        new_agent, new_state = agent.curate(state, jr.key(1))
        assert isinstance(new_agent, PrototypeAgent)
        assert isinstance(new_state, PrototypeAgentState)

    def test_curate_preserves_non_oak_states(self) -> None:
        cfg = PrototypeAgentConfig(
            oak=_oak_cfg(),
            world_model=_wm_cfg(),
            dreaming=DreamingConfig(warmup_steps=1000),
            n_dreams_per_step=0,
        )
        agent = PrototypeAgent(cfg)
        state = agent.start(agent.init(jr.key(0)), jnp.zeros(OBS_DIM))
        for _ in range(5):
            result = agent.update(state, jnp.array(0.0), jnp.ones(OBS_DIM))
            state = result.state
        new_agent, new_state = agent.curate(state, jr.key(2))
        # World model state preserved
        assert (
            int(new_state.world_model_state.step_count)
            == int(state.world_model_state.step_count)
        )

    def test_curated_agent_can_continue_learning(self) -> None:
        agent = PrototypeAgent(_minimal_config())
        state = agent.start(agent.init(jr.key(0)), jnp.zeros(OBS_DIM))
        for _ in range(10):
            result = agent.update(state, jnp.array(1.0), jnp.ones(OBS_DIM))
            state = result.state
        new_agent, new_state = agent.curate(state, jr.key(5))
        primed = new_agent.start(new_state, jnp.zeros(OBS_DIM))
        result = new_agent.update(primed, jnp.array(0.5), jnp.ones(OBS_DIM))
        assert jnp.isfinite(result.oak_td_error)


# ---------------------------------------------------------------------------
# Auto subtask specs
# ---------------------------------------------------------------------------


class TestAutoSubtaskSpecs:
    def test_auto_subtask_specs_count(self) -> None:
        agent = PrototypeAgent(_minimal_config())
        state = agent.start(agent.init(jr.key(0)), jnp.zeros(OBS_DIM))
        for _ in range(5):
            result = agent.update(state, jnp.array(1.0), jnp.ones(OBS_DIM))
            state = result.state
        specs = agent.auto_subtask_specs(state, n_subtasks=3)
        assert len(specs) == 3

    def test_auto_subtask_specs_valid_indices(self) -> None:
        agent = PrototypeAgent(_minimal_config())
        state = agent.start(agent.init(jr.key(0)), jr.normal(jr.key(7), (OBS_DIM,)))
        for _ in range(10):
            result = agent.update(state, jr.normal(jr.key(8), ()), jr.normal(jr.key(9), (OBS_DIM,)))
            state = result.state
        specs = agent.auto_subtask_specs(state, n_subtasks=4)
        for spec in specs:
            assert 0 <= spec.feature_index < OBS_DIM

    def test_auto_subtask_specs_unique_indices(self) -> None:
        agent = PrototypeAgent(_minimal_config())
        state = agent.start(agent.init(jr.key(0)), jr.normal(jr.key(10), (OBS_DIM,)))
        for _ in range(10):
            result = agent.update(state, jnp.array(1.0), jr.normal(jr.key(11), (OBS_DIM,)))
            state = result.state
        specs = agent.auto_subtask_specs(state, n_subtasks=OBS_DIM)
        indices = [s.feature_index for s in specs]
        assert len(indices) == len(set(indices))


# ---------------------------------------------------------------------------
# feature_to_subtask_specs standalone
# ---------------------------------------------------------------------------


class TestFeatureToSubtaskSpecs:
    def test_returns_correct_count(self) -> None:
        agent = PrototypeAgent(_minimal_config())
        state = agent.init(jr.key(0))
        specs = feature_to_subtask_specs(state.oak_state, n_subtasks=2)
        assert len(specs) == 2

    def test_caps_at_obs_dim(self) -> None:
        agent = PrototypeAgent(_minimal_config())
        state = agent.init(jr.key(0))
        specs = feature_to_subtask_specs(state.oak_state, n_subtasks=100)
        assert len(specs) <= OBS_DIM

    def test_respects_threshold(self) -> None:
        agent = PrototypeAgent(_minimal_config())
        state = agent.init(jr.key(0))
        specs = feature_to_subtask_specs(state.oak_state, n_subtasks=2, threshold=0.7)
        for spec in specs:
            assert spec.threshold == pytest.approx(0.7)

    def test_respects_max_option_steps(self) -> None:
        agent = PrototypeAgent(_minimal_config())
        state = agent.init(jr.key(0))
        specs = feature_to_subtask_specs(state.oak_state, n_subtasks=2, max_option_steps=15)
        for spec in specs:
            assert spec.max_option_steps == 15

    def test_valid_feature_indices(self) -> None:
        agent = PrototypeAgent(_minimal_config())
        state = agent.init(jr.key(0))
        specs = feature_to_subtask_specs(state.oak_state, n_subtasks=OBS_DIM)
        for spec in specs:
            assert 0 <= spec.feature_index < OBS_DIM


# ---------------------------------------------------------------------------
# Config serialization agent roundtrip
# ---------------------------------------------------------------------------


class TestPrototypeAgentSerializationRoundtrip:
    def test_from_config_to_config_minimal(self) -> None:
        agent = PrototypeAgent(_minimal_config())
        restored = PrototypeAgent.from_config(agent.to_config())
        assert restored.config.oak.observation_dim == OBS_DIM
        assert restored.config.world_model is None

    def test_from_config_to_config_full(self) -> None:
        agent = PrototypeAgent(_full_config())
        restored = PrototypeAgent.from_config(agent.to_config())
        assert restored.config.n_dreams_per_step == agent.config.n_dreams_per_step
        assert restored.config.horde_spec is not None
        assert restored.config.ia is not None


# ---------------------------------------------------------------------------
# Dreaming mechanics
# ---------------------------------------------------------------------------


class TestPrototypeAgentDreaming:
    def test_dreams_accepted_after_warmup(self) -> None:
        """After warmup, at least some dream TD errors should be nonzero."""
        cfg = PrototypeAgentConfig(
            oak=_oak_cfg(),
            world_model=_wm_cfg(),
            dreaming=DreamingConfig(warmup_steps=1, max_model_error_ema=1e6),
            buffer_capacity=50,
            n_dreams_per_step=4,
        )
        agent = PrototypeAgent(cfg)
        state = agent.start(agent.init(jr.key(0)), jnp.zeros(OBS_DIM))
        # Warm up the world model and buffer
        for _ in range(10):
            result = agent.update(state, jnp.array(0.5), jr.normal(jr.key(13), (OBS_DIM,)))
            state = result.state
        result = agent.update(state, jnp.array(1.0), jnp.ones(OBS_DIM))
        assert result.dream_td_errors is not None
        chex.assert_shape(result.dream_td_errors, (4,))
        chex.assert_tree_all_finite(result.dream_td_errors)

    def test_dreams_zero_before_warmup(self) -> None:
        """During warmup, dream TD errors should all be zero (gated)."""
        cfg = PrototypeAgentConfig(
            oak=_oak_cfg(),
            world_model=_wm_cfg(),
            dreaming=DreamingConfig(warmup_steps=10000, max_model_error_ema=1e6),
            buffer_capacity=50,
            n_dreams_per_step=3,
        )
        agent = PrototypeAgent(cfg)
        state = agent.start(agent.init(jr.key(0)), jnp.zeros(OBS_DIM))
        result = agent.update(state, jnp.array(1.0), jnp.ones(OBS_DIM))
        assert result.dream_td_errors is not None
        # All gated dreams produce 0.0
        chex.assert_trees_all_close(result.dream_td_errors, jnp.zeros(3), atol=1e-6)


# ---------------------------------------------------------------------------
# 200-step fineness (smoke)
# ---------------------------------------------------------------------------


class TestPrototypeAgentSmoke:
    def test_200_step_minimal(self) -> None:
        agent = PrototypeAgent(_minimal_config())
        state = agent.start(agent.init(jr.key(0)), jnp.zeros(OBS_DIM))
        key = jr.key(99)
        for i in range(200):
            key, rk, ok = jr.split(key, 3)
            r = jr.normal(rk, ())
            obs = jr.normal(ok, (OBS_DIM,))
            result = agent.update(state, r, obs)
            state = result.state
        assert jnp.isfinite(result.oak_td_error)
        assert int(state.step_count) == 200

    def test_200_step_full(self) -> None:
        """Full-stack smoke kept shorter because each step touches all components."""
        agent = PrototypeAgent(_full_config(n_dreams=1))
        state = agent.start(agent.init(jr.key(0)), jnp.zeros(OBS_DIM))
        key = jr.key(100)
        n_steps = 50
        for _ in range(n_steps):
            key, rk, ok = jr.split(key, 3)
            r = jr.normal(rk, ())
            obs = jr.normal(ok, (OBS_DIM,))
            result = agent.update(state, r, obs)
            state = result.state
        assert int(state.step_count) == n_steps
        assert jnp.isfinite(result.oak_td_error)
        assert result.world_model_error is not None
        assert jnp.isfinite(result.world_model_error)

    def test_200_step_with_curations(self) -> None:
        """Periodic curation over 200 steps should not crash."""
        cfg = PrototypeAgentConfig(
            oak=_oak_cfg(specs=(_SPEC0, _SPEC1)),
        )
        agent = PrototypeAgent(cfg)
        state = agent.start(agent.init(jr.key(0)), jnp.zeros(OBS_DIM))
        key = jr.key(101)
        for i in range(200):
            key, rk, ok, ck = jr.split(key, 4)
            r = jr.normal(rk, ())
            obs = jr.normal(ok, (OBS_DIM,))
            result = agent.update(state, r, obs)
            state = result.state
            if (i + 1) % 50 == 0:
                agent, state = agent.curate(state, ck)
        assert jnp.isfinite(result.oak_td_error)


# ---------------------------------------------------------------------------
# GRU Perception (Step 8 sub-component a)
# ---------------------------------------------------------------------------

GRU_OBS_DIM = 4
GRU_HIDDEN = 8
GRU_AUG_DIM = GRU_OBS_DIM + GRU_HIDDEN


def _gru_config() -> PrototypeAgentConfig:
    from alberta_framework.core.prototype_agent import GRUPerceptionConfig

    return PrototypeAgentConfig(
        oak=_oak_cfg(obs_dim=GRU_AUG_DIM),
        gru_perception=GRUPerceptionConfig(
            observation_dim=GRU_OBS_DIM,
            hidden_dim=GRU_HIDDEN,
        ),
    )


class TestGRUPerceptionConfig:
    def test_augmented_dim(self) -> None:
        from alberta_framework.core.prototype_agent import GRUPerceptionConfig

        cfg = GRUPerceptionConfig(observation_dim=4, hidden_dim=16)
        assert cfg.augmented_dim() == 20

    def test_config_roundtrip(self) -> None:
        from alberta_framework.core.prototype_agent import GRUPerceptionConfig

        cfg = GRUPerceptionConfig(observation_dim=6, hidden_dim=32)
        restored = GRUPerceptionConfig.from_config(cfg.to_config())
        assert restored.observation_dim == 6
        assert restored.hidden_dim == 32

    def test_oak_dim_mismatch_raises(self) -> None:
        from alberta_framework.core.prototype_agent import GRUPerceptionConfig

        with pytest.raises(ValueError, match="oak.observation_dim"):
            PrototypeAgentConfig(
                oak=_oak_cfg(obs_dim=4),  # wrong — should be 4+8=12
                gru_perception=GRUPerceptionConfig(observation_dim=4, hidden_dim=8),
            )

    def test_world_model_dim_mismatch_raises(self) -> None:
        from alberta_framework.core.prototype_agent import GRUPerceptionConfig

        with pytest.raises(ValueError, match="world_model.observation_dim"):
            PrototypeAgentConfig(
                oak=_oak_cfg(obs_dim=12),  # correct: 4+8
                world_model=ActionConditionedWorldModelConfig(
                    observation_dim=4,  # wrong — should be 12
                    n_actions=2,
                ),
                gru_perception=GRUPerceptionConfig(observation_dim=4, hidden_dim=8),
            )

    def test_prototype_config_roundtrip_with_gru(self) -> None:
        cfg = _gru_config()
        restored = PrototypeAgentConfig.from_config(cfg.to_config())
        assert restored.gru_perception is not None
        assert restored.gru_perception.observation_dim == GRU_OBS_DIM
        assert restored.gru_perception.hidden_dim == GRU_HIDDEN


class TestGRUPerceptionStateInit:
    def test_hidden_zeros_at_init(self) -> None:
        agent = PrototypeAgent(_gru_config())
        state = agent.init(jr.key(0))
        assert state.gru_state is not None
        chex.assert_shape(state.gru_state.hidden, (GRU_HIDDEN,))
        assert float(jnp.max(jnp.abs(state.gru_state.hidden))) == pytest.approx(0.0)

    def test_weight_shapes_correct(self) -> None:
        agent = PrototypeAgent(_gru_config())
        state = agent.init(jr.key(1))
        gru = state.gru_state
        chex.assert_shape(gru.W_z, (GRU_HIDDEN, GRU_OBS_DIM))
        chex.assert_shape(gru.U_z, (GRU_HIDDEN, GRU_HIDDEN))
        chex.assert_shape(gru.b_z, (GRU_HIDDEN,))

    def test_no_gru_state_when_disabled(self) -> None:
        agent = PrototypeAgent(_minimal_config())
        state = agent.init(jr.key(0))
        assert state.gru_state is None


class TestGRUPerceptionUpdate:
    def test_hidden_updates_after_start(self) -> None:
        agent = PrototypeAgent(_gru_config())
        state0 = agent.init(jr.key(0))
        obs = jr.normal(jr.key(1), (GRU_OBS_DIM,))
        state1 = agent.start(state0, obs)
        assert float(jnp.max(jnp.abs(state1.gru_state.hidden))) > 0.0

    def test_oak_receives_augmented_obs(self) -> None:
        """OaK last_obs should have augmented dimension after start."""
        agent = PrototypeAgent(_gru_config())
        state = agent.start(agent.init(jr.key(0)), jr.normal(jr.key(1), (GRU_OBS_DIM,)))
        stored = state.oak_state.stomp_state.base_last_obs
        chex.assert_shape(stored, (GRU_AUG_DIM,))

    def test_update_changes_hidden(self) -> None:
        agent = PrototypeAgent(_gru_config())
        state = agent.start(agent.init(jr.key(0)), jnp.zeros(GRU_OBS_DIM))
        h0 = state.gru_state.hidden
        obs = jr.normal(jr.key(2), (GRU_OBS_DIM,))
        result = agent.update(state, jnp.array(1.0), obs)
        h1 = result.state.gru_state.hidden
        assert not jnp.allclose(h0, h1)

    def test_update_finite(self) -> None:
        agent = PrototypeAgent(_gru_config())
        state = agent.start(agent.init(jr.key(0)), jnp.zeros(GRU_OBS_DIM))
        for _ in range(10):
            obs = jr.normal(jr.key(42), (GRU_OBS_DIM,))
            result = agent.update(state, jnp.array(1.0), obs)
            state = result.state
        assert jnp.isfinite(result.oak_td_error)
        assert jnp.all(jnp.isfinite(state.gru_state.hidden))

    def test_curate_preserves_gru_config(self) -> None:
        from alberta_framework.core.prototype_agent import GRUPerceptionConfig

        agent = PrototypeAgent(
            PrototypeAgentConfig(
                oak=_oak_cfg(specs=(_SPEC0, _SPEC1), obs_dim=GRU_AUG_DIM),
                gru_perception=GRUPerceptionConfig(
                    observation_dim=GRU_OBS_DIM, hidden_dim=GRU_HIDDEN
                ),
            )
        )
        state = agent.start(agent.init(jr.key(0)), jnp.zeros(GRU_OBS_DIM))
        new_agent, new_state = agent.curate(state, jr.key(99))
        assert new_agent.config.gru_perception is not None
        assert new_agent.config.gru_perception.hidden_dim == GRU_HIDDEN


class TestAutoCurate:
    """Tests for auto_curate_every config field and maybe_curate() method."""

    def _agent(self, auto_curate_every: int = 0) -> tuple[PrototypeAgent, PrototypeAgentState]:
        cfg = PrototypeAgentConfig(
            oak=_oak_cfg(specs=(_SPEC0, _SPEC1)),
            auto_curate_every=auto_curate_every,
        )
        agent = PrototypeAgent(cfg)
        state = agent.start(agent.init(jr.key(0)), jnp.zeros(OBS_DIM))
        return agent, state

    def test_config_roundtrip_with_auto_curate(self) -> None:
        cfg = PrototypeAgentConfig(oak=_oak_cfg(), auto_curate_every=50)
        cfg2 = PrototypeAgentConfig.from_config(cfg.to_config())
        assert cfg2.auto_curate_every == 50

    def test_negative_auto_curate_raises(self) -> None:
        with pytest.raises(ValueError, match="auto_curate_every"):
            PrototypeAgentConfig(oak=_oak_cfg(), auto_curate_every=-1)

    def test_maybe_curate_disabled_returns_same(self) -> None:
        agent, state = self._agent(auto_curate_every=0)
        new_agent, new_state = agent.maybe_curate(state, jr.key(1))
        assert new_agent is agent
        assert new_state is state

    def test_maybe_curate_fires_at_zero_step(self) -> None:
        agent, state = self._agent(auto_curate_every=10)
        # step_count == 0 → 0 % 10 == 0 → fires
        new_agent, new_state = agent.maybe_curate(state, jr.key(2))
        assert new_agent is not agent

    def test_maybe_curate_does_not_fire_at_non_aligned_step(self) -> None:
        agent, state = self._agent(auto_curate_every=10)
        # Advance step_count to 1 via an update
        obs = jr.normal(jr.key(7), (OBS_DIM,))
        result = agent.update(state, jnp.array(0.0), obs)
        state1 = result.state
        assert int(state1.step_count) == 1
        new_agent, new_state = agent.maybe_curate(state1, jr.key(3))
        assert new_agent is agent
        assert new_state is state1

    def test_maybe_curate_preserves_auto_curate_every(self) -> None:
        agent, state = self._agent(auto_curate_every=5)
        new_agent, _ = agent.maybe_curate(state, jr.key(4))
        assert new_agent.config.auto_curate_every == 5

    def test_maybe_curate_fires_every_n_steps(self) -> None:
        agent, state = self._agent(auto_curate_every=5)
        curations = 0
        obs = jr.normal(jr.key(0), (OBS_DIM,))
        for i in range(15):
            if int(state.step_count) % 5 == 0:
                agent, state = agent.maybe_curate(state, jr.key(i + 100))
                curations += 1
            result = agent.update(state, jnp.array(0.0), obs)
            state = result.state
        # Fires at step_count 0, 5, 10 → exactly 3
        assert curations == 3
