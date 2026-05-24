"""SARSA agent: on-policy control via Horde (Sutton & Barto Ch. 10).

Wraps ``HordeLearner`` with epsilon-greedy action selection and SARSA
target computation. Each action maps to a control demon (head) in the
Horde. The SARSA target ``r + gamma * Q(s', a')`` is computed externally
and passed as the cumulant to the Horde, so control demons use gamma=0
internally (single-step prediction of the externally-computed target).

This avoids modifying the Horde's TD target logic: the real discount
lives in ``SARSAConfig.gamma``, while each control demon sees its
cumulant as a supervised target.

Optionally, prediction demons can coexist with control demons in the
same Horde — they learn alongside the Q-heads without interference.

Reference: Sutton & Barto 2018, Section 10.1 (Episodic Semi-gradient SARSA)
"""

import dataclasses
import functools
import time
from typing import Any

import chex
import jax
import jax.numpy as jnp
import jax.random as jr
from jax import Array
from jaxtyping import Float, Int

from alberta_framework.core.horde import HordeLearner
from alberta_framework.core.multi_head_learner import (
    AnyOptimizer,
    MultiHeadMLPState,
)
from alberta_framework.core.normalizers import (
    EMANormalizerState,
    Normalizer,
    WelfordNormalizerState,
)
from alberta_framework.core.optimizers import Bounder
from alberta_framework.core.types import (
    DemonType,
    GVFSpec,
    TraceMode,
    create_horde_spec,
)

# =============================================================================
# Types
# =============================================================================


