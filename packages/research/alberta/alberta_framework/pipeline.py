# mypy: disable-error-code="attr-defined,call-arg,no-any-return,unused-ignore"
"""End-to-end Alberta Plan Step 1-4 pipeline glue.

The production pipeline composes the existing packaged pieces conservatively:

1. Step 1 enters through the adaptive optimizers used by later learners.
2. Step 2 supplies feature augmentation via either the lightweight temporal
   context featurizer or the promoted nonlinear UPGD learner whose penultimate
   hidden activations become the feature vector for downstream Step 3 and
   Step 4 learners.
3. Step 3 learns GVF/Horde predictions on those features. Cumulants are
   either supplied through a caller-provided callable or fall back to the
   observation-channel cumulant function used by the legacy smoke API.
4. Step 4 learns control on the same features, either as discrete SARSA
   (default) or as a Horde-backed actor-critic (``HordeActorCriticAgent``).

The API is intentionally narrow and transition-oriented.  It is suitable for
daemon smoke tests, downstream integration probes, and checkpointed online
state, while research-scale experiments should continue to use their dedicated
runners.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from typing import Any, Literal, cast

import chex
import jax
import jax.numpy as jnp
import jax.random as jr
from jax import Array

from alberta_framework.core.associative_memory import (
    AssociativeFeatureFamily,
    AssociativeMemoryConfig,
    AssociativeMemoryLearner,
    AssociativeMemoryState,
)
from alberta_framework.core.horde import HordeLearner
from alberta_framework.core.horde_actor_critic import (
    HordeActorCriticAgent,
    HordeActorCriticConfig,
    HordeActorCriticState,
)
from alberta_framework.core.multi_head_learner import MultiHeadMLPState
from alberta_framework.core.optimizers import ObGDBounding
from alberta_framework.core.sarsa import SARSAState
from alberta_framework.core.temporal_context import (
    TemporalContextConfig,
    TemporalContextFeaturizer,
    TemporalContextState,
)
from alberta_framework.core.upgd import UPGDLearner, UPGDState
from alberta_framework.steps.step3 import (
    Step3HordeConfig,
    init_step3_state,
    make_step3_horde,
    step3_predict,
    step3_update,
)
from alberta_framework.steps.step4 import (
    Step4SARSAConfig,
    init_step4_state,
    make_step4_sarsa_agent,
    step4_update,
)

Step2Mode = Literal["temporal_context", "upgd", "associative", "identity"]
Step2UPGDPreset = Literal["default", "strict_digit_readout"]
Step2UPGDReadoutMode = Literal[
    "linear_mse",
    "softmax_ce",
    "adaptive_simplex",
    "factorized_simplex",
    "adaptive_factorized_simplex",
    "two_timescale_simplex",
]
ControlMode = Literal["sarsa", "horde_ac"]

CumulantFn = Callable[[Array, Array, Array], Array]
"""Caller-supplied cumulant function.

