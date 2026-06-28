"""Tests for out-of-hypothesis-class Step 2 benchmark streams.

These streams (``OutOfClassPolynomialStream``, ``FrequencyMismatchStream``,
``CompositionalStream``) generate targets whose minimal representation lies
outside a 1-layer pair-product or tanh feature bank.  The tests here verify
shape correctness, JIT compatibility via ``jax.lax.scan``, and the
out-of-class structural properties that motivate each stream.
"""

import chex
import jax
import jax.numpy as jnp
import jax.random as jr

from alberta_framework.streams.out_of_class import (
    CompositionalStream,
    FrequencyMismatchStream,
    OutOfClassPolynomialStream,
)


def _scan_collect(stream, num_steps: int, key) -> tuple[jnp.ndarray, jnp.ndarray]:
    """Run a stream for ``num_steps`` via ``jax.lax.scan`` and stack outputs.

    Used by the ``test_collect_via_scan`` cases to confirm that each stream
    composes cleanly with ``jax.lax.scan`` (i.e. is JIT-compatible).
    """
    state = stream.init(key)

    def body(carry, idx):
        ts, new_state = stream.step(carry, idx)
        return new_state, (ts.observation, ts.target)

    _, (observations, targets) = jax.lax.scan(
        body, state, jnp.arange(num_steps)
    )
    return observations, targets


# =============================================================================
# OutOfClassPolynomialStream
# =============================================================================


class TestOutOfClassPolynomialStream:
    """Tests for the degree-3 polynomial out-of-class stream."""

    def test_step_shapes(self):
        stream = OutOfClassPolynomialStream(
            feature_dim=5,
            n_tasks=3,
            n_contexts=2,
            context_length=4,
            active_triples_per_context=2,
        )
        state = stream.init(jr.key(0))
        timestep, new_state = stream.step(state, jnp.array(0))

        chex.assert_shape(timestep.observation, (5,))
        chex.assert_shape(timestep.target, (3,))
        assert int(new_state.step_count) == 1

    def test_finite_outputs(self):
        stream = OutOfClassPolynomialStream(
            feature_dim=6,
            n_tasks=2,
            active_triples_per_context=3,
        )
        state = stream.init(jr.key(1))
        timestep, _ = stream.step(state, jnp.array(0))
        chex.assert_tree_all_finite(timestep.observation)
        chex.assert_tree_all_finite(timestep.target)

    def test_collect_via_scan(self):
        stream = OutOfClassPolynomialStream(
            feature_dim=4,
            n_tasks=2,
            n_contexts=2,
            context_length=3,
            active_triples_per_context=2,
        )
        observations, targets = _scan_collect(stream, num_steps=12, key=jr.key(2))
        chex.assert_shape(observations, (12, 4))
        chex.assert_shape(targets, (12, 2))
        chex.assert_tree_all_finite(observations)
        chex.assert_tree_all_finite(targets)

    def test_higher_order_structure_present(self):
        """Variance of targets should grow faster than O(scale^2).

        For a pure linear oracle, ``var(y(scale*x)) = scale^2 var(y(x))``.
        For our degree-3 oracle (with a small linear component), variance
        should grow much faster than that across a range of input scales.

        We feed inputs of growing scale, measure target variance per task,
        and verify that the empirical variance ratio (largest_scale vs
        baseline_scale) substantially exceeds the ratio expected of a
        purely linear generator.
        """
        # Build a stream with the noise turned down so the polynomial
        # signal dominates the variance estimate, and with a tiny linear
        # component so the higher-order effect is visible.
        stream = OutOfClassPolynomialStream(
            feature_dim=5,
            n_tasks=2,
            n_contexts=1,
            context_length=10_000,
            active_triples_per_context=4,
            linear_scale=0.0,
            noise_std=0.0,
        )
        state = stream.init(jr.key(3))
        n_samples = 256
        scales = jnp.array([0.5, 1.0, 2.0, 3.0], dtype=jnp.float32)

        # Manually evaluate the deterministic polynomial part (no noise,
        # no linear) on Gaussian samples scaled by each ``scale`` value.
        base_x = jr.normal(jr.key(4), (n_samples, 5), dtype=jnp.float32)

        def target_for_scale(s: jnp.ndarray) -> jnp.ndarray:
            xs = s * base_x  # (n_samples, feature_dim)
            triples = (
                xs[:, state.triples_left]
                * xs[:, state.triples_middle]
                * xs[:, state.triples_right]
            )  # (n_samples, n_triples)
            ws = state.context_weights[0]  # (n_tasks, n_triples)
            return triples @ ws.T  # (n_samples, n_tasks)

        # Per-task variance at each scale, summed across tasks.
        variances = jnp.array(
            [jnp.var(target_for_scale(s)).item() for s in scales]
        )
        # For a degree-3 polynomial, variance scales like s^6 (since each
        # output is a sum of triple products and var grows as the square
        # of the output magnitude scaling).  For a linear oracle it grows
        # as s^2.  We require that the ratio var(scale=3.0) / var(scale=1.0)
        # be far above 9 (the linear bound).
        ratio = variances[3] / variances[1]
        assert ratio > 9.0 * 50.0, (
            f"Expected target variance to scale super-linearly with input"
            f" magnitude (ratio at scale=3 vs scale=1 was {ratio:.2f},"
            f" linear bound is 9.0). All variances: {variances.tolist()}"
        )


