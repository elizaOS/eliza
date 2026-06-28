"""Pavlovian / classical-conditioning streams for GVF prediction testbeds.

Implements the classical-conditioning testbed envisioned in Step 3 of the
Alberta Plan: predicting unconditioned-stimulus (US) arrival from the
conditioned-stimulus (CS) given a fixed CS->US delay. The Horde then
learns multi-horizon "anticipation" curves indexed by ``gamma``.

Trial structure
---------------
- An **inter-trial interval (ITI)** of random length separates trials.
- A trial begins by activating one of the CSes designated as active for
  the current phase. The CS stays on for ``cs_duration`` steps.
- ``cs_us_delay`` steps after CS *onset*, the US fires (target = 1.0)
  with probability ``cs_us_contingency``. Other steps emit target 0.0.
- ``cs_active`` is the tuple of CS indices that can act as the *primary*
  trial CS in this phase. ``compound_index`` (>= 0) adds a second CS
  that fires *together* with the primary CS — used for blocking.

Animal-learning scenarios
-------------------------
- Acquisition: CS reliably predicts US (contingency = 1.0).
- Extinction: CS no longer paired with US (contingency = 0.0).
- Reacquisition: acquisition -> extinction -> acquisition.
- Partial reinforcement: contingency in (0, 1).
- Blocking (Kamin): pretrain CS_0 alone, then compound (CS_0, CS_1)
  paired with US. CS_1 acquires no association — it is "blocked".

References
----------
- Sutton, R.S., et al. (2011). "Horde: A Scalable Real-time Architecture
  for Learning Knowledge from Unsupervised Sensorimotor Interaction."
- Pavlov, I.P. (1927). "Conditioned Reflexes."
- Rescorla, R.A. & Wagner, A.R. (1972). "A theory of Pavlovian
  conditioning: Variations in the effectiveness of reinforcement and
  nonreinforcement."
- Kamin, L.J. (1969). "Predictability, surprise, attention, and
  conditioning."
"""

from __future__ import annotations

import chex
import jax
import jax.numpy as jnp
import jax.random as jr
from jax import Array
from jaxtyping import Int, PRNGKeyArray

from alberta_framework.core.types import TimeStep
from alberta_framework.streams.base import ScanStream  # noqa: F401  (re-exported)

# =============================================================================
# State and phase descriptors
# =============================================================================


@chex.dataclass(frozen=True)
class PavlovianPhase:
    """One phase of a Pavlovian protocol.

    Each phase declares which CSes are active, the contingency between the
    primary CS and the US, and (optionally) a compound CS that fires with
    the primary CS.

    Attributes:
        name: Human-readable phase name (e.g. ``"acquisition"``).
        n_steps: Number of time steps spent in this phase.
        cs_us_contingency: Probability ``P(US | trial onset)`` for this
            phase. ``1.0`` is full reinforcement, ``0.0`` is extinction.
        cs_active: Tuple of CS indices that are *eligible* to start a
            trial in this phase. One of these is sampled per trial.
        compound_index: Index of an additional CS that fires together
            with the trial CS during this phase. ``-1`` disables the
            compound. Used to construct Kamin-style blocking phases.
    """

    name: str
    n_steps: int
    cs_us_contingency: float
    cs_active: tuple[int, ...]
    compound_index: int = -1


@chex.dataclass(frozen=True)
class PavlovianState:
    """Mutable state for ``ClassicalConditioningStream``.

    All fields are JAX arrays so the state is a valid pytree and can be
    threaded through ``jax.lax.scan``.

    Attributes:
        key: JAX PRNG key for stochastic choices (CS selection,
            contingency sampling, ITI length, distractors, noise).
        cs_active_steps_remaining: Per-CS countdown of remaining "on"
            steps (shape ``(n_cs,)``). A CS is considered active
            (indicator = 1) whenever this is > 0.
        us_pending_steps_remaining: Steps until the scheduled US fires.
            ``0`` means the US fires *this* step; ``-1`` means no US is
            scheduled.
        phase_idx: Index of the currently active phase in ``phases``.
        step_in_phase: Steps elapsed within the current phase. Resets
            on phase transition.
        n_distractor_active: Per-distractor countdown of remaining "on"
            steps (shape ``(n_distractors,)``).
        iti_steps_remaining: Steps until the next trial may start.
            ``0`` means a trial may start this step.
    """

    key: PRNGKeyArray
    cs_active_steps_remaining: Int[Array, " n_cs"]
    us_pending_steps_remaining: Int[Array, ""]
    phase_idx: Int[Array, ""]
    step_in_phase: Int[Array, ""]
    n_distractor_active: Int[Array, " n_distractors"]
    iti_steps_remaining: Int[Array, ""]


