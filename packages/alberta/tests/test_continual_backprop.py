"""Tests for Continual Backprop (CBP) per-unit utility tracking + replacement.

Reference: Dohare et al. 2024, "Loss of plasticity in deep continual learning."
"""

import chex
import jax
import jax.numpy as jnp
import jax.random as jr

from alberta_framework.core.continual_backprop import (
    CBPLearningResult,
    CBPMLPLearner,
    CBPMLPState,
    CBPMultiHeadMLPLearner,
    CBPMultiHeadMLPState,
    ContinualBackpropConfig,
    ContinualBackpropState,
    ContinualBackpropTracker,
    init_cbp_state,
    maybe_replace_units,
    run_cbp_learning_loop,
    update_utility,
)
from alberta_framework.core.multi_head_learner import MultiHeadMLPLearner

# =============================================================================
# init_cbp_state shape / value tests
# =============================================================================


class TestInitCbpStateShapes:
    """init_cbp_state should produce zero utility/age arrays matching the trunk."""

    def test_init_cbp_state_shapes(self):
        learner = MultiHeadMLPLearner(
            n_heads=3, hidden_sizes=(32, 16), sparsity=0.0
        )
        mlp_state = learner.init(feature_dim=8, key=jr.key(0))
        cbp_state = init_cbp_state(mlp_state, (32, 16), key=jr.key(1))

        assert isinstance(cbp_state, ContinualBackpropState)
        assert len(cbp_state.utilities) == 2
        chex.assert_shape(cbp_state.utilities[0], (32,))
        chex.assert_shape(cbp_state.utilities[1], (16,))
        assert len(cbp_state.ages) == 2
        chex.assert_shape(cbp_state.ages[0], (32,))
        chex.assert_shape(cbp_state.ages[1], (16,))
        # Initial values are all zero.
        for u in cbp_state.utilities:
            chex.assert_trees_all_close(u, jnp.zeros_like(u))
        for a in cbp_state.ages:
            assert int(jnp.sum(a)) == 0

    def test_init_cbp_state_linear_baseline(self):
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(), sparsity=0.0
        )
        mlp_state = learner.init(feature_dim=5, key=jr.key(0))
        cbp_state = init_cbp_state(mlp_state, (), key=jr.key(1))
        assert len(cbp_state.utilities) == 0
        assert len(cbp_state.ages) == 0

    def test_init_cbp_state_mismatch_raises(self):
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(8,), sparsity=0.0
        )
        mlp_state = learner.init(feature_dim=4, key=jr.key(0))
        try:
            init_cbp_state(mlp_state, (8, 4), key=jr.key(1))
        except ValueError:
            return
        raise AssertionError("expected ValueError on mismatched hidden_sizes")


# =============================================================================
# Utility update behaviour
# =============================================================================


class TestUtilityUpdate:
    """Utility EMA should respond to active vs inactive units."""

    def test_utility_increases_with_active_unit(self):
        """After repeated nonzero (act, grad), the utility EMA must rise."""
        # Two-layer trunk so we can target the second layer with known
        # activations and gradients.
        layer_size = 4
        cbp_state = ContinualBackpropState(  # type: ignore[call-arg]
            utilities=(jnp.zeros(layer_size, dtype=jnp.float32),),
            ages=(jnp.zeros(layer_size, dtype=jnp.int32),),
            replacement_accumulators=jnp.zeros(1, dtype=jnp.float32),
            rng_key=jr.key(0),
        )
        # Activation = 1 everywhere, gradient = [1, 0, 1, 0].
        activations = (jnp.array([1.0, 1.0, 1.0, 1.0], dtype=jnp.float32),)
        grads = (jnp.array([1.0, 0.0, 1.0, 0.0], dtype=jnp.float32),)

        # Run many EMA updates.
        decay = 0.9
        state = cbp_state
        for _ in range(100):
            state = update_utility(state, activations, grads, decay)

        u_final = state.utilities[0]
        # Active units (0, 2) should have a much larger utility than
        # inactive units (1, 3).
        assert float(u_final[0]) > float(u_final[1])
        assert float(u_final[2]) > float(u_final[3])
        # Inactive should still be ~0.
        assert float(u_final[1]) < 1e-6
        assert float(u_final[3]) < 1e-6
        # Active should have approached 1.0 from below.
        assert 0.0 < float(u_final[0]) < 1.0

    def test_age_increments_each_call(self):
        cbp_state = ContinualBackpropState(  # type: ignore[call-arg]
            utilities=(jnp.zeros(3, dtype=jnp.float32),),
            ages=(jnp.zeros(3, dtype=jnp.int32),),
            replacement_accumulators=jnp.zeros(1, dtype=jnp.float32),
            rng_key=jr.key(0),
        )
        acts = (jnp.zeros(3, dtype=jnp.float32),)
        grads = (jnp.zeros(3, dtype=jnp.float32),)
        state = cbp_state
        for _ in range(10):
            state = update_utility(state, acts, grads, 0.99)
        assert int(state.ages[0][0]) == 10
        assert int(state.ages[0][1]) == 10
        assert int(state.ages[0][2]) == 10


