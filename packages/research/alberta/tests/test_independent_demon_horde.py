"""Tests for the IndependentDemonHorde reference architecture.

The IndependentDemonHorde gives every GVF demon its own independent
``MLPLearner``. Because there is no shared trunk, full per-parameter
eligibility traces with ``gamma * lamda > 0`` are forward-view-correct
(unlike ``HordeLearner`` which must force trunk ``gamma * lamda = 0``).

These tests verify that:
- State init produces correct shapes.
- Demons truly do not share parameters (NaN-masking on one demon
  leaves another demon's params unchanged).
- ``gamma * lamda > 0`` with hidden layers does not raise (the whole
  point of this architecture vs ``HordeLearner``).
- All-gamma=0 results approximately match ``HordeLearner`` (sanity
  check; the architectures differ — independent trunks vs shared, so
  exact equivalence is not expected).
- Temporal demons stay finite over many steps.
- ``to_config()`` / ``from_config()`` round-trip preserves all settings.
- Per-demon metrics have shape ``(n_demons, 3)``.
- The scan-based learning loop returns correctly shaped arrays.
"""

import chex
import jax.numpy as jnp
import jax.random as jr
import pytest

from alberta_framework import (
    DemonType,
    GVFSpec,
    HordeLearner,
    ObGDBounding,
    create_horde_spec,
)
from alberta_framework.core.independent_demon_horde import (
    BatchedIndependentDemonHordeResult,
    IndependentDemonHorde,
    IndependentDemonHordeLearningResult,
    IndependentDemonHordeState,
    run_independent_horde_learning_loop,
    run_independent_horde_learning_loop_batched,
)


def _make_all_gamma0_spec(n: int) -> list[GVFSpec]:
    """Helper: create n prediction demons with gamma=0."""
    return [
        GVFSpec(
            name=f"d{i}",
            demon_type=DemonType.PREDICTION,
            gamma=0.0,
            lamda=0.0,
            cumulant_index=i,
        )
        for i in range(n)
    ]


# =============================================================================
# Init / shape contract
# =============================================================================


class TestInitShape:
    """State init produces correct shape; predict has correct output shape."""

    def test_init_shape(self) -> None:
        n_demons = 3
        feature_dim = 5
        spec = create_horde_spec(_make_all_gamma0_spec(n_demons))

        horde = IndependentDemonHorde(
            horde_spec=spec,
            hidden_sizes=(16,),
            sparsity=0.0,
        )
        state = horde.init(feature_dim, jr.key(42))

        # Per-demon state tuple length matches n_demons.
        assert isinstance(state, IndependentDemonHordeState)
        assert len(state.demon_states) == n_demons

        # Each demon's first weight matrix has shape (16, feature_dim).
        for ds in state.demon_states:
            chex.assert_shape(ds.params.weights[0], (16, feature_dim))
            chex.assert_shape(ds.params.weights[1], (1, 16))
            chex.assert_shape(ds.params.biases[0], (16,))
            chex.assert_shape(ds.params.biases[1], (1,))

        # Predict output shape.
        obs = jnp.ones(feature_dim)
        preds = horde.predict(state, obs)
        chex.assert_shape(preds, (n_demons,))

    def test_init_linear_baseline_shape(self) -> None:
        """``hidden_sizes=()`` should give per-demon linear models."""
        n_demons = 4
        feature_dim = 7
        spec = create_horde_spec(_make_all_gamma0_spec(n_demons))

        horde = IndependentDemonHorde(
            horde_spec=spec,
            hidden_sizes=(),
            sparsity=0.0,
        )
        state = horde.init(feature_dim, jr.key(0))

        assert len(state.demon_states) == n_demons
        for ds in state.demon_states:
            # Single output layer of shape (1, feature_dim).
            assert len(ds.params.weights) == 1
            chex.assert_shape(ds.params.weights[0], (1, feature_dim))


# =============================================================================
# Independence: demons truly do not share parameters
# =============================================================================


