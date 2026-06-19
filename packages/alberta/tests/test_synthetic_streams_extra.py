"""Additional tests for synthetic streams beyond the original Sutton 1992 task.

Covers the ``noise_std`` and ``bias_drift_rate`` extensions to
:class:`SuttonExperiment1Stream` that bring it in line with the Alberta Plan
Step 1 specification while preserving backward compatibility with the
noiseless 1992 replication, plus the hidden-state AR(2) stream introduced
for the Step 3 DoD-7 hidden-state demonstration.
"""

import chex
import jax.numpy as jnp
import jax.random as jr
import pytest

from alberta_framework.streams.synthetic import (
    HiddenStateAR2Stream,
    SuttonExperiment1Stream,
)


def _collect_targets(
    stream: SuttonExperiment1Stream, key: jnp.ndarray, num_steps: int
) -> jnp.ndarray:
    """Run a stream for ``num_steps`` and return the stacked scalar targets."""
    state = stream.init(key)
    targets = []
    for i in range(num_steps):
        timestep, state = stream.step(state, jnp.array(i))
        targets.append(timestep.target[0])
    return jnp.stack(targets)


def test_sutton_stream_default_is_noiseless():
    """Backward compat: default stream is byte-for-byte the original task.

    With ``noise_std=0.0`` and ``bias_drift_rate=0.0`` the target at step 0
    must equal the dot product of the (all-+1) signs and the first 5 inputs
    exactly, with zero contribution from the irrelevant inputs.
    """
    key = jr.key(0)
    stream = SuttonExperiment1Stream(num_relevant=5, num_irrelevant=15)
    state = stream.init(key)
    timestep, _ = stream.step(state, jnp.array(0))

    expected = jnp.sum(timestep.observation[:5])
    assert jnp.isclose(timestep.target[0], expected, rtol=1e-5, atol=1e-6)


def test_sutton_stream_noise_changes_target_distribution():
    """With ``noise_std=1.0`` the target spread strictly exceeds the noiseless case.

    Run two streams that share the same ``init`` key (so the relevant signs and
    the input-key derivation are identical). Because the noise key is split off
    before the input key, the input streams are NOT identical between the two
    runs, but the noiseless stream's target std equals the std of a sum of 5
    independent N(0,1) values (~ sqrt(5) ~ 2.236), while the noisy stream adds
    an independent unit-variance noise per step, increasing the std.
    """
    key = jr.key(123)
    n_steps = 1000

    noiseless_stream = SuttonExperiment1Stream(
        num_relevant=5, num_irrelevant=15, noise_std=0.0
    )
    noisy_stream = SuttonExperiment1Stream(
        num_relevant=5, num_irrelevant=15, noise_std=1.0
    )

    targets_clean = _collect_targets(noiseless_stream, key, n_steps)
    targets_noisy = _collect_targets(noisy_stream, key, n_steps)

    std_clean = float(jnp.std(targets_clean))
    std_noisy = float(jnp.std(targets_noisy))

    # Sanity: no NaNs / infs.
    assert jnp.all(jnp.isfinite(targets_clean))
    assert jnp.all(jnp.isfinite(targets_noisy))

    # The noisy stream must have visibly larger target spread.
    assert std_noisy > std_clean, (
        f"expected noisy target std > clean target std, got "
        f"{std_noisy:.4f} vs {std_clean:.4f}"
    )

    # Concrete sanity check: the clean target std should be close to sqrt(5)
    # since the relevant inputs are iid N(0,1) and signs are +/-1; tolerate
    # 20% slack for the small change-of-sign perturbation across 1000 steps.
    assert abs(std_clean - jnp.sqrt(5.0)) < 0.5, std_clean