class TestWrapperUtilityGradients:
    """The CBP wrapper should track utility in every hidden layer."""

    def test_multilayer_update_assigns_utility_to_earlier_layers(self):
        learner = CBPMultiHeadMLPLearner(
            n_heads=1,
            hidden_sizes=(6, 5),
            cbp_config=ContinualBackpropConfig(
                decay_rate=0.0,
                replacement_rate=0.0,
                maturity_threshold=1000,
                enabled=True,
            ),
            step_size=0.01,
            sparsity=0.0,
            use_layer_norm=False,
        )
        state = learner.init(feature_dim=4, key=jr.key(123))
        obs = jnp.array([0.4, -0.2, 0.7, 1.0], dtype=jnp.float32)
        targets = jnp.array([1.5], dtype=jnp.float32)

        result = learner.update(state, obs, targets)

        first_layer_utility = float(jnp.sum(result.state.cbp_state.utilities[0]))
        second_layer_utility = float(jnp.sum(result.state.cbp_state.utilities[1]))
        assert first_layer_utility > 1e-8
        assert second_layer_utility > 1e-8


# =============================================================================
# Replacement re-initializes low-utility units
# =============================================================================


class TestReplacement:
    """maybe_replace_units must re-init low-utility units beyond maturity."""

    def test_replacement_re_initializes_low_utility_unit(self):
        """Force a replacement and verify the unit's incoming weights changed."""
        learner = MultiHeadMLPLearner(
            n_heads=1, hidden_sizes=(4,), sparsity=0.0
        )
        mlp_state = learner.init(feature_dim=3, key=jr.key(42))
        cbp_state = init_cbp_state(mlp_state, (4,), key=jr.key(7))

        # Set utilities so unit 2 has the lowest, age above maturity.
        utilities = (jnp.array([5.0, 5.0, 0.001, 5.0], dtype=jnp.float32),)
        ages = (jnp.array([200, 200, 200, 200], dtype=jnp.int32),)
        # Force the replacement accumulator high enough to fire this step.
        accum = jnp.array([1.0], dtype=jnp.float32)
        cbp_state = cbp_state.replace(  # type: ignore[attr-defined]
            utilities=utilities, ages=ages, replacement_accumulators=accum
        )

        config = ContinualBackpropConfig(
            decay_rate=0.99,
            replacement_rate=1.0,  # large -> guaranteed to fire
            maturity_threshold=100,
            enabled=True,
        )

        old_row_2 = mlp_state.trunk_params.weights[0][2].copy()
        new_mlp_state, new_cbp_state = maybe_replace_units(
            mlp_state, cbp_state, config, sparsity=0.0
        )
        new_row_2 = new_mlp_state.trunk_params.weights[0][2]
        # The chosen unit's row should differ from before (with sparsity=0
        # the new row is dense, drawn from sparse_init).
        assert not jnp.allclose(old_row_2, new_row_2), (
            "replaced unit's incoming weights should change"
        )
        # Other rows must NOT change.
        chex.assert_trees_all_close(
            mlp_state.trunk_params.weights[0][0],
            new_mlp_state.trunk_params.weights[0][0],
        )
        chex.assert_trees_all_close(
            mlp_state.trunk_params.weights[0][1],
            new_mlp_state.trunk_params.weights[0][1],
        )
        chex.assert_trees_all_close(
            mlp_state.trunk_params.weights[0][3],
            new_mlp_state.trunk_params.weights[0][3],
        )
        # Outgoing column 2 in the head weight matrix should be zero.
        head_w = new_mlp_state.head_params.weights[0]
        chex.assert_trees_all_close(
            head_w[:, 2], jnp.zeros_like(head_w[:, 2])
        )

    def test_age_resets_on_replacement(self):
        learner = MultiHeadMLPLearner(
            n_heads=1, hidden_sizes=(4,), sparsity=0.0
        )
        mlp_state = learner.init(feature_dim=3, key=jr.key(42))
        cbp_state = init_cbp_state(mlp_state, (4,), key=jr.key(7))

        utilities = (jnp.array([5.0, 5.0, 0.001, 5.0], dtype=jnp.float32),)
        ages = (jnp.array([200, 200, 200, 200], dtype=jnp.int32),)
        cbp_state = cbp_state.replace(  # type: ignore[attr-defined]
            utilities=utilities,
            ages=ages,
            replacement_accumulators=jnp.array([1.0], dtype=jnp.float32),
        )
        config = ContinualBackpropConfig(
            decay_rate=0.99,
            replacement_rate=1.0,
            maturity_threshold=100,
            enabled=True,
        )
        _, new_cbp = maybe_replace_units(
            mlp_state, cbp_state, config, sparsity=0.0
        )
        # Unit 2 had lowest utility, so its age should be reset to 0.
        assert int(new_cbp.ages[0][2]) == 0
        # Other units retain their age.
        assert int(new_cbp.ages[0][0]) == 200
        assert int(new_cbp.ages[0][1]) == 200
        assert int(new_cbp.ages[0][3]) == 200
        # Utility of replaced unit should be reset to 0.
        assert float(new_cbp.utilities[0][2]) == 0.0

    def test_maturity_threshold_protects_young_units(self):
        """No unit above maturity_threshold => no replacement happens."""
        learner = MultiHeadMLPLearner(
            n_heads=1, hidden_sizes=(4,), sparsity=0.0
        )
        mlp_state = learner.init(feature_dim=3, key=jr.key(42))
        cbp_state = init_cbp_state(mlp_state, (4,), key=jr.key(7))

        # Even though utility is very low, every unit's age is below
        # maturity threshold.
        utilities = (jnp.array([0.001, 0.001, 0.001, 0.001], dtype=jnp.float32),)
        ages = (jnp.array([5, 5, 5, 5], dtype=jnp.int32),)
        cbp_state = cbp_state.replace(  # type: ignore[attr-defined]
            utilities=utilities,
            ages=ages,
            replacement_accumulators=jnp.array([1.0], dtype=jnp.float32),
        )
        config = ContinualBackpropConfig(
            decay_rate=0.99,
            replacement_rate=1.0,
            maturity_threshold=100,
            enabled=True,
        )

        new_mlp_state, new_cbp = maybe_replace_units(
            mlp_state, cbp_state, config, sparsity=0.0
        )
        # All weights must be unchanged.
        chex.assert_trees_all_close(
            mlp_state.trunk_params.weights[0],
            new_mlp_state.trunk_params.weights[0],
        )
        # Ages and utilities must be unchanged.
        chex.assert_trees_all_close(cbp_state.ages[0], new_cbp.ages[0])
        chex.assert_trees_all_close(
            cbp_state.utilities[0], new_cbp.utilities[0]
        )


