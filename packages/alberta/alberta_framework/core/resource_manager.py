"""Learned resource managers for continual feature/plasticity allocation.

The Alberta Plan calls for agents that decide where to spend limited
representation-building effort.  This module provides a small, JAX-friendly
resource manager that learns a causal allocation over discrete resource
policies from online losses.

The manager is intentionally generic: actions can represent generator choices,
replacement rates, perturbation schedules, expert policies, or any other
resource-consuming option.  It does not assume a particular learner.  Each
update receives the current action losses and optional resource costs, then
performs a discounted exponentiated-gradient update.  With ``n_contexts > 1``
the manager learns separate allocations for externally supplied stream states
or inferred contexts.
"""

from __future__ import annotations

import functools
import math
from typing import Any

import chex
import jax
import jax.numpy as jnp
import jax.random as jr
from jax import Array
from jaxtyping import Float


def optimal_hedge_learning_rate(
    n_actions: int,
    horizon: int,
    loss_bound: float = 1.0,
) -> float:
    """Return the fixed-horizon Hedge rate for bounded losses.

    The bound used throughout the Step 2 theory notes assumes losses in
    ``[0, loss_bound]`` and an undiscounted full-information exponential
    weights update.  For ``n_actions == 1`` the regret is identically zero, so
    the returned learning rate is ``0.0``.
    """
    if n_actions < 1:
        raise ValueError("n_actions must be positive")
    if horizon < 1:
        raise ValueError("horizon must be positive")
    if loss_bound <= 0.0:
        raise ValueError("loss_bound must be positive")
    if n_actions == 1:
        return 0.0
    return math.sqrt(8.0 * math.log(n_actions) / (horizon * loss_bound**2))


def finite_candidate_hedge_regret_bound(
    n_actions: int,
    horizon: int,
    learning_rate: float,
    loss_bound: float = 1.0,
) -> float:
    """Bound static regret for finite full-information Hedge selection.

    For losses in ``[0, loss_bound]`` and update
    ``w_i <- w_i * exp(-learning_rate * loss_i)``, the cumulative mixture loss
    is at most the best fixed action's cumulative loss plus this value.

    This is a theorem for the selector abstraction. Discounting, forced
    exploration, partial feedback, nonstationary comparators, and heuristic
    promote/delete rules require separate terms and must not cite this helper
    as a proof.
    """
    if n_actions < 1:
        raise ValueError("n_actions must be positive")
    if horizon < 1:
        raise ValueError("horizon must be positive")
    if learning_rate < 0.0:
        raise ValueError("learning_rate must be non-negative")
    if loss_bound <= 0.0:
        raise ValueError("loss_bound must be positive")
    if n_actions == 1:
        return 0.0
    if learning_rate == 0.0:
        return math.inf
    return (
        math.log(n_actions) / learning_rate
        + learning_rate * horizon * loss_bound**2 / 8.0
    )


@chex.dataclass(frozen=True)
class LearnedResourceManagerState:
    """State for a contextual learned resource manager.

    Attributes:
        log_weights: Per-context action preferences, shape
            ``(n_contexts, n_actions)``.
        loss_ema: Per-context/action EMA of observed adjusted losses.
        action_counts: Per-context/action count of updates in which an action
            had a finite observed loss.
        step_count: Scalar update counter.
    """

    log_weights: Float[Array, " n_contexts n_actions"]
    loss_ema: Float[Array, " n_contexts n_actions"]
    action_counts: Float[Array, " n_contexts n_actions"]
    step_count: Array


@chex.dataclass(frozen=True)
class LearnedResourceManagerUpdateResult:
    """Result of one resource-manager update.

    Attributes:
        state: Updated manager state.
        weights: Pre-update action allocation for the selected context.
        adjusted_losses: Per-action loss plus resource cost.
        advantages: Baseline-relative advantage, positive for better actions.
    """

    state: LearnedResourceManagerState
    weights: Float[Array, " n_actions"]
    adjusted_losses: Float[Array, " n_actions"]
    advantages: Float[Array, " n_actions"]


