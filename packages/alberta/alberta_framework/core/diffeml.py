# mypy: disable-error-code="call-arg"
"""Differentiable EML circuits.

This module explores an EML analogue of differentiable logic networks:
binary EML nodes are kept differentiable during training by learning soft
source selections, while hard argmax routing can be inspected or used for a
discrete circuit after training.
"""

import functools
import time
from dataclasses import dataclass
from typing import Any

import chex
import jax
import jax.numpy as jnp
from jax import Array
from jaxtyping import Float, Int

from alberta_framework.core.types import Observation, Target
from alberta_framework.streams.base import ScanStream

BOOLEAN_INPUTS = jnp.array(
    [[0.0, 0.0], [0.0, 1.0], [1.0, 0.0], [1.0, 1.0]],
    dtype=jnp.float32,
)
"""Two-input Boolean truth-table rows in mask order ``00, 01, 10, 11``."""

BOOLEAN_GATE_NAMES: dict[int, str] = {
    0: "FALSE",
    1: "NOR",
    2: "not_a_and_b",
    3: "NOT_A",
    4: "a_and_not_b",
    5: "NOT_B",
    6: "XOR",
    7: "NAND",
    8: "AND",
    9: "XNOR",
    10: "B",
    11: "a_implies_b",
    12: "A",
    13: "b_implies_a",
    14: "OR",
    15: "TRUE",
}
"""Canonical names for the 16 two-input Boolean functions."""


def eml_operator(x: Array, y: Array) -> Array:
    """Compute the exact real EML operator ``exp(x) - log(y)``.

    This exact form is differentiable for real ``y > 0``. Use
    :func:`stable_eml_operator` for trainable real-valued circuits whose
    right input may cross zero during optimization.

    Args:
        x: Left EML input.
        y: Positive right EML input.

    Returns:
        ``exp(x) - log(y)``.
    """
    return jnp.exp(x) - jnp.log(y)


def stable_eml_operator(
    x: Array,
    y: Array,
    *,
    eps: float = 1e-6,
    input_clip: float = 8.0,
    output_clip: float = 30.0,
) -> Array:
    """Compute a numerically stable real-valued EML relaxation.

    The right input is passed through ``softplus`` so the logarithm remains
    in-domain under gradient descent. Inputs and outputs are clipped to avoid
    overflow in deep composed trees.

    Args:
        x: Left EML input.
        y: Unconstrained right EML input.
        eps: Positive floor for the right input after ``softplus``.
        input_clip: Symmetric clip applied before exponentiation.
        output_clip: Symmetric clip applied to the EML node output.

    Returns:
        Stable real-valued EML output.
    """
    x_safe = jnp.clip(x, -input_clip, input_clip)
    y_safe = jax.nn.softplus(y) + eps
    out = eml_operator(x_safe, y_safe)
    return jnp.clip(out, -output_clip, output_clip)


def boolean_truth_table(mask: int) -> Float[Array, " 4"]:
    """Return a two-input Boolean truth table from its four-bit mask.

    The row convention is ``00, 01, 10, 11``. Bit ``i`` of ``mask`` gives the
    output on row ``i``.

    Args:
        mask: Integer in ``[0, 15]``.

    Returns:
        Four Boolean outputs as ``float32`` values.

    Raises:
        ValueError: If ``mask`` is outside the two-input Boolean range.
    """
    if mask < 0 or mask > 15:
        raise ValueError("mask must be in [0, 15]")
    return jnp.array([(mask >> i) & 1 for i in range(4)], dtype=jnp.float32)


def mask_from_truth_table(values: Array) -> int:
    """Convert a four-row Boolean truth table to its integer mask."""
    if values.shape != (4,):
        raise ValueError("values must have shape (4,)")
    bits = [int(value) for value in values.astype(jnp.int32).tolist()]
    return sum(bit << idx for idx, bit in enumerate(bits))


@dataclass(frozen=True)
class DiffEMLGateLibrary:
    """Hard two-input gate library used by the differentiable selector.

    Attributes:
        outputs: Gate truth tables with shape ``(n_gates, 4)``.
        masks: Integer masks for each truth table.
        names: Human-readable gate names.
        expressions: EML-threshold expressions that define each gate.
    """

    outputs: Float[Array, "n_gates 4"]
    masks: tuple[int, ...]
    names: tuple[str, ...]
    expressions: tuple[str, ...]

    def __post_init__(self) -> None:
        """Validate static library metadata."""
        if self.outputs.ndim != 2 or self.outputs.shape[1] != 4:
            raise ValueError("outputs must have shape (n_gates, 4)")
        n_gates = int(self.outputs.shape[0])
        if len(self.masks) != n_gates:
            raise ValueError("masks length must match outputs")
        if len(self.names) != n_gates:
            raise ValueError("names length must match outputs")
        if len(self.expressions) != n_gates:
            raise ValueError("expressions length must match outputs")
        if len(set(self.masks)) != len(self.masks):
            raise ValueError("masks must be unique")

    @property
    def size(self) -> int:
        """Number of hard gates in the library."""
        return int(self.outputs.shape[0])


@dataclass(frozen=True)
class EMLTemplateExpr:
    """Executable EML-threshold expression over two Boolean inputs.

    Leaves are ``"0"``, ``"1"``, ``"A"``, or ``"B"``. Internal expressions
    compute ``bit(eml(left, right) >= threshold)`` when ``direction=1`` and
    ``bit(eml(left, right) <= threshold)`` when ``direction=-1``.
    """

    leaf: str | None = None
    left: "EMLTemplateExpr | None" = None
    right: "EMLTemplateExpr | None" = None
    threshold: float = 0.0
    direction: int = 1


@dataclass(frozen=True)
class EMLTemplateBank:
    """Executable EML gate templates sorted by Boolean mask.

    Unlike :class:`DiffEMLGateLibrary`, this keeps expression trees instead of
    only their four-row truth tables, so downstream relaxations can execute
    nested EML-threshold programs directly.
    """

    masks: tuple[int, ...]
    names: tuple[str, ...]
    expressions: tuple[str, ...]
    exprs: tuple[EMLTemplateExpr, ...]

    def __post_init__(self) -> None:
        """Validate static template metadata."""
        n_templates = len(self.exprs)
        if len(self.masks) != n_templates:
            raise ValueError("masks length must match exprs")
        if len(self.names) != n_templates:
            raise ValueError("names length must match exprs")
        if len(self.expressions) != n_templates:
            raise ValueError("expressions length must match exprs")
        if len(set(self.masks)) != n_templates:
            raise ValueError("masks must be unique")

    @property
    def size(self) -> int:
        """Number of executable templates in the bank."""
        return len(self.exprs)


def known_boolean_gate_library() -> DiffEMLGateLibrary:
    """Return the exact 16 two-input Boolean gates as a selector library."""
    masks = tuple(range(16))
    outputs = jnp.stack([boolean_truth_table(mask) for mask in masks], axis=0)
    names = tuple(BOOLEAN_GATE_NAMES[mask] for mask in masks)
    return DiffEMLGateLibrary(
        outputs=outputs,
        masks=masks,
        names=names,
        expressions=names,
    )