# =============================================================================
# enabled=False = noop
# =============================================================================


class TestDisabledIsNoop:
    """With enabled=False, the wrapper must match plain MultiHeadMLPLearner."""

    def test_disabled_means_noop(self):
        feature_dim = 5
        n_heads = 2
        cbp_config = ContinualBackpropConfig(enabled=False)
        cbp_learner = CBPMultiHeadMLPLearner(
            n_heads=n_heads,
            hidden_sizes=(8,),
            cbp_config=cbp_config,
            step_size=0.1,
            sparsity=0.0,
        )
        plain_learner = MultiHeadMLPLearner(
            n_heads=n_heads,
            hidden_sizes=(8,),
            step_size=0.1,
            sparsity=0.0,
        )
        # Same key feeds both: cbp_learner.init splits the key internally
        # so the underlying MLP gets the first split. Match it manually.
        key = jr.key(2024)
        mlp_key, _cbp_key = jr.split(key)

        cbp_state = cbp_learner.init(feature_dim, key)
        plain_state = plain_learner.init(feature_dim, mlp_key)

        # Sanity: same starting weights.
        chex.assert_trees_all_close(
            cbp_state.mlp_state.trunk_params.weights[0],
            plain_state.trunk_params.weights[0],
        )

        # Run a few updates on identical data.
        observations = jr.normal(jr.key(11), (10, feature_dim))
        targets = jr.normal(jr.key(12), (10, n_heads))

        cbp_running = cbp_state
        plain_running = plain_state
        for i in range(observations.shape[0]):
            obs = observations[i]
            tgt = targets[i]
            cbp_result = cbp_learner.update(cbp_running, obs, tgt)
            plain_result = plain_learner.update(plain_running, obs, tgt)

            # Predictions and trunk weights should match exactly.
            chex.assert_trees_all_close(
                cbp_result.predictions, plain_result.predictions, atol=1e-6
            )
            chex.assert_trees_all_close(
                cbp_result.state.mlp_state.trunk_params.weights[0],
                plain_result.state.trunk_params.weights[0],
                atol=1e-6,
            )

            cbp_running = cbp_result.state
            plain_running = plain_result.state


