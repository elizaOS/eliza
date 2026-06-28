"""Compositional feature discovery for Alberta Plan Step 2.

This module implements ``CompositionalFeatureLearner``, a fixed-budget
feature learner whose features form a directed acyclic graph (DAG) of
compositional operations.  Where ``FixedBudgetFeatureLearner`` only constructs
features that are direct functions of the raw input, and
``FixedBudgetInteractionLearner`` only forms pairwise products of raw inputs,
this learner explicitly composes features OF features.

The Alberta Plan Step 2 calls for "new features made by combining existing
features."  Each feature slot here records an op type (raw, product, sum,
tanh of a learned linear combination, or gated multiplication), two parent
indices, a small per-feature parameter vector, a topological depth, and the
familiar utility/age machinery used elsewhere in the framework.

The forward pass uses ``jax.lax.scan`` over slots in topological order so that
parents are always evaluated before children.  Generation enforces
``depth[new] > max(depth[parent_a], depth[parent_b])``, and replacement
cascades through descendants of a replaced slot to keep the DAG well-formed
under JIT compilation.
"""

import functools
import math
import time
from typing import Any

import chex
import jax
import jax.numpy as jnp
import jax.random as jr
from jax import Array
from jaxtyping import Float, Int, PRNGKeyArray

from alberta_framework.core.future_utility import (
    contribution_trace_output_loss_reduction,
    normalize_future_utility_signal,
    trace_output_loss_reduction,
)
from alberta_framework.core.resource_manager import (
    GeneratorMetaResourceManager,
    GeneratorMetaResourceManagerState,
)

OP_RAW = 0
OP_PRODUCT = 1
OP_SUM = 2
OP_TANH = 3
OP_GATED = 4

NUM_OPS = 5

GENERATION_UNIFORM = "uniform"
GENERATION_UTILITY = "utility"
GENERATION_MUTATION = "mutation"
GENERATION_RESIDUAL_IMPRINT = "residual_imprint"
GENERATION_RECURSIVE_PRODUCT = "recursive_product"
GENERATION_ROBUST_RECURSIVE = "robust_recursive"

PARENT_MODE_UNIFORM = 0
PARENT_MODE_UTILITY = 1
PARENT_MODE_MUTATION = 2
PARENT_MODE_RESIDUAL_IMPRINT = 3

DEFAULT_GENERATOR_META_POLICY_NAMES = (
    "random_product_safe",
    "mutation_product_nominal",
    "residual_tanh",
    "residual_gated_aggressive",
)
DEFAULT_GENERATOR_META_OP_IDS = (
    OP_PRODUCT,
    OP_PRODUCT,
    OP_TANH,
    OP_GATED,
)
DEFAULT_GENERATOR_META_PARENT_MODES = (
    PARENT_MODE_UNIFORM,
    PARENT_MODE_MUTATION,
    PARENT_MODE_RESIDUAL_IMPRINT,
    PARENT_MODE_RESIDUAL_IMPRINT,
)
DEFAULT_GENERATOR_META_REPLACEMENT_MULTIPLIERS = (0.5, 1.0, 1.0, 2.0)
DEFAULT_GENERATOR_META_PROMOTION_MARGIN_MULTIPLIERS = (1.25, 1.0, 0.9, 0.75)
DEFAULT_GENERATOR_META_CANDIDATE_MIN_AGE_MULTIPLIERS = (1.5, 1.0, 0.75, 0.5)
DEFAULT_GENERATOR_META_IMPRINT_SCALES = (0.0, 0.25, 1.0, 1.0)

PROMOTION_SCALED_CANDIDATE = "scaled_candidate"
PROMOTION_BLEND = "blend"

CANDIDATE_SELECTOR_LEGACY = "legacy"
CANDIDATE_SELECTOR_HEDGE = "hedge"
CANDIDATE_SELECTOR_EXP3 = "exp3"


@chex.dataclass(frozen=True)
class CompositionalFeatureState:
    """State for ``CompositionalFeatureLearner``.

    Slots ``[0, feature_dim)`` are reserved for ``OP_RAW`` features that
    expose individual raw observation entries.  The remaining active slots
    hold composed features whose parent indices refer to earlier slots.
    Candidates mirror this structure with their own bank.

    Attributes:
        key: PRNG key for generation/replacement decisions.
        ops: Op type per active slot.
        parent_a: First parent index (raw-input index for ``OP_RAW``,
            otherwise feature slot index strictly less than ``i``).
        parent_b: Second parent index (``-1`` for ``OP_RAW``, else
            feature slot index strictly less than ``i``).
        theta: Per-feature parameter vector of length two used by ``OP_TANH``
            and ``OP_GATED``.
        depth: Topological depth (raw inputs at depth 0).
        output_weights: Output head weights, shape ``(n_tasks, n_features)``.
        output_bias: Output head biases.
        utilities: EMA utility per active slot.
        utility_contribution_trace: Discounted ``error * feature`` trace for
            TD(lambda)-style future-utility estimates.
        utility_error_trace: Discounted residual trace for temporally extended
            marginal future-utility estimates.
        utility_feature_trace: Discounted active feature-value trace.
        utility_feature_energy_trace: Discounted active squared-feature trace.
        utility_signal_second_moment: Online second moment for optional
            uncertainty normalization.
        feature_score_residual_trace: Discounted ``error * feature`` trace
            used by opt-in matching-pursuit candidate scoring.
        feature_score_energy_trace: Discounted feature-energy trace used by
            opt-in matching-pursuit candidate scoring.
        retention_slow_utilities: Optional slow utility EMA used by opt-in
            hysteretic replacement. Disabled configurations leave it at zero.
        task_activity_ema: Per-task activity frequency for rare-task credit.
        ages: Age in steps per active slot.
        candidate_*: Candidate slot bank with the same fields.
        candidate_utility_contribution_trace: Discounted candidate
            ``error * feature`` trace.
        candidate_utility_feature_trace: Discounted candidate value trace.
        candidate_utility_feature_energy_trace: Discounted candidate squared
            value trace.
        candidate_utility_signal_second_moment: Online second moment for
            optional candidate uncertainty normalization.
        candidate_score_residual_trace: Discounted candidate
            ``error * feature`` trace used by opt-in matching-pursuit scoring.
        candidate_score_energy_trace: Discounted candidate feature-energy
            trace used by opt-in matching-pursuit scoring.
        candidate_retention_slow_utilities: Optional candidate slow utility EMA
            used by opt-in hysteretic promotion/probation.
        candidate_active_correlation_trace: Discounted cross-feature trace
            used to penalize candidates that duplicate active features.
        candidate_selector_*: Optional finite-candidate selector state used
            only when ``candidate_selector`` is not ``"legacy"``.  The default
            promote heuristic ignores these fields.
        feature_generator_policy: Meta-resource policy that created each
            active feature slot.
        candidate_generator_policy: Meta-resource policy that created each
            candidate slot.
        generator_resource_state: Contextual policy-allocation state for
            generator-internal choices.
        replacement_accumulator: Fractional replacement clock used when the
            learned policy controls replacement rate.
        step_count: Number of update steps applied.
        birth_timestamp: Wall-clock initialization time.
        uptime_s: Cumulative seconds spent inside scan loops.
    """

    key: PRNGKeyArray
    ops: Int[Array, " n_features"]
    parent_a: Int[Array, " n_features"]
    parent_b: Int[Array, " n_features"]
    theta: Float[Array, "n_features 2"]
    depth: Int[Array, " n_features"]
    output_weights: Float[Array, "n_tasks n_features"]
    output_bias: Float[Array, " n_tasks"]
    utilities: Float[Array, " n_features"]
    utility_contribution_trace: Float[Array, "n_tasks n_features"]
    utility_error_trace: Float[Array, " n_tasks"]
    utility_feature_trace: Float[Array, " n_features"]
    utility_feature_energy_trace: Float[Array, " n_features"]
    utility_signal_second_moment: Float[Array, " n_features"]
    feature_score_residual_trace: Float[Array, "n_tasks n_features"]
    feature_score_energy_trace: Float[Array, " n_features"]
    retention_slow_utilities: Float[Array, " n_features"]
    task_activity_ema: Float[Array, " n_tasks"]
    ages: Int[Array, " n_features"]
    candidate_ops: Int[Array, " n_candidates"]
    candidate_parent_a: Int[Array, " n_candidates"]
    candidate_parent_b: Int[Array, " n_candidates"]
    candidate_theta: Float[Array, "n_candidates 2"]
    candidate_depth: Int[Array, " n_candidates"]
    candidate_output_weights: Float[Array, "n_tasks n_candidates"]
    candidate_utilities: Float[Array, " n_candidates"]
    candidate_utility_contribution_trace: Float[Array, "n_tasks n_candidates"]
    candidate_utility_feature_trace: Float[Array, " n_candidates"]
    candidate_utility_feature_energy_trace: Float[Array, " n_candidates"]
    candidate_utility_signal_second_moment: Float[Array, " n_candidates"]
    candidate_score_residual_trace: Float[Array, "n_tasks n_candidates"]
    candidate_score_energy_trace: Float[Array, " n_candidates"]
    candidate_retention_slow_utilities: Float[Array, " n_candidates"]
    candidate_active_correlation_trace: Float[Array, "n_candidates n_features"]
    candidate_ages: Int[Array, " n_candidates"]
    candidate_selector_log_weights: Float[Array, " n_candidates"]
    candidate_selector_cumulative_loss: Float[Array, " n_candidates"]
    candidate_selector_action_counts: Float[Array, " n_candidates"]
    feature_generator_policy: Int[Array, " n_features"]
    candidate_generator_policy: Int[Array, " n_candidates"]
    generator_resource_state: GeneratorMetaResourceManagerState
    replacement_accumulator: Float[Array, ""]
    step_count: Int[Array, ""]
    birth_timestamp: float = 0.0
    uptime_s: float = 0.0


@chex.dataclass(frozen=True)
class CompositionalFeatureUpdateResult:
    """Result of one compositional-feature update."""

    state: CompositionalFeatureState
    predictions: Float[Array, " n_tasks"]
    errors: Float[Array, " n_tasks"]
    metrics: Float[Array, " 7"]
    replaced_slot: Int[Array, ""]
    promoted_candidate: Int[Array, ""]


@chex.dataclass(frozen=True)
class CompositionalFeatureLearningResult:
    """Result from a scan-based compositional feature run."""

    state: CompositionalFeatureState
    metrics: Float[Array, "num_steps 7"]


@chex.dataclass(frozen=True)
class FiniteCandidateSelectorState:
    """State for a finite-candidate bounded-loss selector.

    The selector treats candidate ids as fixed experts.  If a caller reuses a
    slot for a different candidate, the caller should reset that slot's state
    before interpreting the finite-expert regret metadata.
    """

    log_weights: Float[Array, " n_candidates"]
    cumulative_loss: Float[Array, " n_candidates"]
    action_counts: Float[Array, " n_candidates"]
    step_count: Int[Array, ""]


@chex.dataclass(frozen=True)
class FiniteCandidateSelectorUpdateResult:
    """Result of one finite-candidate selector update."""

    state: FiniteCandidateSelectorState
    probabilities: Float[Array, " n_candidates"]
    bounded_losses: Float[Array, " n_candidates"]
    selected_action: Int[Array, ""]


