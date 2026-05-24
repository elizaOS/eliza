# mypy: disable-error-code="attr-defined,call-arg,no-any-return,union-attr"
"""Prototype Alberta Plan agent integrating all 12 steps.

The :class:`PrototypeAgent` is the culmination of the 12-step Alberta Plan
retreat-and-return strategy.  It integrates:

- **OaK** (steps 5/6/10/11): Differential average-reward control with temporal
  abstraction, option utility tracking, and curation.
- **Horde** (step 3): Parallel GVF prediction demons sharing a learned trunk.
- **World Model** (step 8): One-step action-conditioned environment model.
- **Guarded Dreaming** (step 9): Model-generated Dyna transitions accepted only
  when the world model's error EMA is below a configurable gate.
- **Intelligence Amplification** (step 12, optional): Exo-cerebellum +
  exo-cortex companion that augments a partner agent's decisions.

Steps 1 and 2 (IDBD / MLP + ObGD) are exercised inside OaK's underlying linear
differential Q-learner.  When a nonlinear Horde trunk is configured, steps 1-2
are also active there.

References:
    Sutton, Bowling, & Pilarski (2022). "The Alberta Plan for AI Research."
    Barreto et al. (2019). "The Option Keyboard: Combining Skills in RL."
    Sutton et al. (2011). "Horde: A Scalable Real-time Architecture."
    Elsayed & Sutton (2024). "Streaming Backpropagation through Time."
"""

from __future__ import annotations

import dataclasses
import functools
from typing import Any, cast

import chex
import jax
import jax.numpy as jnp
import jax.random as jr
from jax import Array
from jaxtyping import Float, Int

from alberta_framework.core.dreaming import (
    DreamingConfig,
    GuardedDreamer,
    RecentObservationBuffer,
)
from alberta_framework.core.horde import HordeLearner
from alberta_framework.core.intelligence_amplification import (
    IAAgent,
    IAConfig,
)
from alberta_framework.core.oak import OaKAgent, OaKConfig, OaKState
from alberta_framework.core.options import STOMPConfig, SubtaskSpec
from alberta_framework.core.types import HordeSpec
from alberta_framework.core.world_model import (
    ActionConditionedWorldModel,
    ActionConditionedWorldModelConfig,
)

# ---------------------------------------------------------------------------
# Standalone utility
# ---------------------------------------------------------------------------


def feature_to_subtask_specs(
    oak_state: OaKState,
    *,
    n_subtasks: int = 4,
    threshold: float = 0.5,
    pseudo_reward_scale: float = 1.0,
    max_option_steps: int = 20,
) -> tuple[SubtaskSpec, ...]:
    """Extract top-k subtask specs from OaK Q-weight feature importance.

    Ranks observation dimensions by the maximum absolute Q-weight across all
    base and option policies.  The top-k most important features become subtask
    targets for the next curation cycle.

    Args:
        oak_state: Current OaK state.
        n_subtasks: Number of subtask specs to return.
        threshold: Pseudo-reward threshold for subtask completion.
        pseudo_reward_scale: Pseudo-reward multiplier for generated specs.
        max_option_steps: Hard cap on option duration.

    Returns:
        Tuple of up to ``n_subtasks`` :class:`SubtaskSpec` instances, ordered
        by descending feature importance.
    """
    bls = oak_state.stomp_state.base_learner_state
    trunk_ws = bls.trunk_params.weights
    if len(trunk_ws) == 0:
        # Linear base Q: head_params.weights[i] has shape (1, obs_dim)
        base_q_mat = jnp.stack([w[0] for w in bls.head_params.weights])
    else:
        # Nonlinear: use first trunk layer as feature-importance proxy
        base_q_mat = trunk_ws[0]  # (hidden_size, obs_dim)
    feature_importance = jnp.max(jnp.abs(base_q_mat), axis=0)  # (obs_dim,)

    opt_q = oak_state.stomp_state.option_policies.q_weights      # (n_opts, n_prim, obs_dim)
    opt_q_abs = jnp.abs(opt_q)
    obs_dim = int(opt_q.shape[-1])
    opt_importance = jnp.max(opt_q_abs.reshape(-1, obs_dim), axis=0)  # (obs_dim,)

    combined = feature_importance + opt_importance
    n = min(n_subtasks, obs_dim)
    ranking = sorted(range(obs_dim), key=lambda i: float(combined[i]), reverse=True)[:n]

    return tuple(
        SubtaskSpec(
            feature_index=int(idx),
            threshold=threshold,
            pseudo_reward_scale=pseudo_reward_scale,
            max_option_steps=max_option_steps,
        )
        for idx in ranking
    )