# =============================================================================
# Stream
# =============================================================================


class ClassicalConditioningStream:
    """Pavlovian classical-conditioning stream with phased non-stationarity.

    Generates a temporally uniform stream of ``(observation, target)``
    pairs in which:

    - ``observation`` is a ``(n_cs + n_distractors,)`` vector of
      indicator features (0/1) plus Gaussian noise.
    - ``target`` is a single scalar US indicator (1.0 if the US fires
      this step, 0.0 otherwise).

    Trial dynamics, per step:

    1. Phase selection: ``phase_idx`` advances after ``phase.n_steps``
       steps in that phase.
    2. ITI: while ``iti_steps_remaining > 0`` and no CS is active, no
       trial may start.
    3. Trial onset: when ITI elapses and no CS is currently active, a
       primary CS is sampled uniformly from the phase's
       ``cs_active`` indices. The US is scheduled to fire
       ``cs_us_delay`` steps later with probability
       ``phase.cs_us_contingency``. The compound CS (if any) is
       activated alongside the primary CS.
    4. Distractors fire independently each step with probability
       ``distractor_prob`` and stay on for ``cs_duration`` steps.
    5. The US fires this step iff
       ``us_pending_steps_remaining == 0``.

    The stream is fully JIT-compatible: branching uses ``jnp.where`` so
    the same step graph runs every iteration.

    Attributes:
        feature_dim: ``n_cs + n_distractors``.
        n_cs: Number of CS features.
        n_distractors: Number of distractor features.
        cs_us_delay: Steps from CS onset to US fire.
        cs_duration: How many steps a CS stays active.
        iti_min: Minimum ITI (steps).
        iti_max: Maximum ITI (steps, inclusive).
        noise_std: Std of Gaussian observation noise.
        distractor_prob: Per-step probability that an idle distractor
            fires.
        phases: Tuple of ``PavlovianPhase``.
    """

    def __init__(
        self,
        phases: tuple[PavlovianPhase, ...],
        n_cs: int = 1,
        n_distractors: int = 0,
        cs_us_delay: int = 5,
        cs_duration: int = 1,
        iti_min: int = 5,
        iti_max: int = 20,
        noise_std: float = 0.05,
        distractor_prob: float = 0.05,
    ):
        """Construct a classical-conditioning stream.

        Args:
            phases: Ordered tuple of phases (e.g. acquisition then
                extinction). Must be non-empty. Total steps in the
                stream are ``sum(p.n_steps for p in phases)``; the
                last phase is repeated indefinitely once steps exceed
                the declared total.
            n_cs: Number of distinct CS features.
            n_distractors: Number of distractor features (never paired
                with the US).
            cs_us_delay: Steps from CS onset to US fire. Must be
                positive so the US is causally predictable from the CS.
            cs_duration: Number of steps a CS stays active after onset.
                ``1`` is the standard punctate CS.
            iti_min: Minimum inter-trial interval (steps).
            iti_max: Maximum inter-trial interval (steps, inclusive).
            noise_std: Gaussian noise added to the observation features.
            distractor_prob: Per-step probability that an idle
                distractor turns on.

        Raises:
            ValueError: if ``phases`` is empty, ``n_cs <= 0``, the
                ITI range is malformed, or any phase references a CS
                index that does not exist.
        """
        if not phases:
            raise ValueError("phases must be non-empty")
        if n_cs <= 0:
            raise ValueError(f"n_cs must be positive, got {n_cs}")
        if n_distractors < 0:
            raise ValueError(f"n_distractors must be >= 0, got {n_distractors}")
        if cs_us_delay <= 0:
            raise ValueError(f"cs_us_delay must be positive, got {cs_us_delay}")
        if cs_duration <= 0:
            raise ValueError(f"cs_duration must be positive, got {cs_duration}")
        if iti_min < 0 or iti_max < iti_min:
            raise ValueError(f"need 0 <= iti_min <= iti_max, got {iti_min}, {iti_max}")

        for phase in phases:
            for cs_idx in phase.cs_active:
                if not (0 <= cs_idx < n_cs):
                    raise ValueError(
                        f"phase {phase.name!r} references cs_active index {cs_idx}, "
                        f"but n_cs={n_cs}"
                    )
            if phase.compound_index >= n_cs:
                raise ValueError(
                    f"phase {phase.name!r} has compound_index={phase.compound_index} "
                    f"but n_cs={n_cs}"
                )
            if phase.n_steps <= 0:
                raise ValueError(f"phase {phase.name!r} must have n_steps > 0")

        self._phases = tuple(phases)
        self._n_cs = int(n_cs)
        self._n_distractors = int(n_distractors)
        self._cs_us_delay = int(cs_us_delay)
        self._cs_duration = int(cs_duration)
        self._iti_min = int(iti_min)
        self._iti_max = int(iti_max)
        self._noise_std = float(noise_std)
        self._distractor_prob = float(distractor_prob)

        # Pre-compute JAX arrays for phase fields used inside step().
        self._phase_n_steps = jnp.array([p.n_steps for p in phases], dtype=jnp.int32)
        self._phase_contingency = jnp.array(
            [p.cs_us_contingency for p in phases], dtype=jnp.float32
        )
        self._phase_compound = jnp.array(
            [p.compound_index for p in phases], dtype=jnp.int32
        )
        # Build a per-phase ``(n_phases, n_cs)`` mask so a phase's
        # ``cs_active`` set can be sampled from inside ``jit``.
        cs_active_mask = jnp.zeros((len(phases), n_cs), dtype=jnp.float32)
        cs_active_count = jnp.zeros(len(phases), dtype=jnp.int32)
        for i, phase in enumerate(phases):
            for cs_idx in phase.cs_active:
                cs_active_mask = cs_active_mask.at[i, cs_idx].set(1.0)
            cs_active_count = cs_active_count.at[i].set(len(phase.cs_active))
        self._phase_cs_mask = cs_active_mask
        self._phase_cs_count = cs_active_count

    @property
    def feature_dim(self) -> int:
        """Number of observation features (CS + distractors)."""
        return self._n_cs + self._n_distractors

    @property
    def n_cs(self) -> int:
        """Number of CS features."""
        return self._n_cs

    @property
    def n_distractors(self) -> int:
        """Number of distractor features."""
        return self._n_distractors

    @property
    def n_phases(self) -> int:
        """Number of declared phases."""
        return len(self._phases)

    @property
    def phases(self) -> tuple[PavlovianPhase, ...]:
        """Tuple of declared phases."""
        return self._phases

    @property
    def cs_us_delay(self) -> int:
        """Configured CS-to-US delay."""
        return self._cs_us_delay

    @property
    def cs_duration(self) -> int:
        """Configured CS active duration."""
        return self._cs_duration

    def init(self, key: Array) -> PavlovianState:
        """Initialize stream state.

        Starts at phase 0 with no active CS, no pending US, and a
        freshly sampled ITI (so the first trial does not begin on
        step 0).

        Args:
            key: JAX random key.

        Returns:
            Initial ``PavlovianState``.
        """
        key, k_iti = jr.split(key)
        iti = jr.randint(k_iti, (), self._iti_min, self._iti_max + 1)
        return PavlovianState(
            key=key,
            cs_active_steps_remaining=jnp.zeros(self._n_cs, dtype=jnp.int32),
            us_pending_steps_remaining=jnp.array(-1, dtype=jnp.int32),
            phase_idx=jnp.array(0, dtype=jnp.int32),
            step_in_phase=jnp.array(0, dtype=jnp.int32),
            n_distractor_active=jnp.zeros(self._n_distractors, dtype=jnp.int32),
            iti_steps_remaining=iti,
        )

    def step(
        self, state: PavlovianState, idx: Array
    ) -> tuple[TimeStep, PavlovianState]:
        """Advance one time step.

        Args:
            state: Current state.
            idx: Step index (unused; phase progression is tracked via
                ``step_in_phase``).

        Returns:
            ``(timestep, new_state)`` where ``timestep.observation`` is
            shape ``(feature_dim,)`` and ``timestep.target`` is shape
            ``(1,)`` containing the US indicator.
        """
        del idx  # unused

        (
            key,
            k_phase_cs,
            k_contingency,
            k_iti,
            k_iti_phase,
            k_distractor,
            k_noise,
        ) = jr.split(state.key, 7)

        n_phases = len(self._phases)

        # ------------------------------------------------------------------
        # 1. Phase progression
        # ------------------------------------------------------------------
        # If we have spent >= n_steps in this phase, advance (clamped).
        cur_phase = state.phase_idx
        cur_phase_steps = self._phase_n_steps[cur_phase]
        # Only advance phases that have a successor; the final phase repeats.
        on_last_phase = cur_phase >= (n_phases - 1)
        should_advance_phase = (state.step_in_phase >= cur_phase_steps) & (~on_last_phase)
        next_phase = jnp.minimum(cur_phase + 1, n_phases - 1)
        new_phase_idx = jnp.where(should_advance_phase, next_phase, cur_phase)
        new_step_in_phase = jnp.where(
            should_advance_phase, jnp.int32(0), state.step_in_phase
        )

        # On phase transition, cancel any in-flight trial so each phase
        # starts cleanly. This avoids "spillover" US events from the
        # previous phase into the new one.
        cs_pre = jnp.where(
            should_advance_phase,
            jnp.zeros_like(state.cs_active_steps_remaining),
            state.cs_active_steps_remaining,
        )
        us_pending_pre = jnp.where(
            should_advance_phase, jnp.int32(-1), state.us_pending_steps_remaining
        )
        iti_pre = jnp.where(
            should_advance_phase,
            jr.randint(k_iti_phase, (), self._iti_min, self._iti_max + 1),
            state.iti_steps_remaining,
        )

        # Per-phase parameters for THIS step.
        contingency = self._phase_contingency[new_phase_idx]
        compound_idx = self._phase_compound[new_phase_idx]
        cs_mask = self._phase_cs_mask[new_phase_idx]  # shape (n_cs,)
        cs_count = self._phase_cs_count[new_phase_idx]

        # ------------------------------------------------------------------
        # 2. Decide whether a new trial starts this step
        # ------------------------------------------------------------------
        any_cs_active = jnp.any(cs_pre > 0)
        us_in_flight = us_pending_pre >= 0
        idle = (~any_cs_active) & (~us_in_flight)
        iti_done = iti_pre <= 0
        can_start_trial = idle & iti_done & (cs_count > 0)

        # ------------------------------------------------------------------
        # 3. Sample primary CS uniformly from phase's active set
        # ------------------------------------------------------------------
        # Use a Gumbel-style argmax over the CS-active mask so the choice
        # is JIT-friendly and respects the per-phase mask.
        gumbel = jr.gumbel(k_phase_cs, (self._n_cs,))
        # log-mask: -inf for inactive entries so they cannot be argmax'd.
        log_mask = jnp.where(cs_mask > 0.0, jnp.float32(0.0), jnp.float32(-1e9))
        chosen_cs = jnp.argmax(gumbel + log_mask).astype(jnp.int32)

        # ------------------------------------------------------------------
        # 4. Decide reinforcement and ITI on trial start
        # ------------------------------------------------------------------
        u = jr.uniform(k_contingency)
        will_reinforce = u < contingency
        new_iti = jr.randint(k_iti, (), self._iti_min, self._iti_max + 1)

        # Activate primary CS (and compound, if any)
        chosen_cs_oh = jax.nn.one_hot(chosen_cs, self._n_cs, dtype=jnp.int32)
        compound_oh = jnp.where(
            (compound_idx >= 0),
            jax.nn.one_hot(jnp.maximum(compound_idx, 0), self._n_cs, dtype=jnp.int32),
            jnp.zeros(self._n_cs, dtype=jnp.int32),
        )
        cs_activations = (chosen_cs_oh + compound_oh) * jnp.int32(self._cs_duration)

        # ------------------------------------------------------------------
        # 5. Update CS / US / ITI counters
        # ------------------------------------------------------------------
        # Decay current CS active counters (don't go below zero).
        decayed_cs = jnp.maximum(cs_pre - 1, 0)

        # On trial start, replace any (zero) decayed counters with full
        # activation. We assume a new trial can only start when no CS is
        # active, so no overwrite of an active counter occurs.
        new_cs_active = jnp.where(
            can_start_trial, cs_activations, decayed_cs
        )

        # US pending counter: decrement if active, schedule on trial start
        # if reinforced.
        decayed_us_pending = jnp.where(
            us_in_flight,
            us_pending_pre - 1,
            jnp.int32(-1),
        )
        scheduled_us = jnp.where(
            will_reinforce,
            jnp.int32(self._cs_us_delay),
            jnp.int32(-1),
        )
        new_us_pending = jnp.where(can_start_trial, scheduled_us, decayed_us_pending)

        # ITI countdown: only ticks during idle steps (no CS active, no US
        # pending). On trial start, reset to a freshly sampled ITI. While a
        # trial is in progress, the ITI counter is held.
        decremented_iti = jnp.where(
            idle,
            jnp.maximum(iti_pre - 1, 0),
            iti_pre,
        )
        new_iti_remaining = jnp.where(can_start_trial, new_iti, decremented_iti)

        # ------------------------------------------------------------------
        # 6. US firing this step
        # ------------------------------------------------------------------
        # The US fires when we just decremented the pending counter to 0.
        # Computed on the *new* counter value.
        us_fires = new_us_pending == 0

        # If the US fires, clear the pending counter (set to -1) for the
        # next step.
        new_us_pending = jnp.where(us_fires, jnp.int32(-1), new_us_pending)

        # ------------------------------------------------------------------
        # 7. Distractors
        # ------------------------------------------------------------------
        # Distractors are independent of trial dynamics; we just decay any
        # active counter and roll fresh starts.
        decayed_distractor = jnp.maximum(state.n_distractor_active - 1, 0)
        u_distract = jr.uniform(k_distractor, (self._n_distractors,))
        starts = (decayed_distractor == 0) & (u_distract < self._distractor_prob)
        new_distractor_active = jnp.where(
            starts, jnp.int32(self._cs_duration), decayed_distractor
        )

        # ------------------------------------------------------------------
        # 8. Build observation
        # ------------------------------------------------------------------
        cs_indicator = (new_cs_active > 0).astype(jnp.float32)
        distractor_indicator = (new_distractor_active > 0).astype(jnp.float32)
        clean_obs = jnp.concatenate([cs_indicator, distractor_indicator])
        noise = self._noise_std * jr.normal(
            k_noise, (self.feature_dim,), dtype=jnp.float32
        )
        observation = (clean_obs + noise).astype(jnp.float32)

        target = jnp.where(us_fires, jnp.float32(1.0), jnp.float32(0.0))

        timestep = TimeStep(
            observation=observation,
            target=jnp.atleast_1d(target),
        )
        new_state = PavlovianState(
            key=key,
            cs_active_steps_remaining=new_cs_active.astype(jnp.int32),
            us_pending_steps_remaining=new_us_pending.astype(jnp.int32),
            phase_idx=new_phase_idx.astype(jnp.int32),
            step_in_phase=(new_step_in_phase + 1).astype(jnp.int32),
            n_distractor_active=new_distractor_active.astype(jnp.int32),
            iti_steps_remaining=new_iti_remaining.astype(jnp.int32),
        )
        return timestep, new_state


