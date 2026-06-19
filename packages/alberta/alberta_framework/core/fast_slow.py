# mypy: disable-error-code="call-arg,name-defined"
"""Fast/slow additive learner implementation for Step 2 productionization.

This module is the small production-oriented bridge from the D18 research
runner toward a JAX-native core learner.  It intentionally avoids the D18
portfolio machinery: there are no kernel banks, Fourier features, polynomial
caps, or hand-routed experts.  The learner has one trainable feature encoder,
one slow readout, one fast decayed readout, and a learned gate between them.

The design goal is not to claim parity with D18 yet.  It is a compact,
scan-compatible API that lets the Step 2 fast/slow hypothesis move into the
core stack without destabilizing existing learners.
"""

from __future__ import annotations

import functools
from typing import Any, cast

import chex
import jax
import jax.numpy as jnp
import jax.random as jr
from jax import Array
from jaxtyping import Float


@chex.dataclass(frozen=True)
class FastSlowConfig:
    """Configuration for :class:`FastSlowLearner`.

    Args:
        input_dim: Observation dimensionality.
        output_dim: Prediction dimensionality.
        hidden_dim: Width of the learned tanh encoder.
        encoder_step_size: Step-size for the shared learned encoder.
        slow_step_size: Step-size for the slow readout.
        fast_step_size: Step-size for the fast readout.
        gate_step_size: Step-size for the learned fast/slow gate.
        fast_decay: Per-step decay applied to the fast readout before its new
            update.  This is the only fixed timescale in the learner.
        slow_weight_decay: Optional multiplicative decay for slow readout
            weights.  Defaults to no decay.
        gate_l2: L2 shrinkage on gate weights.  Defaults to no shrinkage.
        grad_clip: Global gradient-norm cap.  Non-positive disables clipping.
        init_scale: Encoder initialization scale.
    """

    input_dim: int
    output_dim: int = 1
    hidden_dim: int = 64
    encoder_step_size: float = 1e-3
    slow_step_size: float = 1e-2
    fast_step_size: float = 5e-2
    gate_step_size: float = 1e-2
    fast_decay: float = 0.98
    slow_weight_decay: float = 1.0
    gate_l2: float = 0.0
    grad_clip: float = 10.0
    init_scale: float = 1.0

    def to_config(self) -> dict[str, Any]:
        """Serialize to a plain dictionary."""
        return {
            "type": "FastSlowConfig",
            "input_dim": self.input_dim,
            "output_dim": self.output_dim,
            "hidden_dim": self.hidden_dim,
            "encoder_step_size": self.encoder_step_size,
            "slow_step_size": self.slow_step_size,
            "fast_step_size": self.fast_step_size,
            "gate_step_size": self.gate_step_size,
            "fast_decay": self.fast_decay,
            "slow_weight_decay": self.slow_weight_decay,
            "gate_l2": self.gate_l2,
            "grad_clip": self.grad_clip,
            "init_scale": self.init_scale,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> FastSlowConfig:
        """Reconstruct a config from :meth:`to_config` output."""
        config = dict(config)
        config.pop("type", None)
        return cls(**config)


@chex.dataclass(frozen=True)
class FastSlowParams:
    """Trainable parameters for the fast/slow learner."""

    encoder_kernel: Float[Array, "input_dim hidden_dim"]
    encoder_bias: Float[Array, " hidden_dim"]
    slow_kernel: Float[Array, "hidden_dim output_dim"]
    slow_bias: Float[Array, " output_dim"]
    fast_kernel: Float[Array, "hidden_dim output_dim"]
    fast_bias: Float[Array, " output_dim"]
    gate_kernel: Float[Array, "hidden_dim output_dim"]
    gate_bias: Float[Array, " output_dim"]


@chex.dataclass(frozen=True)
class FastSlowState:
    """State for :class:`FastSlowLearner`."""

    params: FastSlowParams
    step_count: Array


@chex.dataclass(frozen=True)
class FastSlowPredictionParts:
    """Structured forward-pass outputs for diagnostics and updates."""

    prediction: Float[Array, " output_dim"]
    slow_prediction: Float[Array, " output_dim"]
    fast_prediction: Float[Array, " output_dim"]
    gate: Float[Array, " output_dim"]
    features: Float[Array, " hidden_dim"]


@chex.dataclass(frozen=True)
class FastSlowUpdateResult:
    """Result of one online update."""

    state: FastSlowState
    prediction: Float[Array, " output_dim"]
    error: Float[Array, " output_dim"]
    metrics: Float[Array, " metrics"]


@chex.dataclass(frozen=True)
class FastSlowLearningResult:
    """Result of running :func:`run_fast_slow_arrays`."""

    state: FastSlowState
    metrics: Float[Array, "steps metrics"]


def _validate_config(config: FastSlowConfig) -> None:
    if config.input_dim < 1:
        raise ValueError("input_dim must be positive")
    if config.output_dim < 1:
        raise ValueError("output_dim must be positive")
    if config.hidden_dim < 1:
        raise ValueError("hidden_dim must be positive")
    if config.encoder_step_size < 0.0:
        raise ValueError("encoder_step_size must be non-negative")
    if config.slow_step_size < 0.0:
        raise ValueError("slow_step_size must be non-negative")
    if config.fast_step_size < 0.0:
        raise ValueError("fast_step_size must be non-negative")
    if config.gate_step_size < 0.0:
        raise ValueError("gate_step_size must be non-negative")
    if not 0.0 <= config.fast_decay <= 1.0:
        raise ValueError("fast_decay must be in [0, 1]")
    if not 0.0 <= config.slow_weight_decay <= 1.0:
        raise ValueError("slow_weight_decay must be in [0, 1]")
    if config.gate_l2 < 0.0:
        raise ValueError("gate_l2 must be non-negative")
    if config.init_scale <= 0.0:
        raise ValueError("init_scale must be positive")


def _linear_init(key: Array, fan_in: int, fan_out: int, scale: float) -> Array:
    std = scale / jnp.sqrt(jnp.asarray(max(fan_in, 1), dtype=jnp.float32))
    return std * jr.normal(key, (fan_in, fan_out), dtype=jnp.float32)


def init_fast_slow_params(key: Array, config: FastSlowConfig) -> FastSlowParams:
    """Initialize fast/slow learner parameters.

    The encoder starts random but is immediately trainable.  Readouts start at
    zero so the first predictions are neutral and all structure is acquired by
    online updates.
    """
    _validate_config(config)
    encoder_key, gate_key = jr.split(key)
    return FastSlowParams(
        encoder_kernel=_linear_init(
            encoder_key,
            config.input_dim,
            config.hidden_dim,
            config.init_scale,
        ),
        encoder_bias=jnp.zeros(config.hidden_dim, dtype=jnp.float32),
        slow_kernel=jnp.zeros(
            (config.hidden_dim, config.output_dim),
            dtype=jnp.float32,
        ),
        slow_bias=jnp.zeros(config.output_dim, dtype=jnp.float32),
        fast_kernel=jnp.zeros(
            (config.hidden_dim, config.output_dim),
            dtype=jnp.float32,
        ),
        fast_bias=jnp.zeros(config.output_dim, dtype=jnp.float32),
        gate_kernel=_linear_init(gate_key, config.hidden_dim, config.output_dim, 0.01),
        gate_bias=jnp.zeros(config.output_dim, dtype=jnp.float32),
    )


def fast_slow_forward(
    params: FastSlowParams,
    observation: Float[Array, " input_dim"],
) -> FastSlowPredictionParts:
    """Run a single-example fast/slow forward pass."""
    features = jnp.tanh(observation @ params.encoder_kernel + params.encoder_bias)
    slow_prediction = features @ params.slow_kernel + params.slow_bias
    fast_prediction = features @ params.fast_kernel + params.fast_bias
    gate = jax.nn.sigmoid(features @ params.gate_kernel + params.gate_bias)
    prediction = slow_prediction + gate * fast_prediction
    return FastSlowPredictionParts(
        prediction=prediction,
        slow_prediction=slow_prediction,
        fast_prediction=fast_prediction,
        gate=gate,
        features=features,
    )


def _loss_and_parts(
    params: FastSlowParams,
    observation: Array,
    target: Array,
) -> tuple[Array, FastSlowPredictionParts]:
    parts = fast_slow_forward(params, observation)
    shaped_target = jnp.reshape(target, parts.prediction.shape)
    error = parts.prediction - shaped_target
    loss = 0.5 * jnp.mean(error**2)
    return loss, parts


def _tree_global_norm(tree: object) -> Array:
    leaves = jax.tree_util.tree_leaves(tree)
    return jnp.sqrt(sum(jnp.sum(leaf**2) for leaf in leaves))


def _clip_grads(grads: FastSlowParams, clip: float) -> tuple[FastSlowParams, Array]:
    norm = _tree_global_norm(grads)
    if clip <= 0.0:
        return grads, norm
    scale = jnp.minimum(1.0, jnp.asarray(clip, dtype=jnp.float32) / (norm + 1e-8))
    return jax.tree_util.tree_map(lambda g: scale * g, grads), norm


class FastSlowLearner:
    """JAX-native fast/slow additive learner.

    Prediction is:

    ``slow(phi(x)) + sigmoid(g(phi(x))) * fast(phi(x))``

    The shared encoder, slow readout, fast readout, and gate all update every
    time step.  The fast readout is decayed before applying its update, giving
    the learner a short-memory path without an external router.
    """

    def __init__(self, config: FastSlowConfig):
        _validate_config(config)
        self._config = config

    @property
    def config(self) -> FastSlowConfig:
        """Learner configuration."""
        return self._config

    def to_config(self) -> dict[str, Any]:
        """Serialize the learner configuration."""
        return {"type": "FastSlowLearner", "config": self._config.to_config()}

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> FastSlowLearner:
        """Reconstruct a learner from :meth:`to_config` output."""
        inner = dict(config["config"])
        return cls(FastSlowConfig.from_config(inner))

    def init(self, key: Array) -> FastSlowState:
        """Create an initial learner state."""
        return FastSlowState(
            params=init_fast_slow_params(key, self._config),
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict_parts(
        self,
        state: FastSlowState,
        observation: Float[Array, " input_dim"],
    ) -> FastSlowPredictionParts:
        """Return prediction plus fast/slow/gate diagnostics."""
        return fast_slow_forward(state.params, observation)

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict(
        self,
        state: FastSlowState,
        observation: Float[Array, " input_dim"],
    ) -> Float[Array, " output_dim"]:
        """Return the current prediction for one observation."""
        return cast(Array, self.predict_parts(state, observation).prediction)

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: FastSlowState,
        observation: Float[Array, " input_dim"],
        target: Float[Array, " output_dim"],
    ) -> FastSlowUpdateResult:
        """Perform one causal online update."""
        (loss, parts), grads = jax.value_and_grad(_loss_and_parts, has_aux=True)(
            state.params,
            observation,
            target,
        )
        clipped_grads, grad_norm = _clip_grads(grads, self._config.grad_clip)
        c = self._config

        new_params = FastSlowParams(
            encoder_kernel=state.params.encoder_kernel
            - c.encoder_step_size * clipped_grads.encoder_kernel,
            encoder_bias=state.params.encoder_bias
            - c.encoder_step_size * clipped_grads.encoder_bias,
            slow_kernel=c.slow_weight_decay * state.params.slow_kernel
            - c.slow_step_size * clipped_grads.slow_kernel,
            slow_bias=state.params.slow_bias - c.slow_step_size * clipped_grads.slow_bias,
            fast_kernel=c.fast_decay * state.params.fast_kernel
            - c.fast_step_size * clipped_grads.fast_kernel,
            fast_bias=c.fast_decay * state.params.fast_bias
            - c.fast_step_size * clipped_grads.fast_bias,
            gate_kernel=(1.0 - c.gate_step_size * c.gate_l2) * state.params.gate_kernel
            - c.gate_step_size * clipped_grads.gate_kernel,
            gate_bias=state.params.gate_bias - c.gate_step_size * clipped_grads.gate_bias,
        )
        new_state = FastSlowState(
            params=new_params,
            step_count=state.step_count + 1,
        )
        shaped_target = jnp.reshape(target, parts.prediction.shape)
        error = shaped_target - parts.prediction
        metrics = jnp.asarray(
            [
                loss,
                jnp.mean(error**2),
                jnp.mean(parts.gate),
                grad_norm,
                _tree_global_norm(new_params.fast_kernel),
                _tree_global_norm(new_params.slow_kernel),
            ],
            dtype=jnp.float32,
        )
        return FastSlowUpdateResult(
            state=new_state,
            prediction=parts.prediction,
            error=error,
            metrics=metrics,
        )


def run_fast_slow_arrays(
    learner: FastSlowLearner,
    observations: Float[Array, "steps input_dim"],
    targets: Float[Array, "steps output_dim"],
    *,
    state: FastSlowState | None = None,
    key: Array | None = None,
) -> FastSlowLearningResult:
    """Run the learner over arrays with ``jax.lax.scan``.

    Args:
        learner: Fast/slow learner instance.
        observations: Observation array with leading time dimension.
        targets: Target array with matching leading time dimension.
        state: Optional initial state.
        key: Initialization key, required when ``state`` is not supplied.

    Returns:
        Final state and per-step metrics with columns:
        ``loss, mse, mean_gate, grad_norm, fast_norm, slow_norm``.
    """
    if state is None:
        if key is None:
            raise ValueError("key is required when state is not supplied")
        state = learner.init(key)

    def step_fn(
        carry: FastSlowState,
        batch: tuple[Array, Array],
    ) -> tuple[FastSlowState, Array]:
        observation, target = batch
        result = learner.update(carry, observation, target)
        return result.state, result.metrics

    final_state, metrics = jax.lax.scan(step_fn, state, (observations, targets))
    return FastSlowLearningResult(state=final_state, metrics=metrics)