# ---------------------------------------------------------------------------
# GRU Perception (Step 8 sub-component a — recursive state update)
# ---------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class GRUPerceptionConfig:
    """Configuration for the fixed-weight GRU perception layer.

    A minimal echo-state GRU that provides the recursive state-update
    (perception) sub-component required by Alberta Plan Step 8.  Weights are
    sampled once at :meth:`PrototypeAgent.init` and remain fixed; the hidden
    state is updated at every step.  The downstream Q-function (OaK) learns to
    use the temporal context encoded in ``hidden``.

    Args:
        observation_dim: Raw observation dimensionality (GRU input).
        hidden_dim: GRU hidden-state dimensionality (GRU output).

    Note:
        When this config is present, the effective observation dimensionality
        seen by OaK, the Horde, the world model, and IA is
        ``observation_dim + hidden_dim``.  Set ``oak.observation_dim``
        (and ``world_model.observation_dim`` when applicable) accordingly.
    """

    observation_dim: int
    hidden_dim: int = 32

    def augmented_dim(self) -> int:
        """Return ``observation_dim + hidden_dim``."""
        return self.observation_dim + self.hidden_dim

    def to_config(self) -> dict[str, Any]:
        """Serialize to a JSON-compatible dictionary."""
        return {
            "type": "GRUPerceptionConfig",
            "observation_dim": self.observation_dim,
            "hidden_dim": self.hidden_dim,
        }

    @classmethod
    def from_config(cls, payload: dict[str, Any]) -> GRUPerceptionConfig:
        """Reconstruct from :meth:`to_config` output."""
        d = dict(payload)
        d.pop("type", None)
        return cls(**d)


@chex.dataclass(frozen=True)
class GRUPerceptionState:
    """State for the fixed-weight GRU perception layer.

    Weight matrices are initialised once and never updated; ``hidden`` is the
    only mutable component and is replaced at every step.

    Attributes:
        W_z, U_z, b_z: Update-gate input/recurrent weights and bias.
        W_r, U_r, b_r: Reset-gate input/recurrent weights and bias.
        W_h, U_h, b_h: Candidate-hidden input/recurrent weights and bias.
        hidden: Running GRU hidden state ``h_t``.
    """

    W_z: Float[Array, "hidden_dim obs_dim"]
    U_z: Float[Array, "hidden_dim hidden_dim"]
    b_z: Float[Array, " hidden_dim"]
    W_r: Float[Array, "hidden_dim obs_dim"]
    U_r: Float[Array, "hidden_dim hidden_dim"]
    b_r: Float[Array, " hidden_dim"]
    W_h: Float[Array, "hidden_dim obs_dim"]
    U_h: Float[Array, "hidden_dim hidden_dim"]
    b_h: Float[Array, " hidden_dim"]
    hidden: Float[Array, " hidden_dim"]


def _glorot_uniform(key: Array, shape: tuple[int, int]) -> Array:
    fan_in, fan_out = shape[-1], shape[0]
    limit = jnp.sqrt(6.0 / (fan_in + fan_out))
    return jr.uniform(key, shape, dtype=jnp.float32, minval=-limit, maxval=limit)


def _init_gru_state(cfg: GRUPerceptionConfig, key: Array) -> GRUPerceptionState:
    """Glorot-uniform weight init + zero hidden state."""
    keys = jr.split(key, 6)
    d_obs, d_h = cfg.observation_dim, cfg.hidden_dim
    return GRUPerceptionState(
        W_z=_glorot_uniform(keys[0], (d_h, d_obs)),
        U_z=_glorot_uniform(keys[1], (d_h, d_h)),
        b_z=jnp.zeros((d_h,), dtype=jnp.float32),
        W_r=_glorot_uniform(keys[2], (d_h, d_obs)),
        U_r=_glorot_uniform(keys[3], (d_h, d_h)),
        b_r=jnp.zeros((d_h,), dtype=jnp.float32),
        W_h=_glorot_uniform(keys[4], (d_h, d_obs)),
        U_h=_glorot_uniform(keys[5], (d_h, d_h)),
        b_h=jnp.zeros((d_h,), dtype=jnp.float32),
        hidden=jnp.zeros((d_h,), dtype=jnp.float32),
    )