# =============================================================================
# Scenario factories
# =============================================================================


def acquisition_scenario(
    n_steps: int = 5000,
    *,
    n_distractors: int = 0,
    cs_us_delay: int = 5,
    cs_duration: int = 1,
    iti_min: int = 5,
    iti_max: int = 20,
    noise_std: float = 0.05,
    distractor_prob: float = 0.05,
) -> ClassicalConditioningStream:
    """Single-phase acquisition: CS reliably predicts US.

    Used as the canonical Step 3 prediction testbed: a Horde with
    ``gamma in {0, 0.5, 0.9, 0.99}`` should learn a monotonically
    increasing anticipation of the US following CS onset.

    Args:
        n_steps: Total steps in the acquisition phase.
        n_distractors: Number of unrelated indicator features.
        cs_us_delay: Steps from CS onset to US.
        cs_duration: Steps the CS stays active.
        iti_min: Minimum inter-trial interval.
        iti_max: Maximum inter-trial interval.
        noise_std: Std of observation noise.
        distractor_prob: Per-step distractor activation probability.

    Returns:
        ``ClassicalConditioningStream`` with one phase ``"acquisition"``.
    """
    phases = (
        PavlovianPhase(
            name="acquisition",
            n_steps=n_steps,
            cs_us_contingency=1.0,
            cs_active=(0,),
        ),
    )
    return ClassicalConditioningStream(
        phases=phases,
        n_cs=1,
        n_distractors=n_distractors,
        cs_us_delay=cs_us_delay,
        cs_duration=cs_duration,
        iti_min=iti_min,
        iti_max=iti_max,
        noise_std=noise_std,
        distractor_prob=distractor_prob,
    )