# =============================================================================
# JIT compatibility
# =============================================================================


class TestJitCompatibility:
    """Utility update should JIT-compile and produce identical results."""

    def test_jit_compatibility(self):
        """jit(update_utility) matches eager update_utility output."""
        cbp_state = ContinualBackpropState(  # type: ignore[call-arg]
            utilities=(jnp.zeros(4, dtype=jnp.float32),),
            ages=(jnp.zeros(4, dtype=jnp.int32),),
            replacement_accumulators=jnp.zeros(1, dtype=jnp.float32),
            rng_key=jr.key(0),
        )
        acts = (jnp.array([1.0, 0.5, -0.2, 0.0], dtype=jnp.float32),)
        grads = (jnp.array([0.1, 0.4, -0.3, 0.2], dtype=jnp.float32),)
        decay = 0.9

        # Eager version.
        eager_out = update_utility(cbp_state, acts, grads, decay)

        # JITted version (decay must be a JAX scalar so we close over it).
        @jax.jit
        def step(s, a, g):
            return update_utility(s, a, g, decay)

        jit_out = step(cbp_state, acts, grads)

        chex.assert_trees_all_close(
            eager_out.utilities[0], jit_out.utilities[0]
        )
        chex.assert_trees_all_close(eager_out.ages[0], jit_out.ages[0])

    def test_full_update_jit_compatible(self):
        """The full CBPMultiHeadMLPLearner.update is JIT-compiled & runs."""
        learner = CBPMultiHeadMLPLearner(
            n_heads=2,
            hidden_sizes=(8,),
            cbp_config=ContinualBackpropConfig(
                decay_rate=0.99,
                replacement_rate=0.05,
                maturity_threshold=10,
            ),
            step_size=0.05,
            sparsity=0.0,
        )
        state = learner.init(feature_dim=4, key=jr.key(0))
        obs = jr.normal(jr.key(1), (4,))
        targets = jnp.array([0.5, -0.3])
        # Multiple update calls reuse the cached compilation.
        for _ in range(5):
            result = learner.update(state, obs, targets)
            chex.assert_tree_all_finite(result.predictions)
            chex.assert_tree_all_finite(result.errors)
            state = result.state


# =============================================================================
# Wrapper plumbing: shapes, init split, predict path
# =============================================================================


class TestWrapperPlumbing:
    """CBPMultiHeadMLPLearner constructor + init/predict basics."""

    def test_init_returns_joint_state(self):
        learner = CBPMultiHeadMLPLearner(
            n_heads=2,
            hidden_sizes=(16, 8),
            cbp_config=ContinualBackpropConfig(),
            sparsity=0.0,
        )
        state = learner.init(feature_dim=5, key=jr.key(0))
        assert isinstance(state, CBPMultiHeadMLPState)
        # Trunk shapes match.
        chex.assert_shape(state.mlp_state.trunk_params.weights[0], (16, 5))
        chex.assert_shape(state.mlp_state.trunk_params.weights[1], (8, 16))
        # CBP shapes match.
        chex.assert_shape(state.cbp_state.utilities[0], (16,))
        chex.assert_shape(state.cbp_state.utilities[1], (8,))

    def test_predict_shape(self):
        learner = CBPMultiHeadMLPLearner(
            n_heads=4,
            hidden_sizes=(8,),
            cbp_config=ContinualBackpropConfig(),
            sparsity=0.0,
        )
        state = learner.init(feature_dim=3, key=jr.key(0))
        preds = learner.predict(state, jnp.array([0.1, -0.2, 0.5]))
        chex.assert_shape(preds, (4,))
        chex.assert_tree_all_finite(preds)