def _threshold_masks(values: Array) -> list[tuple[int, str]]:
    """Enumerate Boolean masks from thresholding one scalar EML signal."""
    unique_values = sorted({round(float(value), 8) for value in values.tolist()})
    candidates = {0: "always_0", 15: "always_1"}
    for threshold in unique_values:
        ge_mask = mask_from_truth_table(values >= threshold)
        le_mask = mask_from_truth_table(values <= threshold)
        candidates.setdefault(ge_mask, f">= {threshold:.6g}")
        candidates.setdefault(le_mask, f"<= {threshold:.6g}")
    return sorted(candidates.items())


def eml_threshold_gate_library(depth: int = 2, eps: float = 0.05) -> DiffEMLGateLibrary:
    """Enumerate hard EML-threshold gates up to a small expression depth.

    The library is built by composing hard Boolean signals with exact EML values
    ``exp(left) - log(eps + right)`` and then thresholding those scalar truth
    tables. With ``depth=2`` and the default ``eps``, this enumerates all 16
    two-input Boolean gates using only EML-derived threshold templates.

    Args:
        depth: Number of EML-threshold expansion rounds.
        eps: Positive offset that keeps Boolean right inputs inside ``log``.

    Returns:
        Hard EML-derived gate library.

    Raises:
        ValueError: If ``depth`` or ``eps`` is invalid.
    """
    if depth < 1:
        raise ValueError("depth must be >= 1")
    if eps <= 0.0:
        raise ValueError("eps must be positive")

    expressions: dict[int, str] = {0: "0", 10: "B", 12: "A", 15: "1"}
    frontier = dict(expressions)

    for _ in range(depth):
        new_frontier: dict[int, str] = {}
        for left_mask, left_expr in frontier.items():
            left = boolean_truth_table(left_mask)
            for right_mask, right_expr in frontier.items():
                right = boolean_truth_table(right_mask)
                eml_values = jnp.exp(left) - jnp.log(eps + right)
                for mask, threshold_expr in _threshold_masks(eml_values):
                    expr = f"bit(eml({left_expr}, {right_expr}) {threshold_expr})"
                    expressions.setdefault(mask, expr)
                    new_frontier.setdefault(mask, expr)
        frontier = new_frontier
        if len(expressions) == 16:
            break

    masks = tuple(sorted(expressions))
    outputs = jnp.stack([boolean_truth_table(mask) for mask in masks], axis=0)
    names = tuple(BOOLEAN_GATE_NAMES.get(mask, f"mask_{mask}") for mask in masks)
    rendered = tuple(expressions[mask] for mask in masks)
    return DiffEMLGateLibrary(
        outputs=outputs,
        masks=masks,
        names=names,
        expressions=rendered,
    )


def render_eml_template_expr(expr: EMLTemplateExpr) -> str:
    """Render an executable template as an EML expression."""
    if expr.leaf is not None:
        return expr.leaf
    if expr.left is None or expr.right is None:
        raise ValueError("internal expression must have left and right children")
    op = ">=" if expr.direction > 0 else "<="
    return (
        f"bit(eml({render_eml_template_expr(expr.left)}, "
        f"{render_eml_template_expr(expr.right)}) {op} {expr.threshold:.6g})"
    )


def build_eml_template_bank(depth: int = 2, eps: float = 0.05) -> EMLTemplateBank:
    """Enumerate executable depth-limited EML threshold templates.

    This mirrors :func:`eml_threshold_gate_library` but keeps expression trees
    executable. With ``depth=2`` and the default ``eps``, the returned bank
    covers all 16 two-input Boolean gates.

    Args:
        depth: Number of EML-threshold expansion rounds.
        eps: Positive offset that keeps Boolean right inputs inside ``log``.

    Returns:
        Executable EML-derived gate templates.

    Raises:
        ValueError: If ``depth`` or ``eps`` is invalid.
        RuntimeError: If the executable enumeration diverges from the
            truth-table library.
    """
    if depth < 1:
        raise ValueError("depth must be >= 1")
    if eps <= 0.0:
        raise ValueError("eps must be positive")

    expressions: dict[int, EMLTemplateExpr] = {
        0: EMLTemplateExpr(leaf="0"),
        10: EMLTemplateExpr(leaf="B"),
        12: EMLTemplateExpr(leaf="A"),
        15: EMLTemplateExpr(leaf="1"),
    }
    frontier = dict(expressions)

    for _ in range(depth):
        new_frontier: dict[int, EMLTemplateExpr] = {}
        for left_mask, left_expr in frontier.items():
            left_values = boolean_truth_table(left_mask)
            for right_mask, right_expr in frontier.items():
                right_values = boolean_truth_table(right_mask)
                eml_values = jnp.exp(left_values) - jnp.log(eps + right_values)
                thresholds = sorted(
                    {round(float(value), 8) for value in eml_values.tolist()}
                )
                for threshold in thresholds:
                    for direction in (1, -1):
                        if direction > 0:
                            mask = mask_from_truth_table(eml_values >= threshold)
                        else:
                            mask = mask_from_truth_table(eml_values <= threshold)
                        expr = EMLTemplateExpr(
                            left=left_expr,
                            right=right_expr,
                            threshold=float(threshold),
                            direction=direction,
                        )
                        expressions.setdefault(mask, expr)
                        new_frontier.setdefault(mask, expr)
        frontier = new_frontier
        if len(expressions) == 16:
            break

    library = eml_threshold_gate_library(depth=depth, eps=eps)
    masks = tuple(sorted(expressions))
    if masks != library.masks:
        raise RuntimeError("executable EML template bank does not match gate library")
    exprs = tuple(expressions[mask] for mask in masks)
    return EMLTemplateBank(
        masks=masks,
        names=library.names,
        expressions=tuple(render_eml_template_expr(expr) for expr in exprs),
        exprs=exprs,
    )


def evaluate_eml_template(
    expr: EMLTemplateExpr,
    left_input: Array,
    right_input: Array,
    *,
    eps: float = 0.05,
    threshold_temperature: Array | float = 0.75,
    hard: bool = False,
) -> Array:
    """Evaluate one executable EML template on scalar or batched sources.

    Soft evaluation replaces each hard bit threshold with a sigmoid. Hard
    evaluation returns the exact Boolean EML-threshold program.
    """
    if expr.leaf == "0":
        return jnp.zeros_like(left_input)
    if expr.leaf == "1":
        return jnp.ones_like(left_input)
    if expr.leaf == "A":
        return left_input
    if expr.leaf == "B":
        return right_input
    if expr.left is None or expr.right is None:
        raise ValueError("internal expression must have left and right children")

    left = evaluate_eml_template(
        expr.left,
        left_input,
        right_input,
        eps=eps,
        threshold_temperature=threshold_temperature,
        hard=hard,
    )
    right = evaluate_eml_template(
        expr.right,
        left_input,
        right_input,
        eps=eps,
        threshold_temperature=threshold_temperature,
        hard=hard,
    )
    eml_value = jnp.exp(jnp.clip(left, -8.0, 8.0)) - jnp.log(
        eps + jnp.clip(right, 0.0, 1.0)
    )
    signed_margin = expr.direction * (eml_value - expr.threshold)
    if hard:
        return (signed_margin >= 0.0).astype(jnp.float32)
    temperature = jnp.asarray(threshold_temperature, dtype=jnp.float32)
    return jax.nn.sigmoid(signed_margin / temperature)