@chex.dataclass(frozen=True)
class SARSAConfig:
    """Configuration for SARSA agent.

    Attributes:
        n_actions: Number of discrete actions
        gamma: Discount factor for SARSA targets (default: 0.99)
        epsilon_start: Initial exploration rate (default: 0.1)
        epsilon_end: Final exploration rate (default: 0.01)
        epsilon_decay_steps: Steps over which epsilon decays linearly.
            0 = no decay (constant epsilon_start).
    """

    n_actions: int
    gamma: float = 0.99
    epsilon_start: float = 0.1
    epsilon_end: float = 0.01
    epsilon_decay_steps: int = 0

    def to_config(self) -> dict[str, Any]:
        """Serialize to dict."""
        return {
            "n_actions": self.n_actions,
            "gamma": self.gamma,
            "epsilon_start": self.epsilon_start,
            "epsilon_end": self.epsilon_end,
            "epsilon_decay_steps": self.epsilon_decay_steps,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> "SARSAConfig":
        """Reconstruct from config dict."""
        return cls(**config)


@chex.dataclass(frozen=True)
class SARSAState:
    """State for the SARSA agent.

    Attributes:
        learner_state: Underlying Horde/MultiHeadMLPLearner state
        last_action: Action taken at previous step (a_t)
        last_observation: Observation at previous step (s_t)
        epsilon: Current exploration rate
        rng_key: JAX random key for action selection
        step_count: Number of SARSA update steps taken
    """

    learner_state: MultiHeadMLPState
    last_action: Int[Array, ""]
    last_observation: Float[Array, " feature_dim"]
    epsilon: Float[Array, ""]
    rng_key: Array
    step_count: Int[Array, ""]


@chex.dataclass(frozen=True)
class SARSAUpdateResult:
    """Result of a single SARSA update step.

    Attributes:
        state: Updated SARSA state (includes new action a_{t+1})
        action: Next action a_{t+1} selected for the new state
        q_values: Q-values for all actions at s_{t+1}
        td_error: TD error for the taken action
        reward: Reward received
    """

    state: SARSAState
    action: Int[Array, ""]
    q_values: Float[Array, " n_actions"]
    td_error: Float[Array, ""]
    reward: Float[Array, ""]


@dataclasses.dataclass(frozen=True)
class SARSAEpisodeResult:
    """Result from running one episode of SARSA.

    Not a chex dataclass — used in Python loops with native Python types.

    Attributes:
        state: Final SARSA state
        total_reward: Sum of rewards in the episode
        num_steps: Number of steps taken
        rewards: Per-step rewards
        q_values: Per-step Q-values
        td_errors: Per-step TD errors
    """

    state: SARSAState
    total_reward: float
    num_steps: int
    rewards: list[float]
    q_values: list[Array]
    td_errors: list[float]


@dataclasses.dataclass(frozen=True)
class SARSAContinuingResult:
    """Result from running SARSA in continuing mode.

    Not a chex dataclass — used in Python loops with native Python types.

    Attributes:
        state: Final SARSA state
        total_reward: Sum of rewards over all steps
        rewards: Per-step rewards
        q_values: Per-step Q-values
        td_errors: Per-step TD errors
    """

    state: SARSAState
    total_reward: float
    rewards: list[float]
    q_values: list[Array]
    td_errors: list[float]


@chex.dataclass(frozen=True)
class SARSAArrayResult:
    """Result from scan-based SARSA on pre-collected arrays.

    Attributes:
        state: Final SARSA state
        q_values: Per-step Q-values, shape ``(num_steps, n_actions)``
        td_errors: Per-step TD errors, shape ``(num_steps,)``
        actions: Per-step actions taken, shape ``(num_steps,)``
    """

    state: SARSAState
    q_values: Float[Array, "num_steps n_actions"]
    td_errors: Float[Array, " num_steps"]
    actions: Int[Array, " num_steps"]


# =============================================================================
# SARSAAgent
# =============================================================================


def _make_control_demons(
    n_actions: int,
    lamda: float = 0.0,
) -> list[GVFSpec]:
    """Create n_actions control demons with gamma=0 (targets computed externally).

    Args:
        n_actions: Number of discrete actions
        lamda: Trace decay for head eligibility traces

    Returns:
        List of GVFSpec for control demons
    """
    return [
        GVFSpec(  # type: ignore[call-arg]
            name=f"q_{i}",
            demon_type=DemonType.CONTROL,
            gamma=0.0,
            lamda=lamda,
            cumulant_index=-1,  # external cumulant (SARSA target)
        )
        for i in range(n_actions)
    ]


class SARSAAgent:
    """On-policy SARSA control agent via Horde architecture.

    Wraps ``HordeLearner`` with epsilon-greedy action selection and
    SARSA target computation. Each action maps to a control demon (head)
    in the Horde. The SARSA target ``r + gamma * Q(s', a')`` is computed
    externally and passed as the cumulant, so control demons use gamma=0
    internally.

    Optionally, additional prediction demons can coexist with the control
    demons — they learn alongside the Q-heads.

    Single-Step (Daemon) Usage
    --------------------------
    Both ``select_action()`` and ``update()`` work with single unbatched
    observations (1D arrays). JIT-compiled automatically.

    Attributes:
        sarsa_config: SARSA configuration
        horde: The underlying HordeLearner
        n_actions: Number of discrete actions
    """

    def __init__(
        self,
        sarsa_config: SARSAConfig,
        hidden_sizes: tuple[int, ...] = (128, 128),
        optimizer: AnyOptimizer | None = None,
        step_size: float = 1.0,
        bounder: Bounder | None = None,
        normalizer: (
            Normalizer[EMANormalizerState] | Normalizer[WelfordNormalizerState] | None
        ) = None,
        sparsity: float = 0.9,
        leaky_relu_slope: float = 0.01,
        use_layer_norm: bool = True,
        head_optimizer: AnyOptimizer | None = None,
        prediction_demons: list[GVFSpec] | None = None,
        lamda: float = 0.0,
        trace_mode: TraceMode = TraceMode.ACCUMULATING,
        utility_decay: float = 0.99,
    ):
        """Initialize the SARSA agent.

        Args:
            sarsa_config: SARSA configuration (n_actions, gamma, epsilon)
            hidden_sizes: Tuple of hidden layer sizes (default: two layers of 128)
            optimizer: Optimizer for weight updates. Defaults to LMS(step_size).
            step_size: Base learning rate (used only when optimizer is None)
            bounder: Optional update bounder (e.g. ObGDBounding)
            normalizer: Optional feature normalizer
            sparsity: Fraction of weights zeroed out per neuron (default: 0.9)
            leaky_relu_slope: Negative slope for LeakyReLU (default: 0.01)
            use_layer_norm: Whether to apply parameterless layer normalization
            head_optimizer: Optional separate optimizer for heads
            prediction_demons: Optional additional prediction demons to
                learn alongside Q-heads. These are appended after the
                control demons in the Horde.
            lamda: Trace decay for control demon heads (default: 0.0)
            trace_mode: Eligibility trace mode (ACCUMULATING or REPLACING)
            utility_decay: EMA decay for hidden-unit utility diagnostics.
        """
        self._sarsa_config = sarsa_config
        self._hidden_sizes = hidden_sizes
        self._lamda = lamda

        # Build HordeSpec: control demons first, then prediction demons
        control_demons = _make_control_demons(sarsa_config.n_actions, lamda=lamda)
        all_demons: list[GVFSpec] = list(control_demons)
        if prediction_demons is not None:
            all_demons.extend(prediction_demons)
        self._n_prediction_demons = len(prediction_demons) if prediction_demons else 0

        horde_spec = create_horde_spec(all_demons)

        self._horde = HordeLearner(
            horde_spec=horde_spec,
            hidden_sizes=hidden_sizes,
            optimizer=optimizer,
            step_size=step_size,
            bounder=bounder,
            normalizer=normalizer,
            sparsity=sparsity,
            leaky_relu_slope=leaky_relu_slope,
            use_layer_norm=use_layer_norm,
            head_optimizer=head_optimizer,
            trace_mode=trace_mode,
            utility_decay=utility_decay,
        )

    @property
    def sarsa_config(self) -> SARSAConfig:
        """The SARSA configuration."""
        return self._sarsa_config

    @property
    def horde(self) -> HordeLearner:
        """The underlying HordeLearner."""
        return self._horde

    @property
    def n_actions(self) -> int:
        """Number of discrete actions."""
        return self._sarsa_config.n_actions

    def to_config(self) -> dict[str, Any]:
        """Serialize agent configuration to dict."""
        horde_config = self._horde.to_config()
        # Remove fields managed by SARSAAgent
        horde_config.pop("type", None)
        horde_config.pop("horde_spec", None)

        # Extract prediction demon specs if any
        pred_demons = None
        if self._n_prediction_demons > 0:
            all_demons = self._horde.horde_spec.demons
            pred_demons = [
                d.to_config()
                for d in all_demons[self._sarsa_config.n_actions :]
            ]

        return {
            "type": "SARSAAgent",
            "sarsa_config": self._sarsa_config.to_config(),
            "lamda": self._lamda,
            "prediction_demons": pred_demons,
            **horde_config,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> "SARSAAgent":
        """Reconstruct from config dict."""
        from alberta_framework.core.normalizers import normalizer_from_config
        from alberta_framework.core.optimizers import (
            bounder_from_config,
            optimizer_from_config,
        )

        config = dict(config)
        config.pop("type", None)

        sarsa_config = SARSAConfig.from_config(config.pop("sarsa_config"))
        optimizer = optimizer_from_config(config.pop("optimizer"))
        bounder_cfg = config.pop("bounder", None)
        bounder = bounder_from_config(bounder_cfg) if bounder_cfg is not None else None
        normalizer_cfg = config.pop("normalizer", None)
        normalizer = (
            normalizer_from_config(normalizer_cfg) if normalizer_cfg is not None else None
        )
        head_opt_cfg = config.pop("head_optimizer", None)
        head_optimizer = (
            optimizer_from_config(head_opt_cfg) if head_opt_cfg is not None else None
        )
        pred_demons_cfg = config.pop("prediction_demons", None)
        prediction_demons = None
        if pred_demons_cfg is not None:
            prediction_demons = [GVFSpec.from_config(d) for d in pred_demons_cfg]

        trace_mode_str = config.pop("trace_mode", None)
        trace_mode = (
            TraceMode(trace_mode_str) if trace_mode_str is not None else TraceMode.ACCUMULATING
        )

        return cls(
            sarsa_config=sarsa_config,
            hidden_sizes=tuple(config.pop("hidden_sizes")),
            optimizer=optimizer,
            bounder=bounder,
            normalizer=normalizer,
            head_optimizer=head_optimizer,
            prediction_demons=prediction_demons,
            trace_mode=trace_mode,
            **config,
        )

    def init(self, feature_dim: int, key: Array) -> SARSAState:
        """Initialize SARSA agent state.

        Args:
            feature_dim: Dimension of the input feature vector
            key: JAX random key

        Returns:
            Initial SARSAState with zeroed last_action/observation
        """
        key, subkey = jr.split(key)
        learner_state = self._horde.init(feature_dim, subkey)

        return SARSAState(  # type: ignore[call-arg]
            learner_state=learner_state,
            last_action=jnp.array(-1, dtype=jnp.int32),
            last_observation=jnp.zeros(feature_dim, dtype=jnp.float32),
            epsilon=jnp.array(self._sarsa_config.epsilon_start, dtype=jnp.float32),
            rng_key=key,
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def select_action(
        self,
        state: SARSAState,
        observation: Array,
    ) -> tuple[Int[Array, ""], Array]:
        """Select action via epsilon-greedy over Q-values.

        JIT-compiled. Uses Gumbel trick for uniform tie-breaking among
        equal Q-values (avoids left-side bias from ``jnp.argmax``).

        Args:
            state: Current SARSA state (uses rng_key and epsilon)
            observation: Input feature vector

        Returns:
            Tuple of (action, new_rng_key)
        """
        key, explore_key, noise_key, random_key = jr.split(state.rng_key, 4)

        # Get Q-values (first n_actions heads are control demons)
        all_preds = self._horde.predict(state.learner_state, observation)
        q_values = all_preds[: self._sarsa_config.n_actions]

        # Greedy action with Gumbel tie-breaking
        # Add small noise only to max-valued actions for uniform tie-breaking
        gumbel_noise = jr.gumbel(noise_key, shape=q_values.shape) * 1e-6
        greedy_action = jnp.argmax(q_values + gumbel_noise).astype(jnp.int32)

        # Random action
        random_action = jr.randint(
            random_key, (), 0, self._sarsa_config.n_actions
        ).astype(jnp.int32)

        # Epsilon-greedy selection
        explore = jr.uniform(explore_key) < state.epsilon
        action = jax.lax.select(explore, random_action, greedy_action)

        return action, key

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: SARSAState,
        reward: Array,
        observation: Array,
        terminated: Array,
        next_action: Array,
        prediction_cumulants: Array | None = None,
    ) -> SARSAUpdateResult:
        """Perform one SARSA update step.

        Computes the SARSA target ``r + gamma * Q(s', a')`` and updates
        the Horde. Only the previously-taken action's head receives the
        target; all other Q-heads get NaN (no update).

        Args:
            state: Current SARSA state
            reward: Reward r received after taking last_action in last_obs
            observation: New observation s' (state we transitioned to)
            terminated: Whether s' is terminal (scalar bool/float)
            next_action: Action a' selected for s' (pre-computed)
            prediction_cumulants: Optional cumulants for prediction demons,
                shape ``(n_prediction_demons,)``. NaN for inactive demons.

        Returns:
            SARSAUpdateResult with updated state, Q-values, TD error
        """
        n_actions = self._sarsa_config.n_actions
        gamma = self._sarsa_config.gamma

        # Q(s', :) for all actions
        all_preds = self._horde.predict(state.learner_state, observation)
        q_next = all_preds[:n_actions]
        q_previous = self._horde.predict(
            state.learner_state,
            state.last_observation,
        )[:n_actions]

        # SARSA target: r + gamma * Q(s', a') with terminal handling
        effective_gamma = jnp.where(terminated, 0.0, gamma)
        sarsa_target = reward + effective_gamma * q_next[next_action]

        # Build cumulants: NaN for all except last_action gets sarsa_target
        cumulants = jnp.full(self._horde.n_demons, jnp.nan, dtype=jnp.float32)
        # Only update the head corresponding to the action we took at s_t
        cumulants = cumulants.at[state.last_action].set(sarsa_target)

        # Add prediction demon cumulants if any
        if prediction_cumulants is not None:
            cumulants = cumulants.at[n_actions:].set(prediction_cumulants)

        # Horde update: learns from (s_t, cumulants, s')
        horde_result = self._horde.update(
            state.learner_state,
            state.last_observation,
            cumulants,
            observation,
        )

        # TD error for the taken action
        q_old = q_previous[state.last_action]
        td_error = sarsa_target - q_old

        # Epsilon decay
        cfg = self._sarsa_config
        new_step_count = state.step_count + 1
        new_epsilon = jax.lax.cond(
            cfg.epsilon_decay_steps > 0,
            lambda: jnp.maximum(
                cfg.epsilon_end,
                cfg.epsilon_start
                - (cfg.epsilon_start - cfg.epsilon_end)
                * new_step_count
                / cfg.epsilon_decay_steps,
            ),
            lambda: state.epsilon,
        )

        new_state = SARSAState(  # type: ignore[call-arg]
            learner_state=horde_result.state,
            last_action=next_action,
            last_observation=observation,
            epsilon=new_epsilon,
            rng_key=state.rng_key,
            step_count=new_step_count,
        )

        return SARSAUpdateResult(  # type: ignore[call-arg]
            state=new_state,
            action=next_action,
            q_values=q_next,
            td_error=td_error,
            reward=reward,
        )


# =============================================================================
# Learning Loops
# =============================================================================


def run_sarsa_episode(
    agent: SARSAAgent,
    state: SARSAState,
    env: Any,
    max_steps: int = 10000,
) -> SARSAEpisodeResult:
    """Run one episode of SARSA on a Gymnasium environment.

    Python loop (env interaction not JIT-able). Follows the SARSA
    pattern: select a' *before* updating, so the update uses the
    on-policy next action.

    Args:
        agent: SARSA agent
        state: Initial SARSA state
        env: Gymnasium environment
        max_steps: Maximum steps per episode

    Returns:
        SARSAEpisodeResult with episode metrics
    """
    obs, _info = env.reset()
    obs = jnp.asarray(obs, dtype=jnp.float32).flatten()

    # Select initial action
    action, new_key = agent.select_action(state, obs)
    state = state.replace(  # type: ignore[attr-defined]
        last_action=action,
        last_observation=obs,
        rng_key=new_key,
    )

    rewards: list[float] = []
    q_values_list: list[Array] = []
    td_errors: list[float] = []
    total_reward = 0.0

    for _ in range(max_steps):
        # Step environment
        next_obs, reward, terminated, truncated, _info = env.step(int(action))
        next_obs = jnp.asarray(next_obs, dtype=jnp.float32).flatten()
        reward_arr = jnp.array(reward, dtype=jnp.float32)
        term_arr = jnp.array(terminated, dtype=jnp.float32)

        # Select next action a' (on-policy)
        next_action, new_key = agent.select_action(state, next_obs)
        state = state.replace(rng_key=new_key)  # type: ignore[attr-defined]

        # SARSA update
        result = agent.update(
            state, reward_arr, next_obs, term_arr, next_action
        )
        state = result.state

        rewards.append(float(reward))
        q_values_list.append(result.q_values)
        td_errors.append(float(result.td_error))
        total_reward += float(reward)

        action = next_action

        if terminated or truncated:
            break

    return SARSAEpisodeResult(
        state=state,
        total_reward=total_reward,
        num_steps=len(rewards),
        rewards=rewards,
        q_values=q_values_list,
        td_errors=td_errors,
    )


def run_sarsa_continuing(
    agent: SARSAAgent,
    state: SARSAState,
    env: Any,
    num_steps: int,
) -> SARSAContinuingResult:
    """Run SARSA in continuing mode for a fixed number of steps.

    At episode boundaries, the environment auto-resets. gamma is set to 0
    at pseudo-boundaries (terminal/truncated) to prevent bootstrapping
    across resets, matching the ``ContinuingWrapper`` pattern.

    Args:
        agent: SARSA agent
        state: Initial SARSA state
        env: Gymnasium environment
        num_steps: Number of steps to run

    Returns:
        SARSAContinuingResult with step-level metrics
    """
    obs, _info = env.reset()
    obs = jnp.asarray(obs, dtype=jnp.float32).flatten()

    # Select initial action
    action, new_key = agent.select_action(state, obs)
    state = state.replace(  # type: ignore[attr-defined]
        last_action=action,
        last_observation=obs,
        rng_key=new_key,
    )

    rewards: list[float] = []
    q_values_list: list[Array] = []
    td_errors: list[float] = []
    total_reward = 0.0

    for _ in range(num_steps):
        next_obs, reward, terminated, truncated, _info = env.step(int(action))
        next_obs = jnp.asarray(next_obs, dtype=jnp.float32).flatten()
        reward_arr = jnp.array(reward, dtype=jnp.float32)

        # Continuing mode: gamma=0 at pseudo-boundaries
        is_boundary = terminated or truncated
        term_arr = jnp.array(is_boundary, dtype=jnp.float32)

        if is_boundary:
            next_obs_reset, _info = env.reset()
            next_obs = jnp.asarray(next_obs_reset, dtype=jnp.float32).flatten()

        # Select next action
        next_action, new_key = agent.select_action(state, next_obs)
        state = state.replace(rng_key=new_key)  # type: ignore[attr-defined]

        # SARSA update
        result = agent.update(
            state, reward_arr, next_obs, term_arr, next_action
        )
        state = result.state

        rewards.append(float(reward))
        q_values_list.append(result.q_values)
        td_errors.append(float(result.td_error))
        total_reward += float(reward)

        action = next_action

    return SARSAContinuingResult(
        state=state,
        total_reward=total_reward,
        rewards=rewards,
        q_values=q_values_list,
        td_errors=td_errors,
    )


def run_sarsa_from_arrays(
    agent: SARSAAgent,
    state: SARSAState,
    observations: Float[Array, "num_steps feature_dim"],
    rewards: Float[Array, " num_steps"],
    terminated: Float[Array, " num_steps"],
    next_observations: Float[Array, "num_steps feature_dim"],
) -> SARSAArrayResult:
    """Run SARSA on pre-collected arrays via ``jax.lax.scan``.

    JIT-compiled for maximum throughput. Actions are selected on-policy
    within the scan. This is the primary loop for security-gym data
    where observations are pre-collected.

    Args:
        agent: SARSA agent
        state: Initial SARSA state (must have valid last_action, last_observation)
        observations: Current observations, shape ``(num_steps, feature_dim)``
        rewards: Rewards, shape ``(num_steps,)``
        terminated: Termination flags, shape ``(num_steps,)``
        next_observations: Next observations, shape ``(num_steps, feature_dim)``

    Returns:
        SARSAArrayResult with per-step Q-values, TD errors, and actions
    """

    @jax.jit
    def _scan_fn(
        carry: SARSAState,
        inputs: tuple[Array, Array, Array, Array],
    ) -> tuple[SARSAState, tuple[Array, Array, Array]]:
        s = carry
        obs, r, term, next_obs = inputs

        # Select next action for next_obs
        next_action, new_key = agent.select_action(s, next_obs)
        s = s.replace(rng_key=new_key)  # type: ignore[attr-defined]

        # Update using current obs/reward/next_obs
        result = agent.update(s, r, next_obs, term, next_action)

        return result.state, (result.q_values, result.td_error, result.action)

    t0 = time.time()
    final_state, (q_vals, td_errs, actions) = jax.lax.scan(
        _scan_fn, state, (observations, rewards, terminated, next_observations)
    )
    elapsed = time.time() - t0

    # Update uptime on the inner learner state
    final_learner = final_state.learner_state.replace(  # type: ignore[attr-defined]
        uptime_s=final_state.learner_state.uptime_s + elapsed,
    )
    final_state = final_state.replace(learner_state=final_learner)  # type: ignore[attr-defined]

    return SARSAArrayResult(  # type: ignore[call-arg]
        state=final_state,
        q_values=q_vals,
        td_errors=td_errs,
        actions=actions,
    )


def run_sarsa_from_arrays_final_state(
    agent: SARSAAgent,
    state: SARSAState,
    observations: Float[Array, "num_steps feature_dim"],
    rewards: Float[Array, " num_steps"],
    terminated: Float[Array, " num_steps"],
    next_observations: Float[Array, "num_steps feature_dim"],
) -> SARSAState:
    """Run the scan-compatible SARSA loop and return only the final state.

    Throughput benchmarks use this helper to avoid materializing per-step
    Q-values, TD errors, and actions.
    """

    @jax.jit
    def _scan_fn(
        carry: SARSAState,
        inputs: tuple[Array, Array, Array, Array],
    ) -> tuple[SARSAState, None]:
        s = carry
        _obs, r, term, next_obs = inputs
        next_action, new_key = agent.select_action(s, next_obs)
        s = s.replace(rng_key=new_key)  # type: ignore[attr-defined]
        result = agent.update(s, r, next_obs, term, next_action)
        return result.state, None

    t0 = time.time()
    final_state, _ = jax.lax.scan(
        _scan_fn,
        state,
        (observations, rewards, terminated, next_observations),
    )
    elapsed = time.time() - t0
    final_learner = final_state.learner_state.replace(  # type: ignore[attr-defined]
        uptime_s=final_state.learner_state.uptime_s + elapsed,
    )
    return final_state.replace(learner_state=final_learner)  # type: ignore[no-any-return, attr-defined]