class LearnedResourceManager:
    """Contextual Hedge manager over discrete resource policies.

    At every time step, the manager emits a probability vector over resource
    actions.  After seeing the current losses, it shifts probability mass toward
    actions whose adjusted loss was lower than the manager's own allocation
    baseline.  Optional ``resource_costs`` let experiments encode a preference
    for cheaper plasticity when predictive losses are comparable.

    The update is causal and online:

    ``advantage_i = dot(weights, adjusted_losses) - adjusted_losses_i``

    ``log_weight_i <- discount * log_weight_i + learning_rate * advantage_i``

    Positive advantage means action ``i`` beat the current allocation.  Centering
    by the allocation baseline keeps the preferences numerically stable and
    makes uniform shifts in all losses irrelevant.
    """

    def __init__(
        self,
        n_actions: int,
        n_contexts: int = 1,
        learning_rate: float = 1.0,
        discount: float = 0.995,
        exploration: float = 0.0,
        loss_decay: float = 0.99,
        cost_weight: float = 0.0,
        advantage_clip: float = 10.0,
    ) -> None:
        """Initialize the resource manager.

        Args:
            n_actions: Number of discrete resource policies.
            n_contexts: Number of independent contexts/state bins.
            learning_rate: Exponentiated-gradient step size.
            discount: Preference decay in ``[0, 1]``.
            exploration: Uniform allocation floor in ``[0, 1)``.
            loss_decay: EMA decay for diagnostics.
            cost_weight: Multiplier on optional resource costs.
            advantage_clip: Absolute clip on centered advantages.

        Raises:
            ValueError: If any hyperparameter is outside its valid range.
        """
        if n_actions < 1:
            raise ValueError("n_actions must be positive")
        if n_contexts < 1:
            raise ValueError("n_contexts must be positive")
        if learning_rate < 0.0:
            raise ValueError("learning_rate must be non-negative")
        if not 0.0 <= discount <= 1.0:
            raise ValueError("discount must be in [0, 1]")
        if not 0.0 <= exploration < 1.0:
            raise ValueError("exploration must be in [0, 1)")
        if not 0.0 <= loss_decay < 1.0:
            raise ValueError("loss_decay must be in [0, 1)")
        if cost_weight < 0.0:
            raise ValueError("cost_weight must be non-negative")
        if advantage_clip <= 0.0:
            raise ValueError("advantage_clip must be positive")

        self._n_actions = int(n_actions)
        self._n_contexts = int(n_contexts)
        self._learning_rate = float(learning_rate)
        self._discount = float(discount)
        self._exploration = float(exploration)
        self._loss_decay = float(loss_decay)
        self._cost_weight = float(cost_weight)
        self._advantage_clip = float(advantage_clip)

    @property
    def n_actions(self) -> int:
        """Number of resource actions."""
        return self._n_actions

    @property
    def n_contexts(self) -> int:
        """Number of independent contexts."""
        return self._n_contexts

    def to_config(self) -> dict[str, Any]:
        """Serialize manager configuration."""
        return {
            "type": "LearnedResourceManager",
            "n_actions": self._n_actions,
            "n_contexts": self._n_contexts,
            "learning_rate": self._learning_rate,
            "discount": self._discount,
            "exploration": self._exploration,
            "loss_decay": self._loss_decay,
            "cost_weight": self._cost_weight,
            "advantage_clip": self._advantage_clip,
        }

    def fixed_candidate_regret_bound(
        self,
        horizon: int,
        loss_bound: float = 1.0,
    ) -> float:
        """Return the finite-action Hedge regret bound for this rate.

        This bound applies only to the undiscounted, no-exploration,
        full-information selector abstraction. The runtime manager can also be
        used with discounting, exploration floors, costs, ignored ``NaN`` losses,
        or context switches; those settings are causal and useful, but this
        static bound is no longer the complete statement.
        """
        return finite_candidate_hedge_regret_bound(
            self._n_actions,
            horizon,
            self._learning_rate,
            loss_bound=loss_bound,
        )

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> LearnedResourceManager:
        """Reconstruct a manager from :meth:`to_config` output."""
        config = dict(config)
        config.pop("type", None)
        return cls(**config)

    def init(self) -> LearnedResourceManagerState:
        """Create an initial uniform-allocation state."""
        shape = (self._n_contexts, self._n_actions)
        return LearnedResourceManagerState(  # type: ignore[call-arg]
            log_weights=jnp.zeros(shape, dtype=jnp.float32),
            loss_ema=jnp.zeros(shape, dtype=jnp.float32),
            action_counts=jnp.zeros(shape, dtype=jnp.float32),
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def weights(
        self,
        state: LearnedResourceManagerState,
        context_id: Array | int = 0,
    ) -> Float[Array, " n_actions"]:
        """Return the current allocation for ``context_id``."""
        context = jnp.asarray(context_id, dtype=jnp.int32)
        logits = state.log_weights[context]
        weights = jax.nn.softmax(logits)
        if self._exploration > 0.0:
            uniform = jnp.full_like(weights, 1.0 / float(self._n_actions))
            weights = (1.0 - self._exploration) * weights + self._exploration * uniform
        return weights

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: LearnedResourceManagerState,
        losses: Float[Array, " n_actions"],
        context_id: Array | int = 0,
        resource_costs: Float[Array, " n_actions"] | None = None,
    ) -> LearnedResourceManagerUpdateResult:
        """Update preferences from current per-action losses.

        Args:
            state: Current manager state.
            losses: Per-action predictive losses. ``NaN`` entries are ignored.
            context_id: Context/state bin to update.
            resource_costs: Optional non-negative per-action costs.

        Returns:
            :class:`LearnedResourceManagerUpdateResult`.
        """
        context = jnp.asarray(context_id, dtype=jnp.int32)
        losses = jnp.asarray(losses, dtype=jnp.float32)
        finite = jnp.isfinite(losses)
        safe_losses = jnp.where(finite, losses, 0.0)
        costs = (
            jnp.zeros_like(safe_losses)
            if resource_costs is None
            else jnp.asarray(resource_costs, dtype=jnp.float32)
        )
        adjusted = safe_losses + jnp.asarray(self._cost_weight, dtype=jnp.float32) * costs

        weights = self.weights(state, context)
        finite_weight_sum = jnp.maximum(jnp.sum(jnp.where(finite, weights, 0.0)), 1e-12)
        masked_weights = jnp.where(finite, weights / finite_weight_sum, 0.0)
        baseline = jnp.sum(masked_weights * adjusted)
        advantages = jnp.where(finite, baseline - adjusted, 0.0)
        advantages = jnp.clip(
            advantages,
            -self._advantage_clip,
            self._advantage_clip,
        )

        old_context_logits = state.log_weights[context]
        new_context_logits = (
            self._discount * old_context_logits + self._learning_rate * advantages
        )
        # Remove an arbitrary additive constant for numerical stability.
        new_context_logits = new_context_logits - jnp.mean(new_context_logits)
        new_log_weights = state.log_weights.at[context].set(new_context_logits)

        old_ema = state.loss_ema[context]
        new_ema = jnp.where(
            finite,
            self._loss_decay * old_ema + (1.0 - self._loss_decay) * adjusted,
            old_ema,
        )
        new_loss_ema = state.loss_ema.at[context].set(new_ema)
        new_counts = state.action_counts.at[context].add(finite.astype(jnp.float32))

        new_state = LearnedResourceManagerState(  # type: ignore[call-arg]
            log_weights=new_log_weights,
            loss_ema=new_loss_ema,
            action_counts=new_counts,
            step_count=state.step_count + 1,
        )
        return LearnedResourceManagerUpdateResult(  # type: ignore[call-arg]
            state=new_state,
            weights=weights,
            adjusted_losses=adjusted,
            advantages=advantages,
        )


