# mypy: disable-error-code="attr-defined,call-arg,no-any-return"
"""Core types and algorithms for the OaK architecture (Alberta Plan Step 11).

OaK (Options and Knowledge) extends the STOMP progression (Step 10) with two
additional mechanisms:

1. **Utility tracking** — Each option's execution frequency and accumulated
   pseudo-reward are tracked online via EMA.  This produces a per-option
   utility score without any expensive periodic evaluation pass.
2. **Curation** — The ``curate()`` method compares each option's utility EMA
   against a configurable threshold.  The lowest-utility option is replaced
   with a new :class:`~alberta_framework.core.options.SubtaskSpec` targeting a
   different observation feature, and its weights/models are reset.
3. **Option keyboard** — A real-valued keyboard vector w ∈ R^N encodes a
   *chord*: a weighted blend of N option Q-functions that produces a single
   Q-vector over primitive actions.  The policy is greedy w.r.t. this blend
   (Barreto et al. 2019, Option Keyboard, §3.1):
   ``Q_w(s, a) = Σ_i w_i Q_i(s, a)``.

Together these realise the **FC-STOMP cycle**:
Feature Construction → SubTask → Option → Model → Planning → (Curation) →
where curation drives continuous self-improvement by replacing unhelpful
options with new subtasks on higher-utility features.

References:
    Sutton, Bowling, & Pilarski (2022). "The Alberta Plan for AI Research."
    Barreto et al. (2019). "The Option Keyboard: Combining Skills in RL."
    Sutton (RLC 2025). "The OaK Architecture."
    Wan, Naik, & Sutton (2021). "Average-Reward Learning and Planning
        with Options."
"""

from __future__ import annotations

import dataclasses
from typing import Any, cast

import chex
import jax
import jax.numpy as jnp
import jax.random as jr
from jax import Array
from jaxtyping import Float, Int

from alberta_framework.core.options import (
    IntraOptionPoliciesState,
    OptionModelsState,
    STOMPAgent,
    STOMPConfig,
    STOMPState,
    STOMPUpdateResult,
    SubtaskSpec,
    subtasks_from_feature_scores,
)
from alberta_framework.core.types import MLPParams

# ---------------------------------------------------------------------------
# Default config helper
# ---------------------------------------------------------------------------


def _default_stomp_config() -> STOMPConfig:
    return STOMPConfig(subtask_specs=(SubtaskSpec(feature_index=0),))


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class OaKConfig:
    """Configuration for the OaK agent.

    Args:
        stomp: Underlying STOMP configuration.  Must include at least one
            :class:`SubtaskSpec`.
        utility_ema_decay: EMA decay for per-option utility tracking.
            Higher → slower adaptation.  Range [0, 1].
        curation_threshold: Utility EMA value below which an option is
            eligible for replacement.  Set to 0 to disable automatic
            threshold gating (replace the worst option unconditionally when
            :meth:`curate` is called).
    """

    stomp: STOMPConfig = dataclasses.field(default_factory=_default_stomp_config)
    utility_ema_decay: float = 0.99
    curation_threshold: float = 0.0

    def __post_init__(self) -> None:
        if not self.stomp.subtask_specs:
            raise ValueError("OaKConfig requires at least one subtask in stomp")
        if not 0.0 <= self.utility_ema_decay <= 1.0:
            raise ValueError("utility_ema_decay must be in [0, 1]")
        if self.curation_threshold < 0.0:
            raise ValueError("curation_threshold must be non-negative")

    @property
    def n_options(self) -> int:
        return len(self.stomp.subtask_specs)

    @property
    def n_primitive_actions(self) -> int:
        return self.stomp.n_primitive_actions

    @property
    def observation_dim(self) -> int:
        return self.stomp.observation_dim

    def to_config(self) -> dict[str, Any]:
        """Return a JSON-serializable dictionary."""
        return {
            "type": "OaKConfig",
            "stomp": self.stomp.to_config(),
            "utility_ema_decay": self.utility_ema_decay,
            "curation_threshold": self.curation_threshold,
        }

    @classmethod
    def from_config(cls, payload: dict[str, Any]) -> OaKConfig:
        """Reconstruct from :meth:`to_config` output."""
        data = dict(payload)
        data.pop("type", None)
        stomp_raw = data.pop("stomp")
        stomp = STOMPConfig.from_config(stomp_raw)
        return cls(stomp=stomp, **data)


