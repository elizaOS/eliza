"""Online behavior/action prediction for discrete-action agents.

The behavior model is a temporally uniform supervised learner for
``P(A_t | features_t)``.  It is deliberately separate from control: SARSA,
actor-critic, scripted policies, external logs, and future dream rollouts can
all feed the same observed ``(features, action)`` stream into this model.
"""

from __future__ import annotations

import dataclasses
import functools
from typing import Any

import chex
import jax
import jax.numpy as jnp
import jax.random as jr
from jax import Array
from jaxtyping import Float, Int


def floor_and_renormalize_probabilities(
    probabilities: Array,
    min_probability: float = 1e-6,
) -> Array:
    """Floor probabilities and return a valid simplex along the last axis.

    This helper is for sampling or reporting a proper simplex distribution
    whose entries are at least ``min_probability``. Importance-ratio denominators
    should use :func:`selected_action_probabilities`, which floors only the
    selected action probability and does not change other actions.
    """
    probs = jnp.asarray(probabilities, dtype=jnp.float32)
    n_actions = probabilities.shape[-1]
    if min_probability * n_actions >= 1.0:
        return jnp.ones_like(probs) / n_actions
    clipped = jnp.maximum(probs, 0.0)
    normalizer = jnp.maximum(
        jnp.sum(clipped, axis=-1, keepdims=True),
        jnp.asarray(1e-12, dtype=jnp.float32),
    )
    normalized = clipped / normalizer
    floor_mass = jnp.asarray(min_probability * n_actions, dtype=jnp.float32)
    return jnp.asarray(min_probability, dtype=jnp.float32) + (
        1.0 - floor_mass
    ) * normalized


def selected_action_probabilities(
    probabilities: Array,
    actions: Array,
    min_probability: float = 1e-6,
) -> Array:
    """Return floor-clipped probabilities for selected discrete actions.

    ``probabilities`` may be a single action distribution with shape
    ``(n_actions,)`` or a batch with actions on the last axis. ``actions`` must
    broadcast to ``probabilities.shape[:-1]``.
    """
    probs = jnp.asarray(probabilities, dtype=jnp.float32)
    action_ids = jnp.asarray(actions, dtype=jnp.int32)
    one_hot = jax.nn.one_hot(action_ids, probs.shape[-1], dtype=jnp.float32)
    selected = jnp.sum(probs * one_hot, axis=-1)
    return jnp.maximum(selected, jnp.asarray(min_probability, dtype=jnp.float32))


def action_log_likelihoods(
    probabilities: Array,
    actions: Array,
    min_probability: float = 1e-6,
) -> Array:
    """Return log-likelihoods for selected actions under a behavior model."""
    return jnp.log(
        selected_action_probabilities(
            probabilities,
            actions,
            min_probability=min_probability,
        )
    )


def clipped_importance_ratios(
    target_probabilities: Array,
    behavior_probabilities: Array,
    actions: Array,
    *,
    clip: float | None = 10.0,
    min_behavior_probability: float = 1e-6,
) -> Array:
    """Compute selected-action target/behavior ratios with safe denominators.

    Args:
        target_probabilities: Target policy probabilities with actions on the
            last axis.
        behavior_probabilities: Behavior model probabilities with actions on
            the last axis.
        actions: Discrete selected actions.
        clip: Optional upper bound on ratios. ``None`` disables clipping.
        min_behavior_probability: Lower bound for behavior denominators.

    Returns:
        Per-sample ratios with shape ``target_probabilities.shape[:-1]``.
    """
    target = selected_action_probabilities(
        target_probabilities,
        actions,
        min_probability=0.0,
    )
    behavior = selected_action_probabilities(
        behavior_probabilities,
        actions,
        min_probability=min_behavior_probability,
    )
    ratios = target / behavior
    if clip is None:
        return ratios
    return jnp.minimum(ratios, jnp.asarray(clip, dtype=jnp.float32))


def epsilon_greedy_probabilities(
    q_values: Array,
    epsilon: Array,
    tie_tolerance: float = 1e-6,
) -> Array:
    """Return the exact epsilon-greedy action distribution for Q-values.

    This mirrors the SARSA/Q-learning policy surface: exploration is uniform
    over all actions and exploitation is uniform over maximal actions.
    """
    q = jnp.asarray(q_values, dtype=jnp.float32)
    n_actions = q.shape[-1]
    eps = jnp.asarray(epsilon, dtype=jnp.float32)
    max_q = jnp.max(q, axis=-1, keepdims=True)
    greedy_mask = jnp.isclose(q, max_q, atol=tie_tolerance, rtol=0.0).astype(
        jnp.float32
    )
    n_greedy = jnp.sum(greedy_mask, axis=-1, keepdims=True)
    explore = eps / n_actions
    exploit = (1.0 - eps) * greedy_mask / jnp.maximum(n_greedy, 1.0)
    return exploit + explore