@chex.dataclass(frozen=True)
class GeneratorMetaResourceManagerState:
    """State for generator-internal meta-resource allocation.

    Attributes:
        log_weights: Per-context generator-policy preferences.
        reward_ema: Per-context/policy EMA of observed provenance rewards.
        action_counts: Per-context/policy count of finite reward updates.
        step_count: Scalar update counter.
    """

    log_weights: Float[Array, " n_contexts n_policies"]
    reward_ema: Float[Array, " n_contexts n_policies"]
    action_counts: Float[Array, " n_contexts n_policies"]
    step_count: Array


@chex.dataclass(frozen=True)
class GeneratorMetaResourceDecision:
    """One causal generator-policy decision and its knobs."""

    action: Array
    weights: Float[Array, " n_policies"]
    op_id: Array
    parent_mode: Array
    replacement_multiplier: Array
    promotion_margin_multiplier: Array
    candidate_min_age_multiplier: Array
    imprint_scale: Array


@chex.dataclass(frozen=True)
class GeneratorMetaResourceUpdateResult:
    """Result of one generator meta-resource update."""

    state: GeneratorMetaResourceManagerState
    weights: Float[Array, " n_policies"]
    adjusted_rewards: Float[Array, " n_policies"]
    advantages: Float[Array, " n_policies"]