# ---------------------------------------------------------------------------
# State and result types
# ---------------------------------------------------------------------------


@chex.dataclass(frozen=True)
class OaKState:
    """Combined OaK agent state.

    Attributes:
        stomp_state: Full STOMP agent state (weights, traces, models, RNG).
        execution_counts: Integer count of times each option has been
            started; shape ``(n_options,)``.
        cumulative_pseudo_rewards: Running sum of pseudo-reward accumulated
            while each option was active; shape ``(n_options,)``.
        utility_ema: EMA utility score for each option; shape
            ``(n_options,)``.  Updated every primitive step that an option is
            executing.
        step_count: Total primitive steps processed.
    """

    stomp_state: STOMPState
    execution_counts: Int[Array, " n_options"]
    cumulative_pseudo_rewards: Float[Array, " n_options"]
    utility_ema: Float[Array, " n_options"]
    step_count: Int[Array, ""]


@chex.dataclass(frozen=True)
class OaKUpdateResult:
    """Result of one primitive OaK transition."""

    state: OaKState
    td_error: Float[Array, ""]
    average_reward: Float[Array, ""]
    primitive_action: Int[Array, ""]
    executing_option: Int[Array, ""]
    option_terminated: Array
    pseudo_reward: Float[Array, ""]
    utility_ema: Float[Array, " n_options"]


@chex.dataclass(frozen=True)
class OaKArrayResult:
    """Scan result for OaK over transition arrays."""

    state: OaKState
    td_errors: Float[Array, " num_steps"]
    average_rewards: Float[Array, " num_steps"]
    primitive_actions: Int[Array, " num_steps"]
    executing_options: Int[Array, " num_steps"]
    option_terminations: Array
    pseudo_rewards: Float[Array, " num_steps"]
    utility_emas: Float[Array, "num_steps n_options"]


# ---------------------------------------------------------------------------
# Learned feature construction and keyboard chord learning
# ---------------------------------------------------------------------------


def learned_feature_subtask_specs(
    oak_state: OaKState,
    *,
    n_subtasks: int = 4,
    threshold: float = 0.5,
    pseudo_reward_scale: float = 1.0,
    max_option_steps: int = 20,
    min_score: float = 0.0,
) -> tuple[SubtaskSpec, ...]:
    """Construct subtask specs from learned OaK feature importance.

    Feature scores combine base extended-action Q weights and intra-option
    primitive-action Q weights.  The highest-scoring observation features are
    converted into :class:`SubtaskSpec` objects for curation or replacement.
    """
    bls = oak_state.stomp_state.base_learner_state
    if len(bls.trunk_params.weights) == 0:
        base_q = jnp.stack([w[0] for w in bls.head_params.weights])
    else:
        base_q = bls.trunk_params.weights[0]
    base_scores = jnp.max(jnp.abs(base_q), axis=0)

    option_q = oak_state.stomp_state.option_policies.q_weights
    obs_dim = int(option_q.shape[-1])
    option_scores = jnp.max(jnp.abs(option_q).reshape(-1, obs_dim), axis=0)
    combined_scores = base_scores + option_scores
    specs = subtasks_from_feature_scores(
        combined_scores,
        top_k=n_subtasks,
        threshold=threshold,
        pseudo_reward_scale=pseudo_reward_scale,
        max_option_steps=max_option_steps,
        min_score=min_score,
    )
    return tuple(specs)


@dataclasses.dataclass(frozen=True)
class KeyboardChordLearnerConfig:
    """Bandit-style learner for option-keyboard chord vectors."""

    n_options: int
    step_size: float = 0.1
    baseline_decay: float = 0.9
    l2_penalty: float = 0.0
    max_norm: float = 10.0

    def __post_init__(self) -> None:
        if self.n_options <= 0:
            raise ValueError("n_options must be positive")
        if self.step_size < 0.0:
            raise ValueError("step_size must be non-negative")
        if not 0.0 <= self.baseline_decay < 1.0:
            raise ValueError("baseline_decay must be in [0, 1)")
        if self.l2_penalty < 0.0:
            raise ValueError("l2_penalty must be non-negative")
        if self.max_norm <= 0.0:
            raise ValueError("max_norm must be positive")

    def to_config(self) -> dict[str, Any]:
        """Serialize to a JSON-compatible dictionary."""
        payload = dataclasses.asdict(self)
        payload["type"] = "KeyboardChordLearnerConfig"
        return payload

    @classmethod
    def from_config(cls, payload: dict[str, Any]) -> KeyboardChordLearnerConfig:
        """Reconstruct from :meth:`to_config` output."""
        data = dict(payload)
        data.pop("type", None)
        return cls(**data)


