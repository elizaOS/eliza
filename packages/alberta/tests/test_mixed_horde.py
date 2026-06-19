"""Tests for the MixedHorde per-demon routing learner.

The :class:`MixedHorde` routes each demon at construction time based on
its ``gamma * lamda`` product:

- ``gamma * lamda == 0`` -> shared trunk path (:class:`HordeLearner`).
- ``gamma * lamda > 0`` -> independent-trunk path
  (:class:`IndependentDemonHorde`).

These tests verify the two edge cases (all-shared, all-independent)
reduce numerically to the corresponding standalone learner, that mixed
configs run without trunk-trace assertion errors, and that
``to_config`` / ``from_config`` round-trip preserves all settings.
"""

import chex
import jax.numpy as jnp
import jax.random as jr

from alberta_framework import (
    DemonType,
    GVFSpec,
    HordeLearner,
    MixedHorde,
    MixedHordeLearningResult,
    ObGDBounding,
    create_horde_spec,
    run_horde_learning_loop,
    run_mixed_horde_learning_loop,
)
from alberta_framework.core.independent_demon_horde import (
    IndependentDemonHorde,
    run_independent_horde_learning_loop,
)

# =============================================================================
# Helpers
# =============================================================================


def _gamma0_demon(name: str, idx: int) -> GVFSpec:
    return GVFSpec(
        name=name,
        demon_type=DemonType.PREDICTION,
        gamma=0.0,
        lamda=0.0,
        cumulant_index=idx,
    )


def _temporal_demon(name: str, idx: int, gamma: float, lamda: float) -> GVFSpec:
    return GVFSpec(
        name=name,
        demon_type=DemonType.PREDICTION,
        gamma=gamma,
        lamda=lamda,
        cumulant_index=idx,
    )


def _random_walk_arrays(
    *,
    num_steps: int,
    feature_dim: int,
    n_demons: int,
    seed: int,
) -> tuple[chex.Array, chex.Array, chex.Array]:
    """Generate observations, cumulants, next_observations for a random walk."""
    key = jr.key(seed)
    k1, k2 = jr.split(key)
    observations = jr.normal(k1, (num_steps, feature_dim))
    cumulants = jr.normal(k2, (num_steps, n_demons))
    next_observations = jnp.concatenate(
        [observations[1:], observations[:1]], axis=0
    )
    return observations, cumulants, next_observations


# =============================================================================
# Routing partition
# =============================================================================


class TestRouting:
    """Routing indices match the gamma*lamda partition."""

    def test_all_shared_when_gamma_lamda_zero(self) -> None:
        demons = [_gamma0_demon(f"d{i}", i) for i in range(3)]
        spec = create_horde_spec(demons)
        horde = MixedHorde(horde_spec=spec, hidden_sizes=(8,), sparsity=0.0)
        assert horde.shared_indices == (0, 1, 2)
        assert horde.independent_indices == ()
        assert horde.shared_horde is not None
        assert horde.independent_horde is None

    def test_all_independent_when_gamma_lamda_positive(self) -> None:
        demons = [
            _temporal_demon(f"d{i}", i, gamma=0.9, lamda=0.5) for i in range(3)
        ]
        spec = create_horde_spec(demons)
        horde = MixedHorde(horde_spec=spec, hidden_sizes=(8,), sparsity=0.0)
        assert horde.shared_indices == ()
        assert horde.independent_indices == (0, 1, 2)
        assert horde.shared_horde is None
        assert horde.independent_horde is not None

    def test_mixed_partition(self) -> None:
        demons = [
            _gamma0_demon("d0", 0),
            _temporal_demon("d1", 1, gamma=0.9, lamda=0.5),
            _gamma0_demon("d2", 2),
            _temporal_demon("d3", 3, gamma=0.5, lamda=0.5),
        ]
        spec = create_horde_spec(demons)
        horde = MixedHorde(horde_spec=spec, hidden_sizes=(8,), sparsity=0.0)
        assert horde.shared_indices == (0, 2)
        assert horde.independent_indices == (1, 3)
        assert horde.shared_horde is not None
        assert horde.independent_horde is not None


# =============================================================================
# Numerical equivalence: all-gamma*lamda=0 mixed == HordeLearner
# =============================================================================