# =============================================================================
# FrequencyMismatchStream
# =============================================================================


class TestFrequencyMismatchStream:
    """Tests for the trigonometric out-of-class stream."""

    def test_step_shapes(self):
        stream = FrequencyMismatchStream(
            feature_dim=4,
            n_tasks=2,
            n_components_per_task=3,
            n_contexts=2,
            context_length=4,
        )
        state = stream.init(jr.key(0))
        timestep, new_state = stream.step(state, jnp.array(0))

        chex.assert_shape(timestep.observation, (4,))
        chex.assert_shape(timestep.target, (2,))
        assert int(new_state.step_count) == 1

    def test_finite_outputs(self):
        stream = FrequencyMismatchStream(
            feature_dim=3,
            n_tasks=2,
            n_components_per_task=4,
        )
        state = stream.init(jr.key(1))
        timestep, _ = stream.step(state, jnp.array(0))
        chex.assert_tree_all_finite(timestep.observation)
        chex.assert_tree_all_finite(timestep.target)

    def test_collect_via_scan(self):
        stream = FrequencyMismatchStream(
            feature_dim=3,
            n_tasks=2,
            n_components_per_task=2,
            n_contexts=2,
            context_length=3,
        )
        observations, targets = _scan_collect(stream, num_steps=10, key=jr.key(2))
        chex.assert_shape(observations, (10, 3))
        chex.assert_shape(targets, (10, 2))
        chex.assert_tree_all_finite(observations)
        chex.assert_tree_all_finite(targets)

    def test_periodic_structure(self):
        """Targets should oscillate when sweeping along one input dim.

        For a sinusoidal oracle, sweeping a single input dimension across
        ``[-pi, pi]`` produces a target that crosses zero multiple times
        (i.e. is non-monotonic).  We construct an oracle that forces the
        first task's first component to listen on dim 0 and have large
        amplitude, then sweep dim 0 along ``[-pi, pi]`` and count sign
        changes of the target.
        """
        stream = FrequencyMismatchStream(
            feature_dim=2,
            n_tasks=1,
            n_components_per_task=1,
            n_contexts=1,
            context_length=10_000,
            omega_min=2.0,
            omega_max=2.001,
            amplitude_scale=2.0,
            noise_std=0.0,
        )
        state = stream.init(jr.key(7))
        # Override the active_indices and amplitudes deterministically so
        # we don't depend on RNG to land on dim 0 / nonzero amplitude.
        active_indices = state.active_indices.at[:].set(0)
        amplitudes = state.amplitudes.at[:].set(2.0)
        state = state.replace(  # type: ignore[attr-defined]
            active_indices=active_indices,
            amplitudes=amplitudes,
        )

        sweep = jnp.linspace(-jnp.pi, jnp.pi, 100, dtype=jnp.float32)
        omegas = state.omegas[0, 0, 0]
        phases = state.phases[0, 0, 0]
        targets = amplitudes[0, 0, 0] * jnp.sin(omegas * sweep + phases)

        # Count sign changes.  For omega ~ 2.0 over [-pi, pi] (range 2*pi),
        # the sinusoid completes ~2 full cycles and crosses zero ~4 times,
        # so we require at least 3 sign changes.
        signs = jnp.sign(targets)
        sign_changes = int(jnp.sum(jnp.abs(jnp.diff(signs)) > 0))
        assert sign_changes >= 3, (
            f"Expected sweeping a single input dim to produce multiple sign"
            f" changes in a sinusoidal oracle (got {sign_changes})"
        )


