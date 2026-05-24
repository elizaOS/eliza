"""Tests for the Pavlovian / classical-conditioning stream.

Covers:
- Trial dynamics (CS-then-US pairing at the configured delay).
- Phase progression (extinction, blocking).
- Statistical properties (partial reinforcement rate, distractor
  independence).
- JIT compatibility under ``jax.lax.scan``.
- Determinism with the same key.
"""

from __future__ import annotations

import chex
import jax
import jax.numpy as jnp
import jax.random as jr

from alberta_framework.streams.pavlovian import (
    ClassicalConditioningStream,
    PavlovianPhase,
    PavlovianState,
    acquisition_scenario,
    blocking_scenario,
    extinction_scenario,
    partial_reinforcement_scenario,
    reacquisition_scenario,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _collect(
    stream: ClassicalConditioningStream,
    state: PavlovianState,
    n_steps: int,
) -> tuple[PavlovianState, jnp.ndarray, jnp.ndarray]:
    """Run a stream for ``n_steps`` and return (final_state, obs, targets)."""
    obs_list = []
    tgt_list = []
    for i in range(n_steps):
        ts, state = stream.step(state, jnp.array(i))
        obs_list.append(ts.observation)
        tgt_list.append(ts.target)
    return state, jnp.stack(obs_list), jnp.stack(tgt_list)


# ---------------------------------------------------------------------------
# Trial dynamics
# ---------------------------------------------------------------------------


def test_acquisition_us_follows_cs():
    """Every US must be preceded by a CS exactly ``cs_us_delay`` steps prior.

    In a noiseless ACQUISITION scenario with contingency = 1.0 the count
    of (CS_onset_at_t, US_at_t+delay) pairs should equal the count of US
    events.
    """
    cs_us_delay = 5
    stream = acquisition_scenario(
        n_steps=2000,
        cs_us_delay=cs_us_delay,
        cs_duration=1,
        iti_min=5,
        iti_max=10,
        noise_std=0.0,
        distractor_prob=0.0,
    )
    state = stream.init(jr.key(0))
    _, obs, tgt = _collect(stream, state, 1000)

    cs_indicator = (obs[:, 0] > 0.5).astype(jnp.float32)
    us_indicator = (tgt[:, 0] > 0.5).astype(jnp.float32)

    n_us = int(jnp.sum(us_indicator))
    assert n_us > 0, "expected at least some US events"

    # For every step where US fires, the CS must have been on at t - delay.
    us_indices = jnp.where(us_indicator > 0.5)[0]
    # Drop early indices where t - delay < 0.
    us_indices = us_indices[us_indices >= cs_us_delay]

    cs_at_minus_delay = cs_indicator[us_indices - cs_us_delay]
    n_cs_then_us = int(jnp.sum(cs_at_minus_delay > 0.5))
    assert n_cs_then_us == int(us_indices.shape[0])


def test_extinction_no_us_after_extinction_phase():
    """No US fires once we are unambiguously inside the extinction phase.

    Any trial in flight at the phase boundary is cancelled by the stream,
    so US events should be exactly zero throughout the extinction phase.
    """
    n_acq = 500
    n_ext = 500
    stream = extinction_scenario(
        n_acquisition=n_acq,
        n_extinction=n_ext,
        cs_us_delay=5,
        cs_duration=1,
        iti_min=5,
        iti_max=10,
        noise_std=0.0,
        distractor_prob=0.0,
    )
    state = stream.init(jr.key(1))
    final_state, obs, tgt = _collect(stream, state, n_acq + n_ext)

    us_indicator = tgt[:, 0] > 0.5
    us_in_acq = int(jnp.sum(us_indicator[:n_acq]))
    us_in_ext = int(jnp.sum(us_indicator[n_acq:]))

    assert us_in_acq > 0, "acquisition phase must produce US events"
    assert us_in_ext == 0, (
        f"extinction phase produced {us_in_ext} US events (expected 0)"
    )

    # Also check we did at least see CS firings in extinction (so the
    # stream is genuinely running, not stuck).
    cs_in_ext = int(jnp.sum(obs[n_acq:, 0] > 0.5))
    assert cs_in_ext > 0


def test_partial_reinforcement_rate():
    """Empirical P(US | trial) is within +/- 0.05 of the configured rate.

    A "trial" is defined here as the rising edge of the CS indicator.
    Each trial may or may not be followed by a US ``cs_us_delay`` steps
    later, and the configured contingency controls the rate.
    """
    p = 0.5
    cs_us_delay = 5
    n_steps = 5000
    stream = partial_reinforcement_scenario(
        p=p,
        n_steps=n_steps,
        cs_us_delay=cs_us_delay,
        cs_duration=1,
        iti_min=5,
        iti_max=15,
        noise_std=0.0,
        distractor_prob=0.0,
    )
    state = stream.init(jr.key(2))
    _, obs, tgt = _collect(stream, state, n_steps)

    cs_ind = (obs[:, 0] > 0.5).astype(jnp.int32)
    # CS rising edges
    cs_diff = jnp.concatenate([jnp.array([0]), jnp.diff(cs_ind)])
    cs_onsets = jnp.where(cs_diff > 0)[0]
    # Drop trials whose US would land past the trace window.
    valid_onsets = cs_onsets[cs_onsets + cs_us_delay < n_steps]
    n_trials = int(valid_onsets.shape[0])
    assert n_trials > 100, f"expected many trials, got {n_trials}"

    us_indicator = tgt[:, 0] > 0.5
    us_after = us_indicator[valid_onsets + cs_us_delay]
    empirical_p = float(jnp.mean(us_after.astype(jnp.float32)))

    assert abs(empirical_p - p) < 0.05, (
        f"empirical P(US|CS)={empirical_p:.3f} not within 0.05 of {p}"
    )


def test_blocking_compound_phase_only_compound_cs():
    """In the compound phase only the (CS_0, CS_1) pair fires together.

    During ``compound_cs0_cs1``, every step where CS_0 = 1 must also
    have CS_1 = 1 and vice versa. There must be no "lone" CS events.
    """
    n_pre = 200
    n_compound = 600
    stream = blocking_scenario(
        n_pretrain=n_pre,
        n_compound=n_compound,
        cs_us_delay=5,
        cs_duration=1,
        iti_min=5,
        iti_max=10,
        noise_std=0.0,
        distractor_prob=0.0,
    )
    state = stream.init(jr.key(3))
    _, obs, _ = _collect(stream, state, n_pre + n_compound)

    cs0 = obs[n_pre:, 0] > 0.5
    cs1 = obs[n_pre:, 1] > 0.5

    # In compound phase: CS_0 == CS_1 at every step.
    chex.assert_trees_all_close(
        cs0.astype(jnp.float32),
        cs1.astype(jnp.float32),
    )
    # And there should be at least some CS firings.
    assert int(jnp.sum(cs0)) > 0


def test_pretrain_phase_only_cs0_fires():
    """During the blocking pretrain phase CS_1 should never fire."""
    stream = blocking_scenario(
        n_pretrain=500,
        n_compound=100,
        cs_us_delay=5,
        cs_duration=1,
        iti_min=5,
        iti_max=10,
        noise_std=0.0,
        distractor_prob=0.0,
    )
    state = stream.init(jr.key(4))
    _, obs, _ = _collect(stream, state, 500)

    cs1 = obs[:, 1] > 0.5
    assert int(jnp.sum(cs1)) == 0


def test_distractors_dont_predict_us():
    """A distractor should be uncorrelated with the US (correlation ~ 0)."""
    n_steps = 5000
    stream = acquisition_scenario(
        n_steps=n_steps,
        n_distractors=3,
        cs_us_delay=5,
        cs_duration=1,
        iti_min=5,
        iti_max=15,
        noise_std=0.0,
        distractor_prob=0.1,
    )
    state = stream.init(jr.key(5))
    _, obs, tgt = _collect(stream, state, n_steps)

    us = tgt[:, 0]
    # Distractors live at indices [n_cs : n_cs + n_distractors].
    n_cs = stream.n_cs
    for d_idx in range(stream.n_distractors):
        distractor = obs[:, n_cs + d_idx]
        # Pearson correlation; skip if a column is constant.
        std_d = float(jnp.std(distractor))
        std_u = float(jnp.std(us))
        if std_d < 1e-6 or std_u < 1e-6:
            continue
        corr = float(jnp.corrcoef(distractor, us)[0, 1])
        assert abs(corr) < 0.1, (
            f"distractor {d_idx} correlated with US: corr={corr:.3f}"
        )


# ---------------------------------------------------------------------------
# Static structure
# ---------------------------------------------------------------------------


def test_observation_shape():
    """``feature_dim`` matches ``n_cs + n_distractors`` and target is shape (1,)."""
    stream = acquisition_scenario(n_steps=200, n_distractors=4)
    assert stream.feature_dim == stream.n_cs + stream.n_distractors == 1 + 4

    state = stream.init(jr.key(6))
    ts, _ = stream.step(state, jnp.array(0))
    chex.assert_shape(ts.observation, (5,))
    chex.assert_shape(ts.target, (1,))
    chex.assert_tree_all_finite(ts.observation)
    chex.assert_tree_all_finite(ts.target)


def test_blocking_scenario_has_two_cs():
    """Blocking scenario must expose two CS features."""
    stream = blocking_scenario(n_pretrain=10, n_compound=10)
    assert stream.n_cs == 2
    assert stream.feature_dim == 2


def test_phases_in_order_and_named():
    """Reacquisition scenario phases are in the declared order and named."""
    stream = reacquisition_scenario(
        n_acquisition=100, n_extinction=100, n_reacquisition=100
    )
    assert tuple(p.name for p in stream.phases) == (
        "acquisition",
        "extinction",
        "reacquisition",
    )
    assert tuple(p.cs_us_contingency for p in stream.phases) == (1.0, 0.0, 1.0)


def test_extinction_phase_has_no_us_during_partial_reinforcement():
    """A direct contingency=0 phase emits zero US events even mid-stream."""
    stream = ClassicalConditioningStream(
        phases=(
            PavlovianPhase(
                name="acq", n_steps=300, cs_us_contingency=1.0, cs_active=(0,)
            ),
            PavlovianPhase(
                name="ext", n_steps=300, cs_us_contingency=0.0, cs_active=(0,)
            ),
        ),
        n_cs=1,
        cs_us_delay=5,
        iti_min=5,
        iti_max=10,
        noise_std=0.0,
        distractor_prob=0.0,
    )
    state = stream.init(jr.key(7))
    _, _, tgt = _collect(stream, state, 600)
    us = tgt[:, 0] > 0.5
    n_us_ext = int(jnp.sum(us[300:]))
    assert n_us_ext == 0


# ---------------------------------------------------------------------------
# JIT / scan
# ---------------------------------------------------------------------------


def test_jit_compatibility():
    """The stream's ``step`` must run under ``jax.lax.scan`` and ``jax.jit``."""
    stream = acquisition_scenario(
        n_steps=500, cs_us_delay=5, iti_min=3, iti_max=8, noise_std=0.05
    )

    def run(state, indices):
        def step_fn(carry, idx):
            ts, new_state = stream.step(carry, idx)
            return new_state, (ts.observation, ts.target)

        final_state, (obs, tgt) = jax.lax.scan(step_fn, state, indices)
        return final_state, obs, tgt

    jit_run = jax.jit(run)
    state = stream.init(jr.key(8))
    final_state, obs, tgt = jit_run(state, jnp.arange(200))

    chex.assert_shape(obs, (200, stream.feature_dim))
    chex.assert_shape(tgt, (200, 1))
    chex.assert_tree_all_finite(obs)
    chex.assert_tree_all_finite(tgt)
    # State remains a valid pytree of the right type.
    assert isinstance(final_state, PavlovianState)


def test_deterministic():
    """Identical keys must yield identical trajectories."""
    stream = acquisition_scenario(
        n_steps=500, cs_us_delay=5, iti_min=3, iti_max=12, noise_std=0.05
    )
    key = jr.key(9)

    state_a = stream.init(key)
    _, obs_a, tgt_a = _collect(stream, state_a, 200)

    state_b = stream.init(key)
    _, obs_b, tgt_b = _collect(stream, state_b, 200)

    chex.assert_trees_all_close(obs_a, obs_b)
    chex.assert_trees_all_close(tgt_a, tgt_b)


def test_different_keys_differ():
    """Different keys must yield different trajectories."""
    stream = acquisition_scenario(
        n_steps=500, cs_us_delay=5, iti_min=3, iti_max=12, noise_std=0.05
    )

    state_a = stream.init(jr.key(11))
    _, obs_a, _ = _collect(stream, state_a, 200)
    state_b = stream.init(jr.key(12))
    _, obs_b, _ = _collect(stream, state_b, 200)

    diff = float(jnp.mean(jnp.abs(obs_a - obs_b)))
    assert diff > 1e-6


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def test_construct_rejects_empty_phases():
    """Constructor raises on empty phases."""
    try:
        ClassicalConditioningStream(phases=(), n_cs=1)
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError for empty phases")


def test_construct_rejects_bad_cs_index():
    """Constructor raises when a phase references an out-of-range CS index."""
    bad_phase = PavlovianPhase(
        name="bad", n_steps=10, cs_us_contingency=1.0, cs_active=(5,)
    )
    try:
        ClassicalConditioningStream(phases=(bad_phase,), n_cs=2)
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError for invalid CS index")


def test_partial_reinforcement_rejects_invalid_p():
    """``p`` outside [0, 1] is rejected."""
    for bad_p in (-0.1, 1.1):
        try:
            partial_reinforcement_scenario(p=bad_p)
        except ValueError:
            continue
        raise AssertionError(f"expected ValueError for p={bad_p}")


def test_reacquisition_runs_three_phases():
    """Reacquisition scenario has three distinct contingency periods."""
    n_acq = 200
    n_ext = 200
    n_re = 200
    stream = reacquisition_scenario(
        n_acquisition=n_acq,
        n_extinction=n_ext,
        n_reacquisition=n_re,
        cs_us_delay=5,
        cs_duration=1,
        iti_min=5,
        iti_max=10,
        noise_std=0.0,
        distractor_prob=0.0,
    )
    state = stream.init(jr.key(13))
    _, _, tgt = _collect(stream, state, n_acq + n_ext + n_re)
    us = tgt[:, 0] > 0.5
    n_us_acq = int(jnp.sum(us[:n_acq]))
    n_us_ext = int(jnp.sum(us[n_acq : n_acq + n_ext]))
    n_us_re = int(jnp.sum(us[n_acq + n_ext :]))
    assert n_us_acq > 0
    assert n_us_ext == 0
    assert n_us_re > 0