class TestSingleOutputCBPMLP:
    """Single-output CBP MLP adapter should behave like a scalar learner."""

    def test_update_returns_scalar_prediction_and_error(self):
        learner = CBPMLPLearner(
            hidden_sizes=(8,),
            cbp_config=ContinualBackpropConfig(
                decay_rate=0.99,
                replacement_rate=0.0,
                maturity_threshold=100,
            ),
            step_size=0.05,
            sparsity=0.0,
        )
        state = learner.init(feature_dim=4, key=jr.key(13))
        assert isinstance(state, CBPMLPState)

        result = learner.update(
            state,
            jnp.array([0.2, -0.1, 0.4, 0.7], dtype=jnp.float32),
            jnp.array(1.0, dtype=jnp.float32),
        )

        chex.assert_shape(result.prediction, ())
        chex.assert_shape(result.error, ())
        chex.assert_shape(result.metrics, (3,))
        chex.assert_shape(result.replacements_made, (1,))
        chex.assert_tree_all_finite(result.metrics)

    def test_config_roundtrip(self):
        learner = CBPMLPLearner(
            hidden_sizes=(16, 8),
            cbp_config=ContinualBackpropConfig(
                decay_rate=0.97,
                replacement_rate=2e-4,
                maturity_threshold=200,
            ),
            step_size=0.05,
            sparsity=0.5,
            utility_decay=0.95,
        )

        rebuilt = CBPMLPLearner.from_config(learner.to_config())

        assert rebuilt.to_config() == learner.to_config()


# =============================================================================
# Full loop smoke test
# =============================================================================


class TestLoop:
    """run_cbp_learning_loop should run end-to-end."""

    def test_run_cbp_learning_loop_smoke(self):
        learner = CBPMultiHeadMLPLearner(
            n_heads=1,
            hidden_sizes=(8,),
            cbp_config=ContinualBackpropConfig(
                decay_rate=0.99,
                replacement_rate=0.01,
                maturity_threshold=20,
                enabled=True,
            ),
            step_size=0.05,
            sparsity=0.0,
        )
        state = learner.init(feature_dim=4, key=jr.key(0))
        observations = jr.normal(jr.key(1), (50, 4))
        targets = jr.normal(jr.key(2), (50, 1))

        result = run_cbp_learning_loop(learner, state, observations, targets)
        assert isinstance(result, CBPLearningResult)
        chex.assert_shape(result.per_head_metrics, (50, 1, 3))
        chex.assert_shape(result.replacements_made, (50, 1))


# =============================================================================
# Tracker dataclass
# =============================================================================


class TestTrackerDataclass:
    """ContinualBackpropTracker is a thin handle bundling config + sparsity."""

    def test_tracker_construct(self):
        tracker = ContinualBackpropTracker(
            config=ContinualBackpropConfig(
                decay_rate=0.95,
                replacement_rate=1e-3,
                maturity_threshold=50,
                enabled=True,
            ),
            sparsity=0.5,
        )
        assert tracker.config.decay_rate == 0.95
        assert tracker.sparsity == 0.5


# =============================================================================
# Config roundtrip
# =============================================================================


class TestConfigRoundtrip:
    """to_config/from_config preserves CBP config + learner hyperparameters."""

    def test_roundtrip(self):
        learner = CBPMultiHeadMLPLearner(
            n_heads=2,
            hidden_sizes=(16, 8),
            cbp_config=ContinualBackpropConfig(
                decay_rate=0.97,
                replacement_rate=2e-4,
                maturity_threshold=200,
                enabled=True,
            ),
            step_size=0.05,
            sparsity=0.5,
        )
        cfg = learner.to_config()
        assert cfg["type"] == "CBPMultiHeadMLPLearner"
        rebuilt = CBPMultiHeadMLPLearner.from_config(cfg)
        cfg2 = rebuilt.to_config()
        assert cfg2 == cfg