def extinction_scenario(
    n_acquisition: int = 2500,
    n_extinction: int = 2500,
    *,
    n_distractors: int = 0,
    cs_us_delay: int = 5,
    cs_duration: int = 1,
    iti_min: int = 5,
    iti_max: int = 20,
    noise_std: float = 0.05,
    distractor_prob: float = 0.05,
) -> ClassicalConditioningStream:
    """Acquisition followed by extinction.

    Phase 1 (``n_acquisition`` steps): contingency = 1.0.
    Phase 2 (``n_extinction`` steps): contingency = 0.0.

    Predictions should grow during acquisition then decay during
    extinction.

    Args:
        n_acquisition: Steps spent in acquisition.
        n_extinction: Steps spent in extinction.
        n_distractors: Number of unrelated indicator features.
        cs_us_delay: Steps from CS onset to US.
        cs_duration: Steps the CS stays active.
        iti_min: Minimum inter-trial interval.
        iti_max: Maximum inter-trial interval.
        noise_std: Std of observation noise.
        distractor_prob: Per-step distractor activation probability.

    Returns:
        ``ClassicalConditioningStream`` with two phases.
    """
    phases = (
        PavlovianPhase(
            name="acquisition",
            n_steps=n_acquisition,
            cs_us_contingency=1.0,
            cs_active=(0,),
        ),
        PavlovianPhase(
            name="extinction",
            n_steps=n_extinction,
            cs_us_contingency=0.0,
            cs_active=(0,),
        ),
    )
    return ClassicalConditioningStream(
        phases=phases,
        n_cs=1,
        n_distractors=n_distractors,
        cs_us_delay=cs_us_delay,
        cs_duration=cs_duration,
        iti_min=iti_min,
        iti_max=iti_max,
        noise_std=noise_std,
        distractor_prob=distractor_prob,
    )