Signature: ``(observation, reward, terminated) -> Array(n_demons,)``.
"""


@dataclass(frozen=True)
class Step2FeatureConfig:
    """Config for the lightweight temporal-context Step 2 layer.

    This is the historical "raw + EMA + delta + phase products" featurizer
    retained for back-compatibility. New deployments should consider
    :class:`Step2UPGDConfig` for the promoted nonlinear Step 2 path.
    """

    observation_dim: int = 4
    include_raw: bool = True
    include_ema: bool = True
    include_delta: bool = True
    include_phase_products: bool = False
    ema_decay: float = 0.95
    periods: tuple[float, ...] = (32.0, 64.0)

    def __post_init__(self) -> None:
        """Validate observation and feature settings."""
        if self.observation_dim < 1:
            msg = f"observation_dim must be positive, got {self.observation_dim}"
            raise ValueError(msg)
        if not (self.include_raw or self.include_ema or self.include_delta):
            msg = "at least one of include_raw/include_ema/include_delta is required"
            raise ValueError(msg)
        if not 0.0 <= self.ema_decay < 1.0:
            msg = f"ema_decay must be in [0, 1), got {self.ema_decay}"
            raise ValueError(msg)
        if any(period <= 0.0 for period in self.periods):
            msg = "all periods must be positive"
            raise ValueError(msg)

    @classmethod
    def identity(cls, observation_dim: int) -> Step2FeatureConfig:
        """Return a raw-observation feature config."""
        return cls(
            observation_dim=observation_dim,
            include_raw=True,
            include_ema=False,
            include_delta=False,
            periods=(),
        )

    def to_temporal_context_config(self) -> TemporalContextConfig:
        """Return the core Step 2 featurizer config."""
        return TemporalContextConfig(
            input_dim=self.observation_dim,
            include_raw=self.include_raw,
            include_ema=self.include_ema,
            include_delta=self.include_delta,
            include_phase_products=self.include_phase_products,
            ema_decay=self.ema_decay,
            periods=self.periods,
        )

    def output_dim(self) -> int:
        """Return the Step 2 feature dimensionality."""
        return self.to_temporal_context_config().output_dim()

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        payload = asdict(self)
        payload["periods"] = list(self.periods)
        return payload

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> Step2FeatureConfig:
        """Reconstruct from :meth:`to_dict` output."""
        config = dict(payload)
        config["periods"] = tuple(cast(list[float], config.get("periods", [])))
        return cls(**cast(Any, config))


@dataclass(frozen=True)
class Step2UPGDConfig:
    """Config for the promoted UPGD-backed Step 2 featurizer.

    The UPGD learner's penultimate hidden activations are exposed as the
    feature vector for downstream Step 3 and Step 4 learners. The number of
    UPGD heads is configurable; supervised targets may optionally be passed
    through :meth:`AlbertaPipeline.update` to drive UPGD learning. When no
    targets are supplied, UPGD operates as a representation extractor whose
    weights are unchanged and the hidden activations are propagated as-is.
    """

    observation_dim: int = 4
    n_heads: int = 1
    hidden_sizes: tuple[int, ...] = (32,)
    step_size: float = 0.03
    sparsity: float = 0.5
    use_layer_norm: bool = True
    learner_preset: Step2UPGDPreset = "default"
    loss_normalization: Literal["target_structure", "target_density"] = (
        "target_structure"
    )
    readout_mode: Step2UPGDReadoutMode = "linear_mse"

    def __post_init__(self) -> None:
        """Validate configuration."""
        if self.observation_dim < 1:
            msg = f"observation_dim must be positive, got {self.observation_dim}"
            raise ValueError(msg)
        if self.n_heads < 1:
            msg = f"n_heads must be positive, got {self.n_heads}"
            raise ValueError(msg)
        if not self.hidden_sizes or any(size < 1 for size in self.hidden_sizes):
            msg = (
                "hidden_sizes must contain at least one positive size, "
                f"got {self.hidden_sizes!r}"
            )
            raise ValueError(msg)
        if self.step_size < 0.0:
            msg = f"step_size must be non-negative, got {self.step_size}"
            raise ValueError(msg)
        if not 0.0 <= self.sparsity <= 1.0:
            msg = f"sparsity must be in [0, 1], got {self.sparsity}"
            raise ValueError(msg)
        if self.learner_preset not in ("default", "strict_digit_readout"):
            msg = f"unknown learner_preset {self.learner_preset!r}"
            raise ValueError(msg)
        if self.loss_normalization not in ("target_structure", "target_density"):
            msg = f"unknown loss_normalization {self.loss_normalization!r}"
            raise ValueError(msg)
        valid_readouts = (
            "linear_mse",
            "softmax_ce",
            "adaptive_simplex",
            "factorized_simplex",
            "adaptive_factorized_simplex",
            "two_timescale_simplex",
        )
        if self.readout_mode not in valid_readouts:
            msg = f"unknown readout_mode {self.readout_mode!r}"
            raise ValueError(msg)
        if self.learner_preset == "strict_digit_readout" and (
            self.loss_normalization != "target_structure"
            or self.readout_mode != "two_timescale_simplex"
        ):
            msg = (
                "strict_digit_readout preset requires "
                "loss_normalization='target_structure' and "
                "readout_mode='two_timescale_simplex'"
            )
            raise ValueError(msg)
        if self.learner_preset == "strict_digit_readout" and (
            self.sparsity != 0.5 or not self.use_layer_norm
        ):
            msg = (
                "strict_digit_readout preset owns sparsity/use_layer_norm; "
                "use sparsity=0.5 and use_layer_norm=True"
            )
            raise ValueError(msg)

    @classmethod
    def strict_digit_readout(
        cls,
        *,
        observation_dim: int = 64,
        n_heads: int = 10,
        hidden_sizes: tuple[int, ...] = (64, 64),
        step_size: float = 0.018,
    ) -> Step2UPGDConfig:
        """Return the promoted strict digit/readout Step 2 config."""
        return cls(
            observation_dim=observation_dim,
            n_heads=n_heads,
            hidden_sizes=hidden_sizes,
            step_size=step_size,
            learner_preset="strict_digit_readout",
            readout_mode="two_timescale_simplex",
        )

    def output_dim(self) -> int:
        """Penultimate-layer dimensionality used as features."""
        return self.hidden_sizes[-1]

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        payload = asdict(self)
        payload["hidden_sizes"] = list(self.hidden_sizes)
        return payload

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> Step2UPGDConfig:
        """Reconstruct from :meth:`to_dict` output."""
        config = dict(payload)
        config["hidden_sizes"] = tuple(cast(list[int], config["hidden_sizes"]))
        return cls(**cast(Any, config))


@dataclass(frozen=True)
class Step2AssociativePipelineConfig:
    """Config for associative Step 2 features in the end-to-end pipeline."""

    vocab_size: int = 16
    block_size: int = 8
    suffix_length: int = 4
    feature_family: AssociativeFeatureFamily = "token_suffix_pair"
    max_features: int = 512
    write_lr: float = 1.0
    retention: float = 0.80
    utility_lr: float = 0.10
    utility_decay: float = 0.995
    min_weight: float = 0.02
    max_weight: float = 8.0
    logit_scale: float = 4.0
    normalize_by_weight: bool = True
    adaptive_feature_family: bool = False
    adaptive_window: bool = False
    adaptive_budget: bool = False
    scope_lr: float = 0.05
    budget_lr: float = 0.05
    initial_budget_fraction: float = 0.5
    min_effective_budget: int = 1
    scope_logit_clip: float = 8.0

    def __post_init__(self) -> None:
        """Validate integer context settings."""
        if self.vocab_size < 2:
            raise ValueError("vocab_size must be at least 2")
        if self.block_size < 1:
            raise ValueError("block_size must be positive")
        if self.suffix_length < 2 or self.suffix_length > self.block_size:
            raise ValueError("suffix_length must be in [2, block_size]")
        if self.max_features < 1:
            raise ValueError("max_features must be positive")
        if self.scope_lr < 0.0:
            raise ValueError("scope_lr must be non-negative")
        if self.budget_lr < 0.0:
            raise ValueError("budget_lr must be non-negative")
        if not 0.0 < self.initial_budget_fraction <= 1.0:
            raise ValueError("initial_budget_fraction must be in (0, 1]")
        if self.min_effective_budget < 1:
            raise ValueError("min_effective_budget must be positive")
        if self.min_effective_budget > self.max_features:
            raise ValueError("min_effective_budget must be <= max_features")
        if self.scope_logit_clip <= 0.0:
            raise ValueError("scope_logit_clip must be positive")

    def output_dim(self) -> int:
        """Return the associative probability-vector dimensionality."""
        return self.vocab_size

    def to_core_config(self) -> AssociativeMemoryConfig:
        """Return the core associative memory config."""
        return AssociativeMemoryConfig(
            vocab_size=self.vocab_size,
            block_size=self.block_size,
            suffix_length=self.suffix_length,
            feature_family=self.feature_family,
            max_features=self.max_features,
            write_lr=self.write_lr,
            retention=self.retention,
            utility_lr=self.utility_lr,
            utility_decay=self.utility_decay,
            min_weight=self.min_weight,
            max_weight=self.max_weight,
            logit_scale=self.logit_scale,
            normalize_by_weight=self.normalize_by_weight,
            adaptive_feature_family=self.adaptive_feature_family,
            adaptive_window=self.adaptive_window,
            adaptive_budget=self.adaptive_budget,
            scope_lr=self.scope_lr,
            budget_lr=self.budget_lr,
            initial_budget_fraction=self.initial_budget_fraction,
            min_effective_budget=self.min_effective_budget,
            scope_logit_clip=self.scope_logit_clip,
        )

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        return asdict(self)

    @classmethod
    def from_dict(
        cls,
        payload: dict[str, object],
    ) -> Step2AssociativePipelineConfig:
        """Reconstruct from :meth:`to_dict` output."""
        return cls(**cast(Any, payload))


@dataclass(frozen=True)
class HordeActorCriticPipelineConfig:
    """Config wrapper for the Horde actor-critic Step 4 control."""

    n_actions: int = 2
    actor_step_size: float = 0.01
    actor_lamda: float = 0.9
    temperature: float = 1.0
    value_head_index: int = 0
    actor_obgd_kappa: float | None = None

    def __post_init__(self) -> None:
        """Validate configuration."""
        if self.n_actions < 1:
            msg = f"n_actions must be positive, got {self.n_actions}"
            raise ValueError(msg)
        if self.actor_step_size < 0.0:
            msg = f"actor_step_size must be non-negative, got {self.actor_step_size}"
            raise ValueError(msg)
        if not 0.0 <= self.actor_lamda <= 1.0:
            msg = f"actor_lamda must be in [0, 1], got {self.actor_lamda}"
            raise ValueError(msg)
        if self.temperature <= 0.0:
            msg = f"temperature must be positive, got {self.temperature}"
            raise ValueError(msg)
        if self.value_head_index < 0:
            msg = (
                "value_head_index must be non-negative, "
                f"got {self.value_head_index}"
            )
            raise ValueError(msg)

    def to_horde_actor_critic_config(self) -> HordeActorCriticConfig:
        """Return the core actor-critic config."""
        return HordeActorCriticConfig(
            n_actions=self.n_actions,
            actor_step_size=self.actor_step_size,
            actor_lamda=self.actor_lamda,
            temperature=self.temperature,
            value_head_index=self.value_head_index,
        )

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> HordeActorCriticPipelineConfig:
        """Reconstruct from :meth:`to_dict` output."""
        return cls(**cast(Any, payload))


@dataclass(frozen=True)
class AlbertaPipelineConfig:
    """Config for the Step 1-4 production pipeline.

    The ``step2`` and ``control`` fields select which Step 2 featurizer and
    Step 4 control mode the pipeline runs. Defaults preserve the legacy
    behavior (temporal-context features + SARSA control); set ``step2="upgd"``
    or ``control="horde_ac"`` to opt into the integrated Step 2/Step 4
    components.
    """

    features: Step2FeatureConfig = field(default_factory=Step2FeatureConfig)
    upgd: Step2UPGDConfig | None = None
    associative: Step2AssociativePipelineConfig | None = None
    horde: Step3HordeConfig = field(default_factory=Step3HordeConfig)
    control: Step4SARSAConfig = field(default_factory=Step4SARSAConfig)
    horde_ac: HordeActorCriticPipelineConfig | None = None
    step2: Step2Mode = "temporal_context"
    control_mode: ControlMode = "sarsa"

    def __post_init__(self) -> None:
        """Validate combinations of step2/control and required sub-configs."""
        if self.step2 not in ("temporal_context", "upgd", "associative", "identity"):
            msg = f"unknown step2 mode {self.step2!r}"
            raise ValueError(msg)
        if self.control_mode not in ("sarsa", "horde_ac"):
            msg = f"unknown control_mode {self.control_mode!r}"
            raise ValueError(msg)
        if self.step2 == "upgd" and self.upgd is None:
            msg = "upgd config is required when step2='upgd'"
            raise ValueError(msg)
        if self.step2 == "associative" and self.associative is None:
            msg = "associative config is required when step2='associative'"
            raise ValueError(msg)
        if self.control_mode == "horde_ac" and self.horde_ac is None:
            msg = "horde_ac config is required when control_mode='horde_ac'"
            raise ValueError(msg)
        if self.control_mode == "horde_ac":
            ac = cast(HordeActorCriticPipelineConfig, self.horde_ac)
            if ac.value_head_index >= self.horde.n_demons:
                msg = (
                    "horde_ac.value_head_index must reference an existing "
                    f"horde demon (got {ac.value_head_index}, n_demons="
                    f"{self.horde.n_demons})"
                )
                raise ValueError(msg)

    def feature_dim(self) -> int:
        """Return the feature dimensionality passed to Step 3 and Step 4."""
        if self.step2 == "upgd":
            return cast(Step2UPGDConfig, self.upgd).output_dim()
        if self.step2 == "associative":
            return cast(Step2AssociativePipelineConfig, self.associative).output_dim()
        if self.step2 == "identity":
            return self.features.observation_dim
        return self.features.output_dim()

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        return {
            "features": self.features.to_dict(),
            "upgd": self.upgd.to_dict() if self.upgd is not None else None,
            "associative": (
                self.associative.to_dict() if self.associative is not None else None
            ),
            "horde": self.horde.to_dict(),
            "control": self.control.to_dict(),
            "horde_ac": (
                self.horde_ac.to_dict() if self.horde_ac is not None else None
            ),
            "step2": self.step2,
            "control_mode": self.control_mode,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> AlbertaPipelineConfig:
        """Reconstruct from :meth:`to_dict` output."""
        upgd_payload = payload.get("upgd")
        associative_payload = payload.get("associative")
        horde_ac_payload = payload.get("horde_ac")
        return cls(
            features=Step2FeatureConfig.from_dict(
                cast(dict[str, object], payload["features"])
            ),
            upgd=Step2UPGDConfig.from_dict(cast(dict[str, object], upgd_payload))
            if upgd_payload is not None
            else None,
            associative=Step2AssociativePipelineConfig.from_dict(
                cast(dict[str, object], associative_payload)
            )
            if associative_payload is not None
            else None,
            horde=Step3HordeConfig.from_dict(
                cast(dict[str, object], payload["horde"])
            ),
            control=Step4SARSAConfig.from_dict(
                cast(dict[str, object], payload["control"])
            ),
            horde_ac=HordeActorCriticPipelineConfig.from_dict(
                cast(dict[str, object], horde_ac_payload)
            )
            if horde_ac_payload is not None
            else None,
            step2=cast(Step2Mode, payload.get("step2", "temporal_context")),
            control_mode=cast(ControlMode, payload.get("control_mode", "sarsa")),
        )


@chex.dataclass(frozen=True)
class AlbertaPipelineState:
    """Checkpoint-friendly immutable state for the Step 1-4 pipeline.

    ``feature_state`` stores the temporal-context state when ``step2`` is
    ``"temporal_context"``; otherwise it is None. ``upgd_state`` stores the
    UPGD learner state when ``step2`` is ``"upgd"``; otherwise it is None.
    ``control_state`` is either a SARSA state or a HordeActorCritic state
    depending on ``control_mode``.
    """

    feature_state: TemporalContextState | None
    upgd_state: UPGDState | None
    associative_state: AssociativeMemoryState | None
    horde_state: MultiHeadMLPState
    control_state: SARSAState | HordeActorCriticState
    last_features: Array
    step_count: Array


@chex.dataclass(frozen=True)
class AlbertaPipelineStepResult:
    """Result from one end-to-end transition update.

    ``q_values`` carries Q-values when ``control_mode == "sarsa"`` and the
    softmax policy when ``control_mode == "horde_ac"``. The ``action`` field
    is the action selected/sampled at the new observation.
    """

    state: AlbertaPipelineState
    features: Array
    horde_predictions: Array
    horde_td_errors: Array
    horde_td_targets: Array
    q_values: Array
    action: Array
    control_td_error: Array
    reward: Array


@chex.dataclass(frozen=True)
class AlbertaPipelineArrayResult:
    """Result from scanning the end-to-end pipeline over arrays."""

    state: AlbertaPipelineState
    features: Array
    horde_predictions: Array
    horde_td_errors: Array
    q_values: Array
    actions: Array
    control_td_errors: Array


@dataclass(frozen=True)
class AlbertaPipelineSmokeResult:
    """Summary returned by :func:`run_pipeline_smoke`."""

    config: AlbertaPipelineConfig
    steps: int
    seed: int
    feature_shape: tuple[int, ...]
    horde_predictions_shape: tuple[int, ...]
    q_values_shape: tuple[int, ...]
    actions_shape: tuple[int, ...]
    finite: bool

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        payload = asdict(self)
        payload["config"] = self.config.to_dict()
        payload["feature_shape"] = list(self.feature_shape)
        payload["horde_predictions_shape"] = list(self.horde_predictions_shape)
        payload["q_values_shape"] = list(self.q_values_shape)
        payload["actions_shape"] = list(self.actions_shape)
        return payload


def observation_channel_cumulant_fn(
    n_demons: int, observation_dim: int
) -> CumulantFn:
    """Return a cumulant function that maps demons to observation channels."""
    if n_demons < 1:
        msg = f"n_demons must be positive, got {n_demons}"
        raise ValueError(msg)
    if observation_dim < 1:
        msg = f"observation_dim must be positive, got {observation_dim}"
        raise ValueError(msg)

    indices = jnp.arange(n_demons) % max(observation_dim, 1)

    def cumulant_fn(
        observation: Array, _reward: Array, _terminated: Array
    ) -> Array:
        obs_1d = jnp.atleast_1d(observation)
        return obs_1d[indices]

    return cumulant_fn


class AlbertaPipeline:
    """Composable Step 2 featurization + Step 3 Horde + Step 4 control.

    See :class:`AlbertaPipelineConfig` for selecting between temporal-context
    and UPGD Step 2 featurization, and between SARSA and HordeActorCritic
    Step 4 control. A caller-supplied ``cumulant_fn`` substitutes domain Step 3
    cumulants for the default observation-channel cumulants; passing
    ``cumulant_fn=None`` preserves the legacy smoke behavior for
    back-compatibility.
    """

    def __init__(
        self,
        config: AlbertaPipelineConfig | None = None,
        *,
        cumulant_fn: CumulantFn | None = None,
    ):
        """Construct all pipeline components from ``config``."""
        self._config = config or AlbertaPipelineConfig()

        if self._config.step2 == "temporal_context":
            self._featurizer: TemporalContextFeaturizer | None = (
                TemporalContextFeaturizer(
                    self._config.features.to_temporal_context_config()
                )
            )
        else:
            self._featurizer = None

        if self._config.step2 == "upgd":
            upgd_cfg = cast(Step2UPGDConfig, self._config.upgd)
            if upgd_cfg.learner_preset == "strict_digit_readout":
                self._upgd: UPGDLearner | None = (
                    UPGDLearner.step2_strict_digit_readout_default(
                        n_heads=upgd_cfg.n_heads,
                        hidden_sizes=upgd_cfg.hidden_sizes,
                        step_size=upgd_cfg.step_size,
                    )
                )
            else:
                self._upgd = UPGDLearner(
                    n_heads=upgd_cfg.n_heads,
                    hidden_sizes=upgd_cfg.hidden_sizes,
                    step_size=upgd_cfg.step_size,
                    bounder=ObGDBounding(kappa=0.5),
                    sparsity=upgd_cfg.sparsity,
                    use_layer_norm=upgd_cfg.use_layer_norm,
                    perturbation_sigma=1e-4,
                    perturbation_noise="rademacher",
                    utility_decay=0.995,
                    perturbation_beta=2.0,
                    perturbation_interval=16,
                    loss_normalization=upgd_cfg.loss_normalization,
                    readout_mode=upgd_cfg.readout_mode,
                    track_unit_utilities=False,
                    track_gradient_history=False,
                )
        else:
            self._upgd = None

        if self._config.step2 == "associative":
            assoc_cfg = cast(Step2AssociativePipelineConfig, self._config.associative)
            self._associative: AssociativeMemoryLearner | None = (
                AssociativeMemoryLearner(assoc_cfg.to_core_config())
            )
        else:
            self._associative = None

        self._horde = make_step3_horde(self._config.horde)

        self._control: HordeActorCriticAgent | Any
        if self._config.control_mode == "horde_ac":
            ac_cfg = cast(HordeActorCriticPipelineConfig, self._config.horde_ac)
            actor_bounder = (
                ObGDBounding(kappa=ac_cfg.actor_obgd_kappa)
                if ac_cfg.actor_obgd_kappa is not None
                else None
            )
            # HordeActorCritic requires the shared-trunk HordeLearner; the
            # mixed/independent routings are unsupported as a critic backend.
            if not isinstance(self._horde, HordeLearner):
                msg = (
                    "control_mode='horde_ac' requires Step 3 routing='shared'; "
                    f"got {type(self._horde).__name__}"
                )
                raise TypeError(msg)
            self._control = HordeActorCriticAgent(
                config=ac_cfg.to_horde_actor_critic_config(),
                critic=self._horde,
                actor_bounder=actor_bounder,
            )
        else:
            self._control = make_step4_sarsa_agent(
                self._config.control,
                prediction_demons=tuple(self._horde.horde_spec.demons),
            )

        observation_dim = self._observation_dim()
        self._cumulant_fn: CumulantFn = cumulant_fn or observation_channel_cumulant_fn(
            self._config.horde.n_demons, observation_dim
        )

    def _observation_dim(self) -> int:
        if self._config.step2 == "upgd":
            return cast(Step2UPGDConfig, self._config.upgd).observation_dim
        if self._config.step2 == "associative":
            return cast(Step2AssociativePipelineConfig, self._config.associative).block_size
        return self._config.features.observation_dim

    @property
    def config(self) -> AlbertaPipelineConfig:
        """Pipeline configuration."""
        return self._config

    @property
    def feature_dim(self) -> int:
        """Feature dimensionality emitted by Step 2."""
        return self._config.feature_dim()

    @property
    def featurizer(self) -> TemporalContextFeaturizer | None:
        """Underlying temporal-context featurizer if configured."""
        return self._featurizer

    @property
    def upgd(self) -> UPGDLearner | None:
        """Underlying UPGD learner if configured."""
        return self._upgd

    @property
    def associative(self) -> AssociativeMemoryLearner | None:
        """Underlying associative memory learner if configured."""
        return self._associative

    @property
    def horde(self) -> Any:
        """Underlying Step 3 Horde learner."""
        return self._horde

    @property
    def control(self) -> Any:
        """Underlying Step 4 control agent (SARSA or HordeActorCritic)."""
        return self._control

    @property
    def cumulant_fn(self) -> CumulantFn:
        """Cumulant function used by Step 3."""
        return self._cumulant_fn

    def _features_from_observation(
        self,
        feature_state: TemporalContextState | None,
        upgd_state: UPGDState | None,
        associative_state: AssociativeMemoryState | None,
        observation: Array,
    ) -> tuple[
        TemporalContextState | None,
        UPGDState | None,
        AssociativeMemoryState | None,
        Array,
    ]:
        """Produce the Step 2 feature vector for an observation."""
        if self._config.step2 == "temporal_context":
            featurizer = cast(TemporalContextFeaturizer, self._featurizer)
            assert feature_state is not None
            new_feature_state, features = featurizer.step(feature_state, observation)
            return new_feature_state, upgd_state, associative_state, features
        if self._config.step2 == "upgd":
            upgd = cast(UPGDLearner, self._upgd)
            assert upgd_state is not None
            features = upgd._trunk_forward(  # noqa: SLF001
                upgd_state.trunk_params.weights,
                upgd_state.trunk_params.biases,
                observation,
                upgd._leaky_relu_slope,  # noqa: SLF001
                upgd._use_layer_norm,  # noqa: SLF001
            )
            return feature_state, upgd_state, associative_state, features
        if self._config.step2 == "associative":
            associative = cast(AssociativeMemoryLearner, self._associative)
            assert associative_state is not None
            prediction = associative.predict(
                associative_state,
                jnp.asarray(observation, dtype=jnp.int32),
            )
            return feature_state, upgd_state, associative_state, prediction.probabilities
        # identity
        return feature_state, upgd_state, associative_state, observation

    def init(self, key: Array, initial_observation: Array) -> AlbertaPipelineState:
        """Initialize learner state and prime control with the first observation."""
        upgd_key, horde_key, control_key = jr.split(key, 3)

        feature_state: TemporalContextState | None = None
        upgd_state: UPGDState | None = None
        associative_state: AssociativeMemoryState | None = None
        observation_dim = self._observation_dim()

        if self._config.step2 == "temporal_context":
            featurizer = cast(TemporalContextFeaturizer, self._featurizer)
            feature_state, initial_features = featurizer.step(
                featurizer.init(),
                initial_observation,
            )
        elif self._config.step2 == "upgd":
            upgd = cast(UPGDLearner, self._upgd)
            upgd_state = upgd.init(observation_dim, upgd_key)
            initial_features = upgd._trunk_forward(  # noqa: SLF001
                upgd_state.trunk_params.weights,
                upgd_state.trunk_params.biases,
                initial_observation,
                upgd._leaky_relu_slope,  # noqa: SLF001
                upgd._use_layer_norm,  # noqa: SLF001
            )
        elif self._config.step2 == "associative":
            associative = cast(AssociativeMemoryLearner, self._associative)
            associative_state = associative.init()
            initial_features = associative.predict(
                associative_state,
                jnp.asarray(initial_observation, dtype=jnp.int32),
            ).probabilities
        else:
            initial_features = initial_observation

        horde_state = init_step3_state(
            self._horde,
            feature_dim=self.feature_dim,
            key=horde_key,
        )

        control_state: SARSAState | HordeActorCriticState
        if self._config.control_mode == "horde_ac":
            ac = cast(HordeActorCriticAgent, self._control)
            ac_state = ac.init(self.feature_dim, control_key)
            ac_state, _action, _probs = ac.start(ac_state, initial_features)
            horde_state = ac_state.critic_state
            control_state = ac_state
        else:
            control_state = init_step4_state(
                self._control,
                feature_dim=self.feature_dim,
                key=control_key,
                initial_features=initial_features,
            )

        return AlbertaPipelineState(
            feature_state=feature_state,
            upgd_state=upgd_state,
            associative_state=associative_state,
            horde_state=horde_state,
            control_state=control_state,
            last_features=initial_features,
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    def predict(self, state: AlbertaPipelineState) -> tuple[Array, Array]:
        """Return Step 3 predictions and Step 4 control outputs.

        For SARSA control, the second element is the per-action Q-value
        vector. For HordeActorCritic control, it is the softmax action
        probability vector.
        """
        horde_predictions = step3_predict(
            self._horde,
            state.horde_state,
            state.last_features,
        )
        if self._config.control_mode == "horde_ac":
            ac = cast(HordeActorCriticAgent, self._control)
            ac_state = cast(HordeActorCriticState, state.control_state)
            policy = ac.policy(ac_state, state.last_features)
            return horde_predictions, policy
        sarsa_state = cast(SARSAState, state.control_state)
        q_values = self._control.horde.predict(
            sarsa_state.learner_state,
            state.last_features,
        )[: self._config.control.n_actions]
        return horde_predictions, q_values

    def update(
        self,
        state: AlbertaPipelineState,
        observation: Array,
        reward: Array,
        terminated: Array,
        horde_cumulants: Array | None = None,
        upgd_targets: Array | None = None,
        associative_label: Array | None = None,
    ) -> AlbertaPipelineStepResult:
        """Advance every pipeline component by one transition.

        ``state.last_features`` represents the previous observation. The new
        raw ``observation`` is transformed by Step 2, then Step 3 and Step 4
        both update on the resulting transition.

        Args:
            state: Current pipeline state.
            observation: Next raw observation.
            reward: Scalar transition reward.
            terminated: Scalar termination flag (``0.0`` or ``1.0``).
            horde_cumulants: Optional explicit Step 3 cumulants of shape
                ``(n_demons,)``. When omitted, the configured cumulant
                function, or the default observation-channel cumulant function,
                is used.
            upgd_targets: Optional supervised targets of shape ``(n_heads,)``
                that drive UPGD learning when ``step2='upgd'``. NaN entries
                mark inactive heads. When omitted, UPGD weights stay frozen
                and the trunk acts as a pure feature extractor.
            associative_label: Optional integer next-token/class label that
                drives associative-memory writes when ``step2='associative'``.
        """
        (
            new_feature_state,
            new_upgd_state,
            new_associative_state,
            features,
        ) = self._features_from_observation(
            state.feature_state,
            state.upgd_state,
            state.associative_state,
            observation,
        )
        if (
            self._config.step2 == "upgd"
            and upgd_targets is not None
            and new_upgd_state is not None
        ):
            upgd = cast(UPGDLearner, self._upgd)
            upgd_result = upgd.update(new_upgd_state, observation, upgd_targets)
            new_upgd_state = upgd_result.state
            features = upgd._trunk_forward(  # noqa: SLF001
                new_upgd_state.trunk_params.weights,
                new_upgd_state.trunk_params.biases,
                observation,
                upgd._leaky_relu_slope,  # noqa: SLF001
                upgd._use_layer_norm,  # noqa: SLF001
            )
        if (
            self._config.step2 == "associative"
            and associative_label is not None
            and new_associative_state is not None
        ):
            associative = cast(AssociativeMemoryLearner, self._associative)
            assoc_result = associative.update(
                new_associative_state,
                jnp.asarray(observation, dtype=jnp.int32),
                jnp.asarray(associative_label, dtype=jnp.int32),
            )
            new_associative_state = assoc_result.state
            features = assoc_result.predictions

        if horde_cumulants is None:
            horde_cumulants = self._cumulant_fn(observation, reward, terminated)
        horde_cumulants = jnp.asarray(horde_cumulants, dtype=jnp.float32)

        if self._config.control_mode == "horde_ac":
            ac = cast(HordeActorCriticAgent, self._control)
            ac_state = cast(HordeActorCriticState, state.control_state)
            ac_state = ac_state.replace(critic_state=state.horde_state)
            n_total_demons = self._horde.n_demons
            value_index = cast(
                HordeActorCriticPipelineConfig, self._config.horde_ac
            ).value_head_index
            aux_indices = jnp.array(
                [i for i in range(n_total_demons) if i != value_index],
                dtype=jnp.int32,
            )
            auxiliary_cumulants = horde_cumulants[aux_indices] if aux_indices.size else None
            ac_result = ac.update(
                ac_state,
                reward,
                features,
                auxiliary_cumulants=auxiliary_cumulants,
            )
            new_control_state: SARSAState | HordeActorCriticState = ac_result.state
            q_values_or_policy = ac_result.policy
            action_out = ac_result.action
            control_td_error = ac_result.td_error
            reward_out = jnp.asarray(reward, dtype=jnp.float32)
            # The actor-critic update already updated the critic for us;
            # we override horde_state to keep them in sync.
            new_horde_state = ac_result.critic_result.state
            horde_predictions = ac_result.critic_result.predictions
            horde_td_errors = ac_result.critic_result.td_errors
            horde_td_targets = ac_result.critic_result.td_targets
        else:
            horde_result = step3_update(
                self._horde,
                state.horde_state,
                state.last_features,
                horde_cumulants,
                features,
            )
            sarsa_state = cast(SARSAState, state.control_state)
            control_result = step4_update(
                self._control,
                sarsa_state,
                reward,
                features,
                terminated,
                prediction_cumulants=horde_cumulants,
            )
            new_control_state = control_result.state
            q_values_or_policy = control_result.q_values
            action_out = control_result.action
            control_td_error = control_result.td_error
            reward_out = control_result.reward
            new_horde_state = horde_result.state
            horde_predictions = horde_result.predictions
            horde_td_errors = horde_result.td_errors
            horde_td_targets = horde_result.td_targets

        next_state = AlbertaPipelineState(
            feature_state=new_feature_state,
            upgd_state=new_upgd_state,
            associative_state=new_associative_state,
            horde_state=new_horde_state,
            control_state=new_control_state,
            last_features=features,
            step_count=state.step_count + 1,
        )
        return AlbertaPipelineStepResult(
            state=next_state,
            features=features,
            horde_predictions=horde_predictions,
            horde_td_errors=horde_td_errors,
            horde_td_targets=horde_td_targets,
            q_values=q_values_or_policy,
            action=action_out,
            control_td_error=control_td_error,
            reward=reward_out,
        )

    def run_arrays(
        self,
        state: AlbertaPipelineState,
        observations: Array,
        rewards: Array,
        terminated: Array,
        horde_cumulants: Array,
        upgd_targets: Array | None = None,
        associative_labels: Array | None = None,
    ) -> AlbertaPipelineArrayResult:
        """Scan the pipeline over transition arrays.

        ``state`` should be initialized with the observation that precedes the
        first row in ``observations``. ``horde_cumulants`` is required here
        (the per-step callable variant is :meth:`update`); array runs use a
        fully resolved cumulant table for ``jax.lax.scan`` compatibility.
        """
        if upgd_targets is None:
            steps = observations.shape[0]
            upgd_targets_array = jnp.full(
                (steps, self._config.upgd.n_heads if self._config.upgd else 1),
                jnp.nan,
                dtype=jnp.float32,
            )
        else:
            upgd_targets_array = jnp.asarray(upgd_targets, dtype=jnp.float32)
        associative_labels_array = (
            jnp.asarray(associative_labels, dtype=jnp.int32)
            if associative_labels is not None
            else jnp.zeros((observations.shape[0],), dtype=jnp.int32)
        )
        use_associative_labels = (
            self._config.step2 == "associative" and associative_labels is not None
        )

        def step_fn(
            carry: AlbertaPipelineState,
            inputs: tuple[Array, Array, Array, Array, Array, Array],
        ) -> tuple[AlbertaPipelineState, tuple[Array, Array, Array, Array, Array, Array]]:
            (
                obs_t,
                reward_t,
                terminated_t,
                cumulants_t,
                upgd_target_t,
                associative_label_t,
            ) = inputs
            result = self.update(
                carry,
                obs_t,
                reward_t,
                terminated_t,
                cumulants_t,
                upgd_target_t if self._config.step2 == "upgd" else None,
                associative_label_t if use_associative_labels else None,
            )
            return result.state, (
                result.features,
                result.horde_predictions,
                result.horde_td_errors,
                result.q_values,
                result.action,
                result.control_td_error,
            )

        final_state, outputs = jax.lax.scan(
            step_fn,
            state,
            (
                observations,
                rewards,
                terminated,
                horde_cumulants,
                upgd_targets_array,
                associative_labels_array,
            ),
        )
        (
            features,
            horde_predictions,
            horde_td_errors,
            q_values,
            actions,
            control_td_errors,
        ) = outputs
        return AlbertaPipelineArrayResult(
            state=final_state,
            features=features,
            horde_predictions=horde_predictions,
            horde_td_errors=horde_td_errors,
            q_values=q_values,
            actions=actions,
            control_td_errors=control_td_errors,
        )


def make_alberta_pipeline(
    config: AlbertaPipelineConfig | None = None,
    *,
    cumulant_fn: CumulantFn | None = None,
) -> AlbertaPipeline:
    """Create an end-to-end Alberta production pipeline."""
    return AlbertaPipeline(config, cumulant_fn=cumulant_fn)


def run_pipeline_smoke(
    config: AlbertaPipelineConfig | None = None,
    *,
    steps: int = 24,
    seed: int = 0,
) -> AlbertaPipelineSmokeResult:
    """Run a deterministic Step 1-4 pipeline smoke probe."""
    if steps < 1:
        msg = f"steps must be positive, got {steps}"
        raise ValueError(msg)
    cfg = config or AlbertaPipelineConfig()
    pipeline = make_alberta_pipeline(cfg)

    observation_dim = pipeline._observation_dim()  # noqa: SLF001

    data_key, state_key = jr.split(jr.key(seed))
    if cfg.step2 == "associative" and cfg.associative is not None:
        observations = jr.randint(
            data_key,
            (steps + 1, observation_dim),
            minval=0,
            maxval=cfg.associative.vocab_size,
            dtype=jnp.int32,
        )
        rewards = jnp.tanh(observations[1:, 0].astype(jnp.float32))
        associative_labels = (
            observations[1:, -1] + 3 * observations[1:, -2] + observations[1:, 0]
        ) % cfg.associative.vocab_size
    else:
        observations = jr.normal(
            data_key,
            (steps + 1, observation_dim),
            dtype=jnp.float32,
        )
        rewards = jnp.tanh(observations[1:, 0])
        associative_labels = None
    terminated = jnp.zeros(steps, dtype=jnp.float32)
    cumulant_indices = jnp.arange(cfg.horde.n_demons) % observation_dim
    horde_cumulants = observations[1:, cumulant_indices].astype(jnp.float32)

    state = pipeline.init(state_key, observations[0])
    result = pipeline.run_arrays(
        state,
        observations[1:],
        rewards,
        terminated,
        horde_cumulants,
        associative_labels=associative_labels,
    )
    result.q_values.block_until_ready()

    finite_actions = (
        jnp.all(result.actions >= 0)
        & jnp.all(result.actions < cfg.horde_ac.n_actions)
        if cfg.control_mode == "horde_ac" and cfg.horde_ac is not None
        else jnp.all(result.actions >= 0) & jnp.all(result.actions < cfg.control.n_actions)
    )
    finite = bool(
        jnp.all(jnp.isfinite(result.features))
        & jnp.all(jnp.isfinite(result.horde_predictions))
        & jnp.all(jnp.isfinite(result.horde_td_errors))
        & jnp.all(jnp.isfinite(result.q_values))
        & jnp.all(jnp.isfinite(result.control_td_errors))
        & finite_actions
    )
    return AlbertaPipelineSmokeResult(
        config=cfg,
        steps=steps,
        seed=seed,
        feature_shape=tuple(int(dim) for dim in result.features.shape),
        horde_predictions_shape=tuple(
            int(dim) for dim in result.horde_predictions.shape
        ),
        q_values_shape=tuple(int(dim) for dim in result.q_values.shape),
        actions_shape=tuple(int(dim) for dim in result.actions.shape),
        finite=finite,
    )
