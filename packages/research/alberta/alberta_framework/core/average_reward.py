# mypy: disable-error-code="attr-defined,call-arg"
"""Average-reward prediction and control primitives.

This module covers the first production slice for Alberta Plan Steps 5 and 6:
linear differential TD prediction and linear differential SARSA control in a
continuing, temporally uniform setting.  The algorithms update their value
weights, traces, policies, and average-reward estimate on every transition.
They intentionally stay small and linear so they can serve as a stable target
for later nonlinear Horde/GQ/GTD and actor-critic integrations.
"""

from __future__ import annotations

import dataclasses
import functools
import time
from typing import Any, cast

import chex
import jax
import jax.numpy as jnp
import jax.random as jr
from jax import Array
from jaxtyping import Float, Int

from alberta_framework.core.multi_head_learner import MultiHeadMLPLearner, MultiHeadMLPState
from alberta_framework.core.optimizers import Autostep, AutostepParamState, optimizer_from_config


@dataclasses.dataclass(frozen=True)
class DifferentialTDConfig:
    """Configuration for linear differential TD prediction.

    Attributes:
        step_size: Step-size for value weights and bias.
        average_reward_step_size: Step-size for the reward-rate estimate.
        trace_decay: Accumulating trace decay `lambda`.
    """

    step_size: float = 0.05
    average_reward_step_size: float = 0.01
    trace_decay: float = 0.0

    def __post_init__(self) -> None:
        """Validate scalar hyperparameters."""
        if self.step_size < 0.0:
            raise ValueError("step_size must be non-negative")
        if self.average_reward_step_size < 0.0:
            raise ValueError("average_reward_step_size must be non-negative")
        if not 0.0 <= self.trace_decay <= 1.0:
            raise ValueError("trace_decay must be in [0, 1]")

    def to_config(self) -> dict[str, Any]:
        """Serialize this config to a dictionary."""
        return {
            "type": "DifferentialTDConfig",
            "step_size": self.step_size,
            "average_reward_step_size": self.average_reward_step_size,
            "trace_decay": self.trace_decay,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> DifferentialTDConfig:
        """Reconstruct a config from :meth:`to_config` output."""
        config = dict(config)
        config.pop("type", None)
        return cls(**config)


@chex.dataclass(frozen=True)
class DifferentialTDState:
    """State for linear differential TD prediction.

    Attributes:
        weights: Linear differential value weights.
        bias: Scalar differential value bias.
        eligibility_traces: Accumulating value-weight trace.
        bias_eligibility_trace: Accumulating bias trace.
        average_reward: Running estimate of the continuing reward rate.
        step_count: Number of transition updates.
        birth_timestamp: Wall-clock seconds at initialization.
        uptime_s: Cumulative wall-clock seconds spent in array loops.
    """

    weights: Float[Array, " feature_dim"]
    bias: Float[Array, ""]
    eligibility_traces: Float[Array, " feature_dim"]
    bias_eligibility_trace: Float[Array, ""]
    average_reward: Float[Array, ""]
    step_count: Int[Array, ""]
    birth_timestamp: float = 0.0
    uptime_s: float = 0.0


@chex.dataclass(frozen=True)
class DifferentialTDUpdateResult:
    """Result from one differential TD transition update."""

    state: DifferentialTDState
    prediction: Float[Array, ""]
    next_prediction: Float[Array, ""]
    td_error: Float[Array, ""]
    average_reward: Float[Array, ""]
    metrics: Float[Array, " 4"]


@chex.dataclass(frozen=True)
class DifferentialTDArrayResult:
    """Result from scanning differential TD over arrays."""

    state: DifferentialTDState
    predictions: Float[Array, " num_steps"]
    td_errors: Float[Array, " num_steps"]
    average_rewards: Float[Array, " num_steps"]
    metrics: Float[Array, "num_steps 4"]


@dataclasses.dataclass(frozen=True)
class DifferentialGTDConfig:
    """Configuration for linear differential GTD/TDC prediction.

    Attributes:
        value_step_size: Step-size for primary value weights and bias.
        secondary_step_size: Step-size for the GTD secondary weights.
        average_reward_step_size: Step-size for the reward-rate estimate.
        trace_decay: Accumulating trace decay `lambda`.
        ratio_clip: Maximum importance-sampling ratio.
    """

    value_step_size: float = 0.05
    secondary_step_size: float = 0.01
    average_reward_step_size: float = 0.01
    trace_decay: float = 0.0
    ratio_clip: float = 10.0

    def __post_init__(self) -> None:
        """Validate scalar hyperparameters."""
        if self.value_step_size < 0.0:
            raise ValueError("value_step_size must be non-negative")
        if self.secondary_step_size < 0.0:
            raise ValueError("secondary_step_size must be non-negative")
        if self.average_reward_step_size < 0.0:
            raise ValueError("average_reward_step_size must be non-negative")
        if not 0.0 <= self.trace_decay <= 1.0:
            raise ValueError("trace_decay must be in [0, 1]")
        if self.ratio_clip <= 0.0:
            raise ValueError("ratio_clip must be positive")

    def to_config(self) -> dict[str, Any]:
        """Serialize this config to a dictionary."""
        return {
            "type": "DifferentialGTDConfig",
            "value_step_size": self.value_step_size,
            "secondary_step_size": self.secondary_step_size,
            "average_reward_step_size": self.average_reward_step_size,
            "trace_decay": self.trace_decay,
            "ratio_clip": self.ratio_clip,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> DifferentialGTDConfig:
        """Reconstruct a config from :meth:`to_config` output."""
        config = dict(config)
        config.pop("type", None)
        return cls(**config)


@chex.dataclass(frozen=True)
class DifferentialGTDState:
    """State for linear differential GTD/TDC prediction."""

    weights: Float[Array, " feature_dim"]
    bias: Float[Array, ""]
    secondary_weights: Float[Array, " feature_dim"]
    secondary_bias: Float[Array, ""]
    eligibility_traces: Float[Array, " feature_dim"]
    bias_eligibility_trace: Float[Array, ""]
    average_reward: Float[Array, ""]
    step_count: Int[Array, ""]
    birth_timestamp: float = 0.0
    uptime_s: float = 0.0


@chex.dataclass(frozen=True)
class DifferentialGTDUpdateResult:
    """Result from one differential GTD/TDC transition update."""

    state: DifferentialGTDState
    prediction: Float[Array, ""]
    next_prediction: Float[Array, ""]
    td_error: Float[Array, ""]
    rho_clipped: Float[Array, ""]
    average_reward: Float[Array, ""]
    metrics: Float[Array, " 6"]


@chex.dataclass(frozen=True)
class DifferentialGTDArrayResult:
    """Result from scanning differential GTD/TDC over arrays."""

    state: DifferentialGTDState
    predictions: Float[Array, " num_steps"]
    td_errors: Float[Array, " num_steps"]
    average_rewards: Float[Array, " num_steps"]
    rho_clipped: Float[Array, " num_steps"]
    metrics: Float[Array, "num_steps 6"]


@chex.dataclass(frozen=True)
class AverageRewardHordeState:
    """State for a shared-trunk average-reward Horde."""

    learner_state: MultiHeadMLPState
    average_rewards: Float[Array, " n_demons"]
    step_count: Int[Array, ""]
    birth_timestamp: float = 0.0
    uptime_s: float = 0.0


@chex.dataclass(frozen=True)
class AverageRewardHordeUpdateResult:
    """Result from one average-reward Horde update."""

    state: AverageRewardHordeState
    predictions: Float[Array, " n_demons"]
    next_predictions: Float[Array, " n_demons"]
    td_errors: Float[Array, " n_demons"]
    td_targets: Float[Array, " n_demons"]
    average_rewards: Float[Array, " n_demons"]
    per_demon_metrics: Float[Array, "n_demons 3"]


@chex.dataclass(frozen=True)
class AverageRewardHordeLearningResult:
    """Result from scanning an average-reward Horde over arrays."""

    state: AverageRewardHordeState
    td_errors: Float[Array, "num_steps n_demons"]
    average_rewards: Float[Array, "num_steps n_demons"]
    per_demon_metrics: Float[Array, "num_steps n_demons 3"]


@dataclasses.dataclass(frozen=True)
class AverageRewardHordeActorCriticConfig:
    """Config for a Horde-critic average-reward actor-critic agent."""

    n_actions: int
    hidden_sizes: tuple[int, ...] = (16,)
    critic_step_size: float = 0.02
    average_reward_step_size: float = 0.01
    temperature: float = 1.0
    epsilon: float = 0.0
    actor_update_clip: float = 0.1
    logit_clip: float = 20.0

    def __post_init__(self) -> None:
        """Validate scalar hyperparameters."""
        if self.n_actions < 1:
            raise ValueError("n_actions must be positive")
        if self.critic_step_size < 0.0:
            raise ValueError("critic_step_size must be non-negative")
        if self.average_reward_step_size < 0.0:
            raise ValueError("average_reward_step_size must be non-negative")
        if self.temperature <= 0.0:
            raise ValueError("temperature must be positive")
        if not 0.0 <= self.epsilon <= 1.0:
            raise ValueError("epsilon must be in [0, 1]")
        if self.actor_update_clip <= 0.0:
            raise ValueError("actor_update_clip must be positive")
        if self.logit_clip <= 0.0:
            raise ValueError("logit_clip must be positive")

    def to_config(self) -> dict[str, Any]:
        """Serialize this config to a dictionary."""
        return {
            "type": "AverageRewardHordeActorCriticConfig",
            "n_actions": self.n_actions,
            "hidden_sizes": list(self.hidden_sizes),
            "critic_step_size": self.critic_step_size,
            "average_reward_step_size": self.average_reward_step_size,
            "temperature": self.temperature,
            "epsilon": self.epsilon,
            "actor_update_clip": self.actor_update_clip,
            "logit_clip": self.logit_clip,
        }

    @classmethod
    def from_config(
        cls,
        config: dict[str, Any],
    ) -> AverageRewardHordeActorCriticConfig:
        """Reconstruct a config from :meth:`to_config` output."""
        config = dict(config)
        config.pop("type", None)
        config["hidden_sizes"] = tuple(config["hidden_sizes"])
        return cls(**config)


@chex.dataclass(frozen=True)
class AverageRewardHordeActorCriticState:
    """State for the average-reward Horde actor-critic."""

    critic_state: AverageRewardHordeState
    actor_weights: Float[Array, "n_actions feature_dim"]
    actor_bias: Float[Array, " n_actions"]
    actor_opt_w: AutostepParamState
    actor_opt_b: AutostepParamState
    last_observation: Float[Array, " observation_dim"]
    last_action: Int[Array, ""]
    rng_key: Array
    step_count: Int[Array, ""]
    birth_timestamp: float = 0.0
    uptime_s: float = 0.0


@chex.dataclass(frozen=True)
class AverageRewardHordeActorCriticUpdateResult:
    """Result from one average-reward Horde actor-critic update."""

    state: AverageRewardHordeActorCriticState
    action: Int[Array, ""]
    policy: Float[Array, " n_actions"]
    td_error: Float[Array, ""]
    average_reward: Float[Array, ""]
    critic_prediction: Float[Array, ""]


@chex.dataclass(frozen=True)
class AverageRewardHordeActorCriticArrayResult:
    """Result from scanning average-reward Horde actor-critic updates."""

    state: AverageRewardHordeActorCriticState
    actions: Int[Array, " num_steps"]
    policies: Float[Array, "num_steps n_actions"]
    td_errors: Float[Array, " num_steps"]
    average_rewards: Float[Array, " num_steps"]


class AverageRewardHordeActorCriticAgent:
    """Average-reward actor-critic using a nonlinear Horde critic.

    The critic is a one-head :class:`AverageRewardHordeLearner`.  The actor is a
    softmax policy over the critic trunk's learned nonlinear feature vector.
    The actor deliberately keeps no eligibility trace in this first production
    slice; every transition still updates the actor, critic, and reward-rate
    baseline.
    """

    def __init__(
        self,
        config: AverageRewardHordeActorCriticConfig,
        actor_optimizer: Autostep | None = None,
    ):
        """Initialize the agent."""
        self._config = config
        self._actor_optimizer = (
            actor_optimizer if actor_optimizer is not None
            else Autostep(initial_step_size=0.05)
        )
        self._critic = AverageRewardHordeLearner(
            n_demons=1,
            hidden_sizes=config.hidden_sizes,
            step_size=config.critic_step_size,
            average_reward_step_size=config.average_reward_step_size,
            sparsity=0.0,
            use_layer_norm=False,
        )

    @property
    def config(self) -> AverageRewardHordeActorCriticConfig:
        """Agent configuration."""
        return self._config

    @property
    def actor_optimizer(self) -> Autostep:
        """Per-weight Autostep optimizer for the actor."""
        return self._actor_optimizer

    @property
    def critic(self) -> AverageRewardHordeLearner:
        """Underlying one-head average-reward Horde critic."""
        return self._critic

    @property
    def actor_feature_dim(self) -> int:
        """Actor feature dimension implied by the critic trunk."""
        if self._config.hidden_sizes:
            return self._config.hidden_sizes[-1]
        raise ValueError("actor_feature_dim requires initialized feature_dim")

    def to_config(self) -> dict[str, Any]:
        """Serialize this agent to a dictionary."""
        return {
            "type": "AverageRewardHordeActorCriticAgent",
            "config": self._config.to_config(),
            "actor_optimizer": self._actor_optimizer.to_config(),
        }

    @classmethod
    def from_config(
        cls,
        config: dict[str, Any],
    ) -> AverageRewardHordeActorCriticAgent:
        """Reconstruct an agent from :meth:`to_config` output."""
        config = dict(config)
        config.pop("type", None)
        cfg = AverageRewardHordeActorCriticConfig.from_config(config["config"])
        actor_opt: Autostep | None = None
        if config.get("actor_optimizer"):
            actor_opt = cast(Autostep, optimizer_from_config(config["actor_optimizer"]))
        return cls(cfg, actor_optimizer=actor_opt)

    def init(self, observation_dim: int, key: Array) -> AverageRewardHordeActorCriticState:
        """Initialize critic and actor state."""
        if observation_dim < 1:
            raise ValueError("observation_dim must be positive")
        key, critic_key = jr.split(key)
        critic_state = self._critic.init(observation_dim, critic_key)
        actor_dim = self._config.hidden_sizes[-1] if self._config.hidden_sizes else observation_dim
        actor_opt_w = self._actor_optimizer.init_for_shape(
            (self._config.n_actions, actor_dim)
        )
        actor_opt_b = self._actor_optimizer.init_for_shape((self._config.n_actions,))
        return AverageRewardHordeActorCriticState(
            critic_state=critic_state,
            actor_weights=jnp.zeros((self._config.n_actions, actor_dim), dtype=jnp.float32),
            actor_bias=jnp.zeros((self._config.n_actions,), dtype=jnp.float32),
            actor_opt_w=actor_opt_w,
            actor_opt_b=actor_opt_b,
            last_observation=jnp.zeros((observation_dim,), dtype=jnp.float32),
            last_action=jnp.array(-1, dtype=jnp.int32),
            rng_key=key,
            step_count=jnp.array(0, dtype=jnp.int32),
            birth_timestamp=time.time(),
            uptime_s=0.0,
        )

    def _actor_features(
        self,
        state: AverageRewardHordeActorCriticState,
        observation: Array,
    ) -> Array:
        learner_state = state.critic_state.learner_state
        return MultiHeadMLPLearner._trunk_forward(
            learner_state.trunk_params.weights,
            learner_state.trunk_params.biases,
            observation,
            self._critic._leaky_relu_slope,  # noqa: SLF001
            self._critic._use_layer_norm,  # noqa: SLF001
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def policy(
        self,
        state: AverageRewardHordeActorCriticState,
        observation: Array,
    ) -> Float[Array, " n_actions"]:
        """Compute softmax action probabilities."""
        features = self._actor_features(state, observation)
        logits = state.actor_weights @ features + state.actor_bias
        logits = jnp.clip(logits, -self._config.logit_clip, self._config.logit_clip)
        return jax.nn.softmax(logits / self._config.temperature)

    @functools.partial(jax.jit, static_argnums=(0,))
    def select_action(
        self,
        state: AverageRewardHordeActorCriticState,
        observation: Array,
    ) -> tuple[Int[Array, ""], Array]:
        """Sample an epsilon-soft policy action."""
        key, sample_key, explore_key, random_key = jr.split(state.rng_key, 4)
        policy = self.policy(state, observation)
        sampled = jr.categorical(sample_key, jnp.log(policy + 1e-8)).astype(jnp.int32)
        random_action = jr.randint(random_key, (), 0, self._config.n_actions).astype(
            jnp.int32
        )
        explore = jr.uniform(explore_key) < self._config.epsilon
        return jax.lax.select(explore, random_action, sampled), key

    @functools.partial(jax.jit, static_argnums=(0,))
    def start(
        self,
        state: AverageRewardHordeActorCriticState,
        observation: Array,
    ) -> tuple[AverageRewardHordeActorCriticState, Int[Array, ""]]:
        """Select and store the first action."""
        action, key = self.select_action(state, observation)
        return state.replace(
            last_observation=observation,
            last_action=action,
            rng_key=key,
        ), action

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: AverageRewardHordeActorCriticState,
        reward: Array,
        next_observation: Array,
    ) -> AverageRewardHordeActorCriticUpdateResult:
        """Apply one average-reward actor-critic update."""
        old_features = self._actor_features(state, state.last_observation)
        old_policy = self.policy(state, state.last_observation)
        next_action, key = self.select_action(state, next_observation)
        critic_result = self._critic.update(
            state.critic_state,
            state.last_observation,
            jnp.atleast_1d(jnp.asarray(reward, dtype=jnp.float32)),
            next_observation,
        )
        td_error = critic_result.td_errors[0]
        actor_td_error = jnp.clip(
            td_error,
            -self._config.logit_clip,
            self._config.logit_clip,
        )
        action_mask = jax.nn.one_hot(
            state.last_action,
            self._config.n_actions,
            dtype=jnp.float32,
        )
        grad_log_policy = (action_mask - old_policy)[:, None] * old_features[None, :]
        bias_grad = action_mask - old_policy
        raw_w, new_opt_w = self._actor_optimizer.update_from_gradient(
            state.actor_opt_w, grad_log_policy, error=actor_td_error
        )
        raw_b, new_opt_b = self._actor_optimizer.update_from_gradient(
            state.actor_opt_b, bias_grad, error=actor_td_error
        )
        weight_step = jnp.clip(
            actor_td_error * raw_w,
            -self._config.actor_update_clip,
            self._config.actor_update_clip,
        )
        bias_step = jnp.clip(
            actor_td_error * raw_b,
            -self._config.actor_update_clip,
            self._config.actor_update_clip,
        )
        actor_weights = jnp.nan_to_num(state.actor_weights + weight_step)
        actor_bias = jnp.nan_to_num(state.actor_bias + bias_step)
        new_state = state.replace(
            critic_state=critic_result.state,
            actor_weights=actor_weights,
            actor_bias=actor_bias,
            actor_opt_w=new_opt_w,
            actor_opt_b=new_opt_b,
            last_observation=next_observation,
            last_action=next_action,
            rng_key=key,
            step_count=state.step_count + 1,
        )
        return AverageRewardHordeActorCriticUpdateResult(
            state=new_state,
            action=next_action,
            policy=self.policy(new_state, next_observation),
            td_error=td_error,
            average_reward=critic_result.average_rewards[0],
            critic_prediction=critic_result.predictions[0],
        )


class AverageRewardHordeLearner:
    """Shared-trunk nonlinear Horde for differential GVF prediction.

    Each head learns a continuing differential value target
    `r_i - rbar_i + v_i(s')`, while `rbar_i` tracks the per-demon average
    cumulant.  The trunk is updated every step through ``MultiHeadMLPLearner``;
    per-head traces can be enabled without trunk temporal traces, matching the
    Step 3 Horde trace constraint.
    """

    def __init__(
        self,
        n_demons: int,
        *,
        hidden_sizes: tuple[int, ...] = (32,),
        step_size: float = 0.01,
        average_reward_step_size: float = 0.01,
        trace_decay: float = 0.0,
        sparsity: float = 0.0,
        use_layer_norm: bool = False,
        leaky_relu_slope: float = 0.01,
    ):
        """Initialize the average-reward Horde."""
        if n_demons < 1:
            raise ValueError("n_demons must be positive")
        if average_reward_step_size < 0.0:
            raise ValueError("average_reward_step_size must be non-negative")
        if not 0.0 <= trace_decay <= 1.0:
            raise ValueError("trace_decay must be in [0, 1]")
        self._n_demons = n_demons
        self._hidden_sizes = hidden_sizes
        self._step_size = step_size
        self._average_reward_step_size = average_reward_step_size
        self._trace_decay = trace_decay
        self._sparsity = sparsity
        self._use_layer_norm = use_layer_norm
        self._leaky_relu_slope = leaky_relu_slope
        self._learner = MultiHeadMLPLearner(
            n_heads=n_demons,
            hidden_sizes=hidden_sizes,
            step_size=step_size,
            gamma=0.0,
            lamda=0.0,
            per_head_gamma_lamda=tuple(trace_decay for _ in range(n_demons)),
            sparsity=sparsity,
            use_layer_norm=use_layer_norm,
            leaky_relu_slope=leaky_relu_slope,
        )

    @property
    def n_demons(self) -> int:
        """Number of average-reward GVF heads."""
        return self._n_demons

    @property
    def learner(self) -> MultiHeadMLPLearner:
        """Underlying shared-trunk learner."""
        return self._learner

    def to_config(self) -> dict[str, Any]:
        """Serialize this learner to a dictionary."""
        return {
            "type": "AverageRewardHordeLearner",
            "n_demons": self._n_demons,
            "hidden_sizes": list(self._hidden_sizes),
            "step_size": self._step_size,
            "average_reward_step_size": self._average_reward_step_size,
            "trace_decay": self._trace_decay,
            "sparsity": self._sparsity,
            "use_layer_norm": self._use_layer_norm,
            "leaky_relu_slope": self._leaky_relu_slope,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> AverageRewardHordeLearner:
        """Reconstruct a learner from :meth:`to_config` output."""
        config = dict(config)
        config.pop("type", None)
        config["hidden_sizes"] = tuple(config["hidden_sizes"])
        return cls(**config)

    def init(self, feature_dim: int, key: Array) -> AverageRewardHordeState:
        """Initialize shared-trunk and per-demon reward-rate state."""
        if feature_dim < 1:
            raise ValueError("feature_dim must be positive")
        return AverageRewardHordeState(
            learner_state=self._learner.init(feature_dim, key),
            average_rewards=jnp.zeros(self._n_demons, dtype=jnp.float32),
            step_count=jnp.array(0, dtype=jnp.int32),
            birth_timestamp=time.time(),
            uptime_s=0.0,
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict(self, state: AverageRewardHordeState, observation: Array) -> Array:
        """Predict all average-reward GVF heads."""
        return cast(Array, self._learner.predict(state.learner_state, observation))

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: AverageRewardHordeState,
        observation: Array,
        cumulants: Array,
        next_observation: Array,
    ) -> AverageRewardHordeUpdateResult:
        """Apply one shared-trunk differential Horde update."""
        next_predictions = self._learner.predict(state.learner_state, next_observation)
        active = ~jnp.isnan(cumulants)
        targets = cumulants - state.average_rewards + next_predictions
        targets = jnp.where(active, targets, jnp.nan)
        result = self._learner.update(state.learner_state, observation, targets)
        td_errors = result.errors
        safe_td_errors = jnp.where(active, td_errors, 0.0)
        new_average_rewards = (
            state.average_rewards
            + self._average_reward_step_size * safe_td_errors
        )
        new_state = state.replace(
            learner_state=result.state,
            average_rewards=new_average_rewards,
            step_count=state.step_count + 1,
        )
        return AverageRewardHordeUpdateResult(
            state=new_state,
            predictions=result.predictions,
            next_predictions=next_predictions,
            td_errors=td_errors,
            td_targets=targets,
            average_rewards=new_average_rewards,
            per_demon_metrics=result.per_head_metrics,
        )


class DifferentialGTDLearner:
    """Linear off-policy differential GTD/TDC prediction.

    This is the average-reward counterpart to the framework's off-policy TD
    primitives.  It maintains a primary value function, a secondary correction
    vector, accumulating importance-weighted traces, and a learned reward-rate
    baseline.  Setting ``rho = 1`` gives an on-policy differential TDC update.
    """

    def __init__(self, config: DifferentialGTDConfig | None = None):
        """Initialize the learner."""
        self._config = config or DifferentialGTDConfig()

    @property
    def config(self) -> DifferentialGTDConfig:
        """Learner configuration."""
        return self._config

    def to_config(self) -> dict[str, Any]:
        """Serialize this learner to a dictionary."""
        return {
            "type": "DifferentialGTDLearner",
            "config": self._config.to_config(),
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> DifferentialGTDLearner:
        """Reconstruct a learner from :meth:`to_config` output."""
        config = dict(config)
        config.pop("type", None)
        return cls(DifferentialGTDConfig.from_config(config["config"]))

    def init(
        self,
        feature_dim: int,
        *,
        average_reward: float = 0.0,
    ) -> DifferentialGTDState:
        """Initialize primary weights, secondary weights, and traces."""
        if feature_dim < 1:
            raise ValueError("feature_dim must be positive")
        return DifferentialGTDState(
            weights=jnp.zeros(feature_dim, dtype=jnp.float32),
            bias=jnp.array(0.0, dtype=jnp.float32),
            secondary_weights=jnp.zeros(feature_dim, dtype=jnp.float32),
            secondary_bias=jnp.array(0.0, dtype=jnp.float32),
            eligibility_traces=jnp.zeros(feature_dim, dtype=jnp.float32),
            bias_eligibility_trace=jnp.array(0.0, dtype=jnp.float32),
            average_reward=jnp.array(average_reward, dtype=jnp.float32),
            step_count=jnp.array(0, dtype=jnp.int32),
            birth_timestamp=time.time(),
            uptime_s=0.0,
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict(
        self,
        state: DifferentialGTDState,
        observation: Array,
    ) -> Float[Array, ""]:
        """Compute the scalar differential value estimate."""
        return jnp.dot(state.weights, observation) + state.bias

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: DifferentialGTDState,
        observation: Array,
        reward: Array,
        next_observation: Array,
        rho: Array,
    ) -> DifferentialGTDUpdateResult:
        """Apply one off-policy average-reward GTD/TDC update."""
        cfg = self._config
        alpha = jnp.asarray(cfg.value_step_size, dtype=jnp.float32)
        beta = jnp.asarray(cfg.secondary_step_size, dtype=jnp.float32)
        eta = jnp.asarray(cfg.average_reward_step_size, dtype=jnp.float32)
        lamda = jnp.asarray(cfg.trace_decay, dtype=jnp.float32)
        ratio_clip = jnp.asarray(cfg.ratio_clip, dtype=jnp.float32)

        reward_s = jnp.squeeze(jnp.asarray(reward, dtype=jnp.float32))
        rho_s = jnp.maximum(
            0.0,
            jnp.minimum(jnp.squeeze(jnp.asarray(rho, dtype=jnp.float32)), ratio_clip),
        )
        prediction = self.predict(state, observation)
        next_prediction = self.predict(state, next_observation)
        td_error = reward_s - state.average_reward + next_prediction - prediction

        traces = rho_s * (lamda * state.eligibility_traces + observation)
        bias_trace = rho_s * (lamda * state.bias_eligibility_trace + 1.0)
        secondary_dot_trace = (
            jnp.dot(state.secondary_weights, traces)
            + state.secondary_bias * bias_trace
        )
        secondary_dot_obs = (
            jnp.dot(state.secondary_weights, observation) + state.secondary_bias
        )

        primary_weight_step = alpha * (
            td_error * traces - (1.0 - lamda) * secondary_dot_trace * next_observation
        )
        primary_bias_step = alpha * (
            td_error * bias_trace - (1.0 - lamda) * secondary_dot_trace
        )
        secondary_weight_step = beta * (td_error * traces - secondary_dot_obs * observation)
        secondary_bias_step = beta * (td_error * bias_trace - secondary_dot_obs)
        new_average_reward = state.average_reward + eta * rho_s * td_error

        new_state = state.replace(
            weights=state.weights + primary_weight_step,
            bias=state.bias + primary_bias_step,
            secondary_weights=state.secondary_weights + secondary_weight_step,
            secondary_bias=state.secondary_bias + secondary_bias_step,
            eligibility_traces=traces,
            bias_eligibility_trace=bias_trace,
            average_reward=new_average_reward,
            step_count=state.step_count + 1,
        )
        metrics = jnp.array(
            [
                td_error**2,
                td_error,
                rho_s,
                new_average_reward,
                jnp.mean(jnp.abs(traces)),
                jnp.sqrt(jnp.mean(new_state.secondary_weights**2)),
            ],
            dtype=jnp.float32,
        )
        return DifferentialGTDUpdateResult(
            state=new_state,
            prediction=prediction,
            next_prediction=next_prediction,
            td_error=td_error,
            rho_clipped=rho_s,
            average_reward=new_average_reward,
            metrics=metrics,
        )


class DifferentialTDLearner:
    """Linear differential TD(lambda) for continuing prediction.

    For a transition `(S_t, R_{t+1}, S_{t+1})`, the learner forms
    `delta_t = R_{t+1} - rbar_t + v(S_{t+1}) - v(S_t)`, updates the
    reward-rate estimate `rbar_{t+1} = rbar_t + beta * delta_t`, and applies
    the semi-gradient value update along accumulating traces.
    """

    def __init__(self, config: DifferentialTDConfig | None = None):
        """Initialize the learner."""
        self._config = config or DifferentialTDConfig()

    @property
    def config(self) -> DifferentialTDConfig:
        """Learner configuration."""
        return self._config

    def to_config(self) -> dict[str, Any]:
        """Serialize this learner to a dictionary."""
        return {
            "type": "DifferentialTDLearner",
            "config": self._config.to_config(),
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> DifferentialTDLearner:
        """Reconstruct a learner from :meth:`to_config` output."""
        config = dict(config)
        config.pop("type", None)
        return cls(DifferentialTDConfig.from_config(config["config"]))

    def init(
        self,
        feature_dim: int,
        *,
        average_reward: float = 0.0,
    ) -> DifferentialTDState:
        """Initialize value weights, traces, and reward-rate estimate."""
        if feature_dim < 1:
            raise ValueError("feature_dim must be positive")
        return DifferentialTDState(
            weights=jnp.zeros(feature_dim, dtype=jnp.float32),
            bias=jnp.array(0.0, dtype=jnp.float32),
            eligibility_traces=jnp.zeros(feature_dim, dtype=jnp.float32),
            bias_eligibility_trace=jnp.array(0.0, dtype=jnp.float32),
            average_reward=jnp.array(average_reward, dtype=jnp.float32),
            step_count=jnp.array(0, dtype=jnp.int32),
            birth_timestamp=time.time(),
            uptime_s=0.0,
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict(
        self,
        state: DifferentialTDState,
        observation: Array,
    ) -> Float[Array, ""]:
        """Compute the scalar differential value estimate."""
        return jnp.dot(state.weights, observation) + state.bias

    @functools.partial(jax.jit, static_argnums=(0,))
    def td_error(
        self,
        state: DifferentialTDState,
        observation: Array,
        reward: Array,
        next_observation: Array,
    ) -> Float[Array, ""]:
        """Compute `R - rbar + v(S') - v(S)` without changing state."""
        reward_s = jnp.squeeze(jnp.asarray(reward, dtype=jnp.float32))
        value = self.predict(state, observation)
        next_value = self.predict(state, next_observation)
        return cast(Array, reward_s - state.average_reward + next_value - value)

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: DifferentialTDState,
        observation: Array,
        reward: Array,
        next_observation: Array,
    ) -> DifferentialTDUpdateResult:
        """Apply one continuing differential TD update."""
        cfg = self._config
        alpha = jnp.asarray(cfg.step_size, dtype=jnp.float32)
        beta = jnp.asarray(cfg.average_reward_step_size, dtype=jnp.float32)
        lamda = jnp.asarray(cfg.trace_decay, dtype=jnp.float32)

        reward_s = jnp.squeeze(jnp.asarray(reward, dtype=jnp.float32))
        prediction = self.predict(state, observation)
        next_prediction = self.predict(state, next_observation)
        td_error = reward_s - state.average_reward + next_prediction - prediction

        traces = lamda * state.eligibility_traces + observation
        bias_trace = lamda * state.bias_eligibility_trace + 1.0
        new_state = state.replace(
            weights=state.weights + alpha * td_error * traces,
            bias=state.bias + alpha * td_error * bias_trace,
            eligibility_traces=traces,
            bias_eligibility_trace=bias_trace,
            average_reward=state.average_reward + beta * td_error,
            step_count=state.step_count + 1,
        )
        metrics = jnp.array(
            [
                td_error**2,
                td_error,
                new_state.average_reward,
                jnp.mean(jnp.abs(traces)),
            ],
            dtype=jnp.float32,
        )
        return DifferentialTDUpdateResult(
            state=new_state,
            prediction=prediction,
            next_prediction=next_prediction,
            td_error=td_error,
            average_reward=new_state.average_reward,
            metrics=metrics,
        )


def run_differential_td_from_arrays(
    learner: DifferentialTDLearner,
    state: DifferentialTDState,
    observations: Float[Array, "num_steps feature_dim"],
    rewards: Float[Array, " num_steps"],
    next_observations: Float[Array, "num_steps feature_dim"],
) -> DifferentialTDArrayResult:
    """Run differential TD updates over transition arrays with ``lax.scan``."""
    start = time.time()

    def _scan_fn(
        carry: DifferentialTDState,
        inputs: tuple[Array, Array, Array],
    ) -> tuple[DifferentialTDState, tuple[Array, Array, Array, Array]]:
        obs, reward, next_obs = inputs
        result = learner.update(carry, obs, reward, next_obs)
        return result.state, (
            result.prediction,
            result.td_error,
            result.average_reward,
            result.metrics,
        )

    final_state, (predictions, td_errors, average_rewards, metrics) = jax.lax.scan(
        _scan_fn,
        state,
        (observations, rewards, next_observations),
    )
    elapsed = time.time() - start
    final_state = final_state.replace(uptime_s=final_state.uptime_s + elapsed)
    return DifferentialTDArrayResult(
        state=final_state,
        predictions=predictions,
        td_errors=td_errors,
        average_rewards=average_rewards,
        metrics=metrics,
    )


def run_differential_gtd_from_arrays(
    learner: DifferentialGTDLearner,
    state: DifferentialGTDState,
    observations: Float[Array, "num_steps feature_dim"],
    rewards: Float[Array, " num_steps"],
    next_observations: Float[Array, "num_steps feature_dim"],
    rhos: Float[Array, " num_steps"],
) -> DifferentialGTDArrayResult:
    """Run differential GTD/TDC updates over transition arrays with ``lax.scan``."""
    start = time.time()

    def _scan_fn(
        carry: DifferentialGTDState,
        inputs: tuple[Array, Array, Array, Array],
    ) -> tuple[DifferentialGTDState, tuple[Array, Array, Array, Array, Array]]:
        obs, reward, next_obs, rho = inputs
        result = learner.update(carry, obs, reward, next_obs, rho)
        return result.state, (
            result.prediction,
            result.td_error,
            result.average_reward,
            result.rho_clipped,
            result.metrics,
        )

    final_state, (predictions, td_errors, average_rewards, rho_clipped, metrics) = (
        jax.lax.scan(
            _scan_fn,
            state,
            (observations, rewards, next_observations, rhos),
        )
    )
    elapsed = time.time() - start
    final_state = final_state.replace(uptime_s=final_state.uptime_s + elapsed)
    return DifferentialGTDArrayResult(
        state=final_state,
        predictions=predictions,
        td_errors=td_errors,
        average_rewards=average_rewards,
        rho_clipped=rho_clipped,
        metrics=metrics,
    )


def run_average_reward_horde_from_arrays(
    learner: AverageRewardHordeLearner,
    state: AverageRewardHordeState,
    observations: Float[Array, "num_steps feature_dim"],
    cumulants: Float[Array, "num_steps n_demons"],
    next_observations: Float[Array, "num_steps feature_dim"],
) -> AverageRewardHordeLearningResult:
    """Run a shared-trunk average-reward Horde over transition arrays."""
    start = time.time()

    def _scan_fn(
        carry: AverageRewardHordeState,
        inputs: tuple[Array, Array, Array],
    ) -> tuple[AverageRewardHordeState, tuple[Array, Array, Array]]:
        obs, cumulant, next_obs = inputs
        result = learner.update(carry, obs, cumulant, next_obs)
        return result.state, (
            result.td_errors,
            result.average_rewards,
            result.per_demon_metrics,
        )

    final_state, (td_errors, average_rewards, per_demon_metrics) = jax.lax.scan(
        _scan_fn,
        state,
        (observations, cumulants, next_observations),
    )
    elapsed = time.time() - start
    final_state = final_state.replace(uptime_s=final_state.uptime_s + elapsed)
    return AverageRewardHordeLearningResult(
        state=final_state,
        td_errors=td_errors,
        average_rewards=average_rewards,
        per_demon_metrics=per_demon_metrics,
    )


def run_average_reward_horde_actor_critic_from_arrays(
    agent: AverageRewardHordeActorCriticAgent,
    state: AverageRewardHordeActorCriticState,
    rewards: Float[Array, " num_steps"],
    next_observations: Float[Array, "num_steps observation_dim"],
) -> AverageRewardHordeActorCriticArrayResult:
    """Run average-reward Horde actor-critic over transition arrays."""
    start = time.time()

    def _scan_fn(
        carry: AverageRewardHordeActorCriticState,
        inputs: tuple[Array, Array],
    ) -> tuple[AverageRewardHordeActorCriticState, tuple[Array, Array, Array, Array]]:
        reward, next_observation = inputs
        result = agent.update(carry, reward, next_observation)
        return result.state, (
            result.action,
            result.policy,
            result.td_error,
            result.average_reward,
        )

    final_state, (actions, policies, td_errors, average_rewards) = jax.lax.scan(
        _scan_fn,
        state,
        (rewards, next_observations),
    )
    elapsed = time.time() - start
    final_state = final_state.replace(uptime_s=final_state.uptime_s + elapsed)
    return AverageRewardHordeActorCriticArrayResult(
        state=final_state,
        actions=actions,
        policies=policies,
        td_errors=td_errors,
        average_rewards=average_rewards,
    )


@dataclasses.dataclass(frozen=True)
class DifferentialSARSAConfig:
    """Configuration for linear differential SARSA control."""

    n_actions: int
    q_step_size: float = 0.05
    average_reward_step_size: float = 0.01
    trace_decay: float = 0.0
    epsilon_start: float = 0.1
    epsilon_end: float = 0.01
    epsilon_decay_steps: int = 0

    def __post_init__(self) -> None:
        """Validate scalar hyperparameters."""
        if self.n_actions < 1:
            raise ValueError("n_actions must be positive")
        if self.q_step_size < 0.0:
            raise ValueError("q_step_size must be non-negative")
        if self.average_reward_step_size < 0.0:
            raise ValueError("average_reward_step_size must be non-negative")
        if not 0.0 <= self.trace_decay <= 1.0:
            raise ValueError("trace_decay must be in [0, 1]")
        if not 0.0 <= self.epsilon_start <= 1.0:
            raise ValueError("epsilon_start must be in [0, 1]")
        if not 0.0 <= self.epsilon_end <= 1.0:
            raise ValueError("epsilon_end must be in [0, 1]")
        if self.epsilon_decay_steps < 0:
            raise ValueError("epsilon_decay_steps must be non-negative")

    def to_config(self) -> dict[str, Any]:
        """Serialize this config to a dictionary."""
        return {
            "type": "DifferentialSARSAConfig",
            "n_actions": self.n_actions,
            "q_step_size": self.q_step_size,
            "average_reward_step_size": self.average_reward_step_size,
            "trace_decay": self.trace_decay,
            "epsilon_start": self.epsilon_start,
            "epsilon_end": self.epsilon_end,
            "epsilon_decay_steps": self.epsilon_decay_steps,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> DifferentialSARSAConfig:
        """Reconstruct a config from :meth:`to_config` output."""
        config = dict(config)
        config.pop("type", None)
        return cls(**config)


@chex.dataclass(frozen=True)
class DifferentialSARSAState:
    """State for linear differential SARSA."""

    q_weights: Float[Array, "n_actions feature_dim"]
    q_bias: Float[Array, " n_actions"]
    q_trace_weights: Float[Array, "n_actions feature_dim"]
    q_trace_bias: Float[Array, " n_actions"]
    average_reward: Float[Array, ""]
    last_observation: Float[Array, " feature_dim"]
    last_action: Int[Array, ""]
    epsilon: Float[Array, ""]
    rng_key: Array
    step_count: Int[Array, ""]
    birth_timestamp: float = 0.0
    uptime_s: float = 0.0


@chex.dataclass(frozen=True)
class DifferentialSARSAUpdateResult:
    """Result from one differential SARSA transition update."""

    state: DifferentialSARSAState
    action: Int[Array, ""]
    q_values: Float[Array, " n_actions"]
    td_error: Float[Array, ""]
    average_reward: Float[Array, ""]
    reward: Float[Array, ""]


@chex.dataclass(frozen=True)
class DifferentialSARSAArrayResult:
    """Result from scanning differential SARSA over continuing transitions."""

    state: DifferentialSARSAState
    q_values: Float[Array, "num_steps n_actions"]
    td_errors: Float[Array, " num_steps"]
    average_rewards: Float[Array, " num_steps"]
    actions: Int[Array, " num_steps"]


class DifferentialSARSAAgent:
    """Linear epsilon-greedy differential SARSA control agent.

    The update is the continuing-control counterpart of SARSA:
    `delta_t = R_{t+1} - rbar_t + Q(S_{t+1}, A_{t+1}) - Q(S_t, A_t)`.
    The same scalar TD error updates the reward-rate estimate and all Q
    parameters through an action-indexed accumulating trace.
    """

    def __init__(self, config: DifferentialSARSAConfig):
        """Initialize the control agent."""
        self._config = config

    @property
    def config(self) -> DifferentialSARSAConfig:
        """Agent configuration."""
        return self._config

    def to_config(self) -> dict[str, Any]:
        """Serialize this agent to a dictionary."""
        return {
            "type": "DifferentialSARSAAgent",
            "config": self._config.to_config(),
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> DifferentialSARSAAgent:
        """Reconstruct an agent from :meth:`to_config` output."""
        config = dict(config)
        config.pop("type", None)
        return cls(DifferentialSARSAConfig.from_config(config["config"]))

    def init(
        self,
        feature_dim: int,
        key: Array,
        *,
        average_reward: float = 0.0,
    ) -> DifferentialSARSAState:
        """Initialize Q weights, traces, reward-rate estimate, and RNG."""
        if feature_dim < 1:
            raise ValueError("feature_dim must be positive")
        cfg = self._config
        zeros_q = jnp.zeros((cfg.n_actions, feature_dim), dtype=jnp.float32)
        zeros_bias = jnp.zeros((cfg.n_actions,), dtype=jnp.float32)
        return DifferentialSARSAState(
            q_weights=zeros_q,
            q_bias=zeros_bias,
            q_trace_weights=zeros_q,
            q_trace_bias=zeros_bias,
            average_reward=jnp.array(average_reward, dtype=jnp.float32),
            last_observation=jnp.zeros(feature_dim, dtype=jnp.float32),
            last_action=jnp.array(-1, dtype=jnp.int32),
            epsilon=jnp.array(cfg.epsilon_start, dtype=jnp.float32),
            rng_key=key,
            step_count=jnp.array(0, dtype=jnp.int32),
            birth_timestamp=time.time(),
            uptime_s=0.0,
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def q_values(
        self,
        state: DifferentialSARSAState,
        observation: Array,
    ) -> Float[Array, " n_actions"]:
        """Compute all action values for one observation."""
        return state.q_weights @ observation + state.q_bias

    @functools.partial(jax.jit, static_argnums=(0,))
    def select_action(
        self,
        state: DifferentialSARSAState,
        observation: Array,
    ) -> tuple[Int[Array, ""], Array]:
        """Select an epsilon-greedy action with uniform tie-breaking."""
        key, explore_key, noise_key, random_key = jr.split(state.rng_key, 4)
        q_values = self.q_values(state, observation)
        greedy_noise = jr.gumbel(noise_key, shape=q_values.shape) * 1e-6
        greedy_action = jnp.argmax(q_values + greedy_noise).astype(jnp.int32)
        random_action = jr.randint(random_key, (), 0, self._config.n_actions).astype(
            jnp.int32
        )
        explore = jr.uniform(explore_key) < state.epsilon
        return jax.lax.select(explore, random_action, greedy_action), key

    @functools.partial(jax.jit, static_argnums=(0,))
    def start(
        self,
        state: DifferentialSARSAState,
        observation: Array,
    ) -> tuple[DifferentialSARSAState, Int[Array, ""]]:
        """Select and store the first action for a continuing stream."""
        action, key = self.select_action(state, observation)
        return state.replace(
            last_observation=observation,
            last_action=action,
            rng_key=key,
        ), action

    @functools.partial(jax.jit, static_argnums=(0,))
    def td_error(
        self,
        state: DifferentialSARSAState,
        reward: Array,
        next_observation: Array,
        next_action: Array,
    ) -> Float[Array, ""]:
        """Compute differential SARSA TD error without changing state."""
        reward_s = jnp.squeeze(jnp.asarray(reward, dtype=jnp.float32))
        q_prev = self.q_values(state, state.last_observation)[state.last_action]
        q_next = self.q_values(state, next_observation)[next_action]
        return cast(Array, reward_s - state.average_reward + q_next - q_prev)

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: DifferentialSARSAState,
        reward: Array,
        next_observation: Array,
        next_action: Array | None = None,
    ) -> DifferentialSARSAUpdateResult:
        """Apply one differential SARSA update.

        Args:
            state: Current state with a valid previous observation/action.
            reward: Reward received after taking ``state.last_action``.
            next_observation: New observation.
            next_action: Optional preselected next action. When omitted, the
                current policy samples one and stores it for the following step.
        """
        cfg = self._config
        if next_action is None:
            selected_next_action, key = self.select_action(state, next_observation)
        else:
            selected_next_action = jnp.asarray(next_action, dtype=jnp.int32)
            key = state.rng_key

        alpha = jnp.asarray(cfg.q_step_size, dtype=jnp.float32)
        beta = jnp.asarray(cfg.average_reward_step_size, dtype=jnp.float32)
        lamda = jnp.asarray(cfg.trace_decay, dtype=jnp.float32)
        reward_s = jnp.squeeze(jnp.asarray(reward, dtype=jnp.float32))

        q_prev_all = self.q_values(state, state.last_observation)
        q_next_all = self.q_values(state, next_observation)
        q_prev = q_prev_all[state.last_action]
        q_next = q_next_all[selected_next_action]
        td_error = reward_s - state.average_reward + q_next - q_prev

        action_mask = jax.nn.one_hot(
            state.last_action,
            cfg.n_actions,
            dtype=jnp.float32,
        )
        grad_weights = action_mask[:, None] * state.last_observation[None, :]
        grad_bias = action_mask
        traces = lamda * state.q_trace_weights + grad_weights
        bias_traces = lamda * state.q_trace_bias + grad_bias
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
        new_average_reward = state.average_reward + beta * td_error
        new_state = state.replace(
            q_weights=state.q_weights + alpha * td_error * traces,
            q_bias=state.q_bias + alpha * td_error * bias_traces,
            q_trace_weights=traces,
            q_trace_bias=bias_traces,
            average_reward=new_average_reward,
            last_observation=next_observation,
            last_action=selected_next_action,
            epsilon=new_epsilon,
            rng_key=key,
            step_count=new_step_count,
        )
        return DifferentialSARSAUpdateResult(
            state=new_state,
            action=selected_next_action,
            q_values=q_next_all,
            td_error=td_error,
            average_reward=new_average_reward,
            reward=reward_s,
        )


def run_differential_sarsa_from_arrays(
    agent: DifferentialSARSAAgent,
    state: DifferentialSARSAState,
    rewards: Float[Array, " num_steps"],
    next_observations: Float[Array, "num_steps feature_dim"],
) -> DifferentialSARSAArrayResult:
    """Run differential SARSA over continuing transition arrays.

    The input state must already be primed with ``agent.start`` so it contains
    the first observation and action. Rewards are therefore aligned with
    transitions from the stored `(S_t, A_t)` to each ``next_observations[t]``.
    """
    start = time.time()

    def _scan_fn(
        carry: DifferentialSARSAState,
        inputs: tuple[Array, Array],
    ) -> tuple[DifferentialSARSAState, tuple[Array, Array, Array, Array]]:
        reward, next_observation = inputs
        result = agent.update(carry, reward, next_observation)
        return result.state, (
            result.q_values,
            result.td_error,
            result.average_reward,
            result.action,
        )

    final_state, (q_values, td_errors, average_rewards, actions) = jax.lax.scan(
        _scan_fn,
        state,
        (rewards, next_observations),
    )
    elapsed = time.time() - start
    final_state = final_state.replace(uptime_s=final_state.uptime_s + elapsed)
    return DifferentialSARSAArrayResult(
        state=final_state,
        q_values=q_values,
        td_errors=td_errors,
        average_rewards=average_rewards,
        actions=actions,
    )