def _gru_step(
    gru: GRUPerceptionState,
    obs: Float[Array, " obs_dim"],
) -> tuple[GRUPerceptionState, Float[Array, " augmented_dim"]]:
    """One GRU step: update hidden state and return augmented observation.

    Returns the *new* GRU state and the concatenation
    ``[obs, new_hidden]`` as the augmented observation.
    """
    h = gru.hidden
    z = jax.nn.sigmoid(gru.W_z @ obs + gru.U_z @ h + gru.b_z)
    r = jax.nn.sigmoid(gru.W_r @ obs + gru.U_r @ h + gru.b_r)
    h_tilde = jnp.tanh(gru.W_h @ obs + gru.U_h @ (r * h) + gru.b_h)
    new_h = (1.0 - z) * h + z * h_tilde
    new_gru = cast(GRUPerceptionState, gru.replace(hidden=new_h))
    return new_gru, jnp.concatenate([obs, new_h], axis=0)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


def _default_oak_config() -> OaKConfig:
    return OaKConfig(
        stomp=STOMPConfig(
            subtask_specs=(SubtaskSpec(feature_index=0),),
            observation_dim=4,
            n_primitive_actions=2,
        )
    )


@dataclasses.dataclass(frozen=True)
class PrototypeAgentConfig:
    """Configuration for the full Alberta Plan prototype agent.

    All components are designed for *continuing* average-reward settings —
    no episode resets, no offline training phases.

    Args:
        oak: OaK agent configuration (steps 5/6/10/11).  Required.
        world_model: World model configuration (step 8).  When ``None``,
            dreaming is disabled regardless of ``n_dreams_per_step``.
        dreaming: Dreaming guard configuration (step 9).  Only honoured when
            ``world_model`` is not ``None``.
        buffer_capacity: Number of real observations retained as dream anchors.
        n_dreams_per_step: Dyna-style imagined transitions per real step.
            Zero disables dreaming even when a world model is configured.
        horde_spec: GVF Horde specification (step 3).  When ``None``, the
            prediction-demon pathway is disabled.
        horde_hidden_sizes: Trunk layer widths for the Horde MLP.
        horde_step_size: Base step-size for the Horde learner.
        ia: IA agent configuration (step 12).  When ``None``, the
            intelligence-amplification companion is disabled.
    """

    oak: OaKConfig = dataclasses.field(default_factory=_default_oak_config)
    world_model: ActionConditionedWorldModelConfig | None = None
    dreaming: DreamingConfig | None = None
    buffer_capacity: int = 200
    n_dreams_per_step: int = 0
    horde_spec: HordeSpec | None = None
    horde_hidden_sizes: tuple[int, ...] = (64, 64)
    horde_step_size: float = 0.1
    ia: IAConfig | None = None
    gru_perception: GRUPerceptionConfig | None = None
    auto_curate_every: int = 0

    def __post_init__(self) -> None:
        if self.buffer_capacity <= 0:
            raise ValueError("buffer_capacity must be positive")
        if self.n_dreams_per_step < 0:
            raise ValueError("n_dreams_per_step must be non-negative")
        if self.horde_step_size <= 0.0:
            raise ValueError("horde_step_size must be positive")
        if self.auto_curate_every < 0:
            raise ValueError("auto_curate_every must be non-negative")
        if self.world_model is None and self.n_dreams_per_step > 0:
            raise ValueError(
                "n_dreams_per_step > 0 requires world_model to be configured"
            )
        if self.gru_perception is not None:
            aug = self.gru_perception.augmented_dim()
            if self.oak.observation_dim != aug:
                raise ValueError(
                    f"When gru_perception is set, oak.observation_dim must equal "
                    f"gru_perception.observation_dim + gru_perception.hidden_dim "
                    f"= {aug}, got {self.oak.observation_dim}"
                )
            if self.world_model is not None and self.world_model.observation_dim != aug:
                raise ValueError(
                    f"When gru_perception is set, world_model.observation_dim must equal "
                    f"gru_perception.augmented_dim() = {aug}, "
                    f"got {self.world_model.observation_dim}"
                )
        if self.ia is not None:
            ia_obs = self.ia.cortex.observation_dim
            oak_obs = self.oak.observation_dim
            if ia_obs != oak_obs:
                raise ValueError(
                    f"ia.cortex.observation_dim ({ia_obs}) must match "
                    f"oak.observation_dim ({oak_obs})"
                )

    def to_config(self) -> dict[str, Any]:
        """Serialize to a JSON-compatible dictionary."""
        payload: dict[str, Any] = {
            "type": "PrototypeAgentConfig",
            "oak": self.oak.to_config(),
            "buffer_capacity": self.buffer_capacity,
            "n_dreams_per_step": self.n_dreams_per_step,
            "horde_hidden_sizes": list(self.horde_hidden_sizes),
            "horde_step_size": self.horde_step_size,
            "auto_curate_every": self.auto_curate_every,
        }
        if self.world_model is not None:
            payload["world_model"] = self.world_model.to_config()
        if self.dreaming is not None:
            payload["dreaming"] = self.dreaming.to_config()
        if self.horde_spec is not None:
            payload["horde_spec"] = self.horde_spec.to_config()
        if self.ia is not None:
            payload["ia"] = self.ia.to_config()
        if self.gru_perception is not None:
            payload["gru_perception"] = self.gru_perception.to_config()
        return payload

    @classmethod
    def from_config(cls, payload: dict[str, Any]) -> PrototypeAgentConfig:
        """Reconstruct from :meth:`to_config` output."""
        from alberta_framework.core.types import HordeSpec as _HordeSpec

        data = dict(payload)
        data.pop("type", None)
        oak = OaKConfig.from_config(cast(dict[str, Any], data.pop("oak")))

        wm_raw = data.pop("world_model", None)
        world_model = (
            ActionConditionedWorldModelConfig.from_config(wm_raw) if wm_raw is not None else None
        )
        dream_raw = data.pop("dreaming", None)
        dreaming = DreamingConfig.from_config(dream_raw) if dream_raw is not None else None
        horde_raw = data.pop("horde_spec", None)
        horde_spec = _HordeSpec.from_config(horde_raw) if horde_raw is not None else None
        ia_raw = data.pop("ia", None)
        ia = IAConfig.from_config(ia_raw) if ia_raw is not None else None
        gru_raw = data.pop("gru_perception", None)
        gru_perception = (
            GRUPerceptionConfig.from_config(gru_raw) if gru_raw is not None else None
        )

        hidden = tuple(int(x) for x in data.pop("horde_hidden_sizes", [64, 64]))
        return cls(
            oak=oak,
            world_model=world_model,
            dreaming=dreaming,
            buffer_capacity=int(data.pop("buffer_capacity", 200)),
            n_dreams_per_step=int(data.pop("n_dreams_per_step", 0)),
            horde_spec=horde_spec,
            horde_hidden_sizes=hidden,
            horde_step_size=float(data.pop("horde_step_size", 0.1)),
            ia=ia,
            gru_perception=gru_perception,
            auto_curate_every=int(data.pop("auto_curate_every", 0)),
        )