def test_sutton_stream_bias_drift_changes_irrelevant_weights():
    """Long-horizon: ``bias_drift_rate > 0`` injects extra variance via x_irr.

    The irrelevant weights start at zero and follow an independent Gaussian
    random walk with std ``bias_drift_rate`` per step. After many steps the
    irrelevant-weight vector has nontrivial magnitude, and because x_irr is
    drawn iid N(0, 1) the target picks up extra variance from the
    ``wt_irr . x_irr`` contribution that is absent when ``bias_drift_rate=0.0``.

    We exercise this by comparing target std between two long runs that share
    the same init key but differ in ``bias_drift_rate``.
    """
    key = jr.key(7)
    n_steps = 5000

    no_drift = SuttonExperiment1Stream(
        num_relevant=5, num_irrelevant=15, bias_drift_rate=0.0
    )
    with_drift = SuttonExperiment1Stream(
        num_relevant=5, num_irrelevant=15, bias_drift_rate=0.05
    )

    targets_no_drift = _collect_targets(no_drift, key, n_steps)
    targets_with_drift = _collect_targets(with_drift, key, n_steps)

    std_no_drift = float(jnp.std(targets_no_drift))
    std_with_drift = float(jnp.std(targets_with_drift))

    # Sanity: no NaNs / infs.
    assert jnp.all(jnp.isfinite(targets_no_drift))
    assert jnp.all(jnp.isfinite(targets_with_drift))

    # Drifting irrelevant weights inject extra target variance over time.
    assert std_with_drift > std_no_drift, (
        f"expected drifting-bias target std > no-drift, got "
        f"{std_with_drift:.4f} vs {std_no_drift:.4f}"
    )

    # And the irrelevant weights themselves should have moved off zero.
    state = with_drift.init(key)
    for i in range(n_steps):
        _, state = with_drift.step(state, jnp.array(i))
    assert float(jnp.max(jnp.abs(state.wt_irr))) > 0.0


def test_sutton_stream_bias_drift_default_keeps_irrelevant_weights_zero():
    """Backward-compat sanity: with default ``bias_drift_rate=0.0`` the
    irrelevant-weight vector stays identically zero forever."""
    key = jr.key(11)
    stream = SuttonExperiment1Stream(num_relevant=5, num_irrelevant=15)
    state = stream.init(key)
    for i in range(200):
        _, state = stream.step(state, jnp.array(i))
    assert jnp.all(state.wt_irr == 0.0)


# =============================================================================
# HiddenStateAR2Stream tests
# =============================================================================


def test_hidden_ar2_shapes():
    """``step`` returns 1D observation of shape ``(feature_dim,)`` and a scalar
    target of shape ``(1,)``."""
    stream = HiddenStateAR2Stream(feature_dim=8, visible_dim=2)
    state = stream.init(jr.key(0))
    timestep, _ = stream.step(state, jnp.array(0))
    chex.assert_shape(timestep.observation, (8,))
    chex.assert_shape(timestep.target, (1,))


def test_hidden_ar2_finite():
    """1000 steps under default config produce finite, bounded values."""
    stream = HiddenStateAR2Stream(feature_dim=8, visible_dim=2)
    state = stream.init(jr.key(1))
    for i in range(1000):
        timestep, state = stream.step(state, jnp.array(i))
        assert jnp.all(jnp.isfinite(timestep.observation))
        assert jnp.all(jnp.isfinite(timestep.target))


def test_hidden_ar2_stationarity_rejects_bad_phi():
    """Init raises for AR(2) coefficients outside the stationarity triangle."""
    # phi1 + phi2 >= 1
    with pytest.raises(ValueError, match="stationarity"):
        HiddenStateAR2Stream(feature_dim=8, visible_dim=2, phi1=0.8, phi2=0.3)
    # phi2 - phi1 >= 1 (phi1 negative, phi2 positive, large)
    with pytest.raises(ValueError, match="stationarity"):
        HiddenStateAR2Stream(feature_dim=8, visible_dim=2, phi1=-0.6, phi2=0.5)
    # |phi2| >= 1
    with pytest.raises(ValueError, match="stationarity"):
        HiddenStateAR2Stream(feature_dim=8, visible_dim=2, phi1=0.0, phi2=-1.0)


