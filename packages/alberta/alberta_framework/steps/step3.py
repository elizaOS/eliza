# mypy: disable-error-code="call-arg"
"""Production Step 3 Horde helpers.

This module packages the stable Step 3 surface for downstream use:

* given-feature GVF prediction through :class:`HordeLearner`;
* a causal array handoff from Step 2 constructed features to Horde inputs;
* a small smoke run for integration tests.

It intentionally does not claim general TD/GVF feature-discovery closure.
Research-scale evidence and open boundaries are documented under
``docs/research/step3_results.md``.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Literal, cast

import chex
import jax.numpy as jnp
import jax.random as jr
from jax import Array

from alberta_framework.core.horde import (
    HordeLearner,
    HordeLearningResult,
    HordeUpdateResult,
    MixedHorde,
    run_horde_learning_loop,
    run_mixed_horde_learning_loop,
)
from alberta_framework.core.independent_demon_horde import (
    IndependentDemonHorde,
    run_independent_horde_learning_loop,
)
from alberta_framework.core.multi_head_learner import MultiHeadMLPState
from alberta_framework.core.normalizers import EMANormalizer, Normalizer
from alberta_framework.core.optimizers import ObGDBounding
from alberta_framework.core.types import DemonType, GVFSpec, TraceMode, create_horde_spec

Step3NormalizerName = Literal["none", "ema"]
Step3TraceModeName = Literal["accumulating", "replacing"]
Step3RoutingName = Literal["shared", "independent", "mixed"]


@dataclass(frozen=True)
class Step3HordeConfig:
    """Config for the production Step 3 given-feature Horde kernel.

    The default is a compact linear Horde with three prediction demons. Hidden
    layers may be enabled, but shared-trunk trace decay remains head-only via
    :class:`HordeLearner`; this helper does not implement nonlinear shared-trunk
    forward-view traces.
    """

    gammas: tuple[float, ...] = (0.0, 0.5, 0.9)
    lamdas: tuple[float, ...] = (0.0, 0.5, 0.8)
    hidden_sizes: tuple[int, ...] = ()
    step_size: float = 0.05
    use_obgd: bool = True
    obgd_kappa: float = 2.0
    normalizer: Step3NormalizerName = "none"
    sparsity: float = 0.0
    use_layer_norm: bool = True
    trace_mode: Step3TraceModeName = "accumulating"
    routing: Step3RoutingName = "shared"

    @property
    def n_demons(self) -> int:
        """Number of Step 3 GVF demons."""
        return len(self.gammas)

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        payload = asdict(self)
        payload["gammas"] = list(self.gammas)
        payload["lamdas"] = list(self.lamdas)
        payload["hidden_sizes"] = list(self.hidden_sizes)
        return payload

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> Step3HordeConfig:
        """Reconstruct from :meth:`to_dict` output."""
        config = dict(payload)
        config["gammas"] = tuple(cast(list[float], config["gammas"]))
        config["lamdas"] = tuple(cast(list[float], config["lamdas"]))
        config["hidden_sizes"] = tuple(cast(list[int], config["hidden_sizes"]))
        return cls(**cast(Any, config))


@dataclass(frozen=True)
class Step3HandoffArrays:
    """Arrays needed by :func:`run_horde_learning_loop`.

    ``observations[t]`` is ``concat(raw_observations[t], constructed_features[t])``.
    ``next_observations[t]`` is the shifted augmented row for the same
    transition. Callers are responsible for constructing row ``t`` features
    causally, using only information available at time ``t``.
    """

    observations: Array
    cumulants: Array
    next_observations: Array

    @property
    def feature_dim(self) -> int:
        """Dimension of each augmented Horde observation."""
        return int(self.observations.shape[1])

    @property
    def n_demons(self) -> int:
        """Number of cumulant streams/demons."""
        return int(self.cumulants.shape[1])

    def to_dict(self) -> dict[str, object]:
        """Return shape metadata for logs and smoke tests."""
        return {
            "observations_shape": list(self.observations.shape),
            "cumulants_shape": list(self.cumulants.shape),
            "next_observations_shape": list(self.next_observations.shape),
            "feature_dim": self.feature_dim,
            "n_demons": self.n_demons,
        }


@dataclass(frozen=True)
class Step3SmokeResult:
    """Summary returned by :func:`run_step3_smoke`."""

    config: Step3HordeConfig
    steps: int
    seed: int
    final_window_mse: float
    per_demon_metrics_shape: tuple[int, ...]
    td_errors_shape: tuple[int, ...]
    finite: bool
    handoff: Step3HandoffArrays
    horde_config: dict[str, Any]

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        return {
            "config": self.config.to_dict(),
            "steps": self.steps,
            "seed": self.seed,
            "final_window_mse": self.final_window_mse,
            "per_demon_metrics_shape": list(self.per_demon_metrics_shape),
            "td_errors_shape": list(self.td_errors_shape),
            "finite": self.finite,
            "handoff": self.handoff.to_dict(),
            "horde_config": self.horde_config,
        }


@chex.dataclass(frozen=True)
class Step3OneStepResult:
    """Result from one production Step 3 transition."""

    state: MultiHeadMLPState
    predictions: Array
    td_errors: Array
    td_targets: Array
    per_demon_metrics: Array


def _validate_horde_config(config: Step3HordeConfig) -> None:
    if len(config.gammas) == 0:
        raise ValueError("Step 3 Horde must have at least one demon")
    if len(config.gammas) != len(config.lamdas):
        msg = (
            "gammas and lamdas must have the same length, "
            f"got {len(config.gammas)} and {len(config.lamdas)}"
        )
        raise ValueError(msg)
    for name, values in (("gammas", config.gammas), ("lamdas", config.lamdas)):
        invalid = [value for value in values if value < 0.0 or value > 1.0]
        if invalid:
            msg = f"{name} must all be in [0, 1], got {invalid!r}"
            raise ValueError(msg)
    if config.step_size < 0.0:
        raise ValueError(f"step_size must be non-negative, got {config.step_size}")
    if any(size < 1 for size in config.hidden_sizes):
        msg = f"hidden_sizes must contain positive sizes, got {config.hidden_sizes!r}"
        raise ValueError(msg)


def make_step3_normalizer(
    config: Step3HordeConfig,
) -> Normalizer[Any] | None:
    """Construct the configured Step 3 input normalizer."""
    if config.normalizer == "none":
        return None
    if config.normalizer == "ema":
        return EMANormalizer()
    msg = f"unknown Step 3 normalizer {config.normalizer!r}"
    raise ValueError(msg)


def make_step3_horde_spec(config: Step3HordeConfig | None = None) -> Any:
    """Create the GVF metadata used by the production Horde."""
    cfg = config or Step3HordeConfig()
    _validate_horde_config(cfg)
    demons = [
        GVFSpec(
            name=f"gvf_{idx}",
            demon_type=DemonType.PREDICTION,
            gamma=gamma,
            lamda=lamda,
            cumulant_index=idx,
        )
        for idx, (gamma, lamda) in enumerate(zip(cfg.gammas, cfg.lamdas, strict=True))
    ]
    return create_horde_spec(demons)


def make_step3_horde(
    config: Step3HordeConfig | None = None,
) -> HordeLearner | IndependentDemonHorde | MixedHorde:
    """Create the production Step 3 given-feature Horde learner.

    Dispatches on ``config.routing``:

    - ``"shared"`` (default): :class:`HordeLearner` (shared trunk,
      head-only traces). Trunk gamma*lamda is forced to 0.
    - ``"independent"``: :class:`IndependentDemonHorde` (each demon owns
      its own MLP). Full per-parameter forward-view traces.
    - ``"mixed"``: :class:`MixedHorde`. Per-demon routing — demons with
      gamma*lamda=0 land on the shared path; demons with gamma*lamda>0
      land on the independent path. Eliminates the trunk-trace
      constraint while keeping memory cost low when most demons are
      single-step (gamma*lamda=0).
    """
    cfg = config or Step3HordeConfig()
    _validate_horde_config(cfg)
    bounder = ObGDBounding(kappa=cfg.obgd_kappa) if cfg.use_obgd else None
    common_kwargs: dict[str, Any] = {
        "horde_spec": make_step3_horde_spec(cfg),
        "hidden_sizes": cfg.hidden_sizes,
        "step_size": cfg.step_size,
        "bounder": bounder,
        "normalizer": make_step3_normalizer(cfg),
        "sparsity": cfg.sparsity,
        "use_layer_norm": cfg.use_layer_norm,
        "trace_mode": TraceMode(cfg.trace_mode),
    }
    if cfg.routing == "shared":
        return HordeLearner(**common_kwargs)
    if cfg.routing == "independent":
        return IndependentDemonHorde(**common_kwargs)
    if cfg.routing == "mixed":
        return MixedHorde(**common_kwargs)
    msg = f"unknown Step 3 routing {cfg.routing!r}"
    raise ValueError(msg)


def init_step3_state(
    horde: HordeLearner,
    *,
    feature_dim: int,
    key: Array,
) -> MultiHeadMLPState:
    """Initialize a Step 3 Horde state."""
    return horde.init(feature_dim, key)


def step3_predict(
    horde: HordeLearner,
    state: MultiHeadMLPState,
    features: Array,
) -> Array:
    """Return one prediction per Step 3 demon."""
    return cast(Array, horde.predict(state, features))


def step3_update(
    horde: HordeLearner,
    state: MultiHeadMLPState,
    features: Array,
    cumulants: Array,
    next_features: Array,
) -> Step3OneStepResult:
    """Run one Step 3 Horde transition update."""
    result: HordeUpdateResult = horde.update(
        state,
        features,
        cumulants,
        next_features,
    )
    return Step3OneStepResult(
        state=result.state,
        predictions=result.predictions,
        td_errors=result.td_errors,
        td_targets=result.td_targets,
        per_demon_metrics=result.per_demon_metrics,
    )


def run_step3_scan(
    horde: HordeLearner,
    state: MultiHeadMLPState,
    features: Array,
    cumulants: Array,
    next_features: Array,
) -> HordeLearningResult:
    """Run the Step 3 Horde over transition arrays."""
    return run_horde_learning_loop(
        horde,
        state,
        features,
        cumulants,
        next_features,
    )


def build_step2_to_step3_arrays(
    raw_observations: Array,
    constructed_features: Array,
    cumulants: Array,
) -> Step3HandoffArrays:
    """Build causal Horde arrays from Step 2 constructed features.

    Args:
        raw_observations: Raw observations, shape ``(steps, raw_dim)``.
        constructed_features: Step 2 features available at the same time index,
            shape ``(steps, constructed_dim)``.
        cumulants: Per-demon cumulants for the transition starting at each row,
            shape ``(steps, n_demons)``.

    Returns:
        Augmented observations, cumulants, and shifted next observations for
        :func:`run_horde_learning_loop`.
    """
    raw = jnp.asarray(raw_observations, dtype=jnp.float32)
    constructed = jnp.asarray(constructed_features, dtype=jnp.float32)
    cums = jnp.asarray(cumulants, dtype=jnp.float32)

    if raw.ndim != 2:
        raise ValueError(f"raw_observations must be 2D, got shape {raw.shape}")
    if constructed.ndim != 2:
        msg = f"constructed_features must be 2D, got shape {constructed.shape}"
        raise ValueError(msg)
    if cums.ndim != 2:
        raise ValueError(f"cumulants must be 2D, got shape {cums.shape}")
    steps = raw.shape[0]
    if steps < 1:
        raise ValueError("at least one transition is required")
    if raw.shape[1] < 1:
        raise ValueError("raw_observations must have at least one feature column")
    if cums.shape[1] < 1:
        raise ValueError("cumulants must have at least one demon column")
    if constructed.shape[0] != steps:
        msg = (
            "constructed_features must have the same number of rows as "
            f"raw_observations, got {constructed.shape[0]} and {steps}"
        )
        raise ValueError(msg)
    if cums.shape[0] != steps:
        msg = (
            "cumulants must have the same number of rows as raw_observations, "
            f"got {cums.shape[0]} and {steps}"
        )
        raise ValueError(msg)

    observations = jnp.concatenate([raw, constructed], axis=1)
    next_observations = jnp.concatenate([observations[1:], observations[-1:]], axis=0)
    return Step3HandoffArrays(
        observations=observations,
        cumulants=cums,
        next_observations=next_observations,
    )


def _synthetic_step2_features(raw_observations: Array, n_features: int) -> Array:
    """Create deterministic Step-2-style product features for smoke tests."""
    if n_features < 1:
        return jnp.zeros((raw_observations.shape[0], 0), dtype=jnp.float32)
    raw_dim = raw_observations.shape[1]
    cols = []
    for idx in range(n_features):
        left = idx % raw_dim
        right = (idx + 1) % raw_dim
        cols.append(raw_observations[:, left] * raw_observations[:, right])
    return jnp.stack(cols, axis=1)


def run_step3_smoke(
    config: Step3HordeConfig | None = None,
    *,
    steps: int = 128,
    seed: int = 0,
    final_window: int = 32,
    raw_feature_dim: int = 4,
    constructed_feature_dim: int = 3,
) -> Step3SmokeResult:
    """Run a tiny deterministic Step 3 Horde integration probe.

    The smoke probe verifies the Step 2-to-Horde array contract, Horde
    initialization, TD updates, finite diagnostics, and config serialization.
    It is not a feature-discovery or throughput claim.
    """
    if steps < 1:
        raise ValueError(f"steps must be positive, got {steps}")
    if final_window < 1 or final_window > steps:
        raise ValueError(
            f"final_window must be in [1, steps], got {final_window}"
        )
    if raw_feature_dim < 1:
        raise ValueError(f"raw_feature_dim must be positive, got {raw_feature_dim}")
    if constructed_feature_dim < 0:
        msg = (
            "constructed_feature_dim must be non-negative, "
            f"got {constructed_feature_dim}"
        )
        raise ValueError(msg)

    cfg = config or Step3HordeConfig()
    _validate_horde_config(cfg)
    data_key, learner_key = jr.split(jr.key(seed))
    raw_observations = jr.normal(data_key, (steps, raw_feature_dim))
    constructed_features = _synthetic_step2_features(
        raw_observations, constructed_feature_dim
    )
    n_demons = len(cfg.gammas)
    if constructed_feature_dim > 0:
        source = constructed_features
    else:
        source = raw_observations
    cumulants = jnp.stack(
        [source[:, idx % source.shape[1]] for idx in range(n_demons)],
        axis=1,
    )

    arrays = build_step2_to_step3_arrays(
        raw_observations,
        constructed_features,
        cumulants,
    )
    horde = make_step3_horde(cfg)
    state = horde.init(arrays.feature_dim, learner_key)
    result: Any
    if isinstance(horde, MixedHorde):
        result = run_mixed_horde_learning_loop(
            horde,
            state,  # type: ignore[arg-type]
            arrays.observations,
            arrays.cumulants,
            arrays.next_observations,
        )
    elif isinstance(horde, IndependentDemonHorde):
        result = run_independent_horde_learning_loop(
            horde,
            state,  # type: ignore[arg-type]
            arrays.observations,
            arrays.cumulants,
            arrays.next_observations,
        )
    else:
        result = run_horde_learning_loop(
            horde,
            state,  # type: ignore[arg-type]
            arrays.observations,
            arrays.cumulants,
            arrays.next_observations,
        )
    result.per_demon_metrics.block_until_ready()
    window = result.per_demon_metrics[-final_window:, :, 0]
    final_window_mse = float(jnp.nanmean(window))
    finite = bool(
        jnp.all(jnp.isfinite(result.per_demon_metrics))
        & jnp.all(jnp.isfinite(result.td_errors))
    )
    return Step3SmokeResult(
        config=cfg,
        steps=steps,
        seed=seed,
        final_window_mse=final_window_mse,
        per_demon_metrics_shape=tuple(int(dim) for dim in result.per_demon_metrics.shape),
        td_errors_shape=tuple(int(dim) for dim in result.td_errors.shape),
        finite=finite,
        handoff=arrays,
        horde_config=horde.to_config(),
    )