class TestAllSharedEqualsHordeLearner:
    """All-shared MixedHorde matches HordeLearner exactly."""

    def test_predictions_match(self) -> None:
        demons = [_gamma0_demon(f"d{i}", i) for i in range(3)]
        spec = create_horde_spec(demons)

        common_kwargs = {
            "horde_spec": spec,
            "hidden_sizes": (16,),
            "step_size": 1.0,
            "sparsity": 0.0,
            "bounder": ObGDBounding(kappa=2.0),
        }
        mixed = MixedHorde(**common_kwargs)
        shared = HordeLearner(**common_kwargs)

        key = jr.key(11)
        m_state = mixed.init(5, key)
        s_state = shared.init(5, key)

        obs = jnp.array([1.0, -0.5, 0.3, 0.2, -0.8])
        m_preds = mixed.predict(m_state, obs)
        s_preds = shared.predict(s_state, obs)

        chex.assert_trees_all_close(m_preds, s_preds)

    def test_random_walk_matches_horde_learner(self) -> None:
        n_demons = 3
        feature_dim = 5
        num_steps = 200
        demons = [_gamma0_demon(f"d{i}", i) for i in range(n_demons)]
        spec = create_horde_spec(demons)

        common_kwargs = {
            "horde_spec": spec,
            "hidden_sizes": (16,),
            "step_size": 0.05,
            "sparsity": 0.0,
            "bounder": ObGDBounding(kappa=2.0),
        }
        mixed = MixedHorde(**common_kwargs)
        shared = HordeLearner(**common_kwargs)

        init_key = jr.key(7)
        observations, cumulants, next_observations = _random_walk_arrays(
            num_steps=num_steps,
            feature_dim=feature_dim,
            n_demons=n_demons,
            seed=42,
        )

        m_state = mixed.init(feature_dim, init_key)
        s_state = shared.init(feature_dim, init_key)

        m_result = run_mixed_horde_learning_loop(
            mixed, m_state, observations, cumulants, next_observations
        )
        s_result = run_horde_learning_loop(
            shared, s_state, observations, cumulants, next_observations
        )

        chex.assert_trees_all_close(
            m_result.per_demon_metrics, s_result.per_demon_metrics, rtol=1e-5
        )
        chex.assert_trees_all_close(
            m_result.td_errors, s_result.td_errors, rtol=1e-5
        )


# =============================================================================
# Numerical equivalence: all-gamma*lamda>0 mixed == IndependentDemonHorde
# =============================================================================


class TestAllIndependentEqualsIndependentDemonHorde:
    """All-independent MixedHorde matches IndependentDemonHorde exactly."""

    def test_predictions_match(self) -> None:
        demons = [
            _temporal_demon(f"d{i}", i, gamma=0.9, lamda=0.5) for i in range(2)
        ]
        spec = create_horde_spec(demons)

        common_kwargs = {
            "horde_spec": spec,
            "hidden_sizes": (16,),
            "step_size": 0.05,
            "sparsity": 0.0,
            "bounder": ObGDBounding(kappa=2.0),
        }
        mixed = MixedHorde(**common_kwargs)
        indep = IndependentDemonHorde(**common_kwargs)

        key = jr.key(13)
        m_state = mixed.init(5, key)
        i_state = indep.init(5, key)

        obs = jnp.array([0.4, -0.7, 0.3, 0.5, -0.2])
        m_preds = mixed.predict(m_state, obs)
        i_preds = indep.predict(i_state, obs)

        chex.assert_trees_all_close(m_preds, i_preds)

    def test_random_walk_matches_independent_horde(self) -> None:
        n_demons = 2
        feature_dim = 5
        num_steps = 200
        demons = [
            _temporal_demon(f"d{i}", i, gamma=0.9, lamda=0.5)
            for i in range(n_demons)
        ]
        spec = create_horde_spec(demons)

        common_kwargs = {
            "horde_spec": spec,
            "hidden_sizes": (16,),
            "step_size": 0.05,
            "sparsity": 0.0,
            "bounder": ObGDBounding(kappa=2.0),
        }
        mixed = MixedHorde(**common_kwargs)
        indep = IndependentDemonHorde(**common_kwargs)

        init_key = jr.key(21)
        observations, cumulants, next_observations = _random_walk_arrays(
            num_steps=num_steps,
            feature_dim=feature_dim,
            n_demons=n_demons,
            seed=99,
        )

        m_state = mixed.init(feature_dim, init_key)
        i_state = indep.init(feature_dim, init_key)

        m_result = run_mixed_horde_learning_loop(
            mixed, m_state, observations, cumulants, next_observations
        )
        i_result = run_independent_horde_learning_loop(
            indep, i_state, observations, cumulants, next_observations
        )

        chex.assert_trees_all_close(
            m_result.per_demon_metrics, i_result.per_demon_metrics, rtol=1e-5
        )
        chex.assert_trees_all_close(
            m_result.td_errors, i_result.td_errors, rtol=1e-5
        )