def test_hidden_ar2_visible_dim_validation():
    """``visible_dim`` and ``feature_dim`` must leave at least 2 hidden channels."""
    with pytest.raises(ValueError, match="visible_dim"):
        HiddenStateAR2Stream(feature_dim=4, visible_dim=4)
    with pytest.raises(ValueError, match="hidden"):
        HiddenStateAR2Stream(feature_dim=4, visible_dim=3)


def test_hidden_ar2_target_depends_on_hidden():
    """Target should differ when the hidden block changes, holding visible
    fixed.

    Because the target uses the FULL state (visible + hidden) and a
    hidden-pair product, perturbing the hidden block must move the target.
    """
    stream = HiddenStateAR2Stream(
        feature_dim=8,
        visible_dim=2,
        phi1=0.0,
        phi2=0.0,  # no AR coupling so the target only depends on x_t
        innovation_std=0.0,  # deterministic given x_prev/x_prev2 and noise=0
        target_noise_std=0.0,
    )
    state = stream.init(jr.key(0))
    # Override x_prev so that the next step's x_t equals state.x_prev *
    # phi1 + state.x_prev2 * phi2 = 0 + 0 = 0; with innovation_std=0 the
    # next observation will be all zeros and target = 0 + alpha * 0 * 0 = 0.
    state_zero = state.replace(  # type: ignore[attr-defined]
        x_prev=jnp.zeros(8, dtype=jnp.float32),
        x_prev2=jnp.zeros(8, dtype=jnp.float32),
    )
    timestep_zero, _ = stream.step(state_zero, jnp.array(0))
    assert jnp.allclose(timestep_zero.observation, jnp.zeros(8), atol=1e-6)
    assert jnp.isclose(timestep_zero.target[0], 0.0, atol=1e-6)

    # Now set hidden block to nonzero values; with phi=0 and innov=0 the
    # observation in the next step is again zeros, but the previous step's
    # nonzero hidden state is what fed the AR(2) update -- so we'll directly
    # validate the same step shape with a stream that propagates state.
    stream2 = HiddenStateAR2Stream(
        feature_dim=8,
        visible_dim=2,
        phi1=1.0,
        phi2=0.0,  # x_t = x_{t-1} (deterministic when innov_std=0)
        innovation_std=0.0,
        nonlinear_coeff=1.0,
        target_noise_std=0.0,
    )
    state2 = stream2.init(jr.key(2))
    state2_with_hidden = state2.replace(  # type: ignore[attr-defined]
        x_prev=jnp.array([0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
                         dtype=jnp.float32),
        x_prev2=jnp.zeros(8, dtype=jnp.float32),
    )
    state2_no_hidden = state2.replace(  # type: ignore[attr-defined]
        x_prev=jnp.array([0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
                         dtype=jnp.float32),
        x_prev2=jnp.zeros(8, dtype=jnp.float32),
    )
    target_with_hidden, _ = stream2.step(state2_with_hidden, jnp.array(0))
    target_no_hidden, _ = stream2.step(state2_no_hidden, jnp.array(0))
    assert not jnp.isclose(
        target_with_hidden.target[0], target_no_hidden.target[0], atol=1e-3
    ), "target must depend on the hidden block"


def test_hidden_ar2_state_propagates_ar2():
    """``x_prev`` advances to the new ``x_t`` and ``x_prev2`` advances to old
    ``x_prev`` after each step (AR(2) shift register)."""
    stream = HiddenStateAR2Stream(feature_dim=8, visible_dim=2)
    state = stream.init(jr.key(3))
    saved_x_prev = state.x_prev
    timestep, new_state = stream.step(state, jnp.array(0))
    # New x_prev2 should match old x_prev exactly (no innovations enter here).
    chex.assert_trees_all_close(new_state.x_prev2, saved_x_prev)
    # New x_prev should match the emitted observation.
    chex.assert_trees_all_close(new_state.x_prev, timestep.observation)