def evaluate_eml_template_bank(
    template_bank: EMLTemplateBank,
    left_input: Array,
    right_input: Array,
    *,
    eps: float = 0.05,
    threshold_temperature: Array | float = 0.75,
    hard: bool = False,
) -> Array:
    """Evaluate all executable EML templates for each source pair.

    Returns values with one trailing gate/template axis.
    """
    values = [
        evaluate_eml_template(
            expr,
            left_input,
            right_input,
            eps=eps,
            threshold_temperature=threshold_temperature,
            hard=hard,
        )
        for expr in template_bank.exprs
    ]
    return jnp.stack(values, axis=-1)


@chex.dataclass(frozen=True)
class DiffEMLGateSelectorParams:
    """Learnable selector weights over a hard EML gate library."""

    gate_logits: Float[Array, " n_gates"]


@chex.dataclass(frozen=True)
class DiffEMLGateSelectorState:
    """State for a differentiable selector over hard EML gates.

    Attributes:
        params: Trainable selector logits.
        adam_m: First Adam moment for the selector logits.
        adam_v: Second Adam moment for the selector logits.
        step_count: Number of selector updates.
        birth_timestamp: Wall-clock initialization time.
        uptime_s: Accumulated time spent in scan loops.
    """

    params: DiffEMLGateSelectorParams
    adam_m: Float[Array, " n_gates"]
    adam_v: Float[Array, " n_gates"]
    step_count: Int[Array, ""] = None  # type: ignore[assignment]
    birth_timestamp: float = 0.0
    uptime_s: float = 0.0


@chex.dataclass(frozen=True)
class DiffEMLGateSelectorUpdateResult:
    """Result from one DiffEML gate-selector update.

    Attributes:
        state: Updated selector state.
        soft_truth_table: Differentiable truth-table prediction before update.
        hard_truth_table: Argmax hard-gate prediction before update.
        metrics: ``[bce, hard_accuracy, soft_accuracy, grad_norm, entropy,
            selected_probability]``.
    """

    state: DiffEMLGateSelectorState
    soft_truth_table: Float[Array, " 4"]
    hard_truth_table: Float[Array, " 4"]
    metrics: Float[Array, " 6"]


@chex.dataclass(frozen=True)
class DiffEMLGateSelectorLearningResult:
    """Result from training a gate selector for a fixed truth table."""

    state: DiffEMLGateSelectorState
    metrics: Float[Array, "num_steps 6"]