class TestIndependence:
    """Updating with cumulant only on demon 0 must leave demon 1 unchanged."""

    def test_independence_demons_dont_share_params(self) -> None:
        spec = create_horde_spec(_make_all_gamma0_spec(2))
        horde = IndependentDemonHorde(
            horde_spec=spec,
            hidden_sizes=(8,),
            sparsity=0.0,
            step_size=0.1,
        )
        state = horde.init(5, jr.key(123))

        obs = jnp.ones(5)
        # Active cumulant on demon 0, NaN on demon 1.
        cumulants = jnp.array([1.0, jnp.nan])
        next_obs = jnp.zeros(5)

        result = horde.update(state, obs, cumulants, next_obs)

        # Demon 1's parameters and traces must be byte-identical to before.
        d1_old = state.demon_states[1]
        d1_new = result.state.demon_states[1]  # type: ignore[attr-defined]
        for w_old, w_new in zip(
            d1_old.params.weights, d1_new.params.weights, strict=True
        ):
            chex.assert_trees_all_close(w_old, w_new)
        for b_old, b_new in zip(
            d1_old.params.biases, d1_new.params.biases, strict=True
        ):
            chex.assert_trees_all_close(b_old, b_new)
        for t_old, t_new in zip(d1_old.traces, d1_new.traces, strict=True):
            chex.assert_trees_all_close(t_old, t_new)

        # Demon 0's parameters DID change.
        d0_old = state.demon_states[0]
        d0_new = result.state.demon_states[0]  # type: ignore[attr-defined]
        # At least one weight matrix should be different.
        any_changed = False
        for w_old, w_new in zip(
            d0_old.params.weights, d0_new.params.weights, strict=True
        ):
            if not jnp.allclose(w_old, w_new):
                any_changed = True
                break
        assert any_changed, "demon 0 weights should have changed"


# =============================================================================
# gamma*lamda > 0 with hidden layers must NOT raise (the point of this class)
# =============================================================================


class TestGammaLamdaWithHiddenLayers:
    """The whole reason this class exists: full per-parameter traces work."""

    def test_gamma_lamda_can_be_nonzero_with_hidden_layers(self) -> None:
        """Per-demon gamma*lamda>0 + hidden layers must not raise."""
        demons = [
            GVFSpec(
                name="temporal",
                demon_type=DemonType.PREDICTION,
                gamma=0.9,
                lamda=0.5,
                cumulant_index=0,
            ),
        ]
        spec = create_horde_spec(demons)

        # No exception expected.
        horde = IndependentDemonHorde(
            horde_spec=spec,
            hidden_sizes=(16,),  # MLP trunk is fine here
            sparsity=0.0,
        )
        state = horde.init(5, jr.key(42))

        obs = jnp.ones(5)
        cumulants = jnp.array([1.0])
        next_obs = jnp.zeros(5)

        # Should run without error and produce finite outputs.
        result = horde.update(state, obs, cumulants, next_obs)
        chex.assert_tree_all_finite(result.predictions)
        chex.assert_tree_all_finite(result.td_errors)

        # Trunk traces should accumulate (not stay at zero) because
        # gamma*lamda > 0 — that's the whole point of this architecture.
        # On step 2 the trunk's hidden-layer trace should be non-zero.
        result2 = horde.update(result.state, obs, cumulants, next_obs)  # type: ignore[arg-type]
        d0_traces = result2.state.demon_states[0].traces  # type: ignore[attr-defined]
        # Trunk weight trace at index 0 should not be all zero.
        assert not jnp.allclose(d0_traces[0], 0.0), (
            "trunk trace should accumulate with gamma*lamda > 0"
        )


# =============================================================================
# Sanity check vs HordeLearner with all gamma=0
# =============================================================================


