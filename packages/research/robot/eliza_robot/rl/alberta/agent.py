"""Alberta-Plan streaming continual-control agent for robot policies.

``AlbertaContinualController`` wraps Alberta's continuous-action actor-critic
(``ContinuousActorCriticAgent``) with the streaming machinery that the Alberta
Plan prescribes for *non-stationary* learning:

- **EMA observation normalization** (``EMANormalizer``) — keeps a useful input
  scale as the task distribution shifts.
- **ObGD update bounding** (``ObGDBounding``) — caps per-step update magnitude
  so a single surprising transition cannot blow away learned weights. This is
  the key continual-learning property: gentle, bounded, *every-step* updates
  rather than the bulk epoch-wise overwrites a replay-buffer PPO performs.
- **A frozen nonlinear feature lift** (``FeatureMap``) — gives the linear
  actor-critic capacity to represent task-conditioned behaviour.

Unlike PPO, this agent updates **at every single time step** with no replay
buffer, no epochs, and no per-task reset. That temporal uniformity is what lets
it accumulate skills across a task stream instead of overwriting them. The
agent exposes a small numpy-friendly surface so it can drive any
``gymnasium.Env`` (the real MuJoCo ``TextConditionedProfileEnv`` or the fast
benchmark envs) through :mod:`eliza_robot.rl.alberta.loop`.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import jax
import jax.numpy as jnp
import numpy as np
from alberta_framework.core.actor_critic import (
    ContinuousActorCriticAgent,
    ContinuousActorCriticConfig,
    ContinuousActorCriticState,
)
from alberta_framework.core.normalizers import EMANormalizer, EMANormalizerState
from alberta_framework.core.optimizers import ObGDBounding

from eliza_robot.rl.alberta.features import FeatureConfig, FeatureMap


@dataclass(frozen=True)
class AlbertaControllerConfig:
    """Hyperparameters for :class:`AlbertaContinualController`.

    Attributes:
        obs_dim: Raw observation dimensionality (before the feature lift).
        action_dim: Continuous action dimensionality.
        action_low / action_high: Action clipping bounds (the env clips too, but
            bounding the policy keeps the Gaussian sane).
        gamma: Discount factor.
        actor_step_size / critic_step_size: AC(lambda) step-sizes.
        actor_lamda / critic_lamda: Eligibility-trace decays.
        log_sigma_init: Initial policy log-std (exploration scale).
        obgd_kappa: ObGD bounding sensitivity; ``None`` disables bounding.
        normalize: Enable EMA observation normalization.
        normalizer_decay: EMA decay for the normalizer (closer to 1.0 = slower).
        features: Frozen feature-lift configuration.
        seed: PRNG seed for agent init.
    """

    obs_dim: int
    action_dim: int
    action_low: float = -1.0
    action_high: float = 1.0
    gamma: float = 0.99
    actor_step_size: float = 3e-3
    critic_step_size: float = 1e-2
    actor_lamda: float = 0.8
    critic_lamda: float = 0.8
    log_sigma_init: float = -0.7
    log_sigma_min: float = -5.0
    log_sigma_max: float = 0.5
    obgd_kappa: float | None = 2.0
    normalize: bool = False
    normalizer_decay: float = 0.999
    features: FeatureConfig = field(default_factory=FeatureConfig)
    seed: int = 0
    # With a sparse_gated feature lift the per-task feature blocks are disjoint,
    # but the agent's global mean/critic biases are shared across tasks and would
    # leak one task's drift into another's greedy action. The block's own "1"
    # feature already supplies a per-task bias, so we pin the global biases to
    # zero — making the task blocks truly independent (leak-free retention).
    decouple_global_bias: bool = True


class AlbertaContinualController:
    """Online streaming continuous-action continual-RL controller.

    Drive it as a continuing stream: call :meth:`start` once with the first
    observation, then alternate env steps with :meth:`observe`, which folds the
    transition into the agent and returns the next action. Episode boundaries
    are handled by passing ``terminated`` / ``truncated`` to :meth:`observe`;
    on a boundary the agent re-bootstraps from the next ``start`` without losing
    its learned weights (continual, not episodic).
    """

    def __init__(self, config: AlbertaControllerConfig):
        self.config = config
        self._feature_map = FeatureMap(config.features, config.obs_dim)
        self.feature_dim = self._feature_map.feature_dim

        ac_config = ContinuousActorCriticConfig(
            action_dim=config.action_dim,
            gamma=config.gamma,
            actor_step_size=config.actor_step_size,
            critic_step_size=config.critic_step_size,
            actor_lamda=config.actor_lamda,
            critic_lamda=config.critic_lamda,
            log_sigma_init=config.log_sigma_init,
            log_sigma_min=config.log_sigma_min,
            log_sigma_max=config.log_sigma_max,
            action_low=config.action_low,
            action_high=config.action_high,
        )
        bounder = ObGDBounding(kappa=config.obgd_kappa) if config.obgd_kappa else None
        self._agent = ContinuousActorCriticAgent(ac_config, bounder=bounder)

        self._normalizer = EMANormalizer(decay=config.normalizer_decay) if config.normalize else None
        key = jax.random.key(config.seed)
        self._ac_state: ContinuousActorCriticState = self._agent.init(self.feature_dim, key)
        self._norm_state: EMANormalizerState | None = (
            self._normalizer.init(config.obs_dim) if self._normalizer is not None else None
        )
        self._steps = 0
        self._decouple_bias = config.decouple_global_bias and config.features.mode == "sparse_gated"
        self._fixed_log_sigma = jnp.full(
            (config.action_dim,), config.log_sigma_init, dtype=jnp.float32
        )
        if self._decouple_bias:
            self._ac_state = self._decouple_globals(self._ac_state)

    def _decouple_globals(self, ac: ContinuousActorCriticState) -> ContinuousActorCriticState:
        """Pin the actor-critic's *shared* (non-block) parameters so they cannot
        couple tasks together. ``mean_bias`` / ``critic_bias`` are zeroed (the
        per-task block's "1" feature carries the bias). ``log_sigma`` is held at
        its init: it is a single global exploration scale, and if it collapses
        toward exploitation during the first task there is no exploration left
        to learn later tasks — the cause of per-task performance falling off a
        cliff after task 0. Holding it fixed gives every task the same
        exploration budget, so per-task learning is uniform."""
        return ac.replace(
            mean_bias=jnp.zeros_like(ac.mean_bias),
            critic_bias=jnp.zeros_like(ac.critic_bias),
            log_sigma=self._fixed_log_sigma,
        )

    # ------------------------------------------------------------------ features

    def _features(self, observation: np.ndarray, *, update_norm: bool) -> jnp.ndarray:
        obs = jnp.asarray(observation, dtype=jnp.float32)
        if self._normalizer is not None:
            assert self._norm_state is not None
            if update_norm:
                obs, self._norm_state = self._normalizer.normalize(self._norm_state, obs)
            else:
                obs = self._normalizer.normalize_only(self._norm_state, obs)
        return self._feature_map(obs)

    # ------------------------------------------------------------------ control

    def start(self, observation: np.ndarray) -> np.ndarray:
        """Select and store the first action for a fresh episode/stream.

        Eligibility traces are zeroed: an env reset teleports the agent, so the
        previous episode's traces are not credit-assignable to the new episode.
        Learned weights are untouched (continual across the whole stream).
        """
        ac = self._ac_state
        self._ac_state = ac.replace(
            mean_trace_weights=jnp.zeros_like(ac.mean_trace_weights),
            mean_trace_bias=jnp.zeros_like(ac.mean_trace_bias),
            log_sigma_trace=jnp.zeros_like(ac.log_sigma_trace),
            critic_trace_weights=jnp.zeros_like(ac.critic_trace_weights),
            critic_trace_bias=jnp.zeros_like(ac.critic_trace_bias),
        )
        feat = self._features(observation, update_norm=True)
        self._ac_state, action, _mean, _sigma = self._agent.start(self._ac_state, feat)
        if self._decouple_bias:
            self._ac_state = self._decouple_globals(self._ac_state)
        return np.asarray(action, dtype=np.float32)

    def observe(
        self,
        reward: float,
        next_observation: np.ndarray,
        *,
        terminated: bool = False,
        truncated: bool = False,
    ) -> np.ndarray:
        """Fold one transition into the agent and return the next action.

        Discounting follows the standard convention: a *terminal* transition
        bootstraps with discount 0 (the episode genuinely ended), while a
        *truncation* (time-limit) keeps the discount so value estimates are not
        corrupted by an artificial horizon.
        """
        feat_next = self._features(next_observation, update_norm=True)
        discount = 0.0 if terminated else self.config.gamma
        result = self._agent.update(
            self._ac_state,
            jnp.asarray(reward, dtype=jnp.float32),
            feat_next,
            discount=jnp.asarray(discount, dtype=jnp.float32),
        )
        self._ac_state = result.state
        if self._decouple_bias:
            self._ac_state = self._decouple_globals(self._ac_state)
        self._steps += 1
        return np.asarray(result.action, dtype=np.float32)

    def act_greedy(self, observation: np.ndarray) -> np.ndarray:
        """Deterministic action (policy mean) for evaluation. No learning, no
        normalizer-stat update."""
        feat = self._features(observation, update_norm=False)
        mean, _sigma = self._agent.policy_params(self._ac_state, feat)
        low, high = self.config.action_low, self.config.action_high
        return np.asarray(jnp.clip(mean, low, high), dtype=np.float32)

    def value(self, observation: np.ndarray) -> float:
        feat = self._features(observation, update_norm=False)
        return float(self._agent.value(self._ac_state, feat))

    # ------------------------------------------------------------------ state io

    @property
    def steps(self) -> int:
        return self._steps

    def state_dict(self) -> dict:
        """Numpy snapshot of all learned parameters (for checkpointing)."""
        ac = self._ac_state
        snap = {
            "mean_weights": np.asarray(ac.mean_weights),
            "mean_bias": np.asarray(ac.mean_bias),
            "log_sigma": np.asarray(ac.log_sigma),
            "critic_weights": np.asarray(ac.critic_weights),
            "critic_bias": np.asarray(ac.critic_bias),
            "steps": np.asarray(self._steps),
        }
        if self._norm_state is not None:
            snap["norm_mean"] = np.asarray(self._norm_state.mean)
            snap["norm_var"] = np.asarray(self._norm_state.var)
            snap["norm_count"] = np.asarray(self._norm_state.sample_count)
        return snap

    def load_state_dict(self, snap: dict) -> None:
        ac = self._ac_state
        self._ac_state = ac.replace(
            mean_weights=jnp.asarray(snap["mean_weights"], dtype=jnp.float32),
            mean_bias=jnp.asarray(snap["mean_bias"], dtype=jnp.float32),
            log_sigma=jnp.asarray(snap["log_sigma"], dtype=jnp.float32),
            critic_weights=jnp.asarray(snap["critic_weights"], dtype=jnp.float32),
            critic_bias=jnp.asarray(snap["critic_bias"], dtype=jnp.float32),
        )
        if self._norm_state is not None and "norm_mean" in snap:
            self._norm_state = self._norm_state.replace(
                mean=jnp.asarray(snap["norm_mean"], dtype=jnp.float32),
                var=jnp.asarray(snap["norm_var"], dtype=jnp.float32),
                sample_count=jnp.asarray(snap["norm_count"], dtype=jnp.float32),
            )
        self._steps = int(snap.get("steps", self._steps))