@dataclasses.dataclass(frozen=True)
class BehaviorModelConfig:
    """Configuration for a linear online discrete behavior model.

    Attributes:
        n_actions: Number of discrete actions.
        step_size: Cross-entropy gradient step-size.
        temperature: Softmax temperature for behavior probabilities.
        l2_penalty: Optional L2 shrinkage on weights and biases.
        max_gradient_norm: Optional global gradient-norm clip before applying
            ``step_size``.
        min_probability: Probability floor for likelihood and ratio helpers.
        ratio_clip: Default ratio clip for off-policy helper methods.
        diagnostic_decay: EMA decay used for online reliability diagnostics.
    """

    n_actions: int
    step_size: float = 0.05
    temperature: float = 1.0
    l2_penalty: float = 0.0
    max_gradient_norm: float | None = None
    min_probability: float = 1e-6
    ratio_clip: float = 10.0
    diagnostic_decay: float = 0.99

    def __post_init__(self) -> None:
        """Validate scalar hyperparameters."""
        if self.n_actions <= 0:
            raise ValueError("n_actions must be positive")
        if self.step_size < 0.0:
            raise ValueError("step_size must be non-negative")
        if self.temperature <= 0.0:
            raise ValueError("temperature must be positive")
        if self.l2_penalty < 0.0:
            raise ValueError("l2_penalty must be non-negative")
        if self.max_gradient_norm is not None and self.max_gradient_norm <= 0.0:
            raise ValueError("max_gradient_norm must be positive when provided")
        if self.min_probability <= 0.0:
            raise ValueError("min_probability must be positive")
        if self.ratio_clip <= 0.0:
            raise ValueError("ratio_clip must be positive")
        if not 0.0 <= self.diagnostic_decay < 1.0:
            raise ValueError("diagnostic_decay must be in [0, 1)")

    def to_config(self) -> dict[str, Any]:
        """Serialize configuration to a JSON-compatible dictionary."""
        return dataclasses.asdict(self)

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> BehaviorModelConfig:
        """Reconstruct from :meth:`to_config` output."""
        return cls(**config)


@chex.dataclass(frozen=True)
class BehaviorModelState:
    """Immutable state for the behavior/action predictor."""

    weights: Float[Array, "n_actions feature_dim"]
    bias: Float[Array, " n_actions"]
    rng_key: Array
    step_count: Int[Array, ""]
    nll_ema: Float[Array, ""]
    accuracy_ema: Float[Array, ""]
    confidence_ema: Float[Array, ""]


@chex.dataclass(frozen=True)
class BehaviorModelUpdateResult:
    """Result of one online behavior-model update."""

    state: BehaviorModelState
    logits: Float[Array, " n_actions"]
    probabilities: Float[Array, " n_actions"]
    action_probability: Float[Array, ""]
    log_likelihood: Float[Array, ""]
    loss: Float[Array, ""]
    entropy: Float[Array, ""]
    confidence: Float[Array, ""]
    predicted_action: Int[Array, ""]
    correct: Float[Array, ""]


@chex.dataclass(frozen=True)
class BehaviorModelSampleResult:
    """Result of sampling an action from the learned behavior model."""

    state: BehaviorModelState
    action: Int[Array, ""]
    probabilities: Float[Array, " n_actions"]
    action_probability: Float[Array, ""]
    log_likelihood: Float[Array, ""]


@chex.dataclass(frozen=True)
class BehaviorModelArrayResult:
    """Result from scan-based behavior-model learning."""

    state: BehaviorModelState
    probabilities: Float[Array, "num_steps n_actions"]
    action_probabilities: Float[Array, " num_steps"]
    log_likelihoods: Float[Array, " num_steps"]
    losses: Float[Array, " num_steps"]
    entropies: Float[Array, " num_steps"]
    confidences: Float[Array, " num_steps"]
    correct: Float[Array, " num_steps"]