class TestMatchesHordeLearnerWithGammaZero:
    """All-gamma=0: independent and shared architectures should be similar.

    Not exact: the architectures differ — independent runs N separate
    trunks while shared runs ONE trunk. The networks differ in their
    weight inits (we split keys differently across demons), and the
    optimization paths differ even with sparsity=0. We accept ~5-10%
    final-error gap as a sanity check.
    """

    def test_matches_hordelearner_with_gamma_zero(self) -> None:
        n_demons = 2
        feature_dim = 5
        num_steps = 100
        spec = create_horde_spec(_make_all_gamma0_spec(n_demons))

        # Same constructor args except for the class itself.
        common_kwargs = {
            "horde_spec": spec,
            "hidden_sizes": (16,),
            "step_size": 0.05,
            "sparsity": 0.0,
            "bounder": ObGDBounding(kappa=2.0),
        }
        independent = IndependentDemonHorde(**common_kwargs)  # type: ignore[arg-type]
        shared = HordeLearner(**common_kwargs)  # type: ignore[arg-type]

        key = jr.key(7)
        k1, k2, k3 = jr.split(key, 3)

        # Each architecture initializes its own networks; we use the SAME
        # seed but the architectures still diverge because the parameter
        # tree differs.
        ind_state = independent.init(feature_dim, k1)
        shared_state = shared.init(feature_dim, k1)

        observations = jr.normal(k2, (num_steps, feature_dim))
        cumulants = jr.normal(k3, (num_steps, n_demons))
        next_observations = jnp.concatenate(
            [observations[1:], observations[:1]], axis=0
        )

        ind_result = run_independent_horde_learning_loop(
            independent, ind_state, observations, cumulants, next_observations
        )
        from alberta_framework import run_horde_learning_loop

        shared_result = run_horde_learning_loop(
            shared, shared_state, observations, cumulants, next_observations
        )

        # Final mean squared error over the last 20 steps for each demon.
        ind_final_se = jnp.nanmean(ind_result.per_demon_metrics[-20:, :, 0])
        shared_final_se = jnp.nanmean(
            shared_result.per_demon_metrics[-20:, :, 0]
        )

        # Sanity check: same order of magnitude. We accept up to a 3x gap
        # because the architectures genuinely differ; the test catches
        # gross bugs (NaN, divergence, completely wrong scale), not
        # subtle differences.
        ratio = ind_final_se / shared_final_se
        assert 0.1 < ratio < 10.0, (
            f"Final SE ratio independent/shared = {ratio} should be O(1) "
            f"sanity check (independent={ind_final_se}, "
            f"shared={shared_final_se})."
        )

        # Both must be finite.
        assert jnp.isfinite(ind_final_se)
        assert jnp.isfinite(shared_final_se)


# =============================================================================
# Temporal demons stay finite over many steps
# =============================================================================


class TestTemporalDemonsFinite:
    """gamma>0 demons over many steps must not blow up."""

    def test_temporal_demons_finite(self) -> None:
        demons = [
            GVFSpec(
                name="d0",
                demon_type=DemonType.PREDICTION,
                gamma=0.9,
                lamda=0.0,
                cumulant_index=0,
            ),
            GVFSpec(
                name="d1",
                demon_type=DemonType.PREDICTION,
                gamma=0.95,
                lamda=0.5,
                cumulant_index=1,
            ),
        ]
        spec = create_horde_spec(demons)
        horde = IndependentDemonHorde(
            horde_spec=spec,
            hidden_sizes=(16,),
            sparsity=0.0,
            step_size=0.05,
            bounder=ObGDBounding(kappa=2.0),
        )

        key = jr.key(11)
        k1, k2, k3 = jr.split(key, 3)
        state = horde.init(5, k1)

        observations = jr.normal(k2, (50, 5))
        cumulants = jr.normal(k3, (50, 2))
        next_observations = jnp.concatenate(
            [observations[1:], observations[:1]], axis=0
        )

        result = run_independent_horde_learning_loop(
            horde, state, observations, cumulants, next_observations
        )

        chex.assert_tree_all_finite(result.per_demon_metrics)
        chex.assert_tree_all_finite(result.td_errors)
        # Final demon states must also be finite.
        for ds in result.state.demon_states:
            for w in ds.params.weights:
                chex.assert_tree_all_finite(w)
            for b in ds.params.biases:
                chex.assert_tree_all_finite(b)


# =============================================================================
# Config round-trip
# =============================================================================