class FiniteCandidateSelector:
    """Hedge/Exp3-style selector over a fixed finite candidate set.

    This is a generic no-regret selector abstraction for externally supplied
    bounded losses.  It is intentionally separate from the compositional
    promote heuristic: the theorem metadata applies to this fixed-candidate
    loss sequence, not to dynamic feature generation or candidate refresh.
    """

    def __init__(
        self,
        n_candidates: int,
        learning_rate: float = 1.0,
        exploration: float = 0.0,
        loss_lower_bound: float = 0.0,
        loss_upper_bound: float = 1.0,
        update_rule: str = CANDIDATE_SELECTOR_HEDGE,
    ) -> None:
        """Initialize a finite-candidate selector.

        Args:
            n_candidates: Number of fixed candidate experts.
            learning_rate: Exponentiated-gradient learning rate.
            exploration: Uniform probability floor mixed into action
                probabilities.
            loss_lower_bound: Lower bound assumed for finite observed losses.
            loss_upper_bound: Upper bound assumed for finite observed losses.
            update_rule: ``"hedge"`` for full-information losses, or
                ``"exp3"`` for selected-action importance-weighted updates.
        """
        if n_candidates < 1:
            raise ValueError("n_candidates must be positive")
        if learning_rate <= 0.0:
            raise ValueError("learning_rate must be positive")
        if not 0.0 <= exploration < 1.0:
            raise ValueError("exploration must be in [0, 1)")
        if loss_lower_bound >= loss_upper_bound:
            raise ValueError("loss_lower_bound must be < loss_upper_bound")
        if update_rule not in {CANDIDATE_SELECTOR_HEDGE, CANDIDATE_SELECTOR_EXP3}:
            raise ValueError("update_rule must be 'hedge' or 'exp3'")
        if update_rule == CANDIDATE_SELECTOR_EXP3 and exploration <= 0.0:
            raise ValueError("exp3 selector requires positive exploration")

        self._n_candidates = int(n_candidates)
        self._learning_rate = float(learning_rate)
        self._exploration = float(exploration)
        self._loss_lower_bound = float(loss_lower_bound)
        self._loss_upper_bound = float(loss_upper_bound)
        self._update_rule = update_rule

    @property
    def n_candidates(self) -> int:
        """Number of fixed candidates."""
        return self._n_candidates

    @property
    def update_rule(self) -> str:
        """Selector update rule."""
        return self._update_rule

    def to_config(self) -> dict[str, Any]:
        """Serialize selector configuration."""
        return {
            "type": "FiniteCandidateSelector",
            "n_candidates": self._n_candidates,
            "learning_rate": self._learning_rate,
            "exploration": self._exploration,
            "loss_lower_bound": self._loss_lower_bound,
            "loss_upper_bound": self._loss_upper_bound,
            "update_rule": self._update_rule,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> "FiniteCandidateSelector":
        """Reconstruct a selector from :meth:`to_config` output."""
        config = dict(config)
        config.pop("type", None)
        return cls(**config)

    def init(self) -> FiniteCandidateSelectorState:
        """Create a uniform selector state."""
        return FiniteCandidateSelectorState(
            log_weights=jnp.zeros(self._n_candidates, dtype=jnp.float32),
            cumulative_loss=jnp.zeros(self._n_candidates, dtype=jnp.float32),
            action_counts=jnp.zeros(self._n_candidates, dtype=jnp.float32),
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    def probabilities(
        self,
        state: FiniteCandidateSelectorState,
    ) -> Float[Array, " n_candidates"]:
        """Return the current candidate probabilities."""
        logits = state.log_weights - jnp.max(state.log_weights)
        weights = jax.nn.softmax(logits)
        if self._exploration > 0.0:
            uniform = jnp.full_like(weights, 1.0 / float(self._n_candidates))
            weights = (1.0 - self._exploration) * weights + self._exploration * uniform
        return weights / jnp.sum(weights)

    def validate_bounded_losses(self, losses: Array) -> None:
        """Raise if finite losses violate the selector's theorem range."""
        losses = jnp.asarray(losses, dtype=jnp.float32)
        finite = jnp.isfinite(losses)
        outside = finite & (
            (losses < self._loss_lower_bound) | (losses > self._loss_upper_bound)
        )
        if bool(jnp.any(outside)):
            raise ValueError(
                "finite-candidate selector assumes finite losses in "
                f"[{self._loss_lower_bound}, {self._loss_upper_bound}]"
            )

    def _unit_losses(self, losses: Array) -> Array:
        losses = jnp.asarray(losses, dtype=jnp.float32)
        finite = jnp.isfinite(losses)
        width = jnp.asarray(
            self._loss_upper_bound - self._loss_lower_bound,
            dtype=jnp.float32,
        )
        unit = (losses - self._loss_lower_bound) / width
        unit = jnp.clip(unit, 0.0, 1.0)
        return jnp.where(finite, unit, jnp.nan)

    def update(
        self,
        state: FiniteCandidateSelectorState,
        losses: Float[Array, " n_candidates"],
        selected_action: Array | int | None = None,
    ) -> FiniteCandidateSelectorUpdateResult:
        """Update selector preferences from bounded losses.

        ``NaN`` losses are ignored.  For ``update_rule="hedge"``, all finite
        losses are observed.  For ``update_rule="exp3"``, only
        ``selected_action`` receives an importance-weighted update.
        """
        bounded_losses = self._unit_losses(losses)
        finite = jnp.isfinite(bounded_losses)
        probabilities = self.probabilities(state)
        if self._update_rule == CANDIDATE_SELECTOR_EXP3:
            action = (
                jnp.argmax(probabilities).astype(jnp.int32)
                if selected_action is None
                else jnp.asarray(selected_action, dtype=jnp.int32)
            )
            probability = jnp.maximum(probabilities[action], 1e-6)
            selected_finite = finite[action]
            loss_hat = jnp.where(
                selected_finite,
                bounded_losses[action] / probability,
                jnp.array(0.0, dtype=jnp.float32),
            )
            update_losses = jnp.zeros_like(bounded_losses).at[action].set(loss_hat)
            update_finite = jnp.zeros_like(finite).at[action].set(selected_finite)
        else:
            action = jnp.argmin(
                jnp.where(finite, bounded_losses, jnp.inf)
            ).astype(jnp.int32)
            update_losses = jnp.where(finite, bounded_losses, 0.0)
            update_finite = finite

        log_weights = state.log_weights - self._learning_rate * update_losses
        log_weights = log_weights - jnp.mean(log_weights)
        cumulative_loss = state.cumulative_loss + jnp.where(
            update_finite,
            jnp.nan_to_num(bounded_losses, nan=0.0),
            0.0,
        )
        action_counts = state.action_counts + update_finite.astype(jnp.float32)
        next_state = FiniteCandidateSelectorState(
            log_weights=log_weights,
            cumulative_loss=cumulative_loss,
            action_counts=action_counts,
            step_count=state.step_count + 1,
        )
        return FiniteCandidateSelectorUpdateResult(
            state=next_state,
            probabilities=probabilities,
            bounded_losses=bounded_losses,
            selected_action=action,
        )

    def regret_metadata(self, horizon: int) -> dict[str, Any]:
        """Return finite-candidate regret assumptions and bound metadata."""
        if horizon < 1:
            raise ValueError("horizon must be positive")
        width = self._loss_upper_bound - self._loss_lower_bound
        log_k = math.log(self._n_candidates)
        if self._n_candidates == 1:
            regret_bound = 0.0
        elif self._update_rule == CANDIDATE_SELECTOR_HEDGE:
            regret_bound = width * (
                log_k / self._learning_rate + self._learning_rate * horizon / 8.0
            )
        else:
            regret_bound = width * 2.0 * math.sqrt(horizon * self._n_candidates * log_k)

        return {
            "algorithm": self._update_rule,
            "candidate_count": self._n_candidates,
            "horizon": horizon,
            "assumptions": {
                "finite_candidate_set": True,
                "fixed_candidate_identities": True,
                "loss_lower_bound": self._loss_lower_bound,
                "loss_upper_bound": self._loss_upper_bound,
                "finite_losses_only": True,
                "comparator": "best fixed candidate in hindsight",
                "exp3_requires_unbiased_importance_weighted_losses": (
                    self._update_rule == CANDIDATE_SELECTOR_EXP3
                ),
            },
            "regret_bound": regret_bound,
            "regret_statement": (
                "Hedge full-information regret is bounded by "
                "(b-a)(ln(K)/eta + eta*T/8) for losses in [a,b]. "
                "The Exp3-style entry records the usual order bound and "
                "requires positive exploration plus unbiased bandit losses."
            ),
        }


def _candidate_scores_to_unit_losses(
    scores: Array,
    finite_mask: Array,
) -> Array:
    """Map candidate promotion scores to bounded losses for the selector.

    Higher utility-like scores become lower losses.  The conversion is only
    for the opt-in finite-candidate selector; it is not a theorem for the
    legacy promote heuristic.
    """
    scores = jnp.asarray(scores, dtype=jnp.float32)
    finite_mask = jnp.asarray(finite_mask, dtype=jnp.bool_) & jnp.isfinite(scores)
    high = jnp.max(jnp.where(finite_mask, scores, -jnp.inf))
    low = jnp.min(jnp.where(finite_mask, scores, jnp.inf))
    span = high - low
    normalized_score = jnp.where(
        span > 1e-6,
        (scores - low) / jnp.maximum(span, 1e-6),
        0.5,
    )
    losses = 1.0 - normalized_score
    return jnp.where(finite_mask, jnp.clip(losses, 0.0, 1.0), jnp.nan)


FEATURE_VALUE_CLIP = 10.0
CANDIDATE_IMPRINT_SCALE = 0.1


def _compute_feature_values(
    ops: Array,
    parent_a: Array,
    parent_b: Array,
    theta: Array,
    observation: Array,
) -> Array:
    """Forward-evaluate compositional features in topological order.

    Slots are evaluated in index order ``0, 1, ..., n_features - 1``; the
    invariant maintained at construction time is that every parent index is
    strictly smaller than its child (or, for ``OP_RAW``, that ``parent_a`` is
    a raw-input index).  This guarantees a valid topological evaluation.

    Each slot's output is clipped to ``[-FEATURE_VALUE_CLIP, FEATURE_VALUE_CLIP]``
    so that chains of multiplications cannot drive values to infinity on
    rare large-input observations.  The clip is intentionally generous
    (default ``10.0``) so that typical product magnitudes are unaffected;
    it acts as a safety rail rather than a learned nonlinearity.

    Args:
        ops: Op type per slot.
        parent_a: First parent indices.
        parent_b: Second parent indices (``-1`` allowed for ``OP_RAW``).
        theta: Per-feature parameter vectors of length two.
        observation: Raw observation vector.

    Returns:
        Vector of feature values, one per active slot.
    """
    n_features = ops.shape[0]
    feature_dim = observation.shape[0]

    def step_fn(values: Array, i: Array) -> tuple[Array, None]:
        op = ops[i]
        a = parent_a[i]
        b = parent_b[i]
        # Safe indexing: clamp to valid ranges, then mask via jnp.where.
        safe_a_obs = jnp.clip(a, 0, feature_dim - 1)
        safe_a_feat = jnp.clip(a, 0, n_features - 1)
        safe_b_feat = jnp.clip(b, 0, n_features - 1)

        raw = observation[safe_a_obs]
        val_a = values[safe_a_feat]
        val_b = jnp.where(b >= 0, values[safe_b_feat], 0.0)

        product = val_a * val_b
        summ = val_a + val_b
        pre_tanh = theta[i, 0] * val_a + theta[i, 1] * val_b
        tanh_val = jnp.tanh(pre_tanh)
        gated = val_a * jax.nn.sigmoid(val_b)

        new_val = jnp.select(
            [
                op == OP_RAW,
                op == OP_PRODUCT,
                op == OP_SUM,
                op == OP_TANH,
                op == OP_GATED,
            ],
            [raw, product, summ, tanh_val, gated],
            default=jnp.array(0.0, dtype=jnp.float32),
        )
        new_val = jnp.clip(new_val, -FEATURE_VALUE_CLIP, FEATURE_VALUE_CLIP)
        return values.at[i].set(new_val), None

    init_values = jnp.zeros(n_features, dtype=jnp.float32)
    values, _ = jax.lax.scan(step_fn, init_values, jnp.arange(n_features))
    return values


def _theta_local_grads(
    ops: Array,
    parent_a: Array,
    parent_b: Array,
    theta: Array,
    feature_values: Array,
) -> tuple[Array, Array]:
    """Compute per-feature theta gradients for the local op output.

    For ``OP_TANH``, ``d val_i / d theta_i = (1 - tanh^2(pre_i)) * [val_a, val_b]``.
    For ``OP_GATED``, theta is unused so the gradient is zero.

    Args:
        ops: Op types per slot.
        parent_a: First parent indices.
        parent_b: Second parent indices.
        theta: Per-feature parameter vectors.
        feature_values: Already-computed feature values for this observation.

    Returns:
        ``(d_val_d_theta0, d_val_d_theta1)`` arrays of shape ``(n_features,)``.
        Entries for slots whose op does not use theta are zero.
    """
    n_features = ops.shape[0]
    safe_a = jnp.clip(parent_a, 0, n_features - 1)
    safe_b = jnp.clip(parent_b, 0, n_features - 1)
    val_a = jnp.where(parent_a >= 0, feature_values[safe_a], 0.0)
    val_b = jnp.where(parent_b >= 0, feature_values[safe_b], 0.0)

    is_tanh = (ops == OP_TANH).astype(jnp.float32)
    tanh_factor = is_tanh * (1.0 - feature_values * feature_values)
    d_theta0 = tanh_factor * val_a
    d_theta1 = tanh_factor * val_b
    return d_theta0, d_theta1


def _compute_candidate_value(
    op: Array,
    parent_a: Array,
    parent_b: Array,
    theta: Array,
    active_values: Array,
    observation: Array,
) -> Array:
    """Evaluate one candidate op against the current active feature values."""
    n_features = active_values.shape[0]
    feature_dim = observation.shape[0]
    safe_a_obs = jnp.clip(parent_a, 0, feature_dim - 1)
    safe_a_feat = jnp.clip(parent_a, 0, n_features - 1)
    safe_b_feat = jnp.clip(parent_b, 0, n_features - 1)

    raw = observation[safe_a_obs]
    val_a = active_values[safe_a_feat]
    val_b = jnp.where(parent_b >= 0, active_values[safe_b_feat], 0.0)
    product = val_a * val_b
    summ = val_a + val_b
    tanh_val = jnp.tanh(theta[0] * val_a + theta[1] * val_b)
    gated = val_a * jax.nn.sigmoid(val_b)
    value = jnp.select(
        [
            op == OP_RAW,
            op == OP_PRODUCT,
            op == OP_SUM,
            op == OP_TANH,
            op == OP_GATED,
        ],
        [raw, product, summ, tanh_val, gated],
        default=jnp.array(0.0, dtype=jnp.float32),
    )
    return jnp.clip(value, -FEATURE_VALUE_CLIP, FEATURE_VALUE_CLIP)


def _candidate_theta_local_grads(
    ops: Array,
    parent_a: Array,
    parent_b: Array,
    theta: Array,
    candidate_values: Array,
    active_values: Array,
) -> tuple[Array, Array]:
    """Compute local theta gradients for one-step candidate features.

    Candidate slots are evaluated as shallow ops over the active feature bank,
    so only their own parameters receive a local gradient.  This mirrors the
    active-bank ``OP_TANH`` update without backpropagating through candidate
    parents.
    """
    n_features = active_values.shape[0]
    safe_a = jnp.clip(parent_a, 0, n_features - 1)
    safe_b = jnp.clip(parent_b, 0, n_features - 1)
    val_a = active_values[safe_a]
    val_b = jnp.where(parent_b >= 0, active_values[safe_b], 0.0)

    is_tanh = (ops == OP_TANH).astype(jnp.float32)
    tanh_factor = is_tanh * (1.0 - candidate_values * candidate_values)
    d_theta0 = tanh_factor * val_a
    d_theta1 = tanh_factor * val_b
    return d_theta0, d_theta1


def _imprint_candidate_output_weights(
    errors: Array,
    candidate_value: Array,
    active_count: Array,
) -> Array:
    """Initialize a candidate head with a small residual-aligned coefficient.

    This is a one-sample least-squares imprint, damped so a refreshed shadow
    feature gets an immediate utility signal without dominating later LMS
    updates.  Inactive heads already have zero error, so they stay zero.
    """
    denom = candidate_value * candidate_value + 1.0
    return CANDIDATE_IMPRINT_SCALE * errors * candidate_value / (denom * active_count)


class CompositionalFeatureLearner:
    """Fixed-budget DAG feature learner that composes features of features.

    Each feature slot stores an op type, two parent indices, a small parameter
    vector ``theta`` (used by ``OP_TANH`` and ``OP_GATED``), a topological
    depth, and standard utility/age tracking.  Output is

    ``y_k = sum_i output_weights[k, i] * feature_values[i] + output_bias[k]``.

    A fixed prefix of ``feature_dim`` slots holds raw-input features
    (``OP_RAW``); the rest are composed.  Generation enforces strict-less-than
    parent indices so ``jax.lax.scan`` over slots in index order is a valid
    topological traversal.  Replacing a slot cascades through its descendants
    so dangling parent references never appear at evaluation time.
    """

    def __init__(
        self,
        n_features: int,
        n_tasks: int,
        candidate_count: int = 0,
        step_size_output: float = 0.03,
        step_size_theta: float = 0.003,
        utility_decay: float = 0.995,
        replacement_interval: int = 200,
        min_feature_age: int = 100,
        candidate_min_age: int = 50,
        promotion_margin: float = 1.05,
        promotion_blend: float = 0.5,
        promotion_output_mode: str = PROMOTION_SCALED_CANDIDATE,
        max_depth: int = 4,
        use_obgd: bool = True,
        obgd_kappa: float = 2.0,
        generation_strategy: str = GENERATION_UTILITY,
        parent_temperature: float = 1.0,
        parent_novelty_weight: float = 0.0,
        parent_depth_prior: float = 0.0,
        retention_depth_bonus: float = 0.0,
        residual_guidance: float = 1.0,
        candidate_imprint_scale: float = CANDIDATE_IMPRINT_SCALE,
        train_candidate_theta: bool = False,
        signed_tanh_scaffold_count: int = 0,
        future_utility_mix: float = 0.0,
        future_utility_trace_decay: float = 0.0,
        future_utility_trace_mode: str = "marginal",
        future_utility_normalization: str = "none",
        future_utility_normalization_decay: float = 0.99,
        future_utility_rare_task_power: float = 0.0,
        future_utility_task_activity_decay: float = 0.995,
        candidate_scoring_mode: str = "legacy",
        candidate_score_trace_decay: float = 0.0,
        candidate_score_energy_epsilon: float = 1e-6,
        candidate_novelty_weight: float = 0.0,
        candidate_novelty_power: float = 1.0,
        candidate_novelty_floor: float = 0.05,
        candidate_selector: str = CANDIDATE_SELECTOR_LEGACY,
        candidate_selector_learning_rate: float = 1.0,
        candidate_selector_exploration: float = 0.0,
        retention_slow_utility_decay: float = 0.0,
        retention_tanh_min_count: int = 0,
        retention_product_min_count: int = 0,
        operation_prior: tuple[float, ...] | None = None,
        learn_generator_resources: bool = False,
        generator_resource_contexts: int = 1,
        generator_resource_learning_rate: float = 1.0,
        generator_resource_discount: float = 0.995,
        generator_resource_exploration: float = 0.01,
        generator_resource_advantage_clip: float = 10.0,
        generator_resource_cost_weight: float = 0.0,
        generator_resource_update_rule: str = "hedge",
        generator_resource_promotion_credit: float = 0.0,
        generator_resource_initial_preferences: tuple[float, ...] | None = None,
    ):
        """Initialize the compositional feature learner.

        Args:
            n_features: Number of active feature slots.  Must exceed the
                raw-input dimension passed to ``init`` so at least one
                composed slot is available.
            n_tasks: Number of supervised output heads.
            candidate_count: Number of shadow candidate slots.
            step_size_output: LMS step-size for output weights.
            step_size_theta: LMS step-size for per-feature theta updates.
            utility_decay: EMA decay for utility estimates.
            replacement_interval: Steps between replacement attempts (``0``
                disables replacement).
            min_feature_age: Minimum active age before a feature is eligible
                for replacement.
            candidate_min_age: Minimum candidate age before promotion.
            promotion_margin: Candidate utility must exceed
                ``promotion_margin * worst_active_utility`` to promote.
            promotion_blend: Fraction of candidate output weights copied on
                promotion. With ``promotion_output_mode="scaled_candidate"``,
                promoted output weights are ``promotion_blend * candidate``.
                With ``promotion_output_mode="blend"``, promoted output weights
                are ``(1 - promotion_blend) * old + promotion_blend * candidate``.
            promotion_output_mode: How to initialize output weights when a
                candidate is promoted. ``"scaled_candidate"`` preserves the
                historical behavior; ``"blend"`` reduces output churn.
            max_depth: Maximum allowed topological depth for any feature.
            use_obgd: Whether to bound effective updates ObGD-style.
            obgd_kappa: ObGD bounding sensitivity.
            generation_strategy: Parent-generation strategy for fresh
                candidates/replacements. ``"utility"`` preserves current
                utility-biased search, ``"uniform"`` is a control,
                ``"mutation"`` anchors one parent on high-utility features and
                samples the other from shallow eligible features, and
                ``"residual_imprint"`` additionally uses one-step residual
                credit and can initialize fresh candidate output weights from
                the current residual. ``"recursive_product"`` is an opt-in
                experimental policy for product-structured recursive targets:
                active initialization builds depth-1 product scaffolds and
                candidates are generated as products of an existing composed
                feature with a raw/shallow parent. ``"robust_recursive"`` uses
                the same causal utility path with product-biased op priors,
                utility/novelty parent selection, and protected recursive
                scaffolds.
            parent_temperature: Softmax temperature for non-uniform parent
                selection. Lower values make the parent search greedier.
            parent_novelty_weight: Extra parent score for low-utility/young
                eligible parents. This keeps search from repeatedly sampling
                the same already-dominant parent.
            parent_depth_prior: Extra parent score for deeper parents, used to
                make feature-of-feature construction more likely without
                hard-coding a target.
            retention_depth_bonus: Additive replacement-score bonus for deeper
                active features. Higher values protect recursive structure from
                immediate churn once discovered.
            residual_guidance: Weight on one-step residual/credit scores in
                ``generation_strategy="residual_imprint"``.
            candidate_imprint_scale: Scale for initializing freshly generated
                candidate output weights from the current residual. Set to
                ``0.0`` to disable imprint initialization.
            train_candidate_theta: If true, candidate ``OP_TANH`` parameters
                receive online shadow updates through their candidate output
                heads before promotion.
            signed_tanh_scaffold_count: Number of deterministic signed
                ``OP_TANH`` raw-pair scaffolds inserted after product
                scaffolds for ``generation_strategy="robust_recursive"``.
                These are task-agnostic local nonlinear basis functions.
            future_utility_mix: Mixture weight for one-step counterfactual
                output-loss-reduction utility. ``0`` keeps the historical
                utility signal. When ``future_utility_trace_decay > 0``, the
                future term uses causal residual/feature traces instead of only
                the current sample.
            future_utility_trace_decay: Discount for temporally extended
                future-utility traces. ``0`` exactly recovers the historical
                one-step counterfactual. Values near ``1`` credit features
                whose residual alignment recurs over multiple recent steps.
            future_utility_trace_mode: ``"contribution"`` traces
                ``error * feature`` directly; ``"marginal"`` keeps the older
                residual-trace times feature-trace proxy for ablation.
            future_utility_normalization: Optional normalization for the
                future term: ``"none"``, ``"age"``, ``"uncertainty"``, or
                ``"uncertainty_age"``.
            future_utility_normalization_decay: EMA decay for the future-signal
                second moment used by uncertainty normalization.
            future_utility_rare_task_power: Extra inverse-frequency weighting
                applied only to future-utility task credit. ``0`` disables it.
            future_utility_task_activity_decay: EMA decay for task activity
                frequencies used by rare-task future credit.
            candidate_scoring_mode: ``"legacy"`` keeps the historical utility
                update. ``"energy_novelty"`` uses matching-pursuit residual
                alignment normalized by feature energy, with candidate scores
                optionally downweighted by active-feature correlation.
            candidate_score_trace_decay: Discount for the opt-in residual,
                energy, and candidate-active correlation traces.
            candidate_score_energy_epsilon: Positive stabilizer for
                energy-normalized candidate scoring.
            candidate_novelty_weight: Interpolation between no novelty
                penalty (``0``) and full correlation novelty gating (``1``).
            candidate_novelty_power: Exponent applied to the novelty gate.
            candidate_novelty_floor: Minimum novelty gate for highly
                correlated candidates.
            candidate_selector: Optional finite-candidate selector for the
                promotion candidate choice. ``"legacy"`` preserves the
                historical argmax-utility heuristic. ``"hedge"`` or
                ``"exp3"`` uses a bounded-loss selector over candidate slots
                before the usual promotion margin check.
            candidate_selector_learning_rate: Exponentiated-gradient step
                size for the opt-in candidate selector.
            candidate_selector_exploration: Uniform probability floor for the
                opt-in selector. Required to be positive for ``"exp3"``.
            retention_slow_utility_decay: Opt-in slow utility EMA decay for
                hysteretic retention. When positive, active replacement uses
                ``max(fast_utility, slow_utility)`` so mature features are
                deleted only when both timescales are low.
            retention_tanh_min_count: Minimum number of active ``OP_TANH``
                slots to protect from replacement. ``0`` disables this quota.
            retention_product_min_count: Minimum number of active
                ``OP_PRODUCT`` slots to protect from replacement. ``0``
                disables this quota.
            operation_prior: Optional operation probabilities in
                ``[raw, product, sum, tanh, gated]`` order. When supplied,
                generation uses this fixed prior instead of the strategy
                default. The raw probability should be zero for composed
                feature generation.
            learn_generator_resources: If true, use a generator-internal
                meta-resource manager to choose operation/parent mode,
                replacement rate, promotion aggressiveness, candidate refresh
                age, and residual-imprint scale.
            generator_resource_contexts: Number of independent context bins
                for generator-policy allocation.
            generator_resource_learning_rate: Exponentiated-gradient step size
                for generator-policy rewards.
            generator_resource_discount: Preference decay for generator
                policies.
            generator_resource_exploration: Uniform policy-allocation floor.
            generator_resource_advantage_clip: Absolute clip on centered
                generator-policy rewards.
            generator_resource_cost_weight: Optional cost penalty for more
                aggressive generator policies.
            generator_resource_update_rule: ``"hedge"`` uses all finite
                provenance scores; ``"exp3"`` updates only the sampled policy
                with importance weighting.
            generator_resource_promotion_credit: Optional bonus assigned to
                the policy whose delayed candidate is promoted.
            generator_resource_initial_preferences: Optional initial
                log-preferences over generator policies.
        """
        if n_features < 1:
            raise ValueError("n_features must be positive")
        if n_tasks < 1:
            raise ValueError("n_tasks must be positive")
        if candidate_count < 0:
            raise ValueError("candidate_count must be non-negative")
        if not 0.0 <= utility_decay < 1.0:
            raise ValueError("utility_decay must be in [0, 1)")
        if replacement_interval < 0:
            raise ValueError("replacement_interval must be non-negative")
        if not 0.0 <= promotion_blend <= 1.0:
            raise ValueError("promotion_blend must be in [0, 1]")
        if promotion_output_mode not in {
            PROMOTION_SCALED_CANDIDATE,
            PROMOTION_BLEND,
        }:
            raise ValueError(
                "promotion_output_mode must be 'scaled_candidate' or 'blend'"
            )
        if max_depth < 1:
            raise ValueError("max_depth must be positive")
        if generation_strategy not in {
            GENERATION_UNIFORM,
            GENERATION_UTILITY,
            GENERATION_MUTATION,
            GENERATION_RESIDUAL_IMPRINT,
            GENERATION_RECURSIVE_PRODUCT,
            GENERATION_ROBUST_RECURSIVE,
        }:
            raise ValueError(
                "generation_strategy must be one of "
                "'uniform', 'utility', 'mutation', 'residual_imprint', "
                "'recursive_product', or 'robust_recursive'"
            )
        if parent_temperature <= 0.0:
            raise ValueError("parent_temperature must be positive")
        if parent_novelty_weight < 0.0:
            raise ValueError("parent_novelty_weight must be non-negative")
        if parent_depth_prior < 0.0:
            raise ValueError("parent_depth_prior must be non-negative")
        if retention_depth_bonus < 0.0:
            raise ValueError("retention_depth_bonus must be non-negative")
        if residual_guidance < 0.0:
            raise ValueError("residual_guidance must be non-negative")
        if candidate_imprint_scale < 0.0:
            raise ValueError("candidate_imprint_scale must be non-negative")
        if signed_tanh_scaffold_count < 0:
            raise ValueError("signed_tanh_scaffold_count must be non-negative")
        if not 0.0 <= future_utility_mix <= 1.0:
            raise ValueError("future_utility_mix must be in [0, 1]")
        if not 0.0 <= future_utility_trace_decay < 1.0:
            raise ValueError("future_utility_trace_decay must be in [0, 1)")
        if future_utility_trace_mode not in {"contribution", "marginal"}:
            raise ValueError(
                "future_utility_trace_mode must be 'contribution' or 'marginal'"
            )
        if future_utility_normalization not in {
            "none",
            "age",
            "uncertainty",
            "uncertainty_age",
        }:
            raise ValueError(
                "future_utility_normalization must be one of "
                "'none', 'age', 'uncertainty', or 'uncertainty_age'"
            )
        if not 0.0 <= future_utility_normalization_decay < 1.0:
            raise ValueError("future_utility_normalization_decay must be in [0, 1)")
        if future_utility_rare_task_power < 0.0:
            raise ValueError("future_utility_rare_task_power must be non-negative")
        if not 0.0 <= future_utility_task_activity_decay < 1.0:
            raise ValueError("future_utility_task_activity_decay must be in [0, 1)")
        if candidate_scoring_mode not in {"legacy", "energy_novelty"}:
            raise ValueError(
                "candidate_scoring_mode must be 'legacy' or 'energy_novelty'"
            )
        if not 0.0 <= candidate_score_trace_decay < 1.0:
            raise ValueError("candidate_score_trace_decay must be in [0, 1)")
        if candidate_score_energy_epsilon <= 0.0:
            raise ValueError("candidate_score_energy_epsilon must be positive")
        if not 0.0 <= candidate_novelty_weight <= 1.0:
            raise ValueError("candidate_novelty_weight must be in [0, 1]")
        if candidate_novelty_power <= 0.0:
            raise ValueError("candidate_novelty_power must be positive")
        if not 0.0 <= candidate_novelty_floor <= 1.0:
            raise ValueError("candidate_novelty_floor must be in [0, 1]")
        if candidate_selector not in {
            CANDIDATE_SELECTOR_LEGACY,
            CANDIDATE_SELECTOR_HEDGE,
            CANDIDATE_SELECTOR_EXP3,
        }:
            raise ValueError("candidate_selector must be 'legacy', 'hedge', or 'exp3'")
        if candidate_selector != CANDIDATE_SELECTOR_LEGACY and candidate_count < 1:
            raise ValueError("candidate_selector requires candidate_count > 0")
        if candidate_selector_learning_rate <= 0.0:
            raise ValueError("candidate_selector_learning_rate must be positive")
        if not 0.0 <= candidate_selector_exploration < 1.0:
            raise ValueError("candidate_selector_exploration must be in [0, 1)")
        if (
            candidate_selector == CANDIDATE_SELECTOR_EXP3
            and candidate_selector_exploration <= 0.0
        ):
            raise ValueError("exp3 candidate_selector requires positive exploration")
        if not 0.0 <= retention_slow_utility_decay < 1.0:
            raise ValueError("retention_slow_utility_decay must be in [0, 1)")
        if retention_tanh_min_count < 0:
            raise ValueError("retention_tanh_min_count must be non-negative")
        if retention_product_min_count < 0:
            raise ValueError("retention_product_min_count must be non-negative")
        if operation_prior is not None:
            if len(operation_prior) != NUM_OPS:
                raise ValueError("operation_prior must have one entry per op")
            if any(prob < 0.0 for prob in operation_prior):
                raise ValueError("operation_prior entries must be non-negative")
            if sum(operation_prior) <= 0.0:
                raise ValueError("operation_prior must have positive mass")
        if generator_resource_contexts < 1:
            raise ValueError("generator_resource_contexts must be positive")
        if generator_resource_learning_rate < 0.0:
            raise ValueError("generator_resource_learning_rate must be non-negative")
        if not 0.0 <= generator_resource_discount <= 1.0:
            raise ValueError("generator_resource_discount must be in [0, 1]")
        if not 0.0 <= generator_resource_exploration < 1.0:
            raise ValueError("generator_resource_exploration must be in [0, 1)")
        if generator_resource_advantage_clip <= 0.0:
            raise ValueError("generator_resource_advantage_clip must be positive")
        if generator_resource_cost_weight < 0.0:
            raise ValueError("generator_resource_cost_weight must be non-negative")
        if generator_resource_update_rule not in {"hedge", "exp3"}:
            raise ValueError("generator_resource_update_rule must be 'hedge' or 'exp3'")
        if generator_resource_promotion_credit < 0.0:
            raise ValueError("generator_resource_promotion_credit must be non-negative")
        if (
            generator_resource_initial_preferences is not None
            and len(generator_resource_initial_preferences)
            != len(DEFAULT_GENERATOR_META_POLICY_NAMES)
        ):
            raise ValueError(
                "generator_resource_initial_preferences must match the default "
                "generator policy count"
            )

        self._n_features = n_features
        self._n_tasks = n_tasks
        self._candidate_count = candidate_count
        self._step_size_output = step_size_output
        self._step_size_theta = step_size_theta
        self._utility_decay = utility_decay
        self._replacement_interval = replacement_interval
        self._min_feature_age = min_feature_age
        self._candidate_min_age = candidate_min_age
        self._promotion_margin = promotion_margin
        self._promotion_blend = promotion_blend
        self._promotion_output_mode = promotion_output_mode
        self._max_depth = max_depth
        self._use_obgd = use_obgd
        self._obgd_kappa = obgd_kappa
        self._generation_strategy = generation_strategy
        self._parent_temperature = parent_temperature
        self._parent_novelty_weight = parent_novelty_weight
        self._parent_depth_prior = parent_depth_prior
        self._retention_depth_bonus = retention_depth_bonus
        self._residual_guidance = residual_guidance
        self._candidate_imprint_scale = candidate_imprint_scale
        self._train_candidate_theta = train_candidate_theta
        self._signed_tanh_scaffold_count = signed_tanh_scaffold_count
        self._future_utility_mix = future_utility_mix
        self._future_utility_trace_decay = future_utility_trace_decay
        self._future_utility_trace_mode = future_utility_trace_mode
        self._future_utility_normalization = future_utility_normalization
        self._future_utility_normalization_decay = future_utility_normalization_decay
        self._future_utility_rare_task_power = future_utility_rare_task_power
        self._future_utility_task_activity_decay = future_utility_task_activity_decay
        self._candidate_scoring_mode = candidate_scoring_mode
        self._candidate_score_trace_decay = candidate_score_trace_decay
        self._candidate_score_energy_epsilon = candidate_score_energy_epsilon
        self._candidate_novelty_weight = candidate_novelty_weight
        self._candidate_novelty_power = candidate_novelty_power
        self._candidate_novelty_floor = candidate_novelty_floor
        self._candidate_selector_mode = candidate_selector
        self._candidate_selector_learning_rate = candidate_selector_learning_rate
        self._candidate_selector_exploration = candidate_selector_exploration
        self._candidate_selector = (
            None
            if candidate_selector == CANDIDATE_SELECTOR_LEGACY
            else FiniteCandidateSelector(
                n_candidates=candidate_count,
                learning_rate=candidate_selector_learning_rate,
                exploration=candidate_selector_exploration,
                update_rule=candidate_selector,
            )
        )
        self._retention_slow_utility_decay = retention_slow_utility_decay
        self._retention_tanh_min_count = retention_tanh_min_count
        self._retention_product_min_count = retention_product_min_count
        self._operation_prior = operation_prior
        self._learn_generator_resources = learn_generator_resources
        self._generator_resource_contexts = generator_resource_contexts
        self._generator_resource_learning_rate = generator_resource_learning_rate
        self._generator_resource_discount = generator_resource_discount
        self._generator_resource_exploration = generator_resource_exploration
        self._generator_resource_advantage_clip = generator_resource_advantage_clip
        self._generator_resource_cost_weight = generator_resource_cost_weight
        self._generator_resource_update_rule = generator_resource_update_rule
        self._generator_resource_promotion_credit = generator_resource_promotion_credit
        self._generator_resource_initial_preferences = (
            generator_resource_initial_preferences
        )
        self._generator_resource_manager = GeneratorMetaResourceManager(
            policy_names=DEFAULT_GENERATOR_META_POLICY_NAMES,
            op_ids=DEFAULT_GENERATOR_META_OP_IDS,
            parent_modes=DEFAULT_GENERATOR_META_PARENT_MODES,
            replacement_multipliers=DEFAULT_GENERATOR_META_REPLACEMENT_MULTIPLIERS,
            promotion_margin_multipliers=(
                DEFAULT_GENERATOR_META_PROMOTION_MARGIN_MULTIPLIERS
            ),
            candidate_min_age_multipliers=(
                DEFAULT_GENERATOR_META_CANDIDATE_MIN_AGE_MULTIPLIERS
            ),
            imprint_scales=DEFAULT_GENERATOR_META_IMPRINT_SCALES,
            n_contexts=generator_resource_contexts,
            learning_rate=generator_resource_learning_rate,
            discount=generator_resource_discount,
            exploration=generator_resource_exploration,
            cost_weight=generator_resource_cost_weight,
            advantage_clip=generator_resource_advantage_clip,
            update_rule=generator_resource_update_rule,
            initial_preferences=generator_resource_initial_preferences,
        )

    @property
    def n_features(self) -> int:
        """Number of active features."""
        return self._n_features

    @property
    def n_tasks(self) -> int:
        """Number of output tasks."""
        return self._n_tasks

    @property
    def max_depth(self) -> int:
        """Maximum allowed topological depth."""
        return self._max_depth

    def to_config(self) -> dict[str, Any]:
        """Serialize learner configuration."""
        return {
            "type": "CompositionalFeatureLearner",
            "n_features": self._n_features,
            "n_tasks": self._n_tasks,
            "candidate_count": self._candidate_count,
            "step_size_output": self._step_size_output,
            "step_size_theta": self._step_size_theta,
            "utility_decay": self._utility_decay,
            "replacement_interval": self._replacement_interval,
            "min_feature_age": self._min_feature_age,
            "candidate_min_age": self._candidate_min_age,
            "promotion_margin": self._promotion_margin,
            "promotion_blend": self._promotion_blend,
            "promotion_output_mode": self._promotion_output_mode,
            "max_depth": self._max_depth,
            "use_obgd": self._use_obgd,
            "obgd_kappa": self._obgd_kappa,
            "generation_strategy": self._generation_strategy,
            "parent_temperature": self._parent_temperature,
            "parent_novelty_weight": self._parent_novelty_weight,
            "parent_depth_prior": self._parent_depth_prior,
            "retention_depth_bonus": self._retention_depth_bonus,
            "residual_guidance": self._residual_guidance,
            "candidate_imprint_scale": self._candidate_imprint_scale,
            "train_candidate_theta": self._train_candidate_theta,
            "signed_tanh_scaffold_count": self._signed_tanh_scaffold_count,
            "future_utility_mix": self._future_utility_mix,
            "future_utility_trace_decay": self._future_utility_trace_decay,
            "future_utility_trace_mode": self._future_utility_trace_mode,
            "future_utility_normalization": self._future_utility_normalization,
            "future_utility_normalization_decay": (
                self._future_utility_normalization_decay
            ),
            "future_utility_rare_task_power": self._future_utility_rare_task_power,
            "future_utility_task_activity_decay": (
                self._future_utility_task_activity_decay
            ),
            "candidate_scoring_mode": self._candidate_scoring_mode,
            "candidate_score_trace_decay": self._candidate_score_trace_decay,
            "candidate_score_energy_epsilon": (
                self._candidate_score_energy_epsilon
            ),
            "candidate_novelty_weight": self._candidate_novelty_weight,
            "candidate_novelty_power": self._candidate_novelty_power,
            "candidate_novelty_floor": self._candidate_novelty_floor,
            "candidate_selector": self._candidate_selector_mode,
            "candidate_selector_learning_rate": (
                self._candidate_selector_learning_rate
            ),
            "candidate_selector_exploration": self._candidate_selector_exploration,
            "retention_slow_utility_decay": self._retention_slow_utility_decay,
            "retention_tanh_min_count": self._retention_tanh_min_count,
            "retention_product_min_count": self._retention_product_min_count,
            "operation_prior": (
                None if self._operation_prior is None else list(self._operation_prior)
            ),
            "learn_generator_resources": self._learn_generator_resources,
            "generator_resource_contexts": self._generator_resource_contexts,
            "generator_resource_learning_rate": (
                self._generator_resource_learning_rate
            ),
            "generator_resource_discount": self._generator_resource_discount,
            "generator_resource_exploration": self._generator_resource_exploration,
            "generator_resource_advantage_clip": (
                self._generator_resource_advantage_clip
            ),
            "generator_resource_cost_weight": self._generator_resource_cost_weight,
            "generator_resource_update_rule": self._generator_resource_update_rule,
            "generator_resource_promotion_credit": (
                self._generator_resource_promotion_credit
            ),
            "generator_resource_initial_preferences": (
                None
                if self._generator_resource_initial_preferences is None
                else list(self._generator_resource_initial_preferences)
            ),
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> "CompositionalFeatureLearner":
        """Reconstruct learner from ``to_config`` output."""
        config = dict(config)
        config.pop("type", None)
        return cls(**config)

    def _init_active_slot(
        self,
        slot: int,
        key: Array,
        feature_dim: int,
    ) -> tuple[int, int, int, Array, int]:
        """Generate Python-side initialization for one composed slot.

        Used by ``init`` to set up randomly composed features above the
        raw-input prefix.  Returns ``(op, parent_a, parent_b, theta, depth)``
        as plain Python / JAX arrays of static shapes.
        """
        # Choose an op uniformly from the composing ops (skip OP_RAW).
        sub_keys = jr.split(key, 3)
        op_key, parent_key, theta_key = sub_keys
        op = int(jr.randint(op_key, (), 1, NUM_OPS))
        # Pick parents uniformly from earlier slots.  At minimum, we have
        # the raw-input prefix [0, feature_dim) and any earlier composed
        # slots [feature_dim, slot).
        max_parent = max(slot, 1)
        parents = jr.randint(parent_key, (2,), 0, max_parent)
        a = int(parents[0])
        b = int(parents[1])
        theta = 0.5 * jr.normal(theta_key, (2,), dtype=jnp.float32)
        # Depth is computed from parents in init below; return a neutral
        # seed value here and let init compute the precise depth array.
        return op, a, b, theta, 1

    def init(self, feature_dim: int, key: Array) -> CompositionalFeatureState:
        """Initialize the active and candidate banks.

        The first ``feature_dim`` slots are ``OP_RAW`` features that simply
        expose raw observation entries.  Remaining active slots are random
        compositions of earlier slots; candidates are similarly random
        compositions of the active raw-input slots.
        """
        if feature_dim < 1:
            raise ValueError("feature_dim must be positive")
        if self._n_features < feature_dim:
            raise ValueError(
                "n_features must be at least feature_dim so raw-input slots fit"
            )

        n_features = self._n_features

        # Active slot fields, built in Python with static shapes.
        ops = [OP_RAW] * n_features
        parent_a = list(range(feature_dim)) + [0] * (n_features - feature_dim)
        parent_b = [-1] * n_features
        depth = [0] * n_features
        theta_arr = jnp.zeros((n_features, 2), dtype=jnp.float32)

        key, theta_key = jr.split(key)
        # Pre-allocate randomness for composed slots.
        comp_count = n_features - feature_dim
        if comp_count > 0:
            theta_arr = theta_arr.at[feature_dim:].set(
                0.5 * jr.normal(theta_key, (comp_count, 2), dtype=jnp.float32)
            )

        for slot in range(feature_dim, n_features):
            key, slot_key = jr.split(key)
            op_key, parent_key = jr.split(slot_key)
            if self._generation_strategy in {
                GENERATION_RECURSIVE_PRODUCT,
                GENERATION_ROBUST_RECURSIVE,
            }:
                pair_parents = [
                    (left, right)
                    for left in range(feature_dim)
                    for right in range(left + 1, feature_dim)
                ]
                if self._generation_strategy == GENERATION_ROBUST_RECURSIVE:
                    pair_parents = [
                        *pair_parents,
                        *((idx, idx) for idx in range(feature_dim)),
                    ]
                if pair_parents:
                    offset = slot - feature_dim
                    if offset < len(pair_parents) or self._max_depth < 2:
                        a, b = pair_parents[offset % len(pair_parents)]
                        ops[slot] = OP_PRODUCT
                    elif (
                        self._generation_strategy == GENERATION_ROBUST_RECURSIVE
                        and offset
                        < len(pair_parents) + self._signed_tanh_scaffold_count
                    ):
                        signed_pairs = [
                            (left, right, sign_a, sign_b)
                            for left in range(feature_dim)
                            for right in range(left + 1, feature_dim)
                            for sign_a, sign_b in (
                                (1.0, -1.0),
                                (-1.0, 1.0),
                                (1.0, 1.0),
                                (-1.0, -1.0),
                            )
                        ]
                        tanh_offset = offset - len(pair_parents)
                        left, right, sign_a, sign_b = signed_pairs[
                            tanh_offset % len(signed_pairs)
                        ]
                        a, b = left, right
                        ops[slot] = OP_TANH
                        theta_arr = theta_arr.at[slot].set(
                            jnp.array([sign_a, sign_b], dtype=jnp.float32)
                        )
                    else:
                        depth_offset = (
                            offset
                            - len(pair_parents)
                            - (
                                self._signed_tanh_scaffold_count
                                if self._generation_strategy
                                == GENERATION_ROBUST_RECURSIVE
                                else 0
                            )
                        )
                        pair_slot = feature_dim + depth_offset % len(pair_parents)
                        raw_parent = (
                            depth_offset // len(pair_parents)
                        ) % feature_dim
                        a, b = pair_slot, raw_parent
                        ops[slot] = (
                            OP_PRODUCT
                            if self._generation_strategy
                            == GENERATION_ROBUST_RECURSIVE
                            else OP_SUM
                        )
                else:
                    a, b = 0, 0
                    ops[slot] = OP_PRODUCT
            else:
                ops[slot] = int(jr.randint(op_key, (), 1, NUM_OPS))
                # Parents must have a strictly smaller slot index; this gives a
                # valid topological order under index iteration.  Restrict to
                # those whose depth + 1 stays within max_depth.
                max_parent_excl = slot
                eligible = [
                    p
                    for p in range(max_parent_excl)
                    if depth[p] + 1 <= self._max_depth
                ]
                if not eligible:
                    # Fall back to a raw-input slot.
                    eligible = list(range(min(feature_dim, max_parent_excl)))
                    if not eligible:
                        eligible = [0]
                choices = jr.randint(parent_key, (2,), 0, len(eligible))
                a = eligible[int(choices[0])]
                b = eligible[int(choices[1])]
            parent_a[slot] = a
            parent_b[slot] = b
            depth[slot] = max(depth[a], depth[b]) + 1

        active_state = {
            "ops": jnp.asarray(ops, dtype=jnp.int32),
            "parent_a": jnp.asarray(parent_a, dtype=jnp.int32),
            "parent_b": jnp.asarray(parent_b, dtype=jnp.int32),
            "theta": theta_arr,
            "depth": jnp.asarray(depth, dtype=jnp.int32),
        }

        # Candidates: each candidate is a random composition referring to
        # active feature slots only.  Their "depth" is recorded as one more
        # than the max of the referenced active depths so promotion can
        # later check the depth budget.
        cand_count = self._candidate_count
        cand_ops = [OP_RAW] * cand_count
        cand_parent_a = [0] * cand_count
        cand_parent_b = [-1] * cand_count
        cand_depth = [0] * cand_count
        cand_theta = jnp.zeros((cand_count, 2), dtype=jnp.float32)
        if cand_count > 0:
            key, cand_theta_key = jr.split(key)
            cand_theta = 0.5 * jr.normal(cand_theta_key, (cand_count, 2), dtype=jnp.float32)
            for i in range(cand_count):
                key, c_key = jr.split(key)
                op_key, parent_key = jr.split(c_key)
                if self._generation_strategy in {
                    GENERATION_RECURSIVE_PRODUCT,
                    GENERATION_ROBUST_RECURSIVE,
                }:
                    composed_parents = [
                        p
                        for p in range(feature_dim, n_features)
                        if 1 <= depth[p] + 1 <= self._max_depth
                    ]
                    raw_parents = list(range(feature_dim))
                    if composed_parents and raw_parents:
                        a = composed_parents[i % len(composed_parents)]
                        b = raw_parents[(i // len(composed_parents)) % len(raw_parents)]
                    else:
                        a, b = 0, 0
                    cand_ops[i] = OP_PRODUCT
                else:
                    cand_ops[i] = int(jr.randint(op_key, (), 1, NUM_OPS))
                    # Candidates pull parents from active slots only.
                    eligible = [
                        p
                        for p in range(n_features)
                        if depth[p] + 1 <= self._max_depth
                    ]
                    if not eligible:
                        eligible = list(range(feature_dim))
                    choices = jr.randint(parent_key, (2,), 0, len(eligible))
                    a = eligible[int(choices[0])]
                    b = eligible[int(choices[1])]
                cand_parent_a[i] = a
                cand_parent_b[i] = b
                cand_depth[i] = max(depth[a], depth[b]) + 1

        return CompositionalFeatureState(
            key=key,
            ops=active_state["ops"],
            parent_a=active_state["parent_a"],
            parent_b=active_state["parent_b"],
            theta=active_state["theta"],
            depth=active_state["depth"],
            output_weights=jnp.zeros(
                (self._n_tasks, n_features), dtype=jnp.float32
            ),
            output_bias=jnp.zeros(self._n_tasks, dtype=jnp.float32),
            utilities=jnp.zeros(n_features, dtype=jnp.float32),
            utility_contribution_trace=jnp.zeros(
                (self._n_tasks, n_features), dtype=jnp.float32
            ),
            utility_error_trace=jnp.zeros(self._n_tasks, dtype=jnp.float32),
            utility_feature_trace=jnp.zeros(n_features, dtype=jnp.float32),
            utility_feature_energy_trace=jnp.zeros(n_features, dtype=jnp.float32),
            utility_signal_second_moment=jnp.zeros(n_features, dtype=jnp.float32),
            feature_score_residual_trace=jnp.zeros(
                (self._n_tasks, n_features), dtype=jnp.float32
            ),
            feature_score_energy_trace=jnp.zeros(n_features, dtype=jnp.float32),
            retention_slow_utilities=jnp.zeros(n_features, dtype=jnp.float32),
            task_activity_ema=jnp.zeros(self._n_tasks, dtype=jnp.float32),
            ages=jnp.zeros(n_features, dtype=jnp.int32),
            candidate_ops=jnp.asarray(cand_ops, dtype=jnp.int32),
            candidate_parent_a=jnp.asarray(cand_parent_a, dtype=jnp.int32),
            candidate_parent_b=jnp.asarray(cand_parent_b, dtype=jnp.int32),
            candidate_theta=cand_theta,
            candidate_depth=jnp.asarray(cand_depth, dtype=jnp.int32),
            candidate_output_weights=jnp.zeros(
                (self._n_tasks, cand_count), dtype=jnp.float32
            ),
            candidate_utilities=jnp.zeros(cand_count, dtype=jnp.float32),
            candidate_utility_contribution_trace=jnp.zeros(
                (self._n_tasks, cand_count), dtype=jnp.float32
            ),
            candidate_utility_feature_trace=jnp.zeros(
                cand_count, dtype=jnp.float32
            ),
            candidate_utility_feature_energy_trace=jnp.zeros(
                cand_count, dtype=jnp.float32
            ),
            candidate_utility_signal_second_moment=jnp.zeros(
                cand_count, dtype=jnp.float32
            ),
            candidate_score_residual_trace=jnp.zeros(
                (self._n_tasks, cand_count), dtype=jnp.float32
            ),
            candidate_score_energy_trace=jnp.zeros(cand_count, dtype=jnp.float32),
            candidate_retention_slow_utilities=jnp.zeros(
                cand_count, dtype=jnp.float32
            ),
            candidate_active_correlation_trace=jnp.zeros(
                (cand_count, n_features), dtype=jnp.float32
            ),
            candidate_ages=jnp.zeros(cand_count, dtype=jnp.int32),
            candidate_selector_log_weights=jnp.zeros(cand_count, dtype=jnp.float32),
            candidate_selector_cumulative_loss=jnp.zeros(
                cand_count, dtype=jnp.float32
            ),
            candidate_selector_action_counts=jnp.zeros(
                cand_count, dtype=jnp.float32
            ),
            feature_generator_policy=jnp.zeros(n_features, dtype=jnp.int32),
            candidate_generator_policy=jnp.zeros(cand_count, dtype=jnp.int32),
            generator_resource_state=self._generator_resource_manager.init(),
            replacement_accumulator=jnp.array(0.0, dtype=jnp.float32),
            step_count=jnp.array(0, dtype=jnp.int32),
            birth_timestamp=time.time(),
            uptime_s=0.0,
        )

    def _candidate_features(
        self,
        state: CompositionalFeatureState,
        active_values: Array,
        observation: Array,
    ) -> Array:
        """Compute candidate feature values by referencing active slots.

        Candidate parents always point into the active feature bank, so each
        candidate is evaluated as a single op over those active values plus,
        for ``OP_RAW`` candidates, the raw observation directly.
        """
        feature_dim = observation.shape[0]
        n_features = self._n_features
        cand_count = self._candidate_count
        if cand_count == 0:
            return jnp.zeros((0,), dtype=jnp.float32)

        safe_a_obs = jnp.clip(state.candidate_parent_a, 0, feature_dim - 1)
        safe_a_feat = jnp.clip(state.candidate_parent_a, 0, n_features - 1)
        safe_b_feat = jnp.clip(state.candidate_parent_b, 0, n_features - 1)

        raw = observation[safe_a_obs]
        val_a = active_values[safe_a_feat]
        val_b = jnp.where(
            state.candidate_parent_b >= 0,
            active_values[safe_b_feat],
            0.0,
        )

        product = val_a * val_b
        summ = val_a + val_b
        pre_tanh = (
            state.candidate_theta[:, 0] * val_a
            + state.candidate_theta[:, 1] * val_b
        )
        tanh_val = jnp.tanh(pre_tanh)
        gated = val_a * jax.nn.sigmoid(val_b)

        ops = state.candidate_ops
        values = jnp.select(
            [
                ops == OP_RAW,
                ops == OP_PRODUCT,
                ops == OP_SUM,
                ops == OP_TANH,
                ops == OP_GATED,
            ],
            [raw, product, summ, tanh_val, gated],
            default=jnp.zeros(cand_count, dtype=jnp.float32),
        )
        return jnp.clip(values, -FEATURE_VALUE_CLIP, FEATURE_VALUE_CLIP)

    def _strategy_parent_mode(self) -> Array:
        """Return the parent-selection mode for the fixed generation strategy."""
        if self._generation_strategy == GENERATION_UNIFORM:
            mode = PARENT_MODE_UNIFORM
        elif self._generation_strategy == GENERATION_MUTATION:
            mode = PARENT_MODE_MUTATION
        elif self._generation_strategy in {
            GENERATION_RESIDUAL_IMPRINT,
            GENERATION_ROBUST_RECURSIVE,
        }:
            mode = PARENT_MODE_RESIDUAL_IMPRINT
        else:
            mode = PARENT_MODE_UTILITY
        return jnp.array(mode, dtype=jnp.int32)

    def _op_logits(self, forced_op: Array | None = None) -> Array:
        """Return generation logits for composing op types."""
        if forced_op is not None:
            op_ids = jnp.arange(NUM_OPS, dtype=jnp.int32)
            return jnp.where(op_ids == forced_op, 0.0, -1e9)
        if self._operation_prior is not None:
            probs = jnp.asarray(self._operation_prior, dtype=jnp.float32)
            probs = probs / jnp.sum(probs)
            return jnp.log(probs + 1e-8)
        if self._generation_strategy == GENERATION_RECURSIVE_PRODUCT:
            probs = jnp.array([0.0, 1.0, 0.0, 0.0, 0.0], dtype=jnp.float32)
            return jnp.log(probs + 1e-8)
        if self._generation_strategy == GENERATION_ROBUST_RECURSIVE:
            probs = jnp.array([0.0, 0.5, 0.1, 0.3, 0.1], dtype=jnp.float32)
            return jnp.log(probs + 1e-8)
        if self._generation_strategy == GENERATION_MUTATION:
            probs = jnp.array([0.0, 0.55, 0.15, 0.15, 0.15], dtype=jnp.float32)
        elif self._generation_strategy == GENERATION_RESIDUAL_IMPRINT:
            probs = jnp.array([0.0, 0.35, 0.15, 0.35, 0.15], dtype=jnp.float32)
        else:
            probs = jnp.array([0.0, 0.4, 0.2, 0.2, 0.2], dtype=jnp.float32)
        return jnp.log(probs + 1e-8)

    def _parent_logits(
        self,
        eligible: Array,
        utilities: Array,
        feature_values: Array | None = None,
        feature_credit: Array | None = None,
        depth: Array | None = None,
        ages: Array | None = None,
        parent_mode: Array | None = None,
    ) -> Array:
        """Return masked parent logits for the configured search strategy."""
        mode = self._strategy_parent_mode() if parent_mode is None else parent_mode
        uniform_logits = jnp.zeros_like(utilities, dtype=jnp.float32)
        utility_scores = utilities + 1e-3
        residual_scores = jnp.zeros_like(utilities, dtype=jnp.float32)
        if feature_values is not None and feature_credit is not None:
            residual_scores = jnp.abs(feature_credit) + 0.05 * jnp.abs(feature_values)
        novelty_scores = jnp.zeros_like(utilities, dtype=jnp.float32)
        if self._parent_novelty_weight > 0.0:
            inverse_utility = 1.0 / jnp.sqrt(jnp.maximum(utility_scores, 1e-6))
            age_bonus = jnp.zeros_like(utilities, dtype=jnp.float32)
            if ages is not None:
                age_bonus = 1.0 / jnp.sqrt(ages.astype(jnp.float32) + 1.0)
            novelty_scores = self._parent_novelty_weight * (
                0.5 * inverse_utility + age_bonus
            )
        depth_scores = jnp.zeros_like(utilities, dtype=jnp.float32)
        if self._parent_depth_prior > 0.0 and depth is not None:
            depth_scores = self._parent_depth_prior * jnp.log1p(
                depth.astype(jnp.float32)
            )
        guided_scores = (
            utility_scores
            + self._residual_guidance * residual_scores
            + novelty_scores
            + depth_scores
        )
        utility_logits = (
            jnp.log(jnp.maximum(utility_scores, 1e-6)) / self._parent_temperature
        )
        residual_logits = (
            jnp.log(jnp.maximum(guided_scores, 1e-6)) / self._parent_temperature
        )
        logits = jnp.select(
            [
                mode == PARENT_MODE_UNIFORM,
                mode == PARENT_MODE_RESIDUAL_IMPRINT,
            ],
            [uniform_logits, residual_logits],
            default=utility_logits,
        )
        return jnp.where(eligible, logits, -1e9)

    def _partner_logits(
        self,
        eligible: Array,
        depth: Array,
        utilities: Array,
        ages: Array | None = None,
        parent_mode: Array | None = None,
    ) -> Array:
        """Return logits for the second parent in mutation-like strategies."""
        mode = self._strategy_parent_mode() if parent_mode is None else parent_mode
        shallow_logits = jnp.where(eligible, -0.25 * depth.astype(jnp.float32), -1e9)
        default_logits = self._parent_logits(
            eligible,
            utilities,
            depth=depth,
            ages=ages,
            parent_mode=mode,
        )
        return jnp.where(
            (mode == PARENT_MODE_MUTATION) | (mode == PARENT_MODE_RESIDUAL_IMPRINT),
            shallow_logits,
            default_logits,
        )

    def _candidate_value_from_parts(
        self,
        op: Array,
        parent_a: Array,
        parent_b: Array,
        theta: Array,
        active_values: Array,
        observation: Array,
    ) -> Array:
        """Evaluate one generated candidate against the current observation."""
        feature_dim = observation.shape[0]
        safe_a_obs = jnp.clip(parent_a, 0, feature_dim - 1)
        safe_a_feat = jnp.clip(parent_a, 0, self._n_features - 1)
        safe_b_feat = jnp.clip(parent_b, 0, self._n_features - 1)

        raw = observation[safe_a_obs]
        val_a = active_values[safe_a_feat]
        val_b = jnp.where(parent_b >= 0, active_values[safe_b_feat], 0.0)
        product = val_a * val_b
        summ = val_a + val_b
        tanh_val = jnp.tanh(theta[0] * val_a + theta[1] * val_b)
        gated = val_a * jax.nn.sigmoid(val_b)

        value = jnp.select(
            [
                op == OP_RAW,
                op == OP_PRODUCT,
                op == OP_SUM,
                op == OP_TANH,
                op == OP_GATED,
            ],
            [raw, product, summ, tanh_val, gated],
            default=jnp.array(0.0, dtype=jnp.float32),
        )
        return jnp.clip(value, -FEATURE_VALUE_CLIP, FEATURE_VALUE_CLIP)

    def _initial_candidate_output_weights(
        self,
        op: Array,
        parent_a: Array,
        parent_b: Array,
        theta: Array,
        active_values: Array,
        observation: Array,
        errors: Array,
        active_count: Array,
        imprint_scale: Array | None = None,
    ) -> Array:
        """Initialize fresh candidate output weights from the current residual."""
        scale = (
            jnp.asarray(self._candidate_imprint_scale, dtype=jnp.float32)
            if imprint_scale is None
            else imprint_scale
        )
        if self._candidate_imprint_scale == 0.0 and imprint_scale is None:
            return jnp.zeros((self._n_tasks,), dtype=jnp.float32)
        candidate_value = self._candidate_value_from_parts(
            op,
            parent_a,
            parent_b,
            theta,
            active_values,
            observation,
        )
        denom = candidate_value * candidate_value + 1.0
        return (
            scale
            * errors
            * candidate_value
            / (denom * active_count)
        )

    def _promoted_output_weights(
        self,
        active_weights: Array,
        candidate_weights: Array,
    ) -> Array:
        """Compute output weights for a promoted candidate slot."""
        if self._promotion_output_mode == PROMOTION_BLEND:
            return (
                (1.0 - self._promotion_blend) * active_weights
                + self._promotion_blend * candidate_weights
            )
        return self._promotion_blend * candidate_weights

    def _future_utility_signal(
        self,
        errors: Array,
        feature_values: Array,
        active_mask: Array,
        active_count: Array,
        task_activity_ema: Array,
        contribution_trace: Array,
        error_trace: Array,
        feature_trace: Array,
        feature_energy_trace: Array,
    ) -> tuple[Array, Array, Array, Array, Array]:
        """Predict traced output-loss reduction for each feature slot."""
        if self._future_utility_trace_mode == "marginal":
            (
                reductions,
                new_error_trace,
                new_feature_trace,
                new_feature_energy_trace,
            ) = trace_output_loss_reduction(
                errors,
                feature_values,
                active_mask,
                self._step_size_output,
                active_count,
                error_trace,
                feature_trace,
                feature_energy_trace,
                self._future_utility_trace_decay,
            )
            new_contribution_trace = contribution_trace
        else:
            reductions, new_contribution_trace, new_feature_energy_trace = (
                contribution_trace_output_loss_reduction(
                    errors,
                    feature_values,
                    active_mask,
                    self._step_size_output,
                    active_count,
                    contribution_trace,
                    feature_energy_trace,
                    self._future_utility_trace_decay,
                )
            )
            new_error_trace = error_trace
            new_feature_trace = feature_trace
        if self._future_utility_rare_task_power > 0.0:
            frequency_floor = jnp.array(
                1.0 - self._future_utility_task_activity_decay,
                dtype=jnp.float32,
            )
            rare_weights = jnp.power(
                1.0 / jnp.maximum(task_activity_ema, frequency_floor),
                self._future_utility_rare_task_power,
            )
            reductions = reductions * rare_weights[:, None]
        return (
            jnp.mean(reductions, axis=0),
            new_contribution_trace,
            new_error_trace,
            new_feature_trace,
            new_feature_energy_trace,
        )

    def _candidate_future_utility_signal(
        self,
        errors: Array,
        feature_values: Array,
        active_mask: Array,
        active_count: Array,
        task_activity_ema: Array,
        contribution_trace: Array,
        error_trace: Array,
        feature_trace: Array,
        feature_energy_trace: Array,
    ) -> tuple[Array, Array, Array, Array]:
        """Predict traced output-loss reduction for candidate slots."""
        if self._future_utility_trace_mode == "marginal":
            reductions, _, new_feature_trace, new_feature_energy_trace = (
                trace_output_loss_reduction(
                    errors,
                    feature_values,
                    active_mask,
                    self._step_size_output,
                    active_count,
                    error_trace,
                    feature_trace,
                    feature_energy_trace,
                    self._future_utility_trace_decay,
                )
            )
            new_contribution_trace = contribution_trace
        else:
            reductions, new_contribution_trace, new_feature_energy_trace = (
                contribution_trace_output_loss_reduction(
                    errors,
                    feature_values,
                    active_mask,
                    self._step_size_output,
                    active_count,
                    contribution_trace,
                    feature_energy_trace,
                    self._future_utility_trace_decay,
                )
            )
            new_feature_trace = feature_trace
        if self._future_utility_rare_task_power > 0.0:
            frequency_floor = jnp.array(
                1.0 - self._future_utility_task_activity_decay,
                dtype=jnp.float32,
            )
            rare_weights = jnp.power(
                1.0 / jnp.maximum(task_activity_ema, frequency_floor),
                self._future_utility_rare_task_power,
            )
            reductions = reductions * rare_weights[:, None]
        return (
            jnp.mean(reductions, axis=0),
            new_contribution_trace,
            new_feature_trace,
            new_feature_energy_trace,
        )

    def _mixed_utility_signal(
        self,
        current_signal: Array,
        future_signal: Array,
    ) -> Array:
        """Blend historical utility with causal predicted future utility."""
        if self._future_utility_mix == 0.0:
            return current_signal
        return (
            (1.0 - self._future_utility_mix) * current_signal
            + self._future_utility_mix * future_signal
        )

    def _retention_slow_utility(
        self,
        previous_slow_utility: Array,
        utility_signal: Array,
    ) -> Array:
        """Update opt-in slow utility for hysteretic deletion."""
        if self._retention_slow_utility_decay == 0.0:
            return previous_slow_utility
        decay = jnp.asarray(self._retention_slow_utility_decay, dtype=jnp.float32)
        return decay * previous_slow_utility + (1.0 - decay) * utility_signal

    def _retention_score(
        self,
        fast_utility: Array,
        slow_utility: Array,
    ) -> Array:
        """Return the utility score used for opt-in delayed deletion."""
        if self._retention_slow_utility_decay == 0.0:
            return fast_utility
        return jnp.maximum(fast_utility, slow_utility)

    def _energy_normalized_residual_score(
        self,
        errors: Array,
        feature_values: Array,
        residual_trace: Array,
        energy_trace: Array,
    ) -> tuple[Array, Array, Array]:
        """Return online matching-pursuit residual scores."""
        trace_decay = jnp.asarray(
            self._candidate_score_trace_decay, dtype=jnp.float32
        )
        new_residual_trace = (
            trace_decay * residual_trace + errors[:, None] * feature_values[None, :]
        )
        new_energy_trace = trace_decay * energy_trace + feature_values * feature_values
        score = jnp.mean(jnp.abs(new_residual_trace), axis=0) / jnp.sqrt(
            new_energy_trace + self._candidate_score_energy_epsilon
        )
        return score, new_residual_trace, new_energy_trace

    def _candidate_novelty_gate(
        self,
        candidate_feature_values: Array,
        active_feature_values: Array,
        candidate_energy_trace: Array,
        active_energy_trace: Array,
        candidate_active_correlation_trace: Array,
    ) -> tuple[Array, Array]:
        """Return correlation novelty gates for candidate utility scores."""
        trace_decay = jnp.asarray(
            self._candidate_score_trace_decay, dtype=jnp.float32
        )
        new_correlation_trace = (
            trace_decay * candidate_active_correlation_trace
            + candidate_feature_values[:, None] * active_feature_values[None, :]
        )
        denom = jnp.sqrt(
            candidate_energy_trace[:, None] * active_energy_trace[None, :]
            + self._candidate_score_energy_epsilon
        )
        correlations = jnp.clip(jnp.abs(new_correlation_trace) / denom, 0.0, 1.0)
        max_correlation = jnp.max(correlations, axis=1)
        novelty = 1.0 - max_correlation
        novelty_gate = jnp.power(
            jnp.clip(
                novelty,
                self._candidate_novelty_floor,
                1.0,
            ),
            self._candidate_novelty_power,
        )
        gate = (
            (1.0 - self._candidate_novelty_weight)
            + self._candidate_novelty_weight * novelty_gate
        )
        return gate, new_correlation_trace

    def _generator_policy_scores(
        self,
        utilities: Array,
        feature_generator_policy: Array,
        candidate_utilities: Array,
        candidate_generator_policy: Array,
    ) -> tuple[Array, Array]:
        """Return mean utility and availability mask per generator policy."""
        policy_ids = jnp.arange(
            self._generator_resource_manager.n_policies,
            dtype=jnp.int32,
        )
        active_matches = feature_generator_policy[None, :] == policy_ids[:, None]
        active_sums = jnp.sum(
            jnp.where(active_matches, utilities[None, :], 0.0),
            axis=1,
        )
        active_counts = jnp.sum(active_matches.astype(jnp.float32), axis=1)
        candidate_matches = (
            candidate_generator_policy[None, :] == policy_ids[:, None]
        )
        candidate_sums = jnp.sum(
            jnp.where(candidate_matches, candidate_utilities[None, :], 0.0),
            axis=1,
        )
        candidate_counts = jnp.sum(candidate_matches.astype(jnp.float32), axis=1)
        counts = active_counts + candidate_counts
        scores = (active_sums + candidate_sums) / jnp.maximum(counts, 1.0)
        return scores, counts > 0.0

    @functools.partial(jax.jit, static_argnums=(0,))
    def constructed_features(
        self,
        state: CompositionalFeatureState,
        observation: Array,
    ) -> Array:
        """Return active compositional feature values for ``observation``.

        These literal compositions are the Step 2 hand-off representation:
        downstream Horde or SARSA learners can consume them as fixed features.
        """
        return _compute_feature_values(
            state.ops,
            state.parent_a,
            state.parent_b,
            state.theta,
            observation,
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def augmented_observation(
        self,
        state: CompositionalFeatureState,
        observation: Array,
    ) -> Array:
        """Concatenate raw observation with active compositional features."""
        return jnp.concatenate(
            [observation, self.constructed_features(state, observation)]
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict(
        self,
        state: CompositionalFeatureState,
        observation: Array,
    ) -> Array:
        """Predict all tasks from active compositional features."""
        features = self.constructed_features(state, observation)
        result: Array = state.output_weights @ features + state.output_bias
        return result

    def _generate_one(
        self,
        key: Array,
        existing_depth: Array,
        existing_utilities: Array | None = None,
        existing_ages: Array | None = None,
        feature_values: Array | None = None,
        feature_credit: Array | None = None,
        forced_op: Array | None = None,
        parent_mode: Array | None = None,
    ) -> tuple[Array, Array, Array, Array, Array]:
        """Sample a fresh candidate composition.

        The op type is biased toward cheap/non-trivial compositional
        primitives.  Parent selection is controlled by ``generation_strategy``:
        the historical path is utility-biased; mutation/imprint variants anchor
        one parent on high-score features and sample the other from shallow
        eligible features to encourage local variants of useful parents.

        Args:
            key: PRNG key.
            existing_depth: Depths of the active feature bank, shape
                ``(n_features,)``.
            existing_utilities: Optional utility array used to bias parent
                selection; when ``None`` parents are drawn uniformly over
                eligible slots.
            existing_ages: Optional age array used by novelty-biased parent
                selection.
            feature_values: Optional active feature values for one-step
                residual-imprint parent scoring.
            feature_credit: Optional active feature residual credit for
                one-step residual-imprint parent scoring.
            forced_op: Optional op id supplied by a meta-resource policy.
            parent_mode: Optional parent-selection mode supplied by a
                meta-resource policy.

        Returns:
            ``(op, parent_a, parent_b, theta, depth)`` as scalar / shape-2
            JAX arrays.
        """
        op_key, pa_key, pb_key, fallback_pa_key, fallback_pb_key, theta_key = jr.split(
            key, 6
        )
        recursive_product = (
            self._generation_strategy
            in {GENERATION_RECURSIVE_PRODUCT, GENERATION_ROBUST_RECURSIVE}
            and forced_op is None
        )
        op = jr.categorical(op_key, self._op_logits(forced_op)).astype(jnp.int32)
        # Eligibility mask: parent depth + 1 <= max_depth.
        eligible = existing_depth + 1 <= self._max_depth
        if existing_utilities is None:
            utilities = jnp.ones_like(existing_depth, dtype=jnp.float32)
        else:
            utilities = existing_utilities
        parent_logits = self._parent_logits(
            eligible,
            utilities,
            feature_values=feature_values,
            feature_credit=feature_credit,
            depth=existing_depth,
            ages=existing_ages,
            parent_mode=parent_mode,
        )
        partner_logits = self._partner_logits(
            eligible,
            existing_depth,
            utilities,
            ages=existing_ages,
            parent_mode=parent_mode,
        )
        a_idx = jr.categorical(pa_key, parent_logits).astype(jnp.int32)
        b_idx = jr.categorical(pb_key, partner_logits).astype(jnp.int32)
        if recursive_product:
            recursive_parent = eligible & (existing_depth >= 1)
            shallow_parent = eligible & (existing_depth == 0)
            has_recursive_parent = jnp.any(recursive_parent)
            has_shallow_parent = jnp.any(shallow_parent)
            recursive_logits = self._parent_logits(
                recursive_parent,
                utilities,
                feature_values=feature_values,
                feature_credit=feature_credit,
                depth=existing_depth,
                ages=existing_ages,
                parent_mode=jnp.array(PARENT_MODE_RESIDUAL_IMPRINT, dtype=jnp.int32),
            )
            recursive_logits = jnp.where(
                has_recursive_parent,
                recursive_logits,
                parent_logits,
            )
            shallow_logits = jnp.where(
                shallow_parent,
                jnp.zeros_like(utilities, dtype=jnp.float32),
                -1e9,
            )
            shallow_logits = jnp.where(
                has_shallow_parent,
                shallow_logits,
                partner_logits,
            )
            recursive_a = jr.categorical(
                fallback_pa_key, recursive_logits
            ).astype(jnp.int32)
            recursive_b = jr.categorical(
                fallback_pb_key, shallow_logits
            ).astype(jnp.int32)
            a_idx = jnp.where(has_recursive_parent, recursive_a, a_idx)
            b_idx = jnp.where(
                has_recursive_parent & has_shallow_parent,
                recursive_b,
                b_idx,
            )
        new_theta = 0.5 * jr.normal(theta_key, (2,), dtype=jnp.float32)
        new_depth = (
            jnp.maximum(existing_depth[a_idx], existing_depth[b_idx]) + 1
        ).astype(jnp.int32)
        return op, a_idx, b_idx, new_theta, new_depth

    def _cascade_replace(
        self,
        ops: Array,
        parent_a: Array,
        parent_b: Array,
        theta: Array,
        depth: Array,
        utilities: Array,
        ages: Array,
        output_weights: Array,
        replaced_mask: Array,
        observation: Array,
        key: Array,
        feature_values: Array | None = None,
        feature_credit: Array | None = None,
        forced_op: Array | None = None,
        parent_mode: Array | None = None,
    ) -> tuple[Array, Array, Array, Array, Array, Array, Array, Array]:
        """Apply cascade replacement: every descendant of a replaced slot is also replaced.

        Iterates over slots in topological order; on each pass, a slot is
        marked for replacement if it is currently in ``replaced_mask`` or if
        it is non-raw and references a parent that has been marked.  Each
        replaced slot is filled with a fresh raw-input passthrough or, when
        possible, a fresh random composition that respects the depth budget
        and the topological invariant.
        """
        del observation  # not used by the simple raw-input refresh path
        n_features = self._n_features
        feature_dim = self._raw_input_dim_from_state(parent_a, ops)

        # Descendant cascade: scan through slots and propagate the mask.
        def cascade_step(
            carry_mask: Array, i: Array
        ) -> tuple[Array, None]:
            a = parent_a[i]
            b = parent_b[i]
            is_composed = ops[i] != OP_RAW
            # Safe gathers; for raw ops the parents reference different
            # spaces, but `is_composed` masks out their effect.
            safe_a = jnp.clip(a, 0, n_features - 1)
            safe_b = jnp.clip(b, 0, n_features - 1)
            parent_replaced = jnp.where(
                is_composed,
                carry_mask[safe_a]
                | jnp.where(b >= 0, carry_mask[safe_b], jnp.bool_(False)),
                jnp.bool_(False),
            )
            new_mark = carry_mask[i] | parent_replaced
            new_carry = carry_mask.at[i].set(new_mark)
            return new_carry, None

        cascaded_mask, _ = jax.lax.scan(
            cascade_step, replaced_mask, jnp.arange(n_features)
        )

        # Generate fresh slot contents, respecting the strict-less-than
        # parent invariant.  Each replaced slot becomes a passthrough of a
        # randomly chosen still-alive earlier slot, or a raw input if none
        # earlier slots survive.
        def refill_step(
            carry: tuple[Array, Array, Array, Array, Array, Array, Array, Array, Array],
            i: Array,
        ) -> tuple[
            tuple[Array, Array, Array, Array, Array, Array, Array, Array, Array], None
        ]:
            (
                ops_c,
                pa_c,
                pb_c,
                theta_c,
                depth_c,
                utils_c,
                ages_c,
                ow_c,
                key_c,
            ) = carry
            do_replace = cascaded_mask[i]
            key_c, slot_key = jr.split(key_c)
            op_key, pa_key, pb_key, theta_key = jr.split(slot_key, 4)

            # Determine the eligible parent set: indices < i whose slot is
            # NOT being replaced.  Bias parent selection by utility so
            # productive surviving features are more likely to become
            # parents of replacements.
            slot_indices = jnp.arange(n_features)
            in_range = slot_indices < i
            alive = in_range & (~cascaded_mask)
            depth_ok = depth_c + 1 <= self._max_depth
            eligible = alive & depth_ok
            any_eligible = jnp.any(eligible)
            logits = self._parent_logits(
                eligible,
                utils_c,
                feature_values=feature_values,
                feature_credit=feature_credit,
                depth=depth_c,
                ages=ages_c,
                parent_mode=parent_mode,
            )
            partner_logits = self._partner_logits(
                eligible,
                depth_c,
                utils_c,
                ages=ages_c,
                parent_mode=parent_mode,
            )
            a_idx = jnp.where(
                any_eligible,
                jr.categorical(pa_key, logits).astype(jnp.int32),
                jnp.array(0, dtype=jnp.int32),
            )
            b_idx = jnp.where(
                any_eligible,
                jr.categorical(pb_key, partner_logits).astype(jnp.int32),
                jnp.array(0, dtype=jnp.int32),
            )
            new_op = jnp.where(
                any_eligible,
                jr.categorical(op_key, self._op_logits(forced_op)).astype(jnp.int32),
                jnp.array(OP_RAW, dtype=jnp.int32),
            )
            # For OP_RAW fallback, parent_a is a raw-input index (clamp to
            # feature_dim-1) and parent_b is -1.  This keeps the slot valid.
            raw_a_idx = jnp.clip(jnp.minimum(i, feature_dim - 1), 0, feature_dim - 1)
            new_pa = jnp.where(any_eligible, a_idx, raw_a_idx)
            new_pb = jnp.where(
                any_eligible, b_idx, jnp.array(-1, dtype=jnp.int32)
            )
            new_theta = 0.5 * jr.normal(theta_key, (2,), dtype=jnp.float32)
            new_depth = jnp.where(
                any_eligible,
                jnp.maximum(depth_c[a_idx], depth_c[b_idx]) + 1,
                jnp.array(0, dtype=jnp.int32),
            ).astype(jnp.int32)

            ops_n = jnp.where(do_replace, ops_c.at[i].set(new_op), ops_c)
            pa_n = jnp.where(do_replace, pa_c.at[i].set(new_pa), pa_c)
            pb_n = jnp.where(do_replace, pb_c.at[i].set(new_pb), pb_c)
            theta_n = jnp.where(
                do_replace, theta_c.at[i].set(new_theta), theta_c
            )
            depth_n = jnp.where(
                do_replace, depth_c.at[i].set(new_depth), depth_c
            )
            utils_n = jnp.where(do_replace, utils_c.at[i].set(0.0), utils_c)
            ages_n = jnp.where(do_replace, ages_c.at[i].set(0), ages_c)
            ow_n = jnp.where(
                do_replace, ow_c.at[:, i].set(0.0), ow_c
            )
            return (ops_n, pa_n, pb_n, theta_n, depth_n, utils_n, ages_n, ow_n, key_c), None

        (ops_f, pa_f, pb_f, theta_f, depth_f, utils_f, ages_f, ow_f, _), _ = (
            jax.lax.scan(
                refill_step,
                (ops, parent_a, parent_b, theta, depth, utilities, ages, output_weights, key),
                jnp.arange(n_features),
            )
        )
        return ops_f, pa_f, pb_f, theta_f, depth_f, utils_f, ages_f, ow_f

    def _raw_input_dim_from_state(self, parent_a: Array, ops: Array) -> int:
        """Recover the raw input dim from state shapes.

        We assume the first ``feature_dim`` slots are ``OP_RAW`` with
        ``parent_a == slot_index``; we recover that dim from the leading
        run of OP_RAW slots at init.  This is purely a Python-side helper
        used for refill fallbacks; it returns a Python int derived from
        ``self._n_features`` (since at runtime we can't introspect the
        active raw-input dim under JIT).  We use ``self._n_features`` as a
        safe upper bound.
        """
        del parent_a, ops
        return self._n_features

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: CompositionalFeatureState,
        observation: Array,
        targets: Array,
        context_id: Array | int = 0,
    ) -> CompositionalFeatureUpdateResult:
        """Perform one temporally-uniform compositional-feature update."""
        context = jnp.asarray(context_id, dtype=jnp.int32)
        active_mask = ~jnp.isnan(targets)
        safe_targets = jnp.where(active_mask, targets, 0.0)
        active_count = jnp.maximum(jnp.sum(active_mask.astype(jnp.float32)), 1.0)
        task_activity_ema = (
            self._future_utility_task_activity_decay * state.task_activity_ema
            + (1.0 - self._future_utility_task_activity_decay)
            * active_mask.astype(jnp.float32)
        )

        feature_values = _compute_feature_values(
            state.ops,
            state.parent_a,
            state.parent_b,
            state.theta,
            observation,
        )
        predictions = state.output_weights @ feature_values + state.output_bias
        errors = jnp.where(active_mask, safe_targets - predictions, 0.0)
        reported_errors = jnp.where(active_mask, errors, jnp.nan)

        # Output-weight update.
        output_delta = (
            self._step_size_output
            * errors[:, None]
            * feature_values[None, :]
            / active_count
        )
        output_bias_delta = self._step_size_output * errors / active_count

        # Per-feature credit and theta update via local linearization.
        feature_credit = (errors @ state.output_weights) / active_count
        d_theta0, d_theta1 = _theta_local_grads(
            state.ops,
            state.parent_a,
            state.parent_b,
            state.theta,
            feature_values,
        )
        theta_delta = self._step_size_theta * jnp.stack(
            [feature_credit * d_theta0, feature_credit * d_theta1], axis=-1
        )

        current_utility_signal = (
            0.5 * jnp.mean(jnp.abs(state.output_weights), axis=0) * jnp.abs(feature_values)
            + 0.5 * jnp.abs(feature_credit)
        )
        (
            future_utility_signal,
            utility_contribution_trace,
            utility_error_trace,
            utility_feature_trace,
            utility_feature_energy_trace,
        ) = self._future_utility_signal(
            errors,
            feature_values,
            active_mask,
            active_count,
            task_activity_ema,
            state.utility_contribution_trace,
            state.utility_error_trace,
            state.utility_feature_trace,
            state.utility_feature_energy_trace,
        )
        if (
            self._future_utility_mix > 0.0
            and self._future_utility_normalization != "none"
        ):
            future_utility_signal, utility_signal_second_moment = (
                normalize_future_utility_signal(
                    future_utility_signal,
                    state.ages,
                    state.utility_signal_second_moment,
                    self._future_utility_normalization_decay,
                    self._utility_decay,
                    self._future_utility_normalization,
                )
            )
        else:
            utility_signal_second_moment = state.utility_signal_second_moment
        utility_signal = self._mixed_utility_signal(
            current_utility_signal,
            future_utility_signal,
        )
        feature_score_residual_trace = state.feature_score_residual_trace
        feature_score_energy_trace = state.feature_score_energy_trace
        if self._candidate_scoring_mode == "energy_novelty":
            (
                utility_signal,
                feature_score_residual_trace,
                feature_score_energy_trace,
            ) = self._energy_normalized_residual_score(
                errors,
                feature_values,
                state.feature_score_residual_trace,
                state.feature_score_energy_trace,
            )
        new_utilities = (
            self._utility_decay * state.utilities
            + (1.0 - self._utility_decay) * utility_signal
        )
        retention_slow_utilities = self._retention_slow_utility(
            state.retention_slow_utilities,
            utility_signal,
        )

        # Candidate forward + utility (candidates contribute to training of
        # their own output weights/parameters but not to predictions).
        candidate_output_delta = jnp.zeros_like(state.candidate_output_weights)
        candidate_theta_delta = jnp.zeros_like(state.candidate_theta)
        new_candidate_utilities = state.candidate_utilities
        candidate_utility_contribution_trace = (
            state.candidate_utility_contribution_trace
        )
        candidate_utility_feature_trace = state.candidate_utility_feature_trace
        candidate_utility_feature_energy_trace = (
            state.candidate_utility_feature_energy_trace
        )
        candidate_utility_signal_second_moment = (
            state.candidate_utility_signal_second_moment
        )
        candidate_score_residual_trace = state.candidate_score_residual_trace
        candidate_score_energy_trace = state.candidate_score_energy_trace
        candidate_active_correlation_trace = state.candidate_active_correlation_trace
        candidate_feature_values = jnp.zeros(
            (self._candidate_count,), dtype=jnp.float32
        )
        if self._candidate_count > 0:
            candidate_feature_values = self._candidate_features(
                state, feature_values, observation
            )
            candidate_output_delta = (
                self._step_size_output
                * errors[:, None]
                * candidate_feature_values[None, :]
                / active_count
            )
            candidate_credit = (
                errors @ state.candidate_output_weights
            ) / active_count
            candidate_d_theta0, candidate_d_theta1 = _candidate_theta_local_grads(
                state.candidate_ops,
                state.candidate_parent_a,
                state.candidate_parent_b,
                state.candidate_theta,
                candidate_feature_values,
                feature_values,
            )
            candidate_theta_delta = self._step_size_theta * jnp.stack(
                [
                    candidate_credit * candidate_d_theta0,
                    candidate_credit * candidate_d_theta1,
                ],
                axis=-1,
            )
            if not self._train_candidate_theta:
                candidate_theta_delta = jnp.zeros_like(candidate_theta_delta)
            candidate_signal = (
                0.5
                * jnp.mean(jnp.abs(state.candidate_output_weights), axis=0)
                * jnp.abs(candidate_feature_values)
                + 0.5 * jnp.abs(candidate_credit)
            )
            (
                candidate_future_signal,
                candidate_utility_contribution_trace,
                candidate_utility_feature_trace,
                candidate_utility_feature_energy_trace,
            ) = self._candidate_future_utility_signal(
                errors,
                candidate_feature_values,
                active_mask,
                active_count,
                task_activity_ema,
                state.candidate_utility_contribution_trace,
                state.utility_error_trace,
                state.candidate_utility_feature_trace,
                state.candidate_utility_feature_energy_trace,
            )
            if (
                self._future_utility_mix > 0.0
                and self._future_utility_normalization != "none"
            ):
                candidate_future_signal, candidate_utility_signal_second_moment = (
                    normalize_future_utility_signal(
                        candidate_future_signal,
                        state.candidate_ages,
                        state.candidate_utility_signal_second_moment,
                        self._future_utility_normalization_decay,
                        self._utility_decay,
                        self._future_utility_normalization,
                    )
                )
            candidate_signal = self._mixed_utility_signal(
                candidate_signal,
                candidate_future_signal,
            )
            if self._candidate_scoring_mode == "energy_novelty":
                (
                    candidate_signal,
                    candidate_score_residual_trace,
                    candidate_score_energy_trace,
                ) = self._energy_normalized_residual_score(
                    errors,
                    candidate_feature_values,
                    state.candidate_score_residual_trace,
                    state.candidate_score_energy_trace,
                )
                novelty_gate, candidate_active_correlation_trace = (
                    self._candidate_novelty_gate(
                        candidate_feature_values,
                        feature_values,
                        candidate_score_energy_trace,
                        feature_score_energy_trace,
                        state.candidate_active_correlation_trace,
                    )
                )
                candidate_signal = candidate_signal * novelty_gate
            new_candidate_utilities = (
                self._utility_decay * state.candidate_utilities
                + (1.0 - self._utility_decay) * candidate_signal
            )
        candidate_retention_slow_utilities = self._retention_slow_utility(
            state.candidate_retention_slow_utilities,
            candidate_signal if self._candidate_count > 0 else new_candidate_utilities,
        )

        # ObGD-style bounding.
        bounding_scale = jnp.array(1.0, dtype=jnp.float32)
        if self._use_obgd:
            total_step = (
                jnp.sum(jnp.abs(output_delta))
                + jnp.sum(jnp.abs(output_bias_delta))
                + jnp.sum(jnp.abs(theta_delta))
                + jnp.sum(jnp.abs(candidate_output_delta))
                + jnp.sum(jnp.abs(candidate_theta_delta))
            )
            err_norm = jnp.linalg.norm(errors)
            bound_magnitude = self._obgd_kappa * jnp.maximum(err_norm, 1.0) * total_step
            bounding_scale = 1.0 / jnp.maximum(bound_magnitude, 1.0)
            output_delta = bounding_scale * output_delta
            output_bias_delta = bounding_scale * output_bias_delta
            theta_delta = bounding_scale * theta_delta
            candidate_output_delta = bounding_scale * candidate_output_delta
            candidate_theta_delta = bounding_scale * candidate_theta_delta

        output_weights = state.output_weights + output_delta
        output_bias = state.output_bias + output_bias_delta
        theta = state.theta + theta_delta
        candidate_theta = state.candidate_theta + candidate_theta_delta
        candidate_output_weights = (
            state.candidate_output_weights + candidate_output_delta
        )
        ages = state.ages + 1
        candidate_ages = state.candidate_ages + 1
        step_count = state.step_count + 1
        key, decision_key, replacement_key = jr.split(state.key, 3)

        replaced_slot = jnp.array(-1, dtype=jnp.int32)
        promoted_candidate = jnp.array(-1, dtype=jnp.int32)

        decision = self._generator_resource_manager.select(
            state.generator_resource_state,
            decision_key,
            context,
        )
        forced_op: Array | None = None
        parent_mode: Array | None = None
        imprint_scale = jnp.asarray(self._candidate_imprint_scale, dtype=jnp.float32)
        promotion_margin = jnp.asarray(self._promotion_margin, dtype=jnp.float32)
        candidate_min_age = jnp.asarray(self._candidate_min_age, dtype=jnp.float32)
        replacement_accumulator = state.replacement_accumulator
        if self._learn_generator_resources:
            forced_op = decision.op_id
            parent_mode = decision.parent_mode
            imprint_scale = decision.imprint_scale
            promotion_margin = promotion_margin * decision.promotion_margin_multiplier
            candidate_min_age = candidate_min_age * decision.candidate_min_age_multiplier
            replacement_rate = (
                jnp.array(0.0, dtype=jnp.float32)
                if self._replacement_interval == 0
                else decision.replacement_multiplier
                / float(self._replacement_interval)
            )
            replacement_accumulator = replacement_accumulator + replacement_rate
            should_try_replace = (
                (self._replacement_interval > 0) & (replacement_accumulator >= 1.0)
            )
            replacement_accumulator = jnp.where(
                should_try_replace,
                replacement_accumulator - 1.0,
                replacement_accumulator,
            )
        else:
            should_try_replace = (
                (self._replacement_interval > 0)
                & (step_count % jnp.array(max(self._replacement_interval, 1)) == 0)
            )

        # Identify the worst eligible active slot.  Raw-input slots
        # (depth == 0) are protected from replacement.
        is_raw = state.ops == OP_RAW
        recursive_product_scaffold = (
            (state.ops == OP_PRODUCT)
            & (state.depth == 1)
            & (self._generation_strategy == GENERATION_RECURSIVE_PRODUCT)
        )
        tanh_quota_protected = (
            (state.ops == OP_TANH)
            & (
                jnp.sum((state.ops == OP_TANH).astype(jnp.int32))
                <= self._retention_tanh_min_count
            )
        )
        product_quota_protected = (
            (state.ops == OP_PRODUCT)
            & (
                jnp.sum((state.ops == OP_PRODUCT).astype(jnp.int32))
                <= self._retention_product_min_count
            )
        )
        eligible_active = (
            (ages >= self._min_feature_age)
            & (~is_raw)
            & (~recursive_product_scaffold)
            & (~tanh_quota_protected)
            & (~product_quota_protected)
        )
        active_replacement_score = self._retention_score(
            new_utilities,
            retention_slow_utilities,
        )
        retention_bonus = (
            jnp.asarray(self._retention_depth_bonus, dtype=jnp.float32)
            * state.depth.astype(jnp.float32)
            / jnp.maximum(float(self._max_depth), 1.0)
        )
        active_scores = jnp.where(
            eligible_active,
            active_replacement_score + retention_bonus,
            jnp.inf,
        )
        worst_active = jnp.argmin(active_scores).astype(jnp.int32)
        has_active_slot = jnp.any(eligible_active)

        ops = state.ops
        parent_a = state.parent_a
        parent_b = state.parent_b
        depth = state.depth
        candidate_ops = state.candidate_ops
        candidate_parent_a = state.candidate_parent_a
        candidate_parent_b = state.candidate_parent_b
        candidate_depth = state.candidate_depth
        feature_generator_policy = state.feature_generator_policy
        candidate_generator_policy = state.candidate_generator_policy
        should_promote_for_trace = jnp.array(False)
        best_candidate_for_trace = jnp.array(0, dtype=jnp.int32)
        promoted_slot_for_trace = worst_active
        candidate_selector_log_weights = state.candidate_selector_log_weights
        candidate_selector_cumulative_loss = state.candidate_selector_cumulative_loss
        candidate_selector_action_counts = state.candidate_selector_action_counts

        if self._candidate_count > 0:
            eligible_candidates = candidate_ages.astype(jnp.float32) >= candidate_min_age
            slot_indices = jnp.arange(self._n_features)
            safe_candidate_pa = jnp.clip(candidate_parent_a, 0, self._n_features - 1)
            safe_candidate_pb = jnp.clip(candidate_parent_b, 0, self._n_features - 1)
            candidate_depth_after_all = (
                jnp.maximum(
                    depth[safe_candidate_pa],
                    jnp.where(
                        candidate_parent_b >= 0,
                        depth[safe_candidate_pb],
                        0,
                    ),
                )
                + 1
            )
            candidate_parent_max = jnp.maximum(
                candidate_parent_a,
                jnp.where(candidate_parent_b >= 0, candidate_parent_b, -1),
            )
            compatible_active_by_candidate = (
                eligible_candidates[:, None]
                & eligible_active[None, :]
                & (slot_indices[None, :] > candidate_parent_max[:, None])
                & (candidate_depth_after_all[:, None] <= self._max_depth)
            )
            candidate_has_destination = jnp.any(
                compatible_active_by_candidate, axis=1
            )
            candidate_promotion_scores = self._retention_score(
                new_candidate_utilities,
                candidate_retention_slow_utilities,
            )
            candidate_selector_state = FiniteCandidateSelectorState(
                log_weights=candidate_selector_log_weights,
                cumulative_loss=candidate_selector_cumulative_loss,
                action_counts=candidate_selector_action_counts,
                step_count=state.step_count,
            )
            if self._candidate_selector is not None:
                selector_probabilities = self._candidate_selector.probabilities(
                    candidate_selector_state
                )
                candidate_scores = jnp.where(
                    candidate_has_destination, selector_probabilities, -jnp.inf
                )
            else:
                candidate_scores = jnp.where(
                    candidate_has_destination, candidate_promotion_scores, -jnp.inf
                )
            best_candidate = jnp.argmax(candidate_scores).astype(jnp.int32)
            has_candidate = jnp.any(candidate_has_destination)
            if self._candidate_selector is not None:
                selector_losses = _candidate_scores_to_unit_losses(
                    candidate_promotion_scores,
                    candidate_has_destination,
                )
                selector_result = self._candidate_selector.update(
                    candidate_selector_state,
                    selector_losses,
                    selected_action=best_candidate,
                )
                candidate_selector_log_weights = selector_result.state.log_weights
                candidate_selector_cumulative_loss = (
                    selector_result.state.cumulative_loss
                )
                candidate_selector_action_counts = selector_result.state.action_counts
            has_refresh_candidate = jnp.any(eligible_candidates)
            refresh_scores = jnp.where(
                eligible_candidates, new_candidate_utilities, jnp.inf
            )
            worst_candidate = jnp.argmin(refresh_scores).astype(jnp.int32)
            compatible_active = compatible_active_by_candidate[best_candidate]
            promotion_slot_scores = jnp.where(
                compatible_active, active_replacement_score, jnp.inf
            )
            promotion_slot = jnp.argmin(promotion_slot_scores).astype(jnp.int32)
            should_promote = (
                should_try_replace
                & has_active_slot
                & has_candidate
                & (
                    candidate_promotion_scores[best_candidate]
                    > promotion_margin * active_replacement_score[promotion_slot]
                )
            )

            def promote_branch(args: tuple[Array, ...]) -> tuple[Array, ...]:
                (
                    ops_a,
                    pa_a,
                    pb_a,
                    theta_a,
                    depth_a,
                    util_a,
                    age_a,
                    ow_a,
                    co_a,
                    cpa_a,
                    cpb_a,
                    ctheta_a,
                    cdepth_a,
                    cow_a,
                    cutil_a,
                    cage_a,
                    fgp_a,
                    cgp_a,
                ) = args
                # Build a candidate that is "promotable": its parents must be
                # strictly smaller than the destination index ``promotion_slot``
                # to preserve the topological invariant.  We only promote when
                # both candidate parents are < promotion_slot.  Otherwise we
                # fall back to a refresh.
                cand_pa = cpa_a[best_candidate]
                cand_pb = cpb_a[best_candidate]
                cand_op = co_a[best_candidate]
                # Also ensure the resulting depth remains within budget.
                cand_depth_after = jnp.maximum(
                    depth_a[jnp.clip(cand_pa, 0, self._n_features - 1)],
                    jnp.where(
                        cand_pb >= 0,
                        depth_a[jnp.clip(cand_pb, 0, self._n_features - 1)],
                        0,
                    ),
                ) + 1
                topo_ok = (cand_pa < promotion_slot) & (
                    (cand_pb < 0) | (cand_pb < promotion_slot)
                )
                depth_ok = cand_depth_after <= self._max_depth
                can_promote = topo_ok & depth_ok

                ops_b = ops_a.at[promotion_slot].set(
                    jnp.where(can_promote, cand_op, ops_a[promotion_slot])
                )
                pa_b = pa_a.at[promotion_slot].set(
                    jnp.where(can_promote, cand_pa, pa_a[promotion_slot])
                )
                pb_b = pb_a.at[promotion_slot].set(
                    jnp.where(can_promote, cand_pb, pb_a[promotion_slot])
                )
                theta_b = theta_a.at[promotion_slot].set(
                    jnp.where(
                        can_promote, ctheta_a[best_candidate], theta_a[promotion_slot]
                    )
                )
                depth_b = depth_a.at[promotion_slot].set(
                    jnp.where(
                        can_promote, cand_depth_after, depth_a[promotion_slot]
                    ).astype(jnp.int32)
                )
                util_b = util_a.at[promotion_slot].set(
                    jnp.where(
                        can_promote, cutil_a[best_candidate], util_a[promotion_slot]
                    )
                )
                age_b = age_a.at[promotion_slot].set(
                    jnp.where(can_promote, 0, age_a[promotion_slot]).astype(jnp.int32)
                )
                ow_b = ow_a.at[:, promotion_slot].set(
                    jnp.where(
                        can_promote,
                        self._promoted_output_weights(
                            ow_a[:, promotion_slot],
                            cow_a[:, best_candidate],
                        ),
                        ow_a[:, promotion_slot],
                    )
                )
                fgp_b = fgp_a.at[promotion_slot].set(
                    jnp.where(
                        can_promote,
                        cgp_a[best_candidate],
                        fgp_a[promotion_slot],
                    )
                )

                # Refresh the promoted candidate slot with a fresh
                # composition (parents drawn over ALL active slots, biased
                # by utility).
                promoted_feature_values = _compute_feature_values(
                    ops_b,
                    pa_b,
                    pb_b,
                    theta_b,
                    observation,
                )
                gen_op, gen_pa, gen_pb, gen_theta, gen_depth = self._generate_one(
                    replacement_key,
                    depth_b,
                    util_b,
                    existing_ages=age_b,
                    feature_values=promoted_feature_values,
                    feature_credit=feature_credit,
                    forced_op=forced_op,
                    parent_mode=parent_mode,
                )
                gen_weights = self._initial_candidate_output_weights(
                    gen_op,
                    gen_pa,
                    gen_pb,
                    gen_theta,
                    promoted_feature_values,
                    observation,
                    errors,
                    active_count,
                    imprint_scale=imprint_scale,
                )
                co_b = co_a.at[best_candidate].set(gen_op)
                cpa_b = cpa_a.at[best_candidate].set(gen_pa)
                cpb_b = cpb_a.at[best_candidate].set(gen_pb)
                ctheta_b = ctheta_a.at[best_candidate].set(gen_theta)
                cdepth_b = cdepth_a.at[best_candidate].set(gen_depth)
                cow_b = cow_a.at[:, best_candidate].set(gen_weights)
                cutil_b = cutil_a.at[best_candidate].set(0.0)
                cage_b = cage_a.at[best_candidate].set(0)
                cgp_b = cgp_a.at[best_candidate].set(decision.action)

                return (
                    ops_b,
                    pa_b,
                    pb_b,
                    theta_b,
                    depth_b,
                    util_b,
                    age_b,
                    ow_b,
                    co_b,
                    cpa_b,
                    cpb_b,
                    ctheta_b,
                    cdepth_b,
                    cow_b,
                    cutil_b,
                    cage_b,
                    fgp_b,
                    cgp_b,
                )

            def refresh_branch(args: tuple[Array, ...]) -> tuple[Array, ...]:
                (
                    ops_a,
                    pa_a,
                    pb_a,
                    theta_a,
                    depth_a,
                    util_a,
                    age_a,
                    ow_a,
                    co_a,
                    cpa_a,
                    cpb_a,
                    ctheta_a,
                    cdepth_a,
                    cow_a,
                    cutil_a,
                    cage_a,
                    fgp_a,
                    cgp_a,
                ) = args
                gen_op, gen_pa, gen_pb, gen_theta, gen_depth = self._generate_one(
                    replacement_key,
                    depth_a,
                    util_a,
                    existing_ages=age_a,
                    feature_values=feature_values,
                    feature_credit=feature_credit,
                    forced_op=forced_op,
                    parent_mode=parent_mode,
                )
                gen_weights = self._initial_candidate_output_weights(
                    gen_op,
                    gen_pa,
                    gen_pb,
                    gen_theta,
                    feature_values,
                    observation,
                    errors,
                    active_count,
                    imprint_scale=imprint_scale,
                )
                do_refresh = should_try_replace & has_refresh_candidate
                co_b = jnp.where(
                    do_refresh, co_a.at[worst_candidate].set(gen_op), co_a
                )
                cpa_b = jnp.where(
                    do_refresh, cpa_a.at[worst_candidate].set(gen_pa), cpa_a
                )
                cpb_b = jnp.where(
                    do_refresh, cpb_a.at[worst_candidate].set(gen_pb), cpb_a
                )
                ctheta_b = jnp.where(
                    do_refresh,
                    ctheta_a.at[worst_candidate].set(gen_theta),
                    ctheta_a,
                )
                cdepth_b = jnp.where(
                    do_refresh,
                    cdepth_a.at[worst_candidate].set(gen_depth),
                    cdepth_a,
                )
                cow_b = jnp.where(
                    do_refresh, cow_a.at[:, worst_candidate].set(gen_weights), cow_a
                )
                cutil_b = jnp.where(
                    do_refresh, cutil_a.at[worst_candidate].set(0.0), cutil_a
                )
                cage_b = jnp.where(
                    do_refresh, cage_a.at[worst_candidate].set(0), cage_a
                )
                cgp_b = jnp.where(
                    do_refresh,
                    cgp_a.at[worst_candidate].set(decision.action),
                    cgp_a,
                )
                return (
                    ops_a,
                    pa_a,
                    pb_a,
                    theta_a,
                    depth_a,
                    util_a,
                    age_a,
                    ow_a,
                    co_b,
                    cpa_b,
                    cpb_b,
                    ctheta_b,
                    cdepth_b,
                    cow_b,
                    cutil_b,
                    cage_b,
                    fgp_a,
                    cgp_b,
                )

            carry = (
                ops,
                parent_a,
                parent_b,
                theta,
                depth,
                new_utilities,
                ages,
                output_weights,
                candidate_ops,
                candidate_parent_a,
                candidate_parent_b,
                candidate_theta,
                candidate_depth,
                candidate_output_weights,
                new_candidate_utilities,
                candidate_ages,
                feature_generator_policy,
                candidate_generator_policy,
            )
            (
                ops,
                parent_a,
                parent_b,
                theta,
                depth,
                new_utilities,
                ages,
                output_weights,
                candidate_ops,
                candidate_parent_a,
                candidate_parent_b,
                candidate_theta,
                candidate_depth,
                candidate_output_weights,
                new_candidate_utilities,
                candidate_ages,
                feature_generator_policy,
                candidate_generator_policy,
            ) = jax.lax.cond(
                should_promote, promote_branch, refresh_branch, carry
            )
            replaced_slot = jnp.where(should_promote, promotion_slot, replaced_slot)
            promoted_candidate = jnp.where(
                should_promote, best_candidate, promoted_candidate
            )
            should_promote_for_trace = should_promote
            best_candidate_for_trace = best_candidate
            promoted_slot_for_trace = promotion_slot

            # If we promoted, cascade-replace any active descendants of
            # ``promotion_slot`` (slots that referenced it as a parent).
            def cascade_after_promote(
                args: tuple[Array, Array, Array, Array, Array, Array, Array, Array],
            ) -> tuple[Array, Array, Array, Array, Array, Array, Array, Array]:
                (
                    ops_x,
                    pa_x,
                    pb_x,
                    theta_x,
                    depth_x,
                    util_x,
                    age_x,
                    ow_x,
                ) = args
                slot_indices = jnp.arange(self._n_features)
                # Mark direct descendants as needing replacement; the cascade
                # routine will then propagate further.
                composed = ops_x != OP_RAW
                refs_a = (
                    composed
                    & (pa_x == promotion_slot)
                    & (slot_indices > promotion_slot)
                )
                refs_b = (
                    composed
                    & (pb_x >= 0)
                    & (pb_x == promotion_slot)
                    & (slot_indices > promotion_slot)
                )
                replaced_mask = refs_a | refs_b
                return self._cascade_replace(
                    ops_x,
                    pa_x,
                    pb_x,
                    theta_x,
                    depth_x,
                    util_x,
                    age_x,
                    ow_x,
                    replaced_mask,
                    observation,
                    replacement_key,
                    feature_values=feature_values,
                    feature_credit=feature_credit,
                    forced_op=forced_op,
                    parent_mode=parent_mode,
                )

            def no_cascade(
                args: tuple[Array, Array, Array, Array, Array, Array, Array, Array],
            ) -> tuple[Array, Array, Array, Array, Array, Array, Array, Array]:
                return args

            (
                ops,
                parent_a,
                parent_b,
                theta,
                depth,
                new_utilities,
                ages,
                output_weights,
            ) = jax.lax.cond(
                should_promote,
                cascade_after_promote,
                no_cascade,
                (
                    ops,
                    parent_a,
                    parent_b,
                    theta,
                    depth,
                    new_utilities,
                    ages,
                    output_weights,
                ),
            )
        else:

            def replace_active_branch(
                args: tuple[Array, Array, Array, Array, Array, Array, Array, Array, Array],
            ) -> tuple[Array, Array, Array, Array, Array, Array, Array, Array, Array]:
                (
                    ops_x,
                    pa_x,
                    pb_x,
                    theta_x,
                    depth_x,
                    util_x,
                    age_x,
                    ow_x,
                    fgp_x,
                ) = args
                # Build a fresh composition whose parents are < worst_active.
                # Mask out slots >= worst_active and bias selection by the
                # current utility estimate so productive features become
                # parents more often.
                op_key, pa_key, pb_key, theta_key = jr.split(replacement_key, 4)
                slot_indices = jnp.arange(self._n_features)
                in_range = slot_indices < worst_active
                depth_ok = depth_x + 1 <= self._max_depth
                eligible = in_range & depth_ok
                logits = self._parent_logits(
                    eligible,
                    util_x,
                    feature_values=feature_values,
                    feature_credit=feature_credit,
                    depth=depth_x,
                    ages=age_x,
                    parent_mode=parent_mode,
                )
                partner_logits = self._partner_logits(
                    eligible,
                    depth_x,
                    util_x,
                    ages=age_x,
                    parent_mode=parent_mode,
                )
                a_idx = jr.categorical(pa_key, logits).astype(jnp.int32)
                b_idx = jr.categorical(pb_key, partner_logits).astype(jnp.int32)
                new_op = jr.categorical(op_key, self._op_logits(forced_op)).astype(
                    jnp.int32
                )
                new_theta = 0.5 * jr.normal(theta_key, (2,), dtype=jnp.float32)
                new_depth = (
                    jnp.maximum(depth_x[a_idx], depth_x[b_idx]) + 1
                ).astype(jnp.int32)

                ops_n = ops_x.at[worst_active].set(new_op)
                pa_n = pa_x.at[worst_active].set(a_idx)
                pb_n = pb_x.at[worst_active].set(b_idx)
                theta_n = theta_x.at[worst_active].set(new_theta)
                depth_n = depth_x.at[worst_active].set(new_depth)
                util_n = util_x.at[worst_active].set(0.0)
                age_n = age_x.at[worst_active].set(0)
                ow_n = ow_x.at[:, worst_active].set(0.0)
                fgp_n = fgp_x.at[worst_active].set(decision.action)

                # Cascade-replace descendants of worst_active.
                composed = ops_n != OP_RAW
                refs_a = composed & (pa_n == worst_active) & (slot_indices > worst_active)
                refs_b = (
                    composed
                    & (pb_n >= 0)
                    & (pb_n == worst_active)
                    & (slot_indices > worst_active)
                )
                replaced_mask = refs_a | refs_b
                ops_f, pa_f, pb_f, theta_f, depth_f, util_f, age_f, ow_f = self._cascade_replace(
                    ops_n,
                    pa_n,
                    pb_n,
                    theta_n,
                    depth_n,
                    util_n,
                    age_n,
                    ow_n,
                    replaced_mask,
                    observation,
                    replacement_key,
                    feature_values=feature_values,
                    feature_credit=feature_credit,
                    forced_op=forced_op,
                    parent_mode=parent_mode,
                )
                return ops_f, pa_f, pb_f, theta_f, depth_f, util_f, age_f, ow_f, fgp_n

            def keep_active_branch(
                args: tuple[Array, Array, Array, Array, Array, Array, Array, Array, Array],
            ) -> tuple[Array, Array, Array, Array, Array, Array, Array, Array, Array]:
                return args

            do_replace = should_try_replace & has_active_slot
            (
                ops,
                parent_a,
                parent_b,
                theta,
                depth,
                new_utilities,
                ages,
                output_weights,
                feature_generator_policy,
            ) = jax.lax.cond(
                do_replace,
                replace_active_branch,
                keep_active_branch,
                (
                    ops,
                    parent_a,
                    parent_b,
                    theta,
                    depth,
                    new_utilities,
                    ages,
                    output_weights,
                    feature_generator_policy,
                ),
            )
            replaced_slot = jnp.where(do_replace, worst_active, replaced_slot)

        reset_active_traces = ages == 0
        if self._candidate_count > 0:
            safe_best_candidate = jnp.clip(
                best_candidate_for_trace, 0, self._candidate_count - 1
            )
            promoted_contribution_trace = candidate_utility_contribution_trace[
                :, safe_best_candidate
            ]
            promoted_feature_trace = candidate_utility_feature_trace[
                safe_best_candidate
            ]
            promoted_feature_energy_trace = candidate_utility_feature_energy_trace[
                safe_best_candidate
            ]
            promoted_signal_second_moment = candidate_utility_signal_second_moment[
                safe_best_candidate
            ]
            promoted_score_residual_trace = candidate_score_residual_trace[
                :, safe_best_candidate
            ]
            promoted_score_energy_trace = candidate_score_energy_trace[
                safe_best_candidate
            ]
            promoted_retention_slow_utility = candidate_retention_slow_utilities[
                safe_best_candidate
            ]
        else:
            promoted_contribution_trace = jnp.zeros(
                (self._n_tasks,), dtype=jnp.float32
            )
            promoted_feature_trace = jnp.array(0.0, dtype=jnp.float32)
            promoted_feature_energy_trace = jnp.array(0.0, dtype=jnp.float32)
            promoted_signal_second_moment = jnp.array(0.0, dtype=jnp.float32)
            promoted_score_residual_trace = jnp.zeros(
                (self._n_tasks,), dtype=jnp.float32
            )
            promoted_score_energy_trace = jnp.array(0.0, dtype=jnp.float32)
            promoted_retention_slow_utility = jnp.array(0.0, dtype=jnp.float32)
        utility_contribution_trace = jnp.where(
            reset_active_traces[None, :], 0.0, utility_contribution_trace
        )
        utility_feature_trace = jnp.where(
            reset_active_traces, 0.0, utility_feature_trace
        )
        utility_feature_energy_trace = jnp.where(
            reset_active_traces, 0.0, utility_feature_energy_trace
        )
        utility_signal_second_moment = jnp.where(
            reset_active_traces, 0.0, utility_signal_second_moment
        )
        feature_score_residual_trace = jnp.where(
            reset_active_traces[None, :], 0.0, feature_score_residual_trace
        )
        feature_score_energy_trace = jnp.where(
            reset_active_traces, 0.0, feature_score_energy_trace
        )
        retention_slow_utilities = jnp.where(
            reset_active_traces, 0.0, retention_slow_utilities
        )
        utility_contribution_trace = utility_contribution_trace.at[
            :, promoted_slot_for_trace
        ].set(
            jnp.where(
                should_promote_for_trace,
                promoted_contribution_trace,
                utility_contribution_trace[:, promoted_slot_for_trace],
            )
        )
        utility_feature_trace = utility_feature_trace.at[
            promoted_slot_for_trace
        ].set(
            jnp.where(
                should_promote_for_trace,
                promoted_feature_trace,
                utility_feature_trace[promoted_slot_for_trace],
            )
        )
        utility_feature_energy_trace = utility_feature_energy_trace.at[
            promoted_slot_for_trace
        ].set(
            jnp.where(
                should_promote_for_trace,
                promoted_feature_energy_trace,
                utility_feature_energy_trace[promoted_slot_for_trace],
            )
        )
        utility_signal_second_moment = utility_signal_second_moment.at[
            promoted_slot_for_trace
        ].set(
            jnp.where(
                should_promote_for_trace,
                promoted_signal_second_moment,
                utility_signal_second_moment[promoted_slot_for_trace],
            )
        )
        feature_score_residual_trace = feature_score_residual_trace.at[
            :, promoted_slot_for_trace
        ].set(
            jnp.where(
                should_promote_for_trace,
                promoted_score_residual_trace,
                feature_score_residual_trace[:, promoted_slot_for_trace],
            )
        )
        feature_score_energy_trace = feature_score_energy_trace.at[
            promoted_slot_for_trace
        ].set(
            jnp.where(
                should_promote_for_trace,
                promoted_score_energy_trace,
                feature_score_energy_trace[promoted_slot_for_trace],
            )
        )
        retention_slow_utilities = retention_slow_utilities.at[
            promoted_slot_for_trace
        ].set(
            jnp.where(
                should_promote_for_trace,
                promoted_retention_slow_utility,
                retention_slow_utilities[promoted_slot_for_trace],
            )
        )
        reset_candidate_traces = candidate_ages == 0
        candidate_utility_contribution_trace = jnp.where(
            reset_candidate_traces[None, :],
            0.0,
            candidate_utility_contribution_trace,
        )
        candidate_utility_feature_trace = jnp.where(
            reset_candidate_traces, 0.0, candidate_utility_feature_trace
        )
        candidate_utility_feature_energy_trace = jnp.where(
            reset_candidate_traces, 0.0, candidate_utility_feature_energy_trace
        )
        candidate_utility_signal_second_moment = jnp.where(
            reset_candidate_traces, 0.0, candidate_utility_signal_second_moment
        )
        candidate_score_residual_trace = jnp.where(
            reset_candidate_traces[None, :], 0.0, candidate_score_residual_trace
        )
        candidate_score_energy_trace = jnp.where(
            reset_candidate_traces, 0.0, candidate_score_energy_trace
        )
        candidate_retention_slow_utilities = jnp.where(
            reset_candidate_traces, 0.0, candidate_retention_slow_utilities
        )
        candidate_active_correlation_trace = jnp.where(
            reset_candidate_traces[:, None] | reset_active_traces[None, :],
            0.0,
            candidate_active_correlation_trace,
        )
        candidate_selector_log_weights = jnp.where(
            reset_candidate_traces, 0.0, candidate_selector_log_weights
        )
        candidate_selector_cumulative_loss = jnp.where(
            reset_candidate_traces, 0.0, candidate_selector_cumulative_loss
        )
        candidate_selector_action_counts = jnp.where(
            reset_candidate_traces, 0.0, candidate_selector_action_counts
        )

        generator_resource_state = state.generator_resource_state
        if self._learn_generator_resources:
            policy_scores, policy_finite = self._generator_policy_scores(
                new_utilities,
                feature_generator_policy,
                new_candidate_utilities,
                candidate_generator_policy,
            )
            if self._generator_resource_promotion_credit > 0.0:
                promoted_policy = feature_generator_policy[promoted_slot_for_trace]
                promotion_bonus = (
                    jnp.asarray(
                        self._generator_resource_promotion_credit,
                        dtype=jnp.float32,
                    )
                    * jnp.maximum(jnp.max(new_candidate_utilities), 0.0)
                )
                policy_ids = jnp.arange(
                    self._generator_resource_manager.n_policies,
                    dtype=jnp.int32,
                )
                promotion_mask = policy_ids == promoted_policy
                policy_scores = policy_scores + jnp.where(
                    promotion_mask,
                    jnp.where(should_promote_for_trace, promotion_bonus, 0.0),
                    0.0,
                )
                policy_finite = policy_finite | (
                    promotion_mask & should_promote_for_trace
                )
            replacement_cost = jnp.asarray(
                DEFAULT_GENERATOR_META_REPLACEMENT_MULTIPLIERS,
                dtype=jnp.float32,
            )
            imprint_cost = jnp.asarray(
                DEFAULT_GENERATOR_META_IMPRINT_SCALES,
                dtype=jnp.float32,
            )
            margin_cost = 1.0 / jnp.asarray(
                DEFAULT_GENERATOR_META_PROMOTION_MARGIN_MULTIPLIERS,
                dtype=jnp.float32,
            )
            age_cost = 1.0 / jnp.asarray(
                DEFAULT_GENERATOR_META_CANDIDATE_MIN_AGE_MULTIPLIERS,
                dtype=jnp.float32,
            )
            policy_costs = (
                replacement_cost
                + 0.25 * imprint_cost
                + 0.25 * margin_cost
                + 0.1 * age_cost
            )
            generator_resource_state = self._generator_resource_manager.update(
                generator_resource_state,
                policy_scores,
                context_id=context,
                finite_mask=policy_finite,
                resource_costs=policy_costs,
                selected_action=decision.action,
                selected_probability=decision.weights[decision.action],
            ).state

        new_state = CompositionalFeatureState(
            key=key,
            ops=ops,
            parent_a=parent_a,
            parent_b=parent_b,
            theta=theta,
            depth=depth,
            output_weights=output_weights,
            output_bias=output_bias,
            utilities=new_utilities,
            utility_contribution_trace=utility_contribution_trace,
            utility_error_trace=utility_error_trace,
            utility_feature_trace=utility_feature_trace,
            utility_feature_energy_trace=utility_feature_energy_trace,
            utility_signal_second_moment=utility_signal_second_moment,
            feature_score_residual_trace=feature_score_residual_trace,
            feature_score_energy_trace=feature_score_energy_trace,
            retention_slow_utilities=retention_slow_utilities,
            task_activity_ema=task_activity_ema,
            ages=ages,
            candidate_ops=candidate_ops,
            candidate_parent_a=candidate_parent_a,
            candidate_parent_b=candidate_parent_b,
            candidate_theta=candidate_theta,
            candidate_depth=candidate_depth,
            candidate_output_weights=candidate_output_weights,
            candidate_utilities=new_candidate_utilities,
            candidate_utility_contribution_trace=candidate_utility_contribution_trace,
            candidate_utility_feature_trace=candidate_utility_feature_trace,
            candidate_utility_feature_energy_trace=(
                candidate_utility_feature_energy_trace
            ),
            candidate_utility_signal_second_moment=(
                candidate_utility_signal_second_moment
            ),
            candidate_score_residual_trace=candidate_score_residual_trace,
            candidate_score_energy_trace=candidate_score_energy_trace,
            candidate_retention_slow_utilities=candidate_retention_slow_utilities,
            candidate_active_correlation_trace=candidate_active_correlation_trace,
            candidate_ages=candidate_ages,
            candidate_selector_log_weights=candidate_selector_log_weights,
            candidate_selector_cumulative_loss=candidate_selector_cumulative_loss,
            candidate_selector_action_counts=candidate_selector_action_counts,
            feature_generator_policy=feature_generator_policy,
            candidate_generator_policy=candidate_generator_policy,
            generator_resource_state=generator_resource_state,
            replacement_accumulator=replacement_accumulator,
            step_count=step_count,
            birth_timestamp=state.birth_timestamp,
            uptime_s=state.uptime_s,
        )

        loss = jnp.sum(errors**2) / active_count
        mean_abs_error = jnp.sum(jnp.abs(errors)) / active_count
        max_candidate_utility = (
            jnp.max(new_candidate_utilities)
            if self._candidate_count > 0
            else jnp.array(0.0, dtype=jnp.float32)
        )
        replacement_flag = (replaced_slot >= 0).astype(jnp.float32)
        metrics = jnp.array(
            [
                loss,
                mean_abs_error,
                jnp.mean(new_utilities),
                jnp.min(new_utilities),
                max_candidate_utility,
                replacement_flag,
                bounding_scale,
            ],
            dtype=jnp.float32,
        )

        return CompositionalFeatureUpdateResult(
            state=new_state,
            predictions=predictions,
            errors=reported_errors,
            metrics=metrics,
            replaced_slot=replaced_slot,
            promoted_candidate=promoted_candidate,
        )


def run_compositional_arrays(
    learner: CompositionalFeatureLearner,
    state: CompositionalFeatureState,
    observations: Array,
    targets: Array,
) -> CompositionalFeatureLearningResult:
    """Run a compositional learner over pre-collected stream arrays."""

    def step_fn(
        carry: CompositionalFeatureState,
        inputs: tuple[Array, Array],
    ) -> tuple[CompositionalFeatureState, Array]:
        observation, target = inputs
        result = learner.update(carry, observation, target)
        return result.state, result.metrics

    t0 = time.time()
    final_state, metrics = jax.lax.scan(step_fn, state, (observations, targets))
    elapsed = time.time() - t0
    final_state = final_state.replace(  # type: ignore[attr-defined]
        uptime_s=final_state.uptime_s + elapsed
    )
    return CompositionalFeatureLearningResult(state=final_state, metrics=metrics)


def run_compositional_loop(
    learner: CompositionalFeatureLearner,
    stream: Any,
    num_steps: int,
    key: Array,
    learner_state: CompositionalFeatureState | None = None,
) -> CompositionalFeatureLearningResult:
    """Run compositional feature discovery directly from a scan-compatible stream."""
    stream_key, learner_key = jr.split(key)
    stream_state = stream.init(stream_key)
    if learner_state is None:
        learner_state = learner.init(stream.feature_dim, learner_key)

    def step_fn(
        carry: tuple[CompositionalFeatureState, Any],
        idx: Array,
    ) -> tuple[tuple[CompositionalFeatureState, Any], Array]:
        l_state, s_state = carry
        timestep, new_s_state = stream.step(s_state, idx)
        result = learner.update(l_state, timestep.observation, timestep.target)
        return (result.state, new_s_state), result.metrics

    t0 = time.time()
    (final_state, _), metrics = jax.lax.scan(
        step_fn, (learner_state, stream_state), jnp.arange(num_steps)
    )
    elapsed = time.time() - t0
    final_state = final_state.replace(  # type: ignore[attr-defined]
        uptime_s=final_state.uptime_s + elapsed
    )
    return CompositionalFeatureLearningResult(state=final_state, metrics=metrics)