class DiffEMLGateSelector:
    """Differentiable selector that hardens into an EML-derived logic gate.

    This is the DiffLogic-style relaxation path for EML: first enumerate a
    library of hard gates that are representable by EML threshold templates,
    then learn softmax logits over that library. During training, predictions
    are convex mixtures of hard truth tables. At evaluation time, ``argmax``
    selects one exact hard EML gate.
    """

    def __init__(
        self,
        library: DiffEMLGateLibrary | None = None,
        step_size: float = 0.1,
        initial_temperature: float = 1.0,
        min_temperature: float = 0.03,
        anneal_steps: int = 50,
        entropy_weight: float = 0.002,
        max_grad_norm: float = 10.0,
        init_scale: float = 0.2,
        adam_beta1: float = 0.9,
        adam_beta2: float = 0.999,
        adam_eps: float = 1e-8,
    ):
        """Initialize a DiffEML hard-gate selector.

        Args:
            library: Hard gate library. Defaults to depth-2 EML threshold
                templates, which cover all 16 two-input Boolean functions.
            step_size: Adam learning rate for selector logits.
            initial_temperature: Initial softmax temperature.
            min_temperature: Final softmax temperature used for hardening.
            anneal_steps: Number of updates over which temperature anneals.
            entropy_weight: Positive entropy penalty that encourages one-hot
                gate selection.
            max_grad_norm: Global gradient-norm clip for selector logits.
            init_scale: Standard deviation of initial selector logits.
            adam_beta1: Adam first-moment coefficient.
            adam_beta2: Adam second-moment coefficient.
            adam_eps: Adam denominator epsilon.

        Raises:
            ValueError: If a hyperparameter is outside its valid range.
        """
        if step_size <= 0.0:
            raise ValueError("step_size must be positive")
        if initial_temperature <= 0.0:
            raise ValueError("initial_temperature must be positive")
        if min_temperature <= 0.0:
            raise ValueError("min_temperature must be positive")
        if min_temperature > initial_temperature:
            raise ValueError("min_temperature must be <= initial_temperature")
        if anneal_steps < 1:
            raise ValueError("anneal_steps must be >= 1")
        if entropy_weight < 0.0:
            raise ValueError("entropy_weight must be >= 0")
        if max_grad_norm <= 0.0:
            raise ValueError("max_grad_norm must be positive")
        if init_scale <= 0.0:
            raise ValueError("init_scale must be positive")
        if not 0.0 <= adam_beta1 < 1.0:
            raise ValueError("adam_beta1 must be in [0, 1)")
        if not 0.0 <= adam_beta2 < 1.0:
            raise ValueError("adam_beta2 must be in [0, 1)")
        if adam_eps <= 0.0:
            raise ValueError("adam_eps must be positive")

        self._library = library if library is not None else eml_threshold_gate_library()
        self._step_size = step_size
        self._initial_temperature = initial_temperature
        self._min_temperature = min_temperature
        self._anneal_steps = anneal_steps
        self._entropy_weight = entropy_weight
        self._max_grad_norm = max_grad_norm
        self._init_scale = init_scale
        self._adam_beta1 = adam_beta1
        self._adam_beta2 = adam_beta2
        self._adam_eps = adam_eps

    @property
    def library(self) -> DiffEMLGateLibrary:
        """Hard EML gate library used by this selector."""
        return self._library

    def to_config(self) -> dict[str, Any]:
        """Serialize selector hyperparameters to a dict."""
        return {
            "type": "DiffEMLGateSelector",
            "step_size": self._step_size,
            "initial_temperature": self._initial_temperature,
            "min_temperature": self._min_temperature,
            "anneal_steps": self._anneal_steps,
            "entropy_weight": self._entropy_weight,
            "max_grad_norm": self._max_grad_norm,
            "init_scale": self._init_scale,
            "adam_beta1": self._adam_beta1,
            "adam_beta2": self._adam_beta2,
            "adam_eps": self._adam_eps,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> "DiffEMLGateSelector":
        """Reconstruct a selector from :meth:`to_config` output."""
        config = dict(config)
        config.pop("type", None)
        return cls(**config)

    def init(self, key: Array) -> DiffEMLGateSelectorState:
        """Initialize selector logits and Adam moments."""
        gate_logits = self._init_scale * jax.random.normal(
            key,
            (self._library.size,),
            dtype=jnp.float32,
        )
        zeros = jnp.zeros_like(gate_logits)
        return DiffEMLGateSelectorState(
            params=DiffEMLGateSelectorParams(gate_logits=gate_logits),
            adam_m=zeros,
            adam_v=zeros,
            step_count=jnp.array(0, dtype=jnp.int32),
            birth_timestamp=time.time(),
            uptime_s=0.0,
        )

    def _temperature_at(self, step_count: Array) -> Array:
        step = jnp.asarray(step_count, dtype=jnp.float32)
        fraction = jnp.minimum(1.0, step / jnp.array(self._anneal_steps, jnp.float32))
        ratio = self._min_temperature / self._initial_temperature
        return jnp.maximum(
            self._min_temperature,
            self._initial_temperature * ratio**fraction,
        )

    def _gate_probabilities(
        self,
        params: DiffEMLGateSelectorParams,
        temperature: Array,
    ) -> Array:
        return jax.nn.softmax(params.gate_logits / temperature, axis=0)

    def _soft_truth_table(
        self,
        params: DiffEMLGateSelectorParams,
        temperature: Array,
    ) -> Array:
        return self._gate_probabilities(params, temperature) @ self._library.outputs

    @staticmethod
    def _binary_cross_entropy(predictions: Array, targets: Array) -> Array:
        predictions = jnp.clip(predictions, 1e-6, 1.0 - 1e-6)
        return -jnp.mean(
            targets * jnp.log(predictions)
            + (1.0 - targets) * jnp.log(1.0 - predictions)
        )

    def _entropy(
        self,
        params: DiffEMLGateSelectorParams,
        temperature: Array,
    ) -> Array:
        probs = self._gate_probabilities(params, temperature)
        return -jnp.sum(probs * jnp.log(probs + 1e-8))

    def _loss(
        self,
        params: DiffEMLGateSelectorParams,
        target_truth_table: Array,
        temperature: Array,
    ) -> Array:
        predictions = self._soft_truth_table(params, temperature)
        bce = self._binary_cross_entropy(predictions, target_truth_table)
        return bce + self._entropy_weight * self._entropy(params, temperature)

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict_truth_table(
        self,
        state: DiffEMLGateSelectorState,
    ) -> Float[Array, " 4"]:
        """Predict a soft truth table at the state's current temperature."""
        temperature = self._temperature_at(state.step_count)
        return self._soft_truth_table(state.params, temperature)

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict_hard_truth_table(
        self,
        state: DiffEMLGateSelectorState,
    ) -> Float[Array, " 4"]:
        """Predict the truth table of the selected hard EML gate."""
        selected_idx = jnp.argmax(state.params.gate_logits)
        return self._library.outputs[selected_idx]

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict(
        self,
        state: DiffEMLGateSelectorState,
        observation: Observation,
    ) -> Float[Array, " 1"]:
        """Predict one Boolean output from a two-bit observation."""
        bits = observation.astype(jnp.int32)
        row_idx = bits[0] * 2 + bits[1]
        return jnp.atleast_1d(self.predict_truth_table(state)[row_idx])

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict_hard(
        self,
        state: DiffEMLGateSelectorState,
        observation: Observation,
    ) -> Float[Array, " 1"]:
        """Predict one Boolean output from the selected hard EML gate."""
        bits = observation.astype(jnp.int32)
        row_idx = bits[0] * 2 + bits[1]
        return jnp.atleast_1d(self.predict_hard_truth_table(state)[row_idx])

    @functools.partial(jax.jit, static_argnums=(0,))
    def update_truth_table(
        self,
        state: DiffEMLGateSelectorState,
        target_truth_table: Float[Array, " 4"],
    ) -> DiffEMLGateSelectorUpdateResult:
        """Perform one Adam update toward a Boolean truth table."""
        target = target_truth_table.astype(jnp.float32)
        temperature = self._temperature_at(state.step_count)
        _, grads = jax.value_and_grad(self._loss)(
            state.params,
            target,
            temperature,
        )

        grad_norm = jnp.sqrt(jnp.sum(grads.gate_logits**2) + 1e-12)
        grad_scale = jnp.minimum(1.0, self._max_grad_norm / (grad_norm + 1e-8))
        clipped_grad = grads.gate_logits * grad_scale

        new_step = state.step_count + 1
        adam_m = self._adam_beta1 * state.adam_m + (1.0 - self._adam_beta1) * clipped_grad
        adam_v = self._adam_beta2 * state.adam_v + (
            1.0 - self._adam_beta2
        ) * clipped_grad**2
        step_float = new_step.astype(jnp.float32)
        m_hat = adam_m / (1.0 - self._adam_beta1**step_float)
        v_hat = adam_v / (1.0 - self._adam_beta2**step_float)
        gate_logits = state.params.gate_logits - self._step_size * m_hat / (
            jnp.sqrt(v_hat) + self._adam_eps
        )
        new_params = DiffEMLGateSelectorParams(gate_logits=gate_logits)
        new_state = DiffEMLGateSelectorState(
            params=new_params,
            adam_m=adam_m,
            adam_v=adam_v,
            step_count=new_step,
            birth_timestamp=state.birth_timestamp,
            uptime_s=state.uptime_s,
        )

        soft_truth_table = self._soft_truth_table(state.params, temperature)
        bce = self._binary_cross_entropy(soft_truth_table, target)
        hard_truth_table = self.predict_hard_truth_table(state)
        soft_bits = (soft_truth_table >= 0.5).astype(jnp.float32)
        hard_accuracy = jnp.mean(hard_truth_table == target)
        soft_accuracy = jnp.mean(soft_bits == target)
        new_temperature = self._temperature_at(new_step)
        new_probs = self._gate_probabilities(new_params, new_temperature)
        selected_probability = jnp.max(new_probs)
        metrics = jnp.array(
            [
                bce,
                hard_accuracy,
                soft_accuracy,
                grad_norm,
                self._entropy(new_params, new_temperature),
                selected_probability,
            ],
            dtype=jnp.float32,
        )
        return DiffEMLGateSelectorUpdateResult(
            state=new_state,
            soft_truth_table=soft_truth_table,
            hard_truth_table=hard_truth_table,
            metrics=metrics,
        )

    def train_truth_table(
        self,
        state: DiffEMLGateSelectorState,
        target_truth_table: Float[Array, " 4"],
        num_steps: int,
    ) -> DiffEMLGateSelectorLearningResult:
        """Train the selector for ``num_steps`` against one truth table."""

        def step_fn(
            selector_state: DiffEMLGateSelectorState,
            _: Array,
        ) -> tuple[DiffEMLGateSelectorState, Array]:
            result = self.update_truth_table(selector_state, target_truth_table)
            return result.state, result.metrics

        t0 = time.time()
        final_state, metrics = jax.lax.scan(
            step_fn,
            state,
            jnp.arange(num_steps),
        )
        elapsed = time.time() - t0
        final_state = final_state.replace(uptime_s=final_state.uptime_s + elapsed)  # type: ignore[attr-defined]
        return DiffEMLGateSelectorLearningResult(state=final_state, metrics=metrics)

    def gate_probabilities(self, state: DiffEMLGateSelectorState) -> Array:
        """Return current relaxed probabilities over hard EML gates."""
        temperature = self._temperature_at(state.step_count)
        return self._gate_probabilities(state.params, temperature)

    def selected_gate_index(self, state: DiffEMLGateSelectorState) -> int:
        """Return the selected hard library index."""
        return int(jnp.argmax(state.params.gate_logits))

    def selected_gate_mask(self, state: DiffEMLGateSelectorState) -> int:
        """Return the Boolean mask selected by the hard selector."""
        return self._library.masks[self.selected_gate_index(state)]

    def selected_gate_name(self, state: DiffEMLGateSelectorState) -> str:
        """Return the name of the selected hard gate."""
        return self._library.names[self.selected_gate_index(state)]

    def selected_gate_expression(self, state: DiffEMLGateSelectorState) -> str:
        """Return the EML-threshold expression for the selected hard gate."""
        return self._library.expressions[self.selected_gate_index(state)]


@chex.dataclass(frozen=True)
class DiffEMLParams:
    """Parameters for a differentiable EML circuit.

    Attributes:
        left_logits: Per-layer routing logits for each node's left input.
        right_logits: Per-layer routing logits for each node's right input.
        readout_weights: Linear readout weights over the final source bank.
        readout_bias: Scalar linear readout bias.
    """

    left_logits: tuple[Array, ...]
    right_logits: tuple[Array, ...]
    readout_weights: Float[Array, " readout_dim"]
    readout_bias: Float[Array, ""]


@chex.dataclass(frozen=True)
class DiffEMLState:
    """State for a differentiable EML learner.

    Attributes:
        params: Trainable EML circuit parameters.
        step_count: Number of online update steps taken.
        birth_timestamp: Wall-clock initialization time.
        uptime_s: Accumulated time spent in scan loops.
    """

    params: DiffEMLParams
    step_count: Int[Array, ""] = None  # type: ignore[assignment]
    birth_timestamp: float = 0.0
    uptime_s: float = 0.0


@chex.dataclass(frozen=True)
class DiffEMLUpdateResult:
    """Result from one differentiable EML update.

    Attributes:
        state: Updated learner state.
        prediction: Prediction made before the update.
        error: Prediction error ``target - prediction``.
        metrics: ``[squared_error, error, grad_norm, route_entropy]``.
    """

    state: DiffEMLState
    prediction: Float[Array, " 1"]
    error: Float[Array, " 1"]
    metrics: Float[Array, " 4"]


@chex.dataclass(frozen=True)
class DiffEMLLearningResult:
    """Result from running a differentiable EML learner over arrays.

    Attributes:
        state: Final learner state.
        metrics: Metrics array with columns
            ``[squared_error, error, grad_norm, route_entropy]``.
    """

    state: DiffEMLState
    metrics: Float[Array, "num_steps 4"]


@chex.dataclass(frozen=True)
class EMLTreeParams:
    """Parameters for a fixed-topology differentiable EML tree.

    Attributes:
        leaf_logits: Soft categorical choices for each tree leaf over
            candidates ``[x_0, ..., x_d, 1, c_0, ...]``.
        constant_params: Raw learned constants, transformed by ``tanh`` before
            use to keep early symbolic-regression probes bounded.
        output_scale: Scalar affine readout scale applied to the root.
        output_bias: Scalar affine readout bias applied to the root.
    """

    leaf_logits: Float[Array, "n_leaves candidate_dim"]
    constant_params: Float[Array, " n_constants"]
    output_scale: Float[Array, ""]
    output_bias: Float[Array, ""]


@chex.dataclass(frozen=True)
class EMLTreeState:
    """State for a fixed-depth differentiable EML tree learner."""

    params: EMLTreeParams
    step_count: Int[Array, ""] = None  # type: ignore[assignment]
    birth_timestamp: float = 0.0
    uptime_s: float = 0.0


@chex.dataclass(frozen=True)
class EMLTreeUpdateResult:
    """Result from one EML tree update.

    Attributes:
        state: Updated learner state.
        prediction: Soft-routed prediction made before the update.
        hard_prediction: Argmax-leaf prediction made before the update.
        error: Soft prediction error ``target - prediction``.
        metrics: ``[soft_squared_error, hard_squared_error, error, grad_norm,
            leaf_entropy]``.
    """

    state: EMLTreeState
    prediction: Float[Array, " 1"]
    hard_prediction: Float[Array, " 1"]
    error: Float[Array, " 1"]
    metrics: Float[Array, " 5"]


@chex.dataclass(frozen=True)
class EMLTreeLearningResult:
    """Result from running a differentiable EML tree over a stream."""

    state: EMLTreeState
    metrics: Float[Array, "num_steps 5"]


class DiffEMLLearner:
    """Trainable differentiable EML circuit.

    The circuit is a stack of binary EML layers. Each EML node learns two
    soft source selections from a source bank, similar in spirit to how
    differentiable logic networks learn a relaxed circuit before hardening it.

    The stable real node is:
    ``exp(clip(left)) - log(softplus(right) + eps)``.

    This makes the learner differentiable and usable with real-valued JAX
    streams, while still preserving the core EML inductive bias: all hidden
    computation is done by repeated applications of one binary operation.
    """

    def __init__(
        self,
        depth: int = 2,
        width: int = 32,
        step_size: float = 1e-3,
        temperature: float = 1.0,
        max_grad_norm: float = 10.0,
        input_clip: float = 8.0,
        output_clip: float = 30.0,
        eps: float = 1e-6,
        include_input_skip: bool = True,
        routing_init_scale: float = 0.1,
        readout_init_scale: float = 0.1,
    ):
        """Initialize a differentiable EML learner.

        Args:
            depth: Number of EML layers.
            width: Number of EML nodes per layer.
            step_size: Online SGD learning rate.
            temperature: Softmax temperature for source routing.
            max_grad_norm: Global gradient-norm clip.
            input_clip: Clip before exponentiation inside EML nodes.
            output_clip: Clip on EML node outputs.
            eps: Positive floor for the stable logarithm input.
            include_input_skip: Whether every layer can route from the original
                observation and constant ``1`` in addition to the previous layer.
            routing_init_scale: Standard deviation for routing-logit init.
            readout_init_scale: Standard deviation for readout-weight init.

        Raises:
            ValueError: If any shape or scale parameter is invalid.
        """
        if depth < 1:
            raise ValueError("depth must be >= 1")
        if width < 1:
            raise ValueError("width must be >= 1")
        if step_size <= 0.0:
            raise ValueError("step_size must be positive")
        if temperature <= 0.0:
            raise ValueError("temperature must be positive")
        if max_grad_norm <= 0.0:
            raise ValueError("max_grad_norm must be positive")
        if input_clip <= 0.0:
            raise ValueError("input_clip must be positive")
        if output_clip <= 0.0:
            raise ValueError("output_clip must be positive")
        if eps <= 0.0:
            raise ValueError("eps must be positive")

        self._depth = depth
        self._width = width
        self._step_size = step_size
        self._temperature = temperature
        self._max_grad_norm = max_grad_norm
        self._input_clip = input_clip
        self._output_clip = output_clip
        self._eps = eps
        self._include_input_skip = include_input_skip
        self._routing_init_scale = routing_init_scale
        self._readout_init_scale = readout_init_scale

    def to_config(self) -> dict[str, Any]:
        """Serialize learner configuration to a dict."""
        return {
            "type": "DiffEMLLearner",
            "depth": self._depth,
            "width": self._width,
            "step_size": self._step_size,
            "temperature": self._temperature,
            "max_grad_norm": self._max_grad_norm,
            "input_clip": self._input_clip,
            "output_clip": self._output_clip,
            "eps": self._eps,
            "include_input_skip": self._include_input_skip,
            "routing_init_scale": self._routing_init_scale,
            "readout_init_scale": self._readout_init_scale,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> "DiffEMLLearner":
        """Reconstruct a learner from :meth:`to_config` output."""
        config = dict(config)
        config.pop("type", None)
        return cls(**config)

    def _source_dim(self, feature_dim: int, layer_idx: int) -> int:
        if layer_idx == 0:
            return feature_dim + 1
        if self._include_input_skip:
            return feature_dim + 1 + self._width
        return self._width + 1

    def _readout_dim(self, feature_dim: int) -> int:
        if self._include_input_skip:
            return feature_dim + 1 + self._width
        return self._width + 1

    def init(self, feature_dim: int, key: Array) -> DiffEMLState:
        """Initialize EML circuit parameters.

        Args:
            feature_dim: Dimension of the input feature vector.
            key: JAX random key.

        Returns:
            Initial differentiable EML state.
        """
        left_logits = []
        right_logits = []
        for i in range(self._depth):
            source_dim = self._source_dim(feature_dim, i)
            key, left_key, right_key = jax.random.split(key, 3)
            left_logits.append(
                self._routing_init_scale
                * jax.random.normal(left_key, (self._width, source_dim), dtype=jnp.float32)
            )
            right_logits.append(
                self._routing_init_scale
                * jax.random.normal(right_key, (self._width, source_dim), dtype=jnp.float32)
            )

        readout_dim = self._readout_dim(feature_dim)
        key, readout_key = jax.random.split(key)
        readout_weights = (
            self._readout_init_scale
            * jax.random.normal(readout_key, (readout_dim,), dtype=jnp.float32)
            / jnp.sqrt(jnp.array(readout_dim, dtype=jnp.float32))
        )

        params = DiffEMLParams(
            left_logits=tuple(left_logits),
            right_logits=tuple(right_logits),
            readout_weights=readout_weights,
            readout_bias=jnp.array(0.0, dtype=jnp.float32),
        )
        return DiffEMLState(
            params=params,
            step_count=jnp.array(0, dtype=jnp.int32),
            birth_timestamp=time.time(),
            uptime_s=0.0,
        )

    def _make_sources(
        self,
        observation: Array,
        previous: Array | None,
    ) -> Array:
        one = jnp.ones((1,), dtype=observation.dtype)
        if previous is None:
            return jnp.concatenate((observation, one))
        if self._include_input_skip:
            return jnp.concatenate((observation, one, previous))
        return jnp.concatenate((previous, one))

    def _select(self, logits: Array, sources: Array, hard: bool) -> Array:
        if hard:
            return sources[jnp.argmax(logits, axis=-1)]
        probs = jax.nn.softmax(logits / self._temperature, axis=-1)
        return probs @ sources

    def _forward_params(
        self,
        params: DiffEMLParams,
        observation: Array,
        *,
        hard: bool = False,
    ) -> Array:
        previous = None
        sources = self._make_sources(observation, previous)
        for left_logits, right_logits in zip(params.left_logits, params.right_logits):
            left = self._select(left_logits, sources, hard)
            right = self._select(right_logits, sources, hard)
            previous = stable_eml_operator(
                left,
                right,
                eps=self._eps,
                input_clip=self._input_clip,
                output_clip=self._output_clip,
            )
            sources = self._make_sources(observation, previous)
        return jnp.dot(params.readout_weights, sources) + params.readout_bias

    def _routing_entropy(self, params: DiffEMLParams) -> Array:
        entropies = []
        for logits in (*params.left_logits, *params.right_logits):
            probs = jax.nn.softmax(logits / self._temperature, axis=-1)
            entropies.append(-jnp.sum(probs * jnp.log(probs + 1e-8), axis=-1))
        return jnp.mean(jnp.concatenate(entropies))

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict(self, state: DiffEMLState, observation: Observation) -> Float[Array, " 1"]:
        """Predict with soft differentiable routing."""
        return jnp.atleast_1d(self._forward_params(state.params, observation, hard=False))

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict_hard(self, state: DiffEMLState, observation: Observation) -> Float[Array, " 1"]:
        """Predict with hard argmax source routing."""
        return jnp.atleast_1d(self._forward_params(state.params, observation, hard=True))

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: DiffEMLState,
        observation: Observation,
        target: Target,
    ) -> DiffEMLUpdateResult:
        """Perform one online SGD update.

        Args:
            state: Current EML learner state.
            observation: Input feature vector.
            target: Desired scalar target.

        Returns:
            Update result with fixed-size scan-compatible metrics.
        """
        target_scalar = jnp.squeeze(target)

        def loss_fn(params: DiffEMLParams) -> Array:
            prediction = self._forward_params(params, observation, hard=False)
            error = target_scalar - prediction
            return 0.5 * error**2

        loss, grads = jax.value_and_grad(loss_fn)(state.params)
        prediction_val = self._forward_params(state.params, observation, hard=False)
        error = target_scalar - prediction_val

        grad_sq_sum = sum(jnp.sum(leaf**2) for leaf in jax.tree_util.tree_leaves(grads))
        grad_norm = jnp.sqrt(grad_sq_sum + 1e-12)
        grad_scale = jnp.minimum(1.0, self._max_grad_norm / (grad_norm + 1e-8))

        new_params = jax.tree_util.tree_map(
            lambda param, grad: param - self._step_size * grad_scale * grad,
            state.params,
            grads,
        )
        new_state = DiffEMLState(
            params=new_params,
            step_count=state.step_count + 1,
            birth_timestamp=state.birth_timestamp,
            uptime_s=state.uptime_s,
        )

        metrics = jnp.array(
            [
                2.0 * loss,
                error,
                grad_norm,
                self._routing_entropy(new_params),
            ],
            dtype=jnp.float32,
        )

        return DiffEMLUpdateResult(
            state=new_state,
            prediction=jnp.atleast_1d(prediction_val),
            error=jnp.atleast_1d(error),
            metrics=metrics,
        )

    def selection_probabilities(
        self, state: DiffEMLState
    ) -> tuple[tuple[Array, ...], tuple[Array, ...]]:
        """Return soft source-selection probabilities for inspection."""
        left = tuple(
            jax.nn.softmax(logits / self._temperature, axis=-1)
            for logits in state.params.left_logits
        )
        right = tuple(
            jax.nn.softmax(logits / self._temperature, axis=-1)
            for logits in state.params.right_logits
        )
        return left, right

    def hard_source_indices(
        self, state: DiffEMLState
    ) -> tuple[tuple[Array, ...], tuple[Array, ...]]:
        """Return argmax source indices for the hard routed circuit."""
        left = tuple(jnp.argmax(logits, axis=-1) for logits in state.params.left_logits)
        right = tuple(jnp.argmax(logits, axis=-1) for logits in state.params.right_logits)
        return left, right


def run_diffeml_learning_loop[StreamStateT](
    learner: DiffEMLLearner,
    stream: ScanStream[StreamStateT],
    num_steps: int,
    key: Array,
    learner_state: DiffEMLState | None = None,
) -> tuple[DiffEMLState, Array]:
    """Run a differentiable EML learner with ``jax.lax.scan``.

    Args:
        learner: Differentiable EML learner.
        stream: Experience stream providing ``(observation, target)`` pairs.
        num_steps: Number of online update steps.
        key: JAX random key for stream and learner initialization.
        learner_state: Optional pre-initialized learner state.

    Returns:
        ``(final_state, metrics)`` where metrics has shape ``(num_steps, 4)``.
    """
    stream_key, init_key = jax.random.split(key)
    if learner_state is None:
        learner_state = learner.init(stream.feature_dim, init_key)
    stream_state = stream.init(stream_key)

    def step_fn(
        carry: tuple[DiffEMLState, StreamStateT],
        idx: Array,
    ) -> tuple[tuple[DiffEMLState, StreamStateT], Array]:
        l_state, s_state = carry
        timestep, new_s_state = stream.step(s_state, idx)
        result = learner.update(l_state, timestep.observation, timestep.target)
        return (result.state, new_s_state), result.metrics

    t0 = time.time()
    (final_learner, _), metrics = jax.lax.scan(
        step_fn, (learner_state, stream_state), jnp.arange(num_steps)
    )
    elapsed = time.time() - t0
    final_learner = final_learner.replace(uptime_s=final_learner.uptime_s + elapsed)  # type: ignore[attr-defined]

    return final_learner, metrics


class EMLTreeLearner:
    """Fixed-depth differentiable EML tree with soft leaf choices.

    Every internal node is the same stable real EML operator. The only
    structural choices are at the leaves, where each leaf learns a categorical
    relaxation over input features, constant ``1``, and learned constants.

    This is the smallest DiffLogic-style EML experiment: train soft leaf
    choices with gradients, then inspect or evaluate the hard argmax tree.
    """

    def __init__(
        self,
        depth: int = 2,
        n_constants: int = 2,
        step_size: float = 1e-3,
        temperature: float = 1.0,
        max_grad_norm: float = 10.0,
        input_clip: float = 8.0,
        output_clip: float = 30.0,
        eps: float = 1e-6,
        constant_scale: float = 2.0,
        leaf_init_scale: float = 0.1,
        constant_init_scale: float = 0.1,
        output_init_scale: float = 1.0,
    ):
        """Initialize an EML tree learner.

        Args:
            depth: Number of EML levels. A depth-2 tree has four leaves.
            n_constants: Number of learned constants available to every leaf.
            step_size: Online SGD learning rate.
            temperature: Softmax temperature for leaf selection.
            max_grad_norm: Global gradient-norm clip.
            input_clip: Clip before exponentiation inside EML nodes.
            output_clip: Clip on EML node outputs.
            eps: Positive floor for the stable logarithm input.
            constant_scale: Bound for transformed learned constants.
            leaf_init_scale: Standard deviation for leaf-logit init.
            constant_init_scale: Standard deviation for raw constant init.
            output_init_scale: Initial affine output scale.

        Raises:
            ValueError: If any hyperparameter is outside its valid range.
        """
        if depth < 1:
            raise ValueError("depth must be >= 1")
        if n_constants < 0:
            raise ValueError("n_constants must be >= 0")
        if step_size <= 0.0:
            raise ValueError("step_size must be positive")
        if temperature <= 0.0:
            raise ValueError("temperature must be positive")
        if max_grad_norm <= 0.0:
            raise ValueError("max_grad_norm must be positive")
        if input_clip <= 0.0:
            raise ValueError("input_clip must be positive")
        if output_clip <= 0.0:
            raise ValueError("output_clip must be positive")
        if eps <= 0.0:
            raise ValueError("eps must be positive")
        if constant_scale <= 0.0:
            raise ValueError("constant_scale must be positive")

        self._depth = depth
        self._n_constants = n_constants
        self._step_size = step_size
        self._temperature = temperature
        self._max_grad_norm = max_grad_norm
        self._input_clip = input_clip
        self._output_clip = output_clip
        self._eps = eps
        self._constant_scale = constant_scale
        self._leaf_init_scale = leaf_init_scale
        self._constant_init_scale = constant_init_scale
        self._output_init_scale = output_init_scale

    @property
    def n_leaves(self) -> int:
        """Number of leaves in the full binary tree."""
        return int(2**self._depth)

    def to_config(self) -> dict[str, Any]:
        """Serialize learner configuration to a dict."""
        return {
            "type": "EMLTreeLearner",
            "depth": self._depth,
            "n_constants": self._n_constants,
            "step_size": self._step_size,
            "temperature": self._temperature,
            "max_grad_norm": self._max_grad_norm,
            "input_clip": self._input_clip,
            "output_clip": self._output_clip,
            "eps": self._eps,
            "constant_scale": self._constant_scale,
            "leaf_init_scale": self._leaf_init_scale,
            "constant_init_scale": self._constant_init_scale,
            "output_init_scale": self._output_init_scale,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> "EMLTreeLearner":
        """Reconstruct a learner from :meth:`to_config` output."""
        config = dict(config)
        config.pop("type", None)
        return cls(**config)

    def _candidate_dim(self, feature_dim: int) -> int:
        return feature_dim + 1 + self._n_constants

    def init(self, feature_dim: int, key: Array) -> EMLTreeState:
        """Initialize a fixed-depth EML tree.

        Args:
            feature_dim: Dimension of the input feature vector.
            key: JAX random key.

        Returns:
            Initial EML tree learner state.
        """
        _, leaf_key, constant_key = jax.random.split(key, 3)
        leaf_logits = self._leaf_init_scale * jax.random.normal(
            leaf_key,
            (self.n_leaves, self._candidate_dim(feature_dim)),
            dtype=jnp.float32,
        )
        constant_params = self._constant_init_scale * jax.random.normal(
            constant_key,
            (self._n_constants,),
            dtype=jnp.float32,
        )
        params = EMLTreeParams(
            leaf_logits=leaf_logits,
            constant_params=constant_params,
            output_scale=jnp.array(self._output_init_scale, dtype=jnp.float32),
            output_bias=jnp.array(0.0, dtype=jnp.float32),
        )
        return EMLTreeState(
            params=params,
            step_count=jnp.array(0, dtype=jnp.int32),
            birth_timestamp=time.time(),
            uptime_s=0.0,
        )

    def _constant_values(self, params: EMLTreeParams) -> Array:
        return self._constant_scale * jnp.tanh(params.constant_params)

    def _candidates(self, params: EMLTreeParams, observation: Array) -> Array:
        one = jnp.ones((1,), dtype=observation.dtype)
        constants = self._constant_values(params).astype(observation.dtype)
        return jnp.concatenate((observation, one, constants))

    def _leaf_values(
        self,
        params: EMLTreeParams,
        observation: Array,
        *,
        hard: bool = False,
    ) -> Array:
        candidates = self._candidates(params, observation)
        if hard:
            return candidates[jnp.argmax(params.leaf_logits, axis=-1)]
        probs = jax.nn.softmax(params.leaf_logits / self._temperature, axis=-1)
        return probs @ candidates

    def _evaluate_internal_tree(self, leaf_values: Array) -> Array:
        nodes = leaf_values
        for _ in range(self._depth):
            left = nodes[0::2]
            right = nodes[1::2]
            nodes = stable_eml_operator(
                left,
                right,
                eps=self._eps,
                input_clip=self._input_clip,
                output_clip=self._output_clip,
            )
        return jnp.squeeze(nodes[0])

    def _forward_params(
        self,
        params: EMLTreeParams,
        observation: Array,
        *,
        hard: bool = False,
    ) -> Array:
        root = self._evaluate_internal_tree(
            self._leaf_values(params, observation, hard=hard)
        )
        return params.output_scale * root + params.output_bias

    def _leaf_entropy(self, params: EMLTreeParams) -> Array:
        probs = jax.nn.softmax(params.leaf_logits / self._temperature, axis=-1)
        entropy = -jnp.sum(probs * jnp.log(probs + 1e-8), axis=-1)
        return jnp.mean(entropy)

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict(self, state: EMLTreeState, observation: Observation) -> Float[Array, " 1"]:
        """Predict with soft leaf choices."""
        return jnp.atleast_1d(self._forward_params(state.params, observation, hard=False))

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict_hard(self, state: EMLTreeState, observation: Observation) -> Float[Array, " 1"]:
        """Predict with hard argmax leaf choices."""
        return jnp.atleast_1d(self._forward_params(state.params, observation, hard=True))

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: EMLTreeState,
        observation: Observation,
        target: Target,
    ) -> EMLTreeUpdateResult:
        """Perform one online SGD update against the soft tree prediction."""
        target_scalar = jnp.squeeze(target)

        def loss_fn(params: EMLTreeParams) -> Array:
            prediction = self._forward_params(params, observation, hard=False)
            error = target_scalar - prediction
            return 0.5 * error**2

        loss, grads = jax.value_and_grad(loss_fn)(state.params)
        prediction_val = self._forward_params(state.params, observation, hard=False)
        hard_prediction_val = self._forward_params(state.params, observation, hard=True)
        error = target_scalar - prediction_val
        hard_error = target_scalar - hard_prediction_val

        grad_sq_sum = sum(jnp.sum(leaf**2) for leaf in jax.tree_util.tree_leaves(grads))
        grad_norm = jnp.sqrt(grad_sq_sum + 1e-12)
        grad_scale = jnp.minimum(1.0, self._max_grad_norm / (grad_norm + 1e-8))

        new_params = jax.tree_util.tree_map(
            lambda param, grad: param - self._step_size * grad_scale * grad,
            state.params,
            grads,
        )
        new_state = EMLTreeState(
            params=new_params,
            step_count=state.step_count + 1,
            birth_timestamp=state.birth_timestamp,
            uptime_s=state.uptime_s,
        )
        metrics = jnp.array(
            [
                2.0 * loss,
                hard_error**2,
                error,
                grad_norm,
                self._leaf_entropy(new_params),
            ],
            dtype=jnp.float32,
        )
        return EMLTreeUpdateResult(
            state=new_state,
            prediction=jnp.atleast_1d(prediction_val),
            hard_prediction=jnp.atleast_1d(hard_prediction_val),
            error=jnp.atleast_1d(error),
            metrics=metrics,
        )

    def leaf_selection_probabilities(self, state: EMLTreeState) -> Array:
        """Return soft categorical leaf-selection probabilities."""
        return jax.nn.softmax(state.params.leaf_logits / self._temperature, axis=-1)

    def hard_leaf_indices(self, state: EMLTreeState) -> Array:
        """Return argmax candidate indices for each tree leaf."""
        return jnp.argmax(state.params.leaf_logits, axis=-1)

    def candidate_names(
        self,
        feature_dim: int,
        feature_names: tuple[str, ...] | None = None,
    ) -> tuple[str, ...]:
        """Return candidate labels for hard-expression inspection."""
        if feature_names is None:
            names = tuple(f"x{i}" for i in range(feature_dim))
        else:
            if len(feature_names) != feature_dim:
                raise ValueError("feature_names length must match feature_dim")
            names = feature_names
        constant_names = tuple(f"c{i}" for i in range(self._n_constants))
        return (*names, "1", *constant_names)

    def hard_expression(
        self,
        state: EMLTreeState,
        feature_dim: int,
        feature_names: tuple[str, ...] | None = None,
    ) -> str:
        """Render the hard argmax tree as a compact EML expression string."""
        names = self.candidate_names(feature_dim, feature_names)
        leaves = [names[int(idx)] for idx in self.hard_leaf_indices(state)]
        nodes = leaves
        for _ in range(self._depth):
            nodes = [
                f"eml({nodes[i]}, {nodes[i + 1]})"
                for i in range(0, len(nodes), 2)
            ]
        scale = float(state.params.output_scale)
        bias = float(state.params.output_bias)
        return f"{scale:.6g} * {nodes[0]} + {bias:.6g}"


def run_eml_tree_learning_loop[StreamStateT](
    learner: EMLTreeLearner,
    stream: ScanStream[StreamStateT],
    num_steps: int,
    key: Array,
    learner_state: EMLTreeState | None = None,
) -> tuple[EMLTreeState, Array]:
    """Run a fixed-depth EML tree learner with ``jax.lax.scan``."""
    stream_key, init_key = jax.random.split(key)
    if learner_state is None:
        learner_state = learner.init(stream.feature_dim, init_key)
    stream_state = stream.init(stream_key)

    def step_fn(
        carry: tuple[EMLTreeState, StreamStateT],
        idx: Array,
    ) -> tuple[tuple[EMLTreeState, StreamStateT], Array]:
        l_state, s_state = carry
        timestep, new_s_state = stream.step(s_state, idx)
        result = learner.update(l_state, timestep.observation, timestep.target)
        return (result.state, new_s_state), result.metrics

    t0 = time.time()
    (final_learner, _), metrics = jax.lax.scan(
        step_fn, (learner_state, stream_state), jnp.arange(num_steps)
    )
    elapsed = time.time() - t0
    final_learner = final_learner.replace(uptime_s=final_learner.uptime_s + elapsed)  # type: ignore[attr-defined]

    return final_learner, metrics