@chex.dataclass(frozen=True)
class KeyboardChordLearnerState:
    """State for bandit-style chord-vector learning."""

    chord_vector: Float[Array, " n_options"]
    reward_baseline: Float[Array, ""]
    step_count: Int[Array, ""]


def init_keyboard_chord_learner(
    config: KeyboardChordLearnerConfig,
) -> KeyboardChordLearnerState:
    """Initialize keyboard-chord learner state."""
    return KeyboardChordLearnerState(
        chord_vector=jnp.ones(config.n_options, dtype=jnp.float32) / config.n_options,
        reward_baseline=jnp.array(0.0, dtype=jnp.float32),
        step_count=jnp.array(0, dtype=jnp.int32),
    )


def update_keyboard_chord_learner(
    config: KeyboardChordLearnerConfig,
    state: KeyboardChordLearnerState,
    selected_chord: Array,
    reward: Array,
) -> KeyboardChordLearnerState:
    """Apply one bandit-style reward update for a selected chord.

    Positive advantage moves the learned chord vector toward the selected
    chord; negative advantage moves it away.  The reward baseline is an EMA.
    """
    chord = jnp.asarray(selected_chord, dtype=jnp.float32).reshape((config.n_options,))
    chord_norm = chord / (jnp.linalg.norm(chord) + 1.0e-8)
    reward_arr = jnp.asarray(reward, dtype=jnp.float32)
    baseline = (
        config.baseline_decay * state.reward_baseline
        + (1.0 - config.baseline_decay) * reward_arr
    )
    advantage = reward_arr - state.reward_baseline
    new_vector = (
        state.chord_vector * (1.0 - config.step_size * config.l2_penalty)
        + config.step_size * advantage * chord_norm
    )
    norm = jnp.linalg.norm(new_vector)
    scale = jnp.minimum(1.0, jnp.asarray(config.max_norm, dtype=jnp.float32) / (norm + 1.0e-8))
    return KeyboardChordLearnerState(
        chord_vector=new_vector * scale,
        reward_baseline=baseline,
        step_count=state.step_count + 1,
    )


# ---------------------------------------------------------------------------
# Option keyboard (standalone JAX functions)
# ---------------------------------------------------------------------------


def keyboard_q_values(
    stomp_state: STOMPState,
    observation: Float[Array, " obs_dim"],
    keyboard_vector: Float[Array, " n_options"],
) -> Float[Array, " n_primitive_actions"]:
    """Compute primitive Q-values for a chord keyboard vector.

    Per Barreto et al. (2019) Eq. 6:
    ``Q_w(s, a) = Σ_i w_i · Q_i(s, a)``
    where ``Q_i(s, a) = option_q_weights[i, a, :] @ s``.

    The keyboard vector is internally L1-normalised so the blend is
    well-defined regardless of scale.

    Args:
        stomp_state: Current STOMP agent state; provides
            ``option_policies.q_weights`` of shape
            ``(n_options, n_prim, obs_dim)``.
        observation: Current observation, shape ``(obs_dim,)``.
        keyboard_vector: Chord weights, shape ``(n_options,)``.

    Returns:
        Shape ``(n_prim,)`` blended Q-values for each primitive action.
    """
    w = keyboard_vector / (jnp.sum(jnp.abs(keyboard_vector)) + 1e-8)
    blended = jnp.einsum("o,oap->ap", w, stomp_state.option_policies.q_weights)
    return blended @ observation


def keyboard_action(
    stomp_state: STOMPState,
    observation: Float[Array, " obs_dim"],
    keyboard_vector: Float[Array, " n_options"],
    key: Array,
    *,
    epsilon: float,
    n_primitive_actions: int,
) -> tuple[Int[Array, ""], Array]:
    """Select a primitive action using a chord keyboard vector.

    Uses the blended Q-values from :func:`keyboard_q_values` with ε-greedy
    exploration and Gumbel-noise tie-breaking.

    Args:
        stomp_state: Current STOMP agent state.
        observation: Current observation.
        keyboard_vector: Chord weights.
        key: JAX PRNG key.
        epsilon: Exploration probability.
        n_primitive_actions: Number of primitive actions.

    Returns:
        ``(action, new_key)`` pair.
    """
    q_vals = keyboard_q_values(stomp_state, observation, keyboard_vector)
    key, explore_key, noise_key = jr.split(key, 3)
    greedy = jnp.argmax(
        q_vals + 1e-6 * jr.gumbel(noise_key, (n_primitive_actions,))
    ).astype(jnp.int32)
    random_action = jr.randint(explore_key, (), 0, n_primitive_actions).astype(jnp.int32)
    action = jnp.where(
        jr.uniform(key) < jnp.asarray(epsilon, dtype=jnp.float32),
        random_action,
        greedy,
    )
    return action, key