class GeneratorMetaResourceManager:
    """Contextual Hedge manager for feature-generator internals.

    A policy is a bundle of generator-internal choices: operation type, parent
    sampling mode, replacement rate multiplier, promotion-margin multiplier,
    candidate refresh age multiplier, and residual-imprint scale.  The manager
    chooses one policy before candidate construction and later updates policy
    preferences from causal provenance rewards, such as the utility of active
    or candidate features built by each policy.
    """

    def __init__(
        self,
        policy_names: tuple[str, ...],
        op_ids: tuple[int, ...],
        parent_modes: tuple[int, ...],
        replacement_multipliers: tuple[float, ...],
        promotion_margin_multipliers: tuple[float, ...],
        candidate_min_age_multipliers: tuple[float, ...],
        imprint_scales: tuple[float, ...],
        n_contexts: int = 1,
        learning_rate: float = 1.0,
        discount: float = 0.995,
        exploration: float = 0.01,
        reward_decay: float = 0.99,
        cost_weight: float = 0.0,
        advantage_clip: float = 10.0,
        update_rule: str = "hedge",
        initial_preferences: tuple[float, ...] | None = None,
    ) -> None:
        """Initialize a generator meta-resource manager.

        Args:
            policy_names: Stable names for generator policies.
            op_ids: Per-policy operation ids interpreted by the consumer.
            parent_modes: Per-policy parent-selection modes.
            replacement_multipliers: Per-policy replacement-rate multipliers.
            promotion_margin_multipliers: Per-policy promotion threshold
                multipliers; lower values are more aggressive.
            candidate_min_age_multipliers: Per-policy candidate refresh-age
                multipliers.
            imprint_scales: Per-policy residual-imprint scales.
            n_contexts: Number of independent context bins.
            learning_rate: Exponentiated-gradient step size.
            discount: Preference decay in ``[0, 1]``.
            exploration: Uniform action-probability floor in ``[0, 1)``.
            reward_decay: EMA decay for diagnostics.
            cost_weight: Multiplier on optional resource costs.
            advantage_clip: Absolute clip on centered rewards.
            update_rule: ``"hedge"`` updates all finite provenance scores;
                ``"exp3"`` applies an importance-weighted update to the
                sampled policy only.
            initial_preferences: Optional additive initial log-preferences.
        """
        n_policies = len(policy_names)
        if n_policies < 1:
            raise ValueError("at least one generator policy is required")
        lengths = {
            len(op_ids),
            len(parent_modes),
            len(replacement_multipliers),
            len(promotion_margin_multipliers),
            len(candidate_min_age_multipliers),
            len(imprint_scales),
        }
        if lengths != {n_policies}:
            raise ValueError("all generator policy tuples must have the same length")
        if n_contexts < 1:
            raise ValueError("n_contexts must be positive")
        if learning_rate < 0.0:
            raise ValueError("learning_rate must be non-negative")
        if not 0.0 <= discount <= 1.0:
            raise ValueError("discount must be in [0, 1]")
        if not 0.0 <= exploration < 1.0:
            raise ValueError("exploration must be in [0, 1)")
        if not 0.0 <= reward_decay < 1.0:
            raise ValueError("reward_decay must be in [0, 1)")
        if cost_weight < 0.0:
            raise ValueError("cost_weight must be non-negative")
        if advantage_clip <= 0.0:
            raise ValueError("advantage_clip must be positive")
        if update_rule not in {"hedge", "exp3"}:
            raise ValueError("update_rule must be 'hedge' or 'exp3'")
        if initial_preferences is not None and len(initial_preferences) != n_policies:
            raise ValueError("initial_preferences must match policy_names length")
        if any(value <= 0.0 for value in replacement_multipliers):
            raise ValueError("replacement_multipliers must be positive")
        if any(value <= 0.0 for value in promotion_margin_multipliers):
            raise ValueError("promotion_margin_multipliers must be positive")
        if any(value <= 0.0 for value in candidate_min_age_multipliers):
            raise ValueError("candidate_min_age_multipliers must be positive")
        if any(value < 0.0 for value in imprint_scales):
            raise ValueError("imprint_scales must be non-negative")

        self._policy_names = tuple(policy_names)
        self._op_ids = tuple(int(value) for value in op_ids)
        self._parent_modes = tuple(int(value) for value in parent_modes)
        self._replacement_multipliers = tuple(float(value) for value in replacement_multipliers)
        self._promotion_margin_multipliers = tuple(
            float(value) for value in promotion_margin_multipliers
        )
        self._candidate_min_age_multipliers = tuple(
            float(value) for value in candidate_min_age_multipliers
        )
        self._imprint_scales = tuple(float(value) for value in imprint_scales)
        self._n_contexts = int(n_contexts)
        self._learning_rate = float(learning_rate)
        self._discount = float(discount)
        self._exploration = float(exploration)
        self._reward_decay = float(reward_decay)
        self._cost_weight = float(cost_weight)
        self._advantage_clip = float(advantage_clip)
        self._update_rule = update_rule
        self._initial_preferences = (
            tuple(float(value) for value in initial_preferences)
            if initial_preferences is not None
            else tuple(0.0 for _ in range(n_policies))
        )

    @property
    def n_policies(self) -> int:
        """Number of generator policies."""
        return len(self._policy_names)

    @property
    def n_contexts(self) -> int:
        """Number of independent contexts."""
        return self._n_contexts

    def to_config(self) -> dict[str, Any]:
        """Serialize manager configuration."""
        return {
            "type": "GeneratorMetaResourceManager",
            "policy_names": list(self._policy_names),
            "op_ids": list(self._op_ids),
            "parent_modes": list(self._parent_modes),
            "replacement_multipliers": list(self._replacement_multipliers),
            "promotion_margin_multipliers": list(
                self._promotion_margin_multipliers
            ),
            "candidate_min_age_multipliers": list(
                self._candidate_min_age_multipliers
            ),
            "imprint_scales": list(self._imprint_scales),
            "n_contexts": self._n_contexts,
            "learning_rate": self._learning_rate,
            "discount": self._discount,
            "exploration": self._exploration,
            "reward_decay": self._reward_decay,
            "cost_weight": self._cost_weight,
            "advantage_clip": self._advantage_clip,
            "update_rule": self._update_rule,
            "initial_preferences": list(self._initial_preferences),
        }

    @classmethod
    def from_config(
        cls, config: dict[str, Any]
    ) -> GeneratorMetaResourceManager:
        """Reconstruct a manager from :meth:`to_config` output."""
        config = dict(config)
        config.pop("type", None)
        initial_preferences = config.pop("initial_preferences", None)
        return cls(
            policy_names=tuple(config.pop("policy_names")),
            op_ids=tuple(config.pop("op_ids")),
            parent_modes=tuple(config.pop("parent_modes")),
            replacement_multipliers=tuple(config.pop("replacement_multipliers")),
            promotion_margin_multipliers=tuple(
                config.pop("promotion_margin_multipliers")
            ),
            candidate_min_age_multipliers=tuple(
                config.pop("candidate_min_age_multipliers")
            ),
            imprint_scales=tuple(config.pop("imprint_scales")),
            initial_preferences=(
                None if initial_preferences is None else tuple(initial_preferences)
            ),
            **config,
        )

    def init(self) -> GeneratorMetaResourceManagerState:
        """Create an initial uniform-allocation state."""
        shape = (self._n_contexts, self.n_policies)
        initial = jnp.asarray(self._initial_preferences, dtype=jnp.float32)
        initial = initial - jnp.mean(initial)
        log_weights = jnp.broadcast_to(initial, shape)
        return GeneratorMetaResourceManagerState(  # type: ignore[call-arg]
            log_weights=log_weights,
            reward_ema=jnp.zeros(shape, dtype=jnp.float32),
            action_counts=jnp.zeros(shape, dtype=jnp.float32),
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def weights(
        self,
        state: GeneratorMetaResourceManagerState,
        context_id: Array | int = 0,
    ) -> Float[Array, " n_policies"]:
        """Return the current policy allocation for ``context_id``."""
        context = jnp.asarray(context_id, dtype=jnp.int32)
        weights = jax.nn.softmax(state.log_weights[context])
        if self._exploration > 0.0:
            uniform = jnp.full_like(weights, 1.0 / float(self.n_policies))
            weights = (1.0 - self._exploration) * weights + self._exploration * uniform
        return weights

    @functools.partial(jax.jit, static_argnums=(0,))
    def select(
        self,
        state: GeneratorMetaResourceManagerState,
        key: Array,
        context_id: Array | int = 0,
    ) -> GeneratorMetaResourceDecision:
        """Sample one policy and return the generator knobs it controls."""
        weights = self.weights(state, context_id)
        action = jr.categorical(key, jnp.log(weights + 1e-8)).astype(jnp.int32)
        op_ids = jnp.asarray(self._op_ids, dtype=jnp.int32)
        parent_modes = jnp.asarray(self._parent_modes, dtype=jnp.int32)
        replacement = jnp.asarray(self._replacement_multipliers, dtype=jnp.float32)
        margins = jnp.asarray(
            self._promotion_margin_multipliers,
            dtype=jnp.float32,
        )
        ages = jnp.asarray(
            self._candidate_min_age_multipliers,
            dtype=jnp.float32,
        )
        imprints = jnp.asarray(self._imprint_scales, dtype=jnp.float32)
        return GeneratorMetaResourceDecision(  # type: ignore[call-arg]
            action=action,
            weights=weights,
            op_id=op_ids[action],
            parent_mode=parent_modes[action],
            replacement_multiplier=replacement[action],
            promotion_margin_multiplier=margins[action],
            candidate_min_age_multiplier=ages[action],
            imprint_scale=imprints[action],
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: GeneratorMetaResourceManagerState,
        rewards: Float[Array, " n_policies"],
        context_id: Array | int = 0,
        finite_mask: Array | None = None,
        resource_costs: Float[Array, " n_policies"] | None = None,
        selected_action: Array | int | None = None,
        selected_probability: Array | float | None = None,
    ) -> GeneratorMetaResourceUpdateResult:
        """Update preferences from current per-policy rewards.

        ``NaN`` rewards, or entries masked out by ``finite_mask``, are ignored.
        Rewards are maximized, unlike :class:`LearnedResourceManager` losses.
        With ``update_rule="exp3"``, only ``selected_action`` receives an
        importance-weighted update.  This is useful when provenance rewards are
        sparse and the experiment wants explicit exploration credit.
        """
        context = jnp.asarray(context_id, dtype=jnp.int32)
        rewards = jnp.asarray(rewards, dtype=jnp.float32)
        finite = jnp.isfinite(rewards)
        if finite_mask is not None:
            finite = finite & jnp.asarray(finite_mask, dtype=jnp.bool_)
        safe_rewards = jnp.where(finite, rewards, 0.0)
        costs = (
            jnp.zeros_like(safe_rewards)
            if resource_costs is None
            else jnp.asarray(resource_costs, dtype=jnp.float32)
        )
        adjusted = safe_rewards - jnp.asarray(self._cost_weight, dtype=jnp.float32) * costs

        weights = self.weights(state, context)
        finite_weight_sum = jnp.maximum(jnp.sum(jnp.where(finite, weights, 0.0)), 1e-12)
        masked_weights = jnp.where(finite, weights / finite_weight_sum, 0.0)
        baseline = jnp.sum(masked_weights * adjusted)
        if self._update_rule == "exp3":
            if selected_action is None:
                raise ValueError("selected_action is required for update_rule='exp3'")
            action = jnp.asarray(selected_action, dtype=jnp.int32)
            probability = (
                weights[action]
                if selected_probability is None
                else jnp.asarray(selected_probability, dtype=jnp.float32)
            )
            probability = jnp.maximum(probability, 1e-6)
            selected_finite = finite[action]
            reward_hat = jnp.where(
                selected_finite,
                adjusted[action] / probability,
                jnp.array(0.0, dtype=jnp.float32),
            )
            raw_advantages = jnp.zeros_like(adjusted).at[action].set(reward_hat)
            raw_advantages = raw_advantages - jnp.mean(raw_advantages)
            advantages = jnp.where(selected_finite, raw_advantages, 0.0)
        else:
            advantages = jnp.where(finite, adjusted - baseline, 0.0)
        advantages = jnp.clip(
            advantages,
            -self._advantage_clip,
            self._advantage_clip,
        )

        old_context_logits = state.log_weights[context]
        new_context_logits = (
            self._discount * old_context_logits + self._learning_rate * advantages
        )
        new_context_logits = new_context_logits - jnp.mean(new_context_logits)
        new_log_weights = state.log_weights.at[context].set(new_context_logits)

        old_ema = state.reward_ema[context]
        new_ema = jnp.where(
            finite,
            self._reward_decay * old_ema + (1.0 - self._reward_decay) * adjusted,
            old_ema,
        )
        new_reward_ema = state.reward_ema.at[context].set(new_ema)
        new_counts = state.action_counts.at[context].add(finite.astype(jnp.float32))

        new_state = GeneratorMetaResourceManagerState(  # type: ignore[call-arg]
            log_weights=new_log_weights,
            reward_ema=new_reward_ema,
            action_counts=new_counts,
            step_count=state.step_count + 1,
        )
        return GeneratorMetaResourceUpdateResult(  # type: ignore[call-arg]
            state=new_state,
            weights=weights,
            adjusted_rewards=adjusted,
            advantages=advantages,
        )