def reacquisition_scenario(
    n_acquisition: int = 2000,
    n_extinction: int = 2000,
    n_reacquisition: int = 2000,
    *,
    n_distractors: int = 0,
    cs_us_delay: int = 5,
    cs_duration: int = 1,
    iti_min: int = 5,
    iti_max: int = 20,
    noise_std: float = 0.05,
    distractor_prob: float = 0.05,
) -> ClassicalConditioningStream:
    """Acquisition -> extinction -> reacquisition.

    Tests the savings effect: classical reacquisition is faster than
    original acquisition. This is the canonical demonstration of
    "memory" in Pavlovian conditioning.

    Args:
        n_acquisition: Steps in initial acquisition.
        n_extinction: Steps in extinction.
        n_reacquisition: Steps in reacquisition.
        n_distractors: Number of unrelated indicator features.
        cs_us_delay: Steps from CS onset to US.
        cs_duration: Steps the CS stays active.
        iti_min: Minimum inter-trial interval.
        iti_max: Maximum inter-trial interval.
        noise_std: Std of observation noise.
        distractor_prob: Per-step distractor activation probability.

    Returns:
        ``ClassicalConditioningStream`` with three phases.
    """
    phases = (
        PavlovianPhase(
            name="acquisition",
            n_steps=n_acquisition,
            cs_us_contingency=1.0,
            cs_active=(0,),
        ),
        PavlovianPhase(
            name="extinction",
            n_steps=n_extinction,
            cs_us_contingency=0.0,
            cs_active=(0,),
        ),
        PavlovianPhase(
            name="reacquisition",
            n_steps=n_reacquisition,
            cs_us_contingency=1.0,
            cs_active=(0,),
        ),
    )
    return ClassicalConditioningStream(
        phases=phases,
        n_cs=1,
        n_distractors=n_distractors,
        cs_us_delay=cs_us_delay,
        cs_duration=cs_duration,
        iti_min=iti_min,
        iti_max=iti_max,
        noise_std=noise_std,
        distractor_prob=distractor_prob,
    )