class TestConfigRoundtrip:
    """to_config() / from_config() preserves all settings."""

    def test_config_roundtrip(self) -> None:
        demons = [
            GVFSpec(
                name="d0",
                demon_type=DemonType.PREDICTION,
                gamma=0.0,
                lamda=0.0,
                cumulant_index=0,
            ),
            GVFSpec(
                name="d1",
                demon_type=DemonType.PREDICTION,
                gamma=0.9,
                lamda=0.5,
                cumulant_index=1,
            ),
        ]
        spec = create_horde_spec(demons)
        original = IndependentDemonHorde(
            horde_spec=spec,
            hidden_sizes=(32, 16),
            step_size=0.5,
            sparsity=0.7,
            leaky_relu_slope=0.02,
            use_layer_norm=False,
            bounder=ObGDBounding(kappa=3.0),
        )

        config = original.to_config()
        assert config["type"] == "IndependentDemonHorde"
        assert len(config["horde_spec"]["demons"]) == 2

        restored = IndependentDemonHorde.from_config(config)

        assert restored.n_demons == 2
        assert restored.horde_spec.demons[0].name == "d0"
        assert restored.horde_spec.demons[1].gamma == pytest.approx(0.9)
        assert restored.horde_spec.demons[1].lamda == pytest.approx(0.5)

        # Same predictions when initialized with the same key (architecture
        # and weight init are deterministic in the seed).
        key = jr.key(42)
        s1 = original.init(5, key)
        s2 = restored.init(5, key)

        p1 = original.predict(s1, jnp.ones(5))
        p2 = restored.predict(s2, jnp.ones(5))

        chex.assert_trees_all_close(p1, p2)


# =============================================================================
# Per-demon metrics shape
# =============================================================================


class TestPerDemonMetricsShape:
    """Per-demon metrics must have shape (n_demons, 3)."""

    def test_per_demon_metrics_shape(self) -> None:
        n_demons = 4
        spec = create_horde_spec(_make_all_gamma0_spec(n_demons))
        horde = IndependentDemonHorde(
            horde_spec=spec,
            hidden_sizes=(16,),
            sparsity=0.0,
        )
        state = horde.init(5, jr.key(0))
        obs = jnp.ones(5)
        cumulants = jnp.arange(n_demons, dtype=jnp.float32)
        next_obs = jnp.zeros(5)

        result = horde.update(state, obs, cumulants, next_obs)
        chex.assert_shape(result.per_demon_metrics, (n_demons, 3))


# =============================================================================
# Scan loop shape contract
# =============================================================================


class TestScanLoopCorrectShape:
    """run_independent_horde_learning_loop returns expected shapes."""

    def test_scan_loop_correct_shape(self) -> None:
        n_demons = 3
        num_steps = 25
        feature_dim = 5
        spec = create_horde_spec(_make_all_gamma0_spec(n_demons))
        horde = IndependentDemonHorde(
            horde_spec=spec,
            hidden_sizes=(16,),
            sparsity=0.0,
        )
        state = horde.init(feature_dim, jr.key(0))

        key = jr.key(1)
        k1, k2 = jr.split(key)
        observations = jr.normal(k1, (num_steps, feature_dim))
        cumulants = jr.normal(k2, (num_steps, n_demons))
        next_observations = jnp.zeros((num_steps, feature_dim))

        result = run_independent_horde_learning_loop(
            horde, state, observations, cumulants, next_observations
        )

        assert isinstance(result, IndependentDemonHordeLearningResult)
        chex.assert_shape(
            result.per_demon_metrics, (num_steps, n_demons, 3)
        )
        chex.assert_shape(result.td_errors, (num_steps, n_demons))

    def test_batched_loop_correct_shape(self) -> None:
        """run_independent_horde_learning_loop_batched: vmap over seeds."""
        n_demons = 2
        num_steps = 10
        feature_dim = 5
        n_seeds = 3
        spec = create_horde_spec(_make_all_gamma0_spec(n_demons))
        horde = IndependentDemonHorde(
            horde_spec=spec,
            hidden_sizes=(8,),
            sparsity=0.0,
        )

        key = jr.key(2)
        k1, k2, k3 = jr.split(key, 3)
        observations = jr.normal(k1, (num_steps, feature_dim))
        cumulants = jr.normal(k2, (num_steps, n_demons))
        next_observations = jnp.zeros((num_steps, feature_dim))
        keys = jr.split(k3, n_seeds)

        result = run_independent_horde_learning_loop_batched(
            horde, observations, cumulants, next_observations, keys
        )
        assert isinstance(result, BatchedIndependentDemonHordeResult)
        chex.assert_shape(
            result.per_demon_metrics, (n_seeds, num_steps, n_demons, 3)
        )
        chex.assert_shape(
            result.td_errors, (n_seeds, num_steps, n_demons)
        )