# =============================================================================
# Mixed config: some gamma*lamda=0, some gamma*lamda>0 with hidden layers
# =============================================================================


class TestMixedConfigRunsWithoutTrunkAssertion:
    """Mixed routing with hidden layers must not raise the trunk-trace error."""

    def test_mixed_runs_with_hidden_layers(self) -> None:
        # Two single-step demons + two temporal demons with gamma*lamda > 0.
        demons = [
            _gamma0_demon("d_short_0", 0),
            _temporal_demon("d_long_0", 1, gamma=0.9, lamda=0.5),
            _gamma0_demon("d_short_1", 2),
            _temporal_demon("d_long_1", 3, gamma=0.99, lamda=0.5),
        ]
        spec = create_horde_spec(demons)
        # Hidden layer present — would trigger trunk-trace assertion in
        # plain HordeLearner if the trunk had nonzero gamma*lamda.
        horde = MixedHorde(
            horde_spec=spec,
            hidden_sizes=(16,),
            step_size=0.05,
            sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        state = horde.init(5, jr.key(101))

        observations, cumulants, next_observations = _random_walk_arrays(
            num_steps=100,
            feature_dim=5,
            n_demons=4,
            seed=202,
        )

        result = run_mixed_horde_learning_loop(
            horde, state, observations, cumulants, next_observations
        )

        # All TD errors must be finite (no NaN / inf from trace coupling).
        chex.assert_tree_all_finite(result.td_errors)
        chex.assert_tree_all_finite(result.per_demon_metrics)
        chex.assert_shape(result.td_errors, (100, 4))
        chex.assert_shape(result.per_demon_metrics, (100, 4, 3))

    def test_predict_returns_finite_after_updates(self) -> None:
        demons = [
            _gamma0_demon("d0", 0),
            _temporal_demon("d1", 1, gamma=0.9, lamda=0.5),
        ]
        spec = create_horde_spec(demons)
        horde = MixedHorde(
            horde_spec=spec,
            hidden_sizes=(8,),
            step_size=0.05,
            sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )

        key = jr.key(303)
        state = horde.init(5, key)

        obs = jnp.ones(5)
        cumulants = jnp.array([1.0, 0.5])
        next_obs = jnp.ones(5) * 0.5

        for _ in range(20):
            result = horde.update(state, obs, cumulants, next_obs)
            state = result.state

        preds = horde.predict(state, obs)
        chex.assert_tree_all_finite(preds)
        chex.assert_shape(preds, (2,))


# =============================================================================
# Output ordering: predictions / errors come back in original demon order
# =============================================================================


class TestOriginalDemonOrder:
    """Predictions and TD targets are returned in original demon order."""

    def test_td_targets_match_per_demon_gamma(self) -> None:
        # Demons are interleaved: shared, indep, shared, indep.
        demons = [
            _gamma0_demon("d0", 0),
            _temporal_demon("d1", 1, gamma=0.9, lamda=0.5),
            _gamma0_demon("d2", 2),
            _temporal_demon("d3", 3, gamma=0.5, lamda=0.5),
        ]
        spec = create_horde_spec(demons)
        horde = MixedHorde(
            horde_spec=spec,
            hidden_sizes=(),  # linear so we can read off the math easily
            step_size=0.0,  # frozen weights
            sparsity=0.0,
        )
        key = jr.key(7)
        state = horde.init(5, key)
        obs = jnp.ones(5)
        cumulants = jnp.array([1.0, 2.0, 3.0, 4.0])
        next_obs = jnp.ones(5) * 0.5

        # Predictions before the update tell us V(s').
        v_next = horde.predict(state, next_obs)

        result = horde.update(state, obs, cumulants, next_obs)

        # gamma=0 demons: target == cumulant.
        chex.assert_trees_all_close(result.td_targets[0], cumulants[0])
        chex.assert_trees_all_close(result.td_targets[2], cumulants[2])
        # temporal demons: target == cumulant + gamma * V(s')
        chex.assert_trees_all_close(
            result.td_targets[1], cumulants[1] + 0.9 * v_next[1], atol=1e-5
        )
        chex.assert_trees_all_close(
            result.td_targets[3], cumulants[3] + 0.5 * v_next[3], atol=1e-5
        )


# =============================================================================
# Config round-trip
# =============================================================================


class TestConfigRoundtrip:
    """to_config / from_config preserves settings and produces the same network."""

    def test_config_roundtrip_mixed(self) -> None:
        demons = [
            _gamma0_demon("d0", 0),
            _temporal_demon("d1", 1, gamma=0.9, lamda=0.5),
            _gamma0_demon("d2", 2),
        ]
        spec = create_horde_spec(demons)
        original = MixedHorde(
            horde_spec=spec,
            hidden_sizes=(16, 8),
            step_size=0.5,
            sparsity=0.0,
            leaky_relu_slope=0.02,
            use_layer_norm=False,
            bounder=ObGDBounding(kappa=3.0),
        )

        config = original.to_config()
        assert config["type"] == "MixedHorde"
        assert len(config["horde_spec"]["demons"]) == 3

        restored = MixedHorde.from_config(config)

        assert restored.n_demons == 3
        assert restored.shared_indices == original.shared_indices
        assert restored.independent_indices == original.independent_indices

        # Same predictions when initialized with the same key.
        key = jr.key(42)
        s1 = original.init(5, key)
        s2 = restored.init(5, key)

        p1 = original.predict(s1, jnp.ones(5))
        p2 = restored.predict(s2, jnp.ones(5))
        chex.assert_trees_all_close(p1, p2)

    def test_config_roundtrip_all_shared(self) -> None:
        demons = [_gamma0_demon(f"d{i}", i) for i in range(3)]
        spec = create_horde_spec(demons)
        original = MixedHorde(
            horde_spec=spec,
            hidden_sizes=(8,),
            sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )

        config = original.to_config()
        restored = MixedHorde.from_config(config)
        assert restored.independent_horde is None
        assert restored.shared_horde is not None

    def test_config_roundtrip_all_independent(self) -> None:
        demons = [
            _temporal_demon(f"d{i}", i, gamma=0.9, lamda=0.5) for i in range(2)
        ]
        spec = create_horde_spec(demons)
        original = MixedHorde(
            horde_spec=spec,
            hidden_sizes=(8,),
            sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )

        config = original.to_config()
        restored = MixedHorde.from_config(config)
        assert restored.shared_horde is None
        assert restored.independent_horde is not None


# =============================================================================
# Scan loop shape contract
# =============================================================================


class TestRunMixedHordeLearningLoop:
    """run_mixed_horde_learning_loop returns expected shapes."""

    def test_scan_loop_shape(self) -> None:
        n_demons = 4
        num_steps = 25
        feature_dim = 5
        demons = [
            _gamma0_demon("d0", 0),
            _temporal_demon("d1", 1, gamma=0.9, lamda=0.5),
            _gamma0_demon("d2", 2),
            _temporal_demon("d3", 3, gamma=0.5, lamda=0.5),
        ]
        spec = create_horde_spec(demons)
        horde = MixedHorde(
            horde_spec=spec,
            hidden_sizes=(8,),
            sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        state = horde.init(feature_dim, jr.key(0))

        observations, cumulants, next_observations = _random_walk_arrays(
            num_steps=num_steps,
            feature_dim=feature_dim,
            n_demons=n_demons,
            seed=1,
        )

        result = run_mixed_horde_learning_loop(
            horde, state, observations, cumulants, next_observations
        )
        assert isinstance(result, MixedHordeLearningResult)
        chex.assert_shape(
            result.per_demon_metrics, (num_steps, n_demons, 3)
        )
        chex.assert_shape(result.td_errors, (num_steps, n_demons))


# =============================================================================
# Step3HordeConfig dispatch
# =============================================================================


class TestStep3RoutingDispatch:
    """Step3HordeConfig.routing dispatches to the right learner class."""

    def test_shared_routing_returns_horde_learner(self) -> None:
        from alberta_framework.steps.step3 import Step3HordeConfig, make_step3_horde

        cfg = Step3HordeConfig(routing="shared")
        h = make_step3_horde(cfg)
        assert isinstance(h, HordeLearner)

    def test_independent_routing_returns_independent_demon_horde(self) -> None:
        from alberta_framework.steps.step3 import Step3HordeConfig, make_step3_horde

        cfg = Step3HordeConfig(routing="independent")
        h = make_step3_horde(cfg)
        assert isinstance(h, IndependentDemonHorde)

    def test_mixed_routing_returns_mixed_horde(self) -> None:
        from alberta_framework.steps.step3 import Step3HordeConfig, make_step3_horde

        cfg = Step3HordeConfig(routing="mixed")
        h = make_step3_horde(cfg)
        assert isinstance(h, MixedHorde)

    def test_step3_config_roundtrip_preserves_routing(self) -> None:
        from alberta_framework.steps.step3 import Step3HordeConfig

        cfg = Step3HordeConfig(routing="mixed")
        restored = Step3HordeConfig.from_dict(cfg.to_dict())
        assert restored.routing == "mixed"