# ---------------------------------------------------------------------------
# OaK agent
# ---------------------------------------------------------------------------


class OaKAgent:
    """Alberta Plan Step 11 OaK agent.

    Wraps a :class:`~alberta_framework.core.options.STOMPAgent` with:

    * **Utility tracking**: an EMA utility score per option, updated on every
      step that an option is actively executing.
    * **Curation**: :meth:`curate` replaces the lowest-utility option when its
      score falls below ``config.curation_threshold``.
    * **Option keyboard**: :meth:`keyboard_q_values` and
      :meth:`keyboard_action` provide chord-blended Q-inference.
    """

    def __init__(self, config: OaKConfig) -> None:
        if config.n_options == 0:
            raise ValueError("OaKAgent requires at least one subtask/option")
        self._config = config
        self._stomp = STOMPAgent(config.stomp)

    @property
    def config(self) -> OaKConfig:
        return self._config

    @property
    def stomp_agent(self) -> STOMPAgent:
        return self._stomp

    def base_q_values(self, state: OaKState, observation: Array) -> Array:
        """Compute Q-values for all extended actions."""
        return self._stomp.base_q_values(state.stomp_state, observation)

    def to_config(self) -> dict[str, Any]:
        return self._config.to_config()

    def init(self, key: Array) -> OaKState:
        """Initialise OaK state (zeros for utility tracking)."""
        stomp_state = self._stomp.init(key)
        n_opt = self._config.n_options
        return OaKState(
            stomp_state=stomp_state,
            execution_counts=jnp.zeros(n_opt, dtype=jnp.int32),
            cumulative_pseudo_rewards=jnp.zeros(n_opt, dtype=jnp.float32),
            utility_ema=jnp.zeros(n_opt, dtype=jnp.float32),
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    def start(self, state: OaKState, initial_observation: Array) -> OaKState:
        """Prime the agent with an initial observation."""
        new_stomp = self._stomp.start(state.stomp_state, initial_observation)
        return cast(OaKState, state.replace(stomp_state=new_stomp))

    def update(
        self,
        state: OaKState,
        env_reward: Array,
        next_observation: Array,
    ) -> OaKUpdateResult:
        """Process one real-time primitive STOMP + utility-tracking step.

        All branching is via ``jnp.where`` so this method is ``jax.lax.scan``
        compatible.

        Args:
            state: Current OaK state.
            env_reward: Scalar environment reward.
            next_observation: Next observation from the environment.

        Returns:
            :class:`OaKUpdateResult` with new state and per-step diagnostics.
        """
        cfg = self._config
        n_opt = cfg.n_options

        stomp_result: STOMPUpdateResult = self._stomp.update(
            state.stomp_state, env_reward, next_observation
        )

        executing = stomp_result.state.executing_option
        option_idx = jnp.maximum(executing, jnp.array(0, dtype=jnp.int32))
        option_mask = jnp.arange(n_opt, dtype=jnp.int32) == option_idx
        is_exec = executing >= jnp.array(0, dtype=jnp.int32)

        # Utility EMA: update when the option is executing
        decay = jnp.asarray(cfg.utility_ema_decay, dtype=jnp.float32)
        new_utility_ema = jnp.where(
            option_mask & is_exec,
            decay * state.utility_ema + (1.0 - decay) * stomp_result.pseudo_reward,
            state.utility_ema,
        )

        # Execution count: increment on option start
        was_idle = state.stomp_state.executing_option < jnp.array(0, dtype=jnp.int32)
        just_started = was_idle & is_exec
        new_exec_counts = state.execution_counts + jnp.where(
            option_mask & just_started,
            jnp.ones(n_opt, dtype=jnp.int32),
            jnp.zeros(n_opt, dtype=jnp.int32),
        )

        # Cumulative pseudo-reward: accumulate while executing
        new_cum_pseudo = state.cumulative_pseudo_rewards + jnp.where(
            option_mask & is_exec,
            jnp.full(n_opt, stomp_result.pseudo_reward, dtype=jnp.float32),
            jnp.zeros(n_opt, dtype=jnp.float32),
        )

        new_state = OaKState(
            stomp_state=stomp_result.state,
            execution_counts=new_exec_counts,
            cumulative_pseudo_rewards=new_cum_pseudo,
            utility_ema=new_utility_ema,
            step_count=state.step_count + 1,
        )

        return OaKUpdateResult(
            state=new_state,
            td_error=stomp_result.td_error,
            average_reward=stomp_result.average_reward,
            primitive_action=stomp_result.primitive_action,
            executing_option=stomp_result.executing_option,
            option_terminated=stomp_result.option_terminated,
            pseudo_reward=stomp_result.pseudo_reward,
            utility_ema=new_utility_ema,
        )

    def scan(
        self,
        state: OaKState,
        env_rewards: Array,
        next_observations: Array,
    ) -> OaKArrayResult:
        """Run OaK over pre-collected continuing transition arrays via scan."""

        def step_fn(
            carry: OaKState,
            inputs: tuple[Array, Array],
        ) -> tuple[OaKState, tuple[Array, ...]]:
            reward, next_obs = inputs
            result = self.update(carry, reward, next_obs)
            return result.state, (
                result.td_error,
                result.average_reward,
                result.primitive_action,
                result.executing_option,
                result.option_terminated,
                result.pseudo_reward,
                result.utility_ema,
            )

        final_state, (
            td_errors,
            average_rewards,
            primitive_actions,
            executing_options,
            option_terminations,
            pseudo_rewards,
            utility_emas,
        ) = jax.lax.scan(step_fn, state, (env_rewards, next_observations))

        return OaKArrayResult(
            state=final_state,
            td_errors=td_errors,
            average_rewards=average_rewards,
            primitive_actions=primitive_actions,
            executing_options=executing_options,
            option_terminations=option_terminations,
            pseudo_rewards=pseudo_rewards,
            utility_emas=utility_emas,
        )

    def curate(
        self,
        state: OaKState,
        key: Array,
        available_feature_indices: list[int] | None = None,
    ) -> tuple[OaKAgent, OaKState]:
        """Replace the lowest-utility option with a new subtask.

        The replacement creates a new :class:`OaKAgent` with updated subtask
        specs.  The replaced option's Q-weights, eligibility traces, option
        model, and utility statistics are reset to initial values.

        Curation is a **Python-level operation** — it runs outside
        ``jax.lax.scan`` / JIT and materialises JAX array values.

        Args:
            state: Current OaK state.
            key: JAX PRNG key for selecting the replacement feature index.
            available_feature_indices: Pool of feature indices to draw the
                new subtask from.  Defaults to all indices not already in
                use; if all are in use, samples from the full range.

        Returns:
            ``(new_agent, new_state)`` where ``new_agent`` has updated subtask
            specs and ``new_state`` has the replaced option's arrays zeroed.
        """
        cfg = self._config
        utility = state.utility_ema

        # Find option with lowest utility
        worst_idx = int(jnp.argmin(utility))
        worst_utility = float(utility[worst_idx])

        # Skip if utility is above threshold and threshold > 0
        if cfg.curation_threshold > 0.0 and worst_utility >= cfg.curation_threshold:
            return self, state

        # Pick replacement feature index
        current_feat_indices = {s.feature_index for s in cfg.stomp.subtask_specs}
        obs_dim = cfg.observation_dim
        if available_feature_indices is None:
            pool = [i for i in range(obs_dim) if i not in current_feat_indices]
            if not pool:
                pool = list(range(obs_dim))
        else:
            pool = list(available_feature_indices)

        key, subkey = jr.split(key)
        new_feat_idx = pool[int(jr.randint(subkey, (), 0, len(pool)))]

        # Build new spec list (preserve threshold / scale / max_steps)
        new_specs = list(cfg.stomp.subtask_specs)
        old = new_specs[worst_idx]
        new_specs[worst_idx] = SubtaskSpec(
            feature_index=new_feat_idx,
            threshold=old.threshold,
            pseudo_reward_scale=old.pseudo_reward_scale,
            max_option_steps=old.max_option_steps,
        )

        # Reset STOMP state for the replaced option
        idx = worst_idx
        n_prim = cfg.n_primitive_actions

        new_op_weights = state.stomp_state.option_policies.q_weights.at[idx].set(
            jnp.zeros_like(state.stomp_state.option_policies.q_weights[idx])
        )
        new_op_traces = state.stomp_state.option_policies.traces.at[idx].set(
            jnp.zeros_like(state.stomp_state.option_policies.traces[idx])
        )
        new_option_policies = cast(
            IntraOptionPoliciesState,
            state.stomp_state.option_policies.replace(
                q_weights=new_op_weights, traces=new_op_traces
            ),
        )

        new_ns_weights = state.stomp_state.option_models.next_state_weights.at[idx].set(
            jnp.zeros_like(state.stomp_state.option_models.next_state_weights[idx])
        )
        new_option_models = cast(
            OptionModelsState,
            state.stomp_state.option_models.replace(
                cumreward_ema=state.stomp_state.option_models.cumreward_ema.at[idx].set(0.0),
                discount_ema=state.stomp_state.option_models.discount_ema.at[idx].set(1.0),
                next_state_weights=new_ns_weights,
                n_completions=state.stomp_state.option_models.n_completions.at[idx].set(0),
            ),
        )

        base_action_idx = n_prim + idx
        ls = state.stomp_state.base_learner_state
        new_head_weights = tuple(
            jnp.zeros_like(w) if i == base_action_idx else w
            for i, w in enumerate(ls.head_params.weights)
        )
        new_head_biases = tuple(
            jnp.zeros_like(b) if i == base_action_idx else b
            for i, b in enumerate(ls.head_params.biases)
        )
        new_head_traces = tuple(
            (jnp.zeros_like(tw), jnp.zeros_like(tb)) if i == base_action_idx else (tw, tb)
            for i, (tw, tb) in enumerate(ls.head_traces)
        )
        new_head_opt_states = tuple(
            jax.tree_util.tree_map(jnp.zeros_like, opt) if i == base_action_idx else opt
            for i, opt in enumerate(ls.head_optimizer_states)
        )
        new_base_learner_state = ls.replace(
            head_params=MLPParams(weights=new_head_weights, biases=new_head_biases),
            head_traces=new_head_traces,
            head_optimizer_states=new_head_opt_states,
        )

        new_stomp_state = cast(
            STOMPState,
            state.stomp_state.replace(
                base_learner_state=new_base_learner_state,
                option_policies=new_option_policies,
                option_models=new_option_models,
            ),
        )

        # Reset utility stats for replaced option
        replace_mask = jnp.arange(cfg.n_options, dtype=jnp.int32) == idx
        new_state = OaKState(
            stomp_state=new_stomp_state,
            execution_counts=jnp.where(replace_mask, 0, state.execution_counts),
            cumulative_pseudo_rewards=jnp.where(
                replace_mask, 0.0, state.cumulative_pseudo_rewards
            ),
            utility_ema=jnp.where(replace_mask, 0.0, state.utility_ema),
            step_count=state.step_count,
        )

        # Build new agent with updated config
        new_stomp_cfg = dataclasses.replace(cfg.stomp, subtask_specs=tuple(new_specs))
        new_oak_cfg = dataclasses.replace(cfg, stomp=new_stomp_cfg)
        return OaKAgent(new_oak_cfg), new_state

    def keyboard_q_values(
        self,
        state: OaKState,
        observation: Array,
        keyboard_vector: Array,
    ) -> Array:
        """Compute blended Q-values for a keyboard chord vector."""
        return keyboard_q_values(state.stomp_state, observation, keyboard_vector)

    def keyboard_action(
        self,
        state: OaKState,
        observation: Array,
        keyboard_vector: Array,
        key: Array,
        *,
        epsilon: float = 0.0,
    ) -> tuple[Array, Array]:
        """Select a primitive action for a chord keyboard vector."""
        return keyboard_action(
            state.stomp_state,
            observation,
            keyboard_vector,
            key,
            epsilon=epsilon,
            n_primitive_actions=self._config.n_primitive_actions,
        )


__all__ = [
    "KeyboardChordLearnerConfig",
    "KeyboardChordLearnerState",
    "OaKAgent",
    "OaKArrayResult",
    "OaKConfig",
    "OaKState",
    "OaKUpdateResult",
    "init_keyboard_chord_learner",
    "keyboard_action",
    "keyboard_q_values",
    "learned_feature_subtask_specs",
    "update_keyboard_chord_learner",
]