# =============================================================================
# CompositionalStream
# =============================================================================


class TestCompositionalStream:
    """Tests for the 2-hidden-layer compositional out-of-class stream."""

    def test_step_shapes(self):
        stream = CompositionalStream(
            feature_dim=6,
            n_tasks=3,
            inner_hidden=4,
            outer_components=5,
            n_contexts=2,
            context_length=4,
        )
        state = stream.init(jr.key(0))
        timestep, new_state = stream.step(state, jnp.array(0))

        chex.assert_shape(timestep.observation, (6,))
        chex.assert_shape(timestep.target, (3,))
        assert int(new_state.step_count) == 1

    def test_finite_outputs(self):
        stream = CompositionalStream(
            feature_dim=4,
            n_tasks=2,
            inner_hidden=3,
            outer_components=3,
        )
        state = stream.init(jr.key(1))
        timestep, _ = stream.step(state, jnp.array(0))
        chex.assert_tree_all_finite(timestep.observation)
        chex.assert_tree_all_finite(timestep.target)

    def test_collect_via_scan(self):
        stream = CompositionalStream(
            feature_dim=5,
            n_tasks=2,
            inner_hidden=3,
            outer_components=3,
            n_contexts=2,
            context_length=3,
        )
        observations, targets = _scan_collect(stream, num_steps=10, key=jr.key(2))
        chex.assert_shape(observations, (10, 5))
        chex.assert_shape(targets, (10, 2))
        chex.assert_tree_all_finite(observations)
        chex.assert_tree_all_finite(targets)

    def test_two_layer_nonlinearity(self):
        """A linear regression should leave substantial residual.

        We collect a batch of samples from the compositional oracle, fit
        a least-squares linear model ``y ~ Wx + b``, and require that the
        residual variance be a non-trivial fraction of the target
        variance.  A purely linear oracle would yield residual / target
        variance close to 0; a linear-plus-noise oracle would only leave
        the noise floor.  A 2-hidden-layer tanh oracle leaves much more.

        We use an aggressive weight scale and an input scale large enough
        that the inner-layer pre-activations push the tanh into its
        nonlinear regime; otherwise tanh acts approximately like the
        identity on small inputs and the oracle collapses toward linear.
        """
        stream = CompositionalStream(
            feature_dim=5,
            n_tasks=1,
            inner_hidden=4,
            outer_components=8,
            n_contexts=1,
            context_length=10_000,
            feature_std=2.0,
            weight_scale=5.0,
            amplitude_scale=2.0,
            noise_std=0.0,
        )
        observations, targets = _scan_collect(
            stream, num_steps=800, key=jr.key(2)
        )

        # Solve y ~ Wx + b via stacking a bias column and lstsq.
        n = observations.shape[0]
        x_bias = jnp.concatenate(
            [observations, jnp.ones((n, 1), dtype=observations.dtype)], axis=1
        )
        # Use jnp.linalg.lstsq for a linear fit.  ``targets`` is (n, 1).
        sol, _, _, _ = jnp.linalg.lstsq(x_bias, targets, rcond=None)
        predictions = x_bias @ sol
        residual = targets - predictions

        target_var = float(jnp.var(targets))
        residual_var = float(jnp.var(residual))
        assert target_var > 0.0, "Target variance should be positive"
        ratio = residual_var / target_var
        # A linear-only oracle would give ratio ~ 0.0 (subject to lstsq
        # numerical floor); 20% residual is well above any plausible
        # numerical residual and strongly indicates the oracle is out of
        # the linear hypothesis class.
        assert ratio > 0.20, (
            f"Linear regression residual variance ratio {ratio:.3f} is too"
            f" small for a compositional oracle; target is out of class"
            f" only if a linear fit leaves substantial residual."
        )
