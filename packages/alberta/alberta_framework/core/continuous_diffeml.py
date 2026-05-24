# mypy: disable-error-code="arg-type, call-arg, no-any-return"
"""Continuous DiffEML layers trained by ordinary backpropagation.

This module is intentionally separate from the hard-gate DiffEML selector
path.  It uses the stable real EML primitive as a differentiable feature block
over real-valued inputs, then updates all parameters with Adam.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Literal

import chex
import jax
import jax.numpy as jnp
import jax.random as jr
from jax import Array

from alberta_framework.core.diffeml import stable_eml_operator

ApproximationKind = Literal["lut", "poly"]
LossKind = Literal["mse", "softmax_cross_entropy"]

_APPROX_LUT_MIN = -8.0
_APPROX_LUT_MAX = 8.0
_APPROX_LUT_SIZE = 257
_APPROX_LUT_GRID = jnp.linspace(
    _APPROX_LUT_MIN,
    _APPROX_LUT_MAX,
    _APPROX_LUT_SIZE,
    dtype=jnp.float32,
)
_APPROX_EXP_LUT = jnp.exp(_APPROX_LUT_GRID)
_APPROX_LOG_SOFTPLUS_LUT = jnp.log(jax.nn.softplus(_APPROX_LUT_GRID) + 1e-6)


@chex.dataclass(frozen=True)
class ContinuousDiffEMLLayerParams:
    """Trainable parameters for one continuous EML block."""

    left_kernel: Array
    left_bias: Array
    right_kernel: Array
    right_bias: Array
    residual_kernel: Array
    residual_bias: Array
    gate_kernel: Array
    gate_bias: Array


@chex.dataclass(frozen=True)
class ContinuousDiffEMLParams:
    """Parameters for a stack of continuous EML blocks and a linear readout."""

    layers: tuple[ContinuousDiffEMLLayerParams, ...]
    readout_kernel: Array
    readout_bias: Array


@chex.dataclass(frozen=True)
class ContinuousDiffEMLAdamState:
    """Adam first and second moments matching ``ContinuousDiffEMLParams``."""

    m: ContinuousDiffEMLParams
    v: ContinuousDiffEMLParams
    step: Array


@chex.dataclass(frozen=True)
class ContinuousDiffEMLState:
    """Trainable model state."""

    params: ContinuousDiffEMLParams
    optimizer_state: ContinuousDiffEMLAdamState
    step_count: Array


@chex.dataclass(frozen=True)
class ContinuousDiffEMLUpdateResult:
    """Result from one gradient update."""

    state: ContinuousDiffEMLState
    predictions: Array
    loss: Array
    grad_norm: Array


@chex.dataclass(frozen=True)
class SparseContinuousEMLLayerParams:
    """Trainable parameters for one sparse continuous EML circuit layer.

    ``left_logits`` and ``right_logits`` are differentiable source selectors.
    They are trained softly and can later be compiled to hard source indices.
    """

    left_logits: Array
    right_logits: Array
    left_scale: Array
    left_bias: Array
    right_scale: Array
    right_bias: Array


@chex.dataclass(frozen=True)
class SparseContinuousEMLCircuitParams:
    """Parameters for a soft sparse continuous EML circuit and linear readout."""

    layers: tuple[SparseContinuousEMLLayerParams, ...]
    readout_kernel: Array
    readout_bias: Array


@chex.dataclass(frozen=True)
class SparseContinuousEMLCircuitAdamState:
    """Adam moments for a sparse continuous EML circuit."""

    m: SparseContinuousEMLCircuitParams
    v: SparseContinuousEMLCircuitParams
    step: Array


@chex.dataclass(frozen=True)
class SparseContinuousEMLCircuitState:
    """Trainable sparse circuit model state."""

    params: SparseContinuousEMLCircuitParams
    optimizer_state: SparseContinuousEMLCircuitAdamState
    step_count: Array


@chex.dataclass(frozen=True)
class SparseContinuousEMLCircuitUpdateResult:
    """Result from one sparse continuous EML circuit update."""

    state: SparseContinuousEMLCircuitState
    predictions: Array
    loss: Array
    grad_norm: Array


@chex.dataclass(frozen=True)
class CompiledSparseContinuousEMLLayer:
    """Fixed-source sparse EML layer for compiled inference."""

    left_indices: Array
    right_indices: Array
    left_scale: Array
    left_bias: Array
    right_scale: Array
    right_bias: Array


@chex.dataclass(frozen=True)
class CompiledSparseContinuousEMLCircuit:
    """Hard-source continuous EML circuit compiled from soft selectors."""

    input_dim: int
    layers: tuple[CompiledSparseContinuousEMLLayer, ...]
    readout_kernel: Array
    readout_bias: Array


def _as_tuple(values: Sequence[int]) -> tuple[int, ...]:
    return tuple(int(value) for value in values)


def _linear_init(key: Array, in_dim: int, out_dim: int, scale: float = 1.0) -> Array:
    std = scale / jnp.sqrt(jnp.asarray(max(in_dim, 1), dtype=jnp.float32))
    return std * jr.normal(key, (in_dim, out_dim), dtype=jnp.float32)


def init_continuous_diffeml_params(
    key: Array,
    *,
    input_dim: int,
    output_dim: int = 1,
    hidden_sizes: Sequence[int] = (32, 32),
    init_scale: float = 0.75,
) -> ContinuousDiffEMLParams:
    """Initialize a continuous DiffEML network.

    Args:
        key: JAX PRNG key.
        input_dim: Input feature dimension.
        output_dim: Number of readout outputs.
        hidden_sizes: Width of each continuous EML block.
        init_scale: Scale for affine kernels.

    Returns:
        Immutable parameter PyTree.
    """
    if input_dim < 1:
        raise ValueError("input_dim must be positive")
    if output_dim < 1:
        raise ValueError("output_dim must be positive")
    sizes = _as_tuple(hidden_sizes)
    if not sizes:
        raise ValueError("hidden_sizes must contain at least one EML block")
    if any(size < 1 for size in sizes):
        raise ValueError("hidden_sizes must be positive")

    layers: list[ContinuousDiffEMLLayerParams] = []
    in_dim = input_dim
    current_key = key
    for width in sizes:
        splits = jr.split(current_key, 7)
        current_key = splits[0]
        layers.append(
            ContinuousDiffEMLLayerParams(
                left_kernel=_linear_init(splits[1], in_dim, width, init_scale),
                left_bias=jnp.zeros(width, dtype=jnp.float32),
                right_kernel=_linear_init(splits[2], in_dim, width, init_scale),
                right_bias=jnp.full(width, 0.5, dtype=jnp.float32),
                residual_kernel=_linear_init(splits[3], in_dim, width, init_scale),
                residual_bias=jnp.zeros(width, dtype=jnp.float32),
                gate_kernel=_linear_init(splits[4], in_dim, width, 0.25 * init_scale),
                gate_bias=jnp.zeros(width, dtype=jnp.float32),
            )
        )
        in_dim = width

    readout_key = jr.split(current_key, 2)[1]
    return ContinuousDiffEMLParams(
        layers=tuple(layers),
        readout_kernel=_linear_init(readout_key, in_dim, output_dim, init_scale),
        readout_bias=jnp.zeros(output_dim, dtype=jnp.float32),
    )


def _normalize_features(x: Array, eps: float = 1e-5) -> Array:
    mean = jnp.mean(x, axis=-1, keepdims=True)
    variance = jnp.mean((x - mean) ** 2, axis=-1, keepdims=True)
    return (x - mean) / jnp.sqrt(variance + eps)


def continuous_diffeml_forward(
    params: ContinuousDiffEMLParams,
    inputs: Array,
    *,
    use_gating: bool = True,
    use_residual: bool = True,
    use_normalization: bool = True,
    eml_scale: float = 0.25,
    eml_eps: float = 1e-6,
    input_clip: float = 8.0,
    output_clip: float = 30.0,
) -> Array:
    """Run a continuous DiffEML forward pass on one example or a batch."""
    squeeze = inputs.ndim == 1
    x = inputs[None, :] if squeeze else inputs

    for layer in params.layers:
        left = x @ layer.left_kernel + layer.left_bias
        right = x @ layer.right_kernel + layer.right_bias
        eml_features = jnp.tanh(
            eml_scale
            * stable_eml_operator(
                left,
                right,
                eps=eml_eps,
                input_clip=input_clip,
                output_clip=output_clip,
            )
        )
        residual = x @ layer.residual_kernel + layer.residual_bias
        if use_gating:
            gate = jax.nn.sigmoid(x @ layer.gate_kernel + layer.gate_bias)
            x = gate * eml_features + (1.0 - gate) * residual
        elif use_residual:
            x = eml_features + residual
        else:
            x = eml_features
        if use_normalization:
            x = _normalize_features(x)

    outputs = x @ params.readout_kernel + params.readout_bias
    return outputs[0] if squeeze else outputs


def continuous_diffeml_loss(
    params: ContinuousDiffEMLParams,
    inputs: Array,
    targets: Array,
    *,
    loss: LossKind = "mse",
    l2_penalty: float = 0.0,
    **forward_kwargs: object,
) -> Array:
    """Compute a scalar supervised loss."""
    predictions = continuous_diffeml_forward(params, inputs, **forward_kwargs)
    if loss == "mse":
        data_loss = jnp.mean((predictions - targets) ** 2)
    elif loss == "softmax_cross_entropy":
        labels = targets if targets.ndim == 1 else jnp.argmax(targets, axis=-1)
        log_probs = jax.nn.log_softmax(predictions, axis=-1)
        data_loss = -jnp.mean(jnp.take_along_axis(log_probs, labels[:, None], axis=-1))
    else:
        raise ValueError(f"unknown loss kind: {loss}")

    if l2_penalty <= 0.0:
        return data_loss
    leaves = jax.tree_util.tree_leaves(params)
    l2 = sum(jnp.sum(leaf**2) for leaf in leaves)
    return data_loss + l2_penalty * l2


def init_continuous_diffeml_state(
    key: Array,
    *,
    input_dim: int,
    output_dim: int = 1,
    hidden_sizes: Sequence[int] = (32, 32),
    init_scale: float = 0.75,
) -> ContinuousDiffEMLState:
    """Initialize model parameters and Adam moments."""
    params = init_continuous_diffeml_params(
        key,
        input_dim=input_dim,
        output_dim=output_dim,
        hidden_sizes=hidden_sizes,
        init_scale=init_scale,
    )
    zeros = jax.tree_util.tree_map(jnp.zeros_like, params)
    return ContinuousDiffEMLState(
        params=params,
        optimizer_state=ContinuousDiffEMLAdamState(
            m=zeros,
            v=zeros,
            step=jnp.array(0, dtype=jnp.int32),
        ),
        step_count=jnp.array(0, dtype=jnp.int32),
    )


def _tree_global_norm(tree: object) -> Array:
    leaves = jax.tree_util.tree_leaves(tree)
    return jnp.sqrt(sum(jnp.sum(leaf**2) for leaf in leaves))


def continuous_diffeml_train_step(
    state: ContinuousDiffEMLState,
    inputs: Array,
    targets: Array,
    *,
    learning_rate: float = 1e-3,
    beta1: float = 0.9,
    beta2: float = 0.999,
    adam_eps: float = 1e-8,
    max_grad_norm: float | None = 10.0,
    loss: LossKind = "mse",
    l2_penalty: float = 0.0,
    **forward_kwargs: object,
) -> ContinuousDiffEMLUpdateResult:
    """Apply one full-batch Adam step through the continuous EML network."""

    def loss_fn(params: ContinuousDiffEMLParams) -> Array:
        return continuous_diffeml_loss(
            params,
            inputs,
            targets,
            loss=loss,
            l2_penalty=l2_penalty,
            **forward_kwargs,
        )

    value, grads = jax.value_and_grad(loss_fn)(state.params)
    grad_norm = _tree_global_norm(grads)
    if max_grad_norm is not None:
        scale = jnp.minimum(1.0, max_grad_norm / (grad_norm + 1e-8))
        grads = jax.tree_util.tree_map(lambda grad: scale * grad, grads)

    opt = state.optimizer_state
    step = opt.step + jnp.array(1, dtype=jnp.int32)
    m = jax.tree_util.tree_map(
        lambda old, grad: beta1 * old + (1.0 - beta1) * grad,
        opt.m,
        grads,
    )
    v = jax.tree_util.tree_map(
        lambda old, grad: beta2 * old + (1.0 - beta2) * grad**2,
        opt.v,
        grads,
    )
    step_f = step.astype(jnp.float32)
    m_hat = jax.tree_util.tree_map(lambda value_: value_ / (1.0 - beta1**step_f), m)
    v_hat = jax.tree_util.tree_map(lambda value_: value_ / (1.0 - beta2**step_f), v)
    params = jax.tree_util.tree_map(
        lambda param, mean, variance: param
        - learning_rate * mean / (jnp.sqrt(variance) + adam_eps),
        state.params,
        m_hat,
        v_hat,
    )
    new_state = ContinuousDiffEMLState(
        params=params,
        optimizer_state=ContinuousDiffEMLAdamState(m=m, v=v, step=step),
        step_count=state.step_count + jnp.array(1, dtype=jnp.int32),
    )
    predictions = continuous_diffeml_forward(params, inputs, **forward_kwargs)
    return ContinuousDiffEMLUpdateResult(
        state=new_state,
        predictions=predictions,
        loss=value,
        grad_norm=grad_norm,
    )


def train_continuous_diffeml(
    state: ContinuousDiffEMLState,
    inputs: Array,
    targets: Array,
    *,
    steps: int,
    learning_rate: float = 1e-3,
    loss: LossKind = "mse",
    **train_kwargs: object,
) -> tuple[ContinuousDiffEMLState, Array]:
    """Train for a fixed number of full-batch steps with ``jax.lax.scan``."""

    def step_fn(carry: ContinuousDiffEMLState, _: Array) -> tuple[ContinuousDiffEMLState, Array]:
        result = continuous_diffeml_train_step(
            carry,
            inputs,
            targets,
            learning_rate=learning_rate,
            loss=loss,
            **train_kwargs,
        )
        return result.state, jnp.stack([result.loss, result.grad_norm])

    return jax.lax.scan(step_fn, state, jnp.arange(steps))


def init_sparse_continuous_eml_circuit_params(
    key: Array,
    *,
    input_dim: int,
    output_dim: int = 1,
    depth: int = 2,
    width: int = 32,
    selector_init_scale: float = 0.01,
    value_init_scale: float = 0.5,
) -> SparseContinuousEMLCircuitParams:
    """Initialize a sparse continuous EML circuit with soft source selectors."""
    if input_dim < 1:
        raise ValueError("input_dim must be positive")
    if output_dim < 1:
        raise ValueError("output_dim must be positive")
    if depth < 1:
        raise ValueError("depth must be positive")
    if width < 1:
        raise ValueError("width must be positive")

    layers: list[SparseContinuousEMLLayerParams] = []
    current_key = key
    for layer_idx in range(depth):
        source_dim = input_dim + 1 if layer_idx == 0 else input_dim + 1 + width
        splits = jr.split(current_key, 3)
        current_key = splits[0]
        layers.append(
            SparseContinuousEMLLayerParams(
                left_logits=selector_init_scale
                * jr.normal(splits[1], (width, source_dim), dtype=jnp.float32),
                right_logits=selector_init_scale
                * jr.normal(splits[2], (width, source_dim), dtype=jnp.float32),
                left_scale=jnp.ones(width, dtype=jnp.float32),
                left_bias=jnp.zeros(width, dtype=jnp.float32),
                right_scale=jnp.ones(width, dtype=jnp.float32),
                right_bias=jnp.full(width, 0.5, dtype=jnp.float32),
            )
        )

    readout_key = jr.split(current_key, 2)[1]
    return SparseContinuousEMLCircuitParams(
        layers=tuple(layers),
        readout_kernel=_linear_init(readout_key, width, output_dim, value_init_scale),
        readout_bias=jnp.zeros(output_dim, dtype=jnp.float32),
    )


def init_sparse_continuous_eml_circuit_state(
    key: Array,
    *,
    input_dim: int,
    output_dim: int = 1,
    depth: int = 2,
    width: int = 32,
    selector_init_scale: float = 0.01,
    value_init_scale: float = 0.5,
) -> SparseContinuousEMLCircuitState:
    """Initialize sparse circuit parameters and Adam moments."""
    params = init_sparse_continuous_eml_circuit_params(
        key,
        input_dim=input_dim,
        output_dim=output_dim,
        depth=depth,
        width=width,
        selector_init_scale=selector_init_scale,
        value_init_scale=value_init_scale,
    )
    zeros = jax.tree_util.tree_map(jnp.zeros_like, params)
    return SparseContinuousEMLCircuitState(
        params=params,
        optimizer_state=SparseContinuousEMLCircuitAdamState(
            m=zeros,
            v=zeros,
            step=jnp.array(0, dtype=jnp.int32),
        ),
        step_count=jnp.array(0, dtype=jnp.int32),
    )


def _sparse_source_bank(inputs: Array, previous: Array | None) -> Array:
    constants = jnp.ones((inputs.shape[0], 1), dtype=inputs.dtype)
    if previous is None:
        return jnp.concatenate((inputs, constants), axis=-1)
    return jnp.concatenate((inputs, constants, previous), axis=-1)


def _select_sources(
    bank: Array,
    logits: Array,
    temperature: Array,
    *,
    hard: bool,
    straight_through: bool = False,
) -> Array:
    weights = jax.nn.softmax(logits / temperature, axis=-1)
    if hard:
        indices = jnp.argmax(logits, axis=-1)
        if straight_through:
            hard_weights = jax.nn.one_hot(indices, logits.shape[-1], dtype=bank.dtype)
            weights = hard_weights + weights - jax.lax.stop_gradient(weights)
            return bank @ weights.T
        return bank[:, indices]
    return bank @ weights.T


def _linear_lookup(values: Array, x: Array) -> Array:
    """Linearly interpolate a fixed lookup table over the EML clip range."""
    clipped = jnp.clip(x, _APPROX_LUT_MIN, _APPROX_LUT_MAX)
    scale = (_APPROX_LUT_SIZE - 1) / (_APPROX_LUT_MAX - _APPROX_LUT_MIN)
    position = (clipped - _APPROX_LUT_MIN) * scale
    lower_index = jnp.floor(position).astype(jnp.int32)
    upper_index = jnp.minimum(lower_index + 1, _APPROX_LUT_SIZE - 1)
    fraction = position - lower_index.astype(jnp.float32)
    lower = values[lower_index]
    upper = values[upper_index]
    return lower + fraction * (upper - lower)


def _approx_exp_repeated_square(x: Array) -> Array:
    """Approximate clipped ``exp(x)`` with repeated squaring."""
    base = 1.0 + jnp.clip(x, _APPROX_LUT_MIN, _APPROX_LUT_MAX) / 16.0
    squared = base * base
    fourth = squared * squared
    eighth = fourth * fourth
    sixteenth = eighth * eighth
    return jnp.maximum(sixteenth, 0.0)


def _approx_log_positive_polynomial(value: Array) -> Array:
    """Approximate ``log(value)`` with an atanh-series polynomial."""
    safe = jnp.clip(value, 1.0 / 16.0, 16.0)
    u = (safe - 1.0) / (safe + 1.0)
    u2 = u * u
    return 2.0 * u * (
        1.0
        + u2 / 3.0
        + (u2 * u2) / 5.0
        + (u2 * u2 * u2) / 7.0
        + (u2 * u2 * u2 * u2) / 9.0
    )


def _approx_tanh_rational(x: Array) -> Array:
    """Approximate ``tanh(x)`` with a bounded rational polynomial."""
    clipped = jnp.clip(x, -3.0, 3.0)
    squared = clipped * clipped
    approx = clipped * (27.0 + squared) / (27.0 + 9.0 * squared)
    return jnp.clip(approx, -1.0, 1.0)


def approximate_stable_eml_operator(
    x: Array,
    y: Array,
    *,
    approximation: ApproximationKind = "lut",
    output_clip: float = 30.0,
) -> Array:
    """Approximate stable EML for hardened inference.

    ``"lut"`` linearly interpolates fixed tables for ``exp(x)`` and
    ``log(softplus(y) + eps)``. ``"poly"`` avoids tables and expensive
    transcendental functions with a repeated-squaring exponential and a smooth
    positive surrogate for the right input.
    """
    if approximation == "lut":
        exp_term = _linear_lookup(_APPROX_EXP_LUT, x)
        log_term = _linear_lookup(_APPROX_LOG_SOFTPLUS_LUT, y)
    elif approximation == "poly":
        exp_term = _approx_exp_repeated_square(x)
        positive = 0.5 * (y + jnp.sqrt(y * y + 4.0)) + 1e-6
        log_term = _approx_log_positive_polynomial(positive)
    else:
        raise ValueError(f"unknown approximation: {approximation}")
    return jnp.clip(exp_term - log_term, -output_clip, output_clip)


def _gather_compiled_sources(
    inputs: Array,
    previous: Array | None,
    indices: Array,
    input_dim: int,
) -> Array:
    """Gather fixed sparse-circuit sources without materializing the full bank."""
    batch_size = inputs.shape[0]
    selector = indices[None, :]
    input_indices = jnp.clip(indices, 0, input_dim - 1)
    input_values = jnp.take(inputs, input_indices, axis=1)
    constant_values = jnp.ones((batch_size, indices.shape[0]), dtype=inputs.dtype)

    if previous is None:
        return jnp.where(selector < input_dim, input_values, constant_values)

    previous_indices = jnp.clip(
        indices - (input_dim + 1),
        0,
        previous.shape[-1] - 1,
    )
    previous_values = jnp.take(previous, previous_indices, axis=1)
    return jnp.where(
        selector < input_dim,
        input_values,
        jnp.where(selector == input_dim, constant_values, previous_values),
    )


def sparse_continuous_eml_circuit_features(
    params: SparseContinuousEMLCircuitParams,
    inputs: Array,
    *,
    temperature: float | Array = 1.0,
    hard: bool = False,
    straight_through: bool = False,
    use_normalization: bool = True,
    eml_scale: float = 0.25,
    eml_eps: float = 1e-6,
    input_clip: float = 8.0,
    output_clip: float = 30.0,
) -> Array:
    """Return final sparse circuit features before the linear readout."""
    squeeze = inputs.ndim == 1
    x = inputs[None, :] if squeeze else inputs
    temperature_array = jnp.asarray(temperature, dtype=jnp.float32)
    previous: Array | None = None

    for layer in params.layers:
        bank = _sparse_source_bank(x, previous)
        left_source = _select_sources(
            bank,
            layer.left_logits,
            temperature_array,
            hard=hard,
            straight_through=straight_through,
        )
        right_source = _select_sources(
            bank,
            layer.right_logits,
            temperature_array,
            hard=hard,
            straight_through=straight_through,
        )
        left = left_source * layer.left_scale + layer.left_bias
        right = right_source * layer.right_scale + layer.right_bias
        previous = jnp.tanh(
            eml_scale
            * stable_eml_operator(
                left,
                right,
                eps=eml_eps,
                input_clip=input_clip,
                output_clip=output_clip,
            )
        )
        if use_normalization:
            previous = _normalize_features(previous)

    if previous is None:
        raise RuntimeError("sparse continuous EML circuit requires at least one layer")
    return previous[0] if squeeze else previous


def sparse_continuous_eml_circuit_forward(
    params: SparseContinuousEMLCircuitParams,
    inputs: Array,
    *,
    temperature: float | Array = 1.0,
    hard: bool = False,
    straight_through: bool = False,
    use_normalization: bool = True,
    **feature_kwargs: object,
) -> Array:
    """Run a sparse continuous EML circuit."""
    squeeze = inputs.ndim == 1
    features = sparse_continuous_eml_circuit_features(
        params,
        inputs,
        temperature=temperature,
        hard=hard,
        straight_through=straight_through,
        use_normalization=use_normalization,
        **feature_kwargs,
    )
    batched = features[None, :] if squeeze else features
    outputs = batched @ params.readout_kernel + params.readout_bias
    return outputs[0] if squeeze else outputs


def sparse_source_entropy(
    params: SparseContinuousEMLCircuitParams,
    *,
    temperature: float | Array = 1.0,
) -> Array:
    """Mean source-selector entropy across all sparse circuit nodes."""
    temperature_array = jnp.asarray(temperature, dtype=jnp.float32)
    entropies = []
    for layer in params.layers:
        for logits in (layer.left_logits, layer.right_logits):
            probs = jax.nn.softmax(logits / temperature_array, axis=-1)
            entropies.append(-jnp.sum(probs * jnp.log(probs + 1e-8), axis=-1))
    return jnp.mean(jnp.concatenate(entropies))


def sparse_continuous_eml_circuit_loss(
    params: SparseContinuousEMLCircuitParams,
    inputs: Array,
    targets: Array,
    *,
    loss: LossKind = "mse",
    temperature: float | Array = 1.0,
    entropy_weight: float = 0.0,
    hard_loss_weight: float = 0.0,
    l2_penalty: float = 0.0,
    **forward_kwargs: object,
) -> Array:
    """Compute sparse-circuit supervised loss with optional entropy pressure."""
    predictions = sparse_continuous_eml_circuit_forward(
        params,
        inputs,
        temperature=temperature,
        hard=False,
        **forward_kwargs,
    )
    if loss == "mse":
        data_loss = jnp.mean((predictions - targets) ** 2)
    elif loss == "softmax_cross_entropy":
        labels = targets if targets.ndim == 1 else jnp.argmax(targets, axis=-1)
        log_probs = jax.nn.log_softmax(predictions, axis=-1)
        data_loss = -jnp.mean(jnp.take_along_axis(log_probs, labels[:, None], axis=-1))
    else:
        raise ValueError(f"unknown loss kind: {loss}")

    if hard_loss_weight > 0.0:
        hard_predictions = sparse_continuous_eml_circuit_forward(
            params,
            inputs,
            temperature=temperature,
            hard=True,
            straight_through=True,
            **forward_kwargs,
        )
        if loss == "mse":
            hard_data_loss = jnp.mean((hard_predictions - targets) ** 2)
        else:
            labels = targets if targets.ndim == 1 else jnp.argmax(targets, axis=-1)
            hard_log_probs = jax.nn.log_softmax(hard_predictions, axis=-1)
            hard_data_loss = -jnp.mean(
                jnp.take_along_axis(hard_log_probs, labels[:, None], axis=-1)
            )
        mix = jnp.clip(jnp.asarray(hard_loss_weight, dtype=jnp.float32), 0.0, 1.0)
        data_loss = (1.0 - mix) * data_loss + mix * hard_data_loss

    penalty = jnp.array(0.0, dtype=jnp.float32)
    if entropy_weight > 0.0:
        penalty = penalty + entropy_weight * sparse_source_entropy(
            params,
            temperature=temperature,
        )
    if l2_penalty > 0.0:
        leaves = jax.tree_util.tree_leaves(params)
        penalty = penalty + l2_penalty * sum(jnp.sum(leaf**2) for leaf in leaves)
    return data_loss + penalty


def sparse_continuous_eml_circuit_train_step(
    state: SparseContinuousEMLCircuitState,
    inputs: Array,
    targets: Array,
    *,
    learning_rate: float = 1e-3,
    beta1: float = 0.9,
    beta2: float = 0.999,
    adam_eps: float = 1e-8,
    max_grad_norm: float | None = 10.0,
    loss: LossKind = "mse",
    temperature: float | Array = 1.0,
    entropy_weight: float = 0.0,
    hard_loss_weight: float = 0.0,
    l2_penalty: float = 0.0,
    **forward_kwargs: object,
) -> SparseContinuousEMLCircuitUpdateResult:
    """Apply one Adam step to a sparse continuous EML circuit."""

    def loss_fn(params: SparseContinuousEMLCircuitParams) -> Array:
        return sparse_continuous_eml_circuit_loss(
            params,
            inputs,
            targets,
            loss=loss,
            temperature=temperature,
            entropy_weight=entropy_weight,
            hard_loss_weight=hard_loss_weight,
            l2_penalty=l2_penalty,
            **forward_kwargs,
        )

    value, grads = jax.value_and_grad(loss_fn)(state.params)
    grad_norm = _tree_global_norm(grads)
    if max_grad_norm is not None:
        scale = jnp.minimum(1.0, max_grad_norm / (grad_norm + 1e-8))
        grads = jax.tree_util.tree_map(lambda grad: scale * grad, grads)

    opt = state.optimizer_state
    step = opt.step + jnp.array(1, dtype=jnp.int32)
    m = jax.tree_util.tree_map(
        lambda old, grad: beta1 * old + (1.0 - beta1) * grad,
        opt.m,
        grads,
    )
    v = jax.tree_util.tree_map(
        lambda old, grad: beta2 * old + (1.0 - beta2) * grad**2,
        opt.v,
        grads,
    )
    step_f = step.astype(jnp.float32)
    m_hat = jax.tree_util.tree_map(lambda value_: value_ / (1.0 - beta1**step_f), m)
    v_hat = jax.tree_util.tree_map(lambda value_: value_ / (1.0 - beta2**step_f), v)
    params = jax.tree_util.tree_map(
        lambda param, mean, variance: param
        - learning_rate * mean / (jnp.sqrt(variance) + adam_eps),
        state.params,
        m_hat,
        v_hat,
    )
    new_state = SparseContinuousEMLCircuitState(
        params=params,
        optimizer_state=SparseContinuousEMLCircuitAdamState(m=m, v=v, step=step),
        step_count=state.step_count + jnp.array(1, dtype=jnp.int32),
    )
    predictions = sparse_continuous_eml_circuit_forward(
        params,
        inputs,
        temperature=temperature,
        hard=False,
        **forward_kwargs,
    )
    return SparseContinuousEMLCircuitUpdateResult(
        state=new_state,
        predictions=predictions,
        loss=value,
        grad_norm=grad_norm,
    )


def train_sparse_continuous_eml_circuit(
    state: SparseContinuousEMLCircuitState,
    inputs: Array,
    targets: Array,
    *,
    steps: int,
    learning_rate: float = 1e-3,
    loss: LossKind = "mse",
    initial_temperature: float = 1.0,
    final_temperature: float = 0.25,
    **train_kwargs: object,
) -> tuple[SparseContinuousEMLCircuitState, Array]:
    """Train a sparse circuit while annealing selector temperature."""

    def step_fn(
        carry: SparseContinuousEMLCircuitState,
        idx: Array,
    ) -> tuple[SparseContinuousEMLCircuitState, Array]:
        fraction = idx.astype(jnp.float32) / jnp.maximum(1.0, jnp.asarray(steps - 1, jnp.float32))
        temperature = initial_temperature * (final_temperature / initial_temperature) ** fraction
        result = sparse_continuous_eml_circuit_train_step(
            carry,
            inputs,
            targets,
            learning_rate=learning_rate,
            loss=loss,
            temperature=temperature,
            **train_kwargs,
        )
        entropy = sparse_source_entropy(result.state.params, temperature=temperature)
        return result.state, jnp.stack([result.loss, result.grad_norm, temperature, entropy])

    return jax.lax.scan(step_fn, state, jnp.arange(steps))


def compile_sparse_continuous_eml_circuit(
    params: SparseContinuousEMLCircuitParams,
    *,
    input_dim: int,
) -> CompiledSparseContinuousEMLCircuit:
    """Compile soft source selectors to fixed source-index EML layers."""
    layers = tuple(
        CompiledSparseContinuousEMLLayer(
            left_indices=jnp.argmax(layer.left_logits, axis=-1).astype(jnp.int32),
            right_indices=jnp.argmax(layer.right_logits, axis=-1).astype(jnp.int32),
            left_scale=layer.left_scale,
            left_bias=layer.left_bias,
            right_scale=layer.right_scale,
            right_bias=layer.right_bias,
        )
        for layer in params.layers
    )
    return CompiledSparseContinuousEMLCircuit(
        input_dim=input_dim,
        layers=layers,
        readout_kernel=params.readout_kernel,
        readout_bias=params.readout_bias,
    )


def compiled_sparse_continuous_eml_circuit_forward(
    circuit: CompiledSparseContinuousEMLCircuit,
    inputs: Array,
    *,
    use_normalization: bool = True,
    eml_scale: float = 0.25,
    eml_eps: float = 1e-6,
    input_clip: float = 8.0,
    output_clip: float = 30.0,
) -> Array:
    """Run a compiled fixed-source sparse EML circuit."""
    squeeze = inputs.ndim == 1
    x = inputs[None, :] if squeeze else inputs
    previous: Array | None = None
    for layer in circuit.layers:
        left_source = _gather_compiled_sources(
            x,
            previous,
            layer.left_indices,
            circuit.input_dim,
        )
        right_source = _gather_compiled_sources(
            x,
            previous,
            layer.right_indices,
            circuit.input_dim,
        )
        left = left_source * layer.left_scale + layer.left_bias
        right = right_source * layer.right_scale + layer.right_bias
        previous = jnp.tanh(
            eml_scale
            * stable_eml_operator(
                left,
                right,
                eps=eml_eps,
                input_clip=input_clip,
                output_clip=output_clip,
            )
        )
        if use_normalization:
            previous = _normalize_features(previous)
    if previous is None:
        raise RuntimeError("compiled sparse EML circuit requires at least one layer")
    outputs = previous @ circuit.readout_kernel + circuit.readout_bias
    return outputs[0] if squeeze else outputs


def compiled_sparse_continuous_eml_circuit_forward_approx(
    circuit: CompiledSparseContinuousEMLCircuit,
    inputs: Array,
    *,
    approximation: ApproximationKind = "lut",
    approximate_tanh: bool = False,
    use_normalization: bool = True,
    eml_scale: float = 0.25,
    output_clip: float = 30.0,
) -> Array:
    """Run compiled sparse EML with an inference-only approximate EML kernel."""
    squeeze = inputs.ndim == 1
    x = inputs[None, :] if squeeze else inputs
    previous: Array | None = None
    for layer in circuit.layers:
        left_source = _gather_compiled_sources(
            x,
            previous,
            layer.left_indices,
            circuit.input_dim,
        )
        right_source = _gather_compiled_sources(
            x,
            previous,
            layer.right_indices,
            circuit.input_dim,
        )
        left = left_source * layer.left_scale + layer.left_bias
        right = right_source * layer.right_scale + layer.right_bias
        node = eml_scale * approximate_stable_eml_operator(
            left,
            right,
            approximation=approximation,
            output_clip=output_clip,
        )
        previous = _approx_tanh_rational(node) if approximate_tanh else jnp.tanh(node)
        if use_normalization:
            previous = _normalize_features(previous)
    if previous is None:
        raise RuntimeError("compiled sparse EML circuit requires at least one layer")
    outputs = previous @ circuit.readout_kernel + circuit.readout_bias
    return outputs[0] if squeeze else outputs


def sparse_continuous_eml_parameter_count(params: SparseContinuousEMLCircuitParams) -> int:
    """Return trainable scalar count for the soft sparse circuit."""
    return int(sum(leaf.size for leaf in jax.tree_util.tree_leaves(params)))


def compiled_sparse_continuous_eml_parameter_count(
    circuit: CompiledSparseContinuousEMLCircuit,
    *,
    count_indices: bool = True,
) -> int:
    """Return stored scalar count for the compiled fixed-source circuit."""
    leaves = []
    for layer in circuit.layers:
        if count_indices:
            leaves.extend([layer.left_indices, layer.right_indices])
        leaves.extend(
            [
                layer.left_scale,
                layer.left_bias,
                layer.right_scale,
                layer.right_bias,
            ]
        )
    leaves.extend([circuit.readout_kernel, circuit.readout_bias])
    return int(sum(leaf.size for leaf in leaves))


class ContinuousDiffEML:
    """Small convenience wrapper around the functional continuous DiffEML API."""

    def __init__(
        self,
        *,
        hidden_sizes: Sequence[int] = (32, 32),
        output_dim: int = 1,
        learning_rate: float = 1e-3,
        use_gating: bool = True,
        use_residual: bool = True,
        use_normalization: bool = True,
        max_grad_norm: float | None = 10.0,
    ) -> None:
        self.hidden_sizes = _as_tuple(hidden_sizes)
        self.output_dim = int(output_dim)
        self.learning_rate = float(learning_rate)
        self.use_gating = bool(use_gating)
        self.use_residual = bool(use_residual)
        self.use_normalization = bool(use_normalization)
        self.max_grad_norm = max_grad_norm

    def init(self, input_dim: int, key: Array) -> ContinuousDiffEMLState:
        """Initialize model state."""
        return init_continuous_diffeml_state(
            key,
            input_dim=input_dim,
            output_dim=self.output_dim,
            hidden_sizes=self.hidden_sizes,
        )

    def predict(self, state: ContinuousDiffEMLState, inputs: Array) -> Array:
        """Predict outputs for one example or a batch."""
        return continuous_diffeml_forward(
            state.params,
            inputs,
            use_gating=self.use_gating,
            use_residual=self.use_residual,
            use_normalization=self.use_normalization,
        )

    def loss(self, state: ContinuousDiffEMLState, inputs: Array, targets: Array) -> Array:
        """Compute mean squared error for the wrapper defaults."""
        return continuous_diffeml_loss(
            state.params,
            inputs,
            targets,
            use_gating=self.use_gating,
            use_residual=self.use_residual,
            use_normalization=self.use_normalization,
        )

    def update(
        self,
        state: ContinuousDiffEMLState,
        inputs: Array,
        targets: Array,
        *,
        loss: LossKind = "mse",
    ) -> ContinuousDiffEMLUpdateResult:
        """Run one Adam update with the wrapper defaults."""
        return continuous_diffeml_train_step(
            state,
            inputs,
            targets,
            learning_rate=self.learning_rate,
            max_grad_norm=self.max_grad_norm,
            loss=loss,
            use_gating=self.use_gating,
            use_residual=self.use_residual,
            use_normalization=self.use_normalization,
        )


__all__ = [
    "ContinuousDiffEML",
    "ContinuousDiffEMLAdamState",
    "ContinuousDiffEMLLayerParams",
    "ContinuousDiffEMLParams",
    "ContinuousDiffEMLState",
    "ContinuousDiffEMLUpdateResult",
    "CompiledSparseContinuousEMLCircuit",
    "CompiledSparseContinuousEMLLayer",
    "SparseContinuousEMLCircuitAdamState",
    "SparseContinuousEMLCircuitParams",
    "SparseContinuousEMLCircuitState",
    "SparseContinuousEMLCircuitUpdateResult",
    "SparseContinuousEMLLayerParams",
    "approximate_stable_eml_operator",
    "compile_sparse_continuous_eml_circuit",
    "compiled_sparse_continuous_eml_circuit_forward",
    "compiled_sparse_continuous_eml_circuit_forward_approx",
    "compiled_sparse_continuous_eml_parameter_count",
    "continuous_diffeml_forward",
    "continuous_diffeml_loss",
    "continuous_diffeml_train_step",
    "init_continuous_diffeml_params",
    "init_continuous_diffeml_state",
    "init_sparse_continuous_eml_circuit_params",
    "init_sparse_continuous_eml_circuit_state",
    "sparse_continuous_eml_circuit_features",
    "sparse_continuous_eml_circuit_forward",
    "sparse_continuous_eml_circuit_loss",
    "sparse_continuous_eml_circuit_train_step",
    "sparse_continuous_eml_parameter_count",
    "sparse_source_entropy",
    "train_continuous_diffeml",
    "train_sparse_continuous_eml_circuit",
]