# ---------------------------------------------------------------------------
# State and result types
# ---------------------------------------------------------------------------


@chex.dataclass(frozen=True)
class PrototypeAgentState:
    """Full prototype agent state.

    Optional sub-states (``world_model_state``, ``buffer_state``,
    ``horde_state``, ``ia_state``) are ``None`` when the corresponding
    component is disabled in the configuration.  The PyTree structure is
    fixed for a given :class:`PrototypeAgent` instance — never switch between
    ``None`` and a real state after initialisation.
    """

    oak_state: OaKState
    world_model_state: Any  # ActionConditionedWorldModelState | None
    buffer_state: Any  # RecentObservationBufferState | None
    horde_state: Any  # MultiHeadMLPState | None
    ia_state: Any  # IAState | None
    gru_state: Any  # GRUPerceptionState | None
    step_count: Int[Array, ""]


@chex.dataclass(frozen=True)
class PrototypeUpdateResult:
    """Result of one real-time prototype agent transition."""

    state: PrototypeAgentState
    action: Int[Array, ""]
    oak_td_error: Float[Array, ""]
    oak_average_reward: Float[Array, ""]
    world_model_error: Any  # Float[Array, ""] | None
    dream_td_errors: Any  # Float[Array, " n_dreams"] | None
    horde_td_errors: Any  # Float[Array, " n_demons"] | None
    ia_augmented_obs: Any  # Float[Array, " augmented_dim"] | None
    ia_recommendation: Any  # Int[Array, ""] | None


@chex.dataclass(frozen=True)
class PrototypeArrayResult:
    """Result from :meth:`PrototypeAgent.scan` over a batch of transitions."""

    state: PrototypeAgentState
    actions: Int[Array, " num_steps"]
    oak_td_errors: Float[Array, " num_steps"]
    oak_average_rewards: Float[Array, " num_steps"]


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------