class BehaviorModel:
    """Online softmax model of the behavior policy.

    The model learns from the actually executed action at every step using a
    one-step cross-entropy update.  It is suitable for estimating behavior
    denominators in off-policy ratios and for sampling plausible actions during
    short model-based rollouts.
    """

    def __init__(self, config: BehaviorModelConfig):
        """Initialize the model."""
        self._config = config

    @property
    def config(self) -> BehaviorModelConfig:
        """Behavior-model configuration."""
        return self._config

    def to_config(self) -> dict[str, Any]:
        """Serialize model configuration."""
        return {
            "type": "BehaviorModel",
            "config": self._config.to_config(),
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> BehaviorModel:
        """Reconstruct a behavior model from :meth:`to_config` output."""
        config = dict(config)
        config.pop("type", None)
        return cls(BehaviorModelConfig.from_config(config["config"]))

    def init(self, feature_dim: int, key: Array) -> BehaviorModelState:
        """Initialize parameters and diagnostics."""
        return BehaviorModelState(  # type: ignore[call-arg]
            weights=jnp.zeros(
                (self._config.n_actions, feature_dim),
                dtype=jnp.float32,
            ),
            bias=jnp.zeros((self._config.n_actions,), dtype=jnp.float32),
            rng_key=key,
            step_count=jnp.array(0, dtype=jnp.int32),
            nll_ema=jnp.array(0.0, dtype=jnp.float32),
            accuracy_ema=jnp.array(0.0, dtype=jnp.float32),
            confidence_ema=jnp.array(0.0, dtype=jnp.float32),
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict_logits(
        self,
        state: BehaviorModelState,
        observation: Array,
    ) -> Float[Array, " n_actions"]:
        """Predict behavior logits for one feature vector."""
        obs = jnp.asarray(observation, dtype=jnp.float32)
        return state.weights @ obs + state.bias

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict_probabilities(
        self,
        state: BehaviorModelState,
        observation: Array,
    ) -> Float[Array, " n_actions"]:
        """Predict behavior action probabilities for one feature vector."""
        logits = self.predict_logits(state, observation)
        return jax.nn.softmax(logits / self._config.temperature)

    @functools.partial(jax.jit, static_argnums=(0,))
    def action_probability(
        self,
        state: BehaviorModelState,
        observation: Array,
        action: Array,
    ) -> Float[Array, ""]:
        """Return the floor-clipped probability of ``action``."""
        probs = self.predict_probabilities(state, observation)
        return selected_action_probabilities(
            probs,
            action,
            min_probability=self._config.min_probability,
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def action_log_likelihood(
        self,
        state: BehaviorModelState,
        observation: Array,
        action: Array,
    ) -> Float[Array, ""]:
        """Return the floor-clipped log-likelihood of ``action``."""
        return jnp.log(self.action_probability(state, observation, action))

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: BehaviorModelState,
        observation: Array,
        action: Array,
    ) -> BehaviorModelUpdateResult:
        """Update the behavior model from one observed action."""
        cfg = self._config
        obs = jnp.asarray(observation, dtype=jnp.float32)
        action_id = jnp.asarray(action, dtype=jnp.int32)
        logits = state.weights @ obs + state.bias
        probabilities = jax.nn.softmax(logits / cfg.temperature)
        one_hot = jax.nn.one_hot(action_id, cfg.n_actions, dtype=jnp.float32)

        logit_error = (one_hot - probabilities) / cfg.temperature
        weight_gradient = logit_error[:, None] * obs[None, :]
        bias_gradient = logit_error
        if cfg.l2_penalty > 0.0:
            weight_gradient = weight_gradient - cfg.l2_penalty * state.weights
            bias_gradient = bias_gradient - cfg.l2_penalty * state.bias

        if cfg.max_gradient_norm is not None:
            grad_norm = jnp.sqrt(
                jnp.sum(weight_gradient * weight_gradient)
                + jnp.sum(bias_gradient * bias_gradient)
            )
            grad_scale = jnp.minimum(
                1.0,
                jnp.asarray(cfg.max_gradient_norm, dtype=jnp.float32)
                / jnp.maximum(grad_norm, 1e-12),
            )
            weight_gradient = grad_scale * weight_gradient
            bias_gradient = grad_scale * bias_gradient

        action_prob = selected_action_probabilities(
            probabilities,
            action_id,
            min_probability=cfg.min_probability,
        )
        log_likelihood = jnp.log(action_prob)
        loss = -log_likelihood
        entropy = -jnp.sum(
            probabilities * jnp.log(jnp.maximum(probabilities, cfg.min_probability))
        )
        confidence = jnp.max(probabilities)
        predicted_action = jnp.argmax(probabilities).astype(jnp.int32)
        correct = (predicted_action == action_id).astype(jnp.float32)

        decay = jnp.asarray(cfg.diagnostic_decay, dtype=jnp.float32)
        first = state.step_count == 0
        nll_ema = jnp.where(
            first,
            loss,
            decay * state.nll_ema + (1.0 - decay) * loss,
        )
        accuracy_ema = jnp.where(
            first,
            correct,
            decay * state.accuracy_ema + (1.0 - decay) * correct,
        )
        confidence_ema = jnp.where(
            first,
            confidence,
            decay * state.confidence_ema + (1.0 - decay) * confidence,
        )

        new_state = state.replace(  # type: ignore[attr-defined]
            weights=state.weights + cfg.step_size * weight_gradient,
            bias=state.bias + cfg.step_size * bias_gradient,
            step_count=state.step_count + 1,
            nll_ema=nll_ema,
            accuracy_ema=accuracy_ema,
            confidence_ema=confidence_ema,
        )
        return BehaviorModelUpdateResult(  # type: ignore[call-arg]
            state=new_state,
            logits=logits,
            probabilities=probabilities,
            action_probability=action_prob,
            log_likelihood=log_likelihood,
            loss=loss,
            entropy=entropy,
            confidence=confidence,
            predicted_action=predicted_action,
            correct=correct,
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def sample_action(
        self,
        state: BehaviorModelState,
        observation: Array,
    ) -> BehaviorModelSampleResult:
        """Sample one action from the learned behavior distribution."""
        key, sample_key = jr.split(state.rng_key)
        probabilities = floor_and_renormalize_probabilities(
            self.predict_probabilities(state, observation),
            min_probability=self._config.min_probability,
        )
        action = jr.categorical(
            sample_key,
            jnp.log(probabilities),
        ).astype(jnp.int32)
        action_prob = selected_action_probabilities(
            probabilities,
            action,
            min_probability=self._config.min_probability,
        )
        return BehaviorModelSampleResult(  # type: ignore[call-arg]
            state=state.replace(rng_key=key),  # type: ignore[attr-defined]
            action=action,
            probabilities=probabilities,
            action_probability=action_prob,
            log_likelihood=jnp.log(action_prob),
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def importance_ratio(
        self,
        state: BehaviorModelState,
        observation: Array,
        action: Array,
        target_probabilities: Array,
    ) -> Float[Array, ""]:
        """Compute a clipped target/behavior ratio for one transition."""
        behavior = self.predict_probabilities(state, observation)
        ratio = clipped_importance_ratios(
            target_probabilities,
            behavior,
            action,
            clip=self._config.ratio_clip,
            min_behavior_probability=self._config.min_probability,
        )
        return ratio


def run_behavior_model_from_arrays(
    model: BehaviorModel,
    state: BehaviorModelState,
    observations: Float[Array, "num_steps feature_dim"],
    actions: Int[Array, " num_steps"],
) -> BehaviorModelArrayResult:
    """Run online behavior prediction over arrays with ``jax.lax.scan``."""

    def _scan_fn(
        carry: BehaviorModelState,
        inputs: tuple[Array, Array],
    ) -> tuple[BehaviorModelState, tuple[Array, Array, Array, Array, Array, Array, Array]]:
        obs, action = inputs
        result = model.update(carry, obs, action)
        return result.state, (
            result.probabilities,
            result.action_probability,
            result.log_likelihood,
            result.loss,
            result.entropy,
            result.confidence,
            result.correct,
        )

    final_state, (
        probabilities,
        action_probabilities,
        log_likelihoods,
        losses,
        entropies,
        confidences,
        correct,
    ) = jax.lax.scan(_scan_fn, state, (observations, actions))
    return BehaviorModelArrayResult(  # type: ignore[call-arg]
        state=final_state,
        probabilities=probabilities,
        action_probabilities=action_probabilities,
        log_likelihoods=log_likelihoods,
        losses=losses,
        entropies=entropies,
        confidences=confidences,
        correct=correct,
    )


__all__ = [
    "BehaviorModel",
    "BehaviorModelArrayResult",
    "BehaviorModelConfig",
    "BehaviorModelSampleResult",
    "BehaviorModelState",
    "BehaviorModelUpdateResult",
    "action_log_likelihoods",
    "clipped_importance_ratios",
    "epsilon_greedy_probabilities",
    "floor_and_renormalize_probabilities",
    "run_behavior_model_from_arrays",
    "selected_action_probabilities",
]