def partial_reinforcement_scenario(
    p: float = 0.5,
    n_steps: int = 5000,
    *,
    n_distractors: int = 0,
    cs_us_delay: int = 5,
    cs_duration: int = 1,
    iti_min: int = 5,
    iti_max: int = 20,
    noise_std: float = 0.05,
    distractor_prob: float = 0.05,
) -> ClassicalConditioningStream:
    """Single-phase partial reinforcement: ``P(US|CS) = p``.

    The expected V(CS) at the prediction moment should approach ``p``
    for a gamma=0 demon.

    Args:
        p: Reinforcement probability per trial. Must be in ``[0, 1]``.
        n_steps: Total steps in the phase.
        n_distractors: Number of unrelated indicator features.
        cs_us_delay: Steps from CS onset to US.
        cs_duration: Steps the CS stays active.
        iti_min: Minimum inter-trial interval.
        iti_max: Maximum inter-trial interval.
        noise_std: Std of observation noise.
        distractor_prob: Per-step distractor activation probability.

    Returns:
        ``ClassicalConditioningStream`` with one phase.

    Raises:
        ValueError: if ``p`` is outside ``[0, 1]``.
    """
    if not (0.0 <= p <= 1.0):
        raise ValueError(f"p must be in [0, 1], got {p}")
    phases = (
        PavlovianPhase(
            name="partial_reinforcement",
            n_steps=n_steps,
            cs_us_contingency=float(p),
            cs_active=(0,),
        ),
    )
    return ClassicalConditioningStream(
        phases=phases,
        n_cs=1,
        n_distractors=n_distractors,
        cs_us_delay=cs_us_delay,
        cs_duration=cs_duration,
        iti_min=iti_min,
        iti_max=iti_max,
        noise_std=noise_std,
        distractor_prob=distractor_prob,
    )