class PrototypeAgent:
    """Alberta Plan prototype integrating all 12 steps.

    Operates in **continuing average-reward mode** — no episode resets, no
    offline batch phases.  Designed for use in sim-to-real transfer: the same
    :meth:`update` API works in simulation and on real hardware.

    Single-step daemon usage::

        state = agent.start(agent.init(jr.key(0)), initial_obs)
        action = int(agent.act(state, initial_obs))
        while True:
            reward, next_obs = env.step(action)
            result = agent.update(state, reward, next_obs)
            state, action = result.state, int(result.action)

    Periodic curation (Python-level, outside JAX)::

        if step % curation_interval == 0:
            agent, state = agent.curate(state, key)
    """

    def __init__(self, config: PrototypeAgentConfig) -> None:
        self._config = config
        self._oak = OaKAgent(config.oak)

        self._world_model: ActionConditionedWorldModel | None = None
        self._buffer: RecentObservationBuffer | None = None
        self._dreamer: GuardedDreamer | None = None
        if config.world_model is not None:
            self._world_model = ActionConditionedWorldModel(config.world_model)
            self._buffer = RecentObservationBuffer(
                config.buffer_capacity, config.oak.observation_dim
            )
            self._dreamer = GuardedDreamer(config.dreaming or DreamingConfig())

        self._horde: HordeLearner | None = None
        if config.horde_spec is not None:
            self._horde = HordeLearner(
                config.horde_spec,
                hidden_sizes=config.horde_hidden_sizes,
                step_size=config.horde_step_size,
            )

        self._ia: IAAgent | None = None
        if config.ia is not None:
            self._ia = IAAgent(config.ia)

    # -- Properties -----------------------------------------------------------

    @property
    def config(self) -> PrototypeAgentConfig:
        """Agent configuration."""
        return self._config

    @property
    def oak_agent(self) -> OaKAgent:
        """Underlying OaK control agent."""
        return self._oak

    # -- Serialization --------------------------------------------------------

    def to_config(self) -> dict[str, Any]:
        """Serialize agent configuration."""
        return self._config.to_config()

    @classmethod
    def from_config(cls, payload: dict[str, Any]) -> PrototypeAgent:
        """Reconstruct from :meth:`to_config` output."""
        return cls(PrototypeAgentConfig.from_config(payload))

    # -- Lifecycle ------------------------------------------------------------

    def init(self, key: Array) -> PrototypeAgentState:
        """Initialise all sub-states.

        Args:
            key: JAX PRNG key.

        Returns:
            Fresh :class:`PrototypeAgentState`.
        """
        key, oak_key, wm_key, horde_key, ia_key, gru_key = jr.split(key, 6)
        oak_state = self._oak.init(oak_key)

        wm_state: Any = None
        buf_state: Any = None
        if self._world_model is not None and self._buffer is not None:
            wm_state = self._world_model.init(wm_key)
            buf_state = self._buffer.init()

        horde_state: Any = None
        if self._horde is not None:
            horde_state = self._horde.init(self._config.oak.observation_dim, horde_key)

        ia_state: Any = None
        if self._ia is not None:
            ia_state = self._ia.init(ia_key)

        gru_state: Any = None
        if self._config.gru_perception is not None:
            gru_state = _init_gru_state(self._config.gru_perception, gru_key)

        return PrototypeAgentState(
            oak_state=oak_state,
            world_model_state=wm_state,
            buffer_state=buf_state,
            horde_state=horde_state,
            ia_state=ia_state,
            gru_state=gru_state,
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    def start(
        self,
        state: PrototypeAgentState,
        initial_observation: Array,
    ) -> PrototypeAgentState:
        """Prime the agent with an initial observation.

        Must be called once before :meth:`update`.

        Args:
            state: Uninitialised state from :meth:`init`.
            initial_observation: First environment observation.

        Returns:
            State with OaK (and optionally IA) primed.
        """
        raw_obs = jnp.asarray(initial_observation, dtype=jnp.float32)
        new_gru_state = state.gru_state
        obs_for_oak = raw_obs
        if state.gru_state is not None:
            new_gru_state, obs_for_oak = _gru_step(state.gru_state, raw_obs)
        new_oak = self._oak.start(state.oak_state, obs_for_oak)
        new_ia = state.ia_state
        if self._ia is not None and state.ia_state is not None:
            new_ia = self._ia.start(state.ia_state, obs_for_oak)
        return cast(
            PrototypeAgentState,
            state.replace(oak_state=new_oak, ia_state=new_ia, gru_state=new_gru_state),
        )

    def act(
        self,
        state: PrototypeAgentState,
        observation: Array,
    ) -> Int[Array, ""]:
        """Return the greedy primitive action without updating state.

        Useful for selecting the first action after :meth:`start`.
        """
        obs = jnp.asarray(observation, dtype=jnp.float32)
        n_prim = self._config.oak.n_primitive_actions
        all_q = self._oak.base_q_values(state.oak_state, obs)
        return jnp.argmax(all_q[:n_prim]).astype(jnp.int32)

    # -- Dreaming scan (JIT-compiled as a method so the closure is stable) ----

    @functools.partial(jax.jit, static_argnums=(0,))
    def _run_dreams(
        self,
        oak_state: OaKState,
        wm_state: Any,
        buf_state: Any,
        rng_key: Array,
    ) -> tuple[OaKState, Float[Array, " n_dreams"]]:
        n_prim = self._config.oak.n_primitive_actions

        def _dream_step(
            carry: tuple[OaKState, Array], _: Any
        ) -> tuple[tuple[OaKState, Array], Float[Array, ""]]:
            oak_s, k = carry
            k, sample_key, action_key = jr.split(k, 3)
            anchor_obs, _ = self._buffer.sample(buf_state, sample_key)
            action = jr.randint(action_key, (), 0, n_prim, dtype=jnp.int32)
            proposal = self._dreamer.propose(self._world_model, wm_state, anchor_obs, action)

            real_last_obs = oak_s.stomp_state.base_last_obs
            real_last_action = oak_s.stomp_state.base_last_action

            temp_stomp = oak_s.stomp_state.replace(
                base_last_obs=anchor_obs,
                base_last_action=action,
            )
            temp_oak = cast(OaKState, oak_s.replace(stomp_state=temp_stomp))
            dream_result = self._oak.update(
                temp_oak,
                proposal.transition.reward,
                proposal.transition.next_observation,
            )

            restored_stomp = dream_result.state.stomp_state.replace(
                base_last_obs=real_last_obs,
                base_last_action=real_last_action,
            )
            restored = cast(
                OaKState, dream_result.state.replace(stomp_state=restored_stomp)
            )
            new_oak_s = jax.tree_util.tree_map(
                lambda n, o: jnp.where(proposal.accepted, n, o),
                restored,
                oak_s,
            )
            td_err = jnp.where(
                proposal.accepted,
                dream_result.td_error,
                jnp.array(0.0, dtype=jnp.float32),
            )
            return (new_oak_s, k), td_err

        (new_oak_state, _), dream_td_errors = jax.lax.scan(
            _dream_step,
            (oak_state, rng_key),
            jnp.arange(self._config.n_dreams_per_step),
        )
        return new_oak_state, dream_td_errors

    # -- Core update ----------------------------------------------------------

    def update(
        self,
        state: PrototypeAgentState,
        reward: Array,
        next_observation: Array,
        horde_cumulants: Array | None = None,
    ) -> PrototypeUpdateResult:
        """Process one real-time continuing transition.

        Execution order:

        1. Update world model from the real transition (if configured).
        2. Add ``next_observation`` to the dream anchor buffer.
        3. Update OaK from the real transition.
        4. Run ``n_dreams_per_step`` guarded Dyna updates (if configured).
        5. Update the Horde from the real transition (if configured).
        6. Update the IA companion from the real transition (if configured).

        Args:
            state: Current agent state.  Must have been primed with
                :meth:`start`.
            reward: Scalar environment reward for the last step.
            next_observation: Next observation from the environment.
            horde_cumulants: Per-demon cumulants for the Horde, shape
                ``(n_demons,)``.  When ``None`` and a Horde is configured, the
                scalar ``reward`` is broadcast to all demons.

        Returns:
            :class:`PrototypeUpdateResult` with updated state, selected action,
            and per-component diagnostics.
        """
        raw_obs = jnp.asarray(next_observation, dtype=jnp.float32)
        rew = jnp.asarray(reward, dtype=jnp.float32)

        # -- Step 8a: GRU recursive state update (perception) -----------------
        new_gru_state = state.gru_state
        obs = raw_obs
        if state.gru_state is not None:
            new_gru_state, obs = _gru_step(state.gru_state, raw_obs)

        # Snapshot last obs/action before OaK update
        last_obs = state.oak_state.stomp_state.base_last_obs
        last_action = state.oak_state.stomp_state.base_last_action

        # -- Step 8b: world model update (real transition) --------------------
        new_wm_state = state.world_model_state
        new_buf_state = state.buffer_state
        wm_error: Any = None

        if self._world_model is not None and self._buffer is not None:
            wm_cfg = self._config.world_model
            gamma = jnp.asarray(
                wm_cfg.gamma if wm_cfg is not None else 0.99, dtype=jnp.float32
            )
            wm_result = self._world_model.update(
                state.world_model_state,
                last_obs,
                last_action,
                rew,
                gamma,
                obs,
            )
            new_wm_state = wm_result.state
            new_buf_state = self._buffer.add(state.buffer_state, obs)
            wm_error = wm_result.prediction_error

        # -- Steps 5/6/10/11: OaK update (real transition) -------------------
        oak_result = self._oak.update(state.oak_state, rew, obs)
        new_oak_state = oak_result.state

        # -- Step 9: guarded Dyna dreaming ------------------------------------
        dream_td_errors: Any = None

        if (
            self._world_model is not None
            and self._buffer is not None
            and self._dreamer is not None
            and self._config.n_dreams_per_step > 0
        ):
            rng_key = new_oak_state.stomp_state.rng_key
            new_oak_state, dream_td_errors = self._run_dreams(
                new_oak_state, new_wm_state, new_buf_state, rng_key
            )

        # -- Step 3: Horde GVF update -----------------------------------------
        new_horde_state = state.horde_state
        horde_tderrs: Any = None

        if self._horde is not None:
            if horde_cumulants is None:
                horde_cumulants = jnp.full(
                    (self._horde.n_demons,), rew, dtype=jnp.float32
                )
            horde_result = self._horde.update(
                state.horde_state, last_obs, horde_cumulants, obs
            )
            new_horde_state = horde_result.state
            horde_tderrs = horde_result.td_errors

        # -- Step 12: IA update -----------------------------------------------
        new_ia_state = state.ia_state
        ia_augmented: Any = None
        ia_recommendation: Any = None

        if self._ia is not None and state.ia_state is not None:
            ia_result = self._ia.update(state.ia_state, last_obs, rew, obs)
            new_ia_state = ia_result.state
            ia_augmented = ia_result.augmented_obs
            ia_recommendation = ia_result.recommendation

        new_state = PrototypeAgentState(
            oak_state=new_oak_state,
            world_model_state=new_wm_state,
            buffer_state=new_buf_state,
            horde_state=new_horde_state,
            ia_state=new_ia_state,
            gru_state=new_gru_state,
            step_count=state.step_count + 1,
        )

        return PrototypeUpdateResult(
            state=new_state,
            action=oak_result.primitive_action,
            oak_td_error=oak_result.td_error,
            oak_average_reward=oak_result.average_reward,
            world_model_error=wm_error,
            dream_td_errors=dream_td_errors,
            horde_td_errors=horde_tderrs,
            ia_augmented_obs=ia_augmented,
            ia_recommendation=ia_recommendation,
        )

    # -- Scan-based loop ------------------------------------------------------

    def scan(
        self,
        state: PrototypeAgentState,
        rewards: Float[Array, " num_steps"],
        next_observations: Float[Array, "num_steps obs_dim"],
        horde_cumulants: Float[Array, "num_steps n_demons"] | None = None,
    ) -> PrototypeArrayResult:
        """Run the agent over pre-collected transition arrays via scan.

        Suitable for simulator pre-training or offline replay.  The world
        model, Horde, and IA companion are all updated at every step.  When a
        Horde is configured but ``horde_cumulants`` is ``None``, the per-step
        reward is broadcast to all demons.

        Args:
            state: Current agent state (primed with :meth:`start`).
            rewards: Scalar rewards, shape ``(num_steps,)``.
            next_observations: Next observations, shape ``(num_steps, obs_dim)``.
            horde_cumulants: Optional per-demon cumulants,
                shape ``(num_steps, n_demons)``.

        Returns:
            :class:`PrototypeArrayResult` with final state and per-step arrays.
        """
        use_horde_cumulants = (
            horde_cumulants is not None and self._horde is not None
        )

        def step_fn(
            carry: PrototypeAgentState,
            inputs: tuple[Array, Array, Array | None],
        ) -> tuple[PrototypeAgentState, tuple[Array, Array, Array]]:
            rew, next_obs, hc = inputs
            result = self.update(carry, rew, next_obs, hc if use_horde_cumulants else None)
            return result.state, (
                result.action,
                result.oak_td_error,
                result.oak_average_reward,
            )

        if use_horde_cumulants and horde_cumulants is not None:
            xs: tuple[Array, Array, Any] = (rewards, next_observations, horde_cumulants)
        else:
            n = int(rewards.shape[0])
            dummy_hc = jnp.zeros((n, 1), dtype=jnp.float32)
            xs = (rewards, next_observations, dummy_hc)

        final_state, (actions, oak_td_errors, oak_avg_rewards) = jax.lax.scan(
            step_fn, state, xs
        )

        return PrototypeArrayResult(
            state=final_state,
            actions=actions,
            oak_td_errors=oak_td_errors,
            oak_average_rewards=oak_avg_rewards,
        )

    # -- Curation (Python-level) ----------------------------------------------

    def curate(
        self,
        state: PrototypeAgentState,
        key: Array,
        available_feature_indices: list[int] | None = None,
    ) -> tuple[PrototypeAgent, PrototypeAgentState]:
        """Replace the lowest-utility OaK option with a new subtask.

        This is a **Python-level operation** — it runs outside
        ``jax.lax.scan`` / JIT and materialises JAX array values.  Call it
        periodically in the outer Python loop.

        Args:
            state: Current agent state.
            key: JAX PRNG key for sampling the replacement feature.
            available_feature_indices: Pool of candidate feature indices.
                Defaults to all indices not currently used by any option.

        Returns:
            ``(new_agent, new_state)`` where ``new_agent`` has updated subtask
            specs and ``new_state`` has the replaced option's arrays zeroed.
        """
        new_oak, new_oak_state = self._oak.curate(
            state.oak_state, key, available_feature_indices
        )
        new_config = PrototypeAgentConfig(
            oak=new_oak.config,
            world_model=self._config.world_model,
            dreaming=self._config.dreaming,
            buffer_capacity=self._config.buffer_capacity,
            n_dreams_per_step=self._config.n_dreams_per_step,
            horde_spec=self._config.horde_spec,
            horde_hidden_sizes=self._config.horde_hidden_sizes,
            horde_step_size=self._config.horde_step_size,
            ia=self._config.ia,
            gru_perception=self._config.gru_perception,
            auto_curate_every=self._config.auto_curate_every,
        )
        new_agent = PrototypeAgent(new_config)
        # Transfer all non-OaK sub-states unchanged
        new_state = cast(
            PrototypeAgentState,
            state.replace(oak_state=new_oak_state),
        )
        return new_agent, new_state

    def maybe_curate(
        self,
        state: PrototypeAgentState,
        key: Array,
        available_feature_indices: list[int] | None = None,
    ) -> tuple[PrototypeAgent, PrototypeAgentState]:
        """Curate if ``auto_curate_every`` steps have elapsed, otherwise no-op.

        Intended for use in the outer Python loop alongside :meth:`update`::

            for obs, reward in stream:
                state, result = agent.update(state, obs, reward, key)
                agent, state = agent.maybe_curate(state, key)

        When ``auto_curate_every == 0`` (default), this is always a no-op.

        Args:
            state: Current agent state.
            key: JAX PRNG key passed to :meth:`curate` when curation fires.
            available_feature_indices: Pool of candidate features; forwarded
                to :meth:`curate` unchanged.

        Returns:
            ``(agent, state)`` — either the updated pair from :meth:`curate`
            or ``(self, state)`` unchanged.
        """
        n = self._config.auto_curate_every
        if n <= 0 or int(state.step_count) % n != 0:
            return self, state
        return self.curate(state, key, available_feature_indices)

    def auto_subtask_specs(
        self,
        state: PrototypeAgentState,
        *,
        n_subtasks: int = 4,
    ) -> tuple[SubtaskSpec, ...]:
        """Return candidate subtask specs ranked by current Q-weight importance.

        Delegates to :func:`feature_to_subtask_specs` using the threshold,
        scale, and max-step settings from the first existing subtask spec.

        Args:
            state: Current agent state.
            n_subtasks: Number of subtask specs to return.

        Returns:
            Tuple of :class:`SubtaskSpec` instances ranked by importance.
        """
        template = self._config.oak.stomp.subtask_specs[0]
        return feature_to_subtask_specs(
            state.oak_state,
            n_subtasks=n_subtasks,
            threshold=template.threshold,
            pseudo_reward_scale=template.pseudo_reward_scale,
            max_option_steps=template.max_option_steps,
        )