def blocking_scenario(
    n_pretrain: int = 2500,
    n_compound: int = 2500,
    *,
    n_distractors: int = 0,
    cs_us_delay: int = 5,
    cs_duration: int = 1,
    iti_min: int = 5,
    iti_max: int = 20,
    noise_std: float = 0.05,
    distractor_prob: float = 0.05,
) -> ClassicalConditioningStream:
    """Kamin blocking: CS_0 is pre-trained, then (CS_0, CS_1) compound.

    Phase 1 (pretrain): only CS_0 fires; CS_0 -> US with prob 1.0.
    Phase 2 (compound): CS_0 and CS_1 always fire together; the pair
    -> US with prob 1.0. Because CS_0 already fully predicts the US,
    CS_1 acquires no association — Kamin's blocking effect.

    Args:
        n_pretrain: Steps in CS_0 pretraining.
        n_compound: Steps in (CS_0, CS_1) compound conditioning.
        n_distractors: Number of unrelated indicator features.
        cs_us_delay: Steps from CS onset to US.
        cs_duration: Steps the CSes stay active.
        iti_min: Minimum inter-trial interval.
        iti_max: Maximum inter-trial interval.
        noise_std: Std of observation noise.
        distractor_prob: Per-step distractor activation probability.

    Returns:
        ``ClassicalConditioningStream`` with two phases and ``n_cs=2``.
    """
    phases = (
        PavlovianPhase(
            name="pretrain_cs0",
            n_steps=n_pretrain,
            cs_us_contingency=1.0,
            cs_active=(0,),
        ),
        PavlovianPhase(
            name="compound_cs0_cs1",
            n_steps=n_compound,
            cs_us_contingency=1.0,
            cs_active=(0,),
            compound_index=1,
        ),
    )
    return ClassicalConditioningStream(
        phases=phases,
        n_cs=2,
        n_distractors=n_distractors,
        cs_us_delay=cs_us_delay,
        cs_duration=cs_duration,
        iti_min=iti_min,
        iti_max=iti_max,
        noise_std=noise_std,
        distractor_prob=distractor_prob,
    )
