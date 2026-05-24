"""Production Step 1 kernel.

This module wraps the Step 1 research implementation in a narrow, stable API:

* canonical Alberta Plan Step 1 streams;
* public optimizers only, with no invented ``Auto`` alias;
* online normalizers used in the canonical ablations;
* a small smoke run suitable for integration tests and deployment probes.

For paper-scale evidence, use the scripts under
``examples/The Alberta Plan/Step1/`` and the committed artifacts under
``outputs/step1_canonical/``.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Literal, cast

import jax.numpy as jnp
import jax.random as jr
from jax import Array

from alberta_framework.core.baseline_optimizers import NADALINE, AdaGain, Adam, RMSprop
from alberta_framework.core.learners import LinearLearner, run_learning_loop
from alberta_framework.core.normalizers import (
    EMANormalizer,
    Normalizer,
    StreamingBatchNormalizer,
    WelfordNormalizer,
)
from alberta_framework.core.optimizers import (
    IDBD,
    LMS,
    Autostep,
    AutostepGTDLambda,
)
from alberta_framework.streams.alberta_plan_step1 import (
    AlbertaPlanStep1Stream,
    XDistShiftStream,
)

Step1OptimizerName = Literal[
    "lms",
    "idbd",
    "autostep",
    "autostep_gtd",
    "adagain",
    "adam",
    "rmsprop",
    "nadaline",
]
Step1NormalizerName = Literal["none", "ema", "welford", "streaming_batch"]
Step1StreamName = Literal["alberta", "xdist_shift"]


@dataclass(frozen=True)
class Step1KernelConfig:
    """Config for the production Step 1 kernel.

    The default is deliberately conservative for daemon/integration use:
    Autostep plus EMA normalization on the canonical drifting Alberta stream.
    Canonical paper claims should still be regenerated with the Step 1
    experiment scripts, because those run the full optimizer/normalizer grids.
    """

    feature_dim: int = 20
    num_relevant: int = 5
    optimizer: Step1OptimizerName = "autostep"
    normalizer: Step1NormalizerName = "ema"
    stream: Step1StreamName = "alberta"
    step_size: float = 0.01
    meta_step_size: float = 0.01
    drift_rate_w: float = 0.001
    drift_rate_b: float = 0.001
    noise_std: float = 1.0
    feature_std: float = 1.0
    ema_decay: float = 0.99
    streaming_batch_momentum: float = 0.99

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> Step1KernelConfig:
        """Reconstruct from :meth:`to_dict` output."""
        return cls(**cast(Any, payload))


@dataclass(frozen=True)
class Step1SmokeResult:
    """Summary returned by :func:`run_step1_smoke`."""

    config: Step1KernelConfig
    steps: int
    seed: int
    final_window_mse: float
    metrics_shape: tuple[int, ...]
    finite: bool

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        payload = asdict(self)
        payload["config"] = self.config.to_dict()
        payload["metrics_shape"] = list(self.metrics_shape)
        return payload


def make_step1_optimizer(config: Step1KernelConfig) -> Any:
    """Construct a public Step 1 optimizer from ``config``.

    ``Auto (Degris in prep.)`` is intentionally not accepted: no public update
    rule is available in the cited sources, so the production package exposes
    only reproducible optimizers.
    """
    name = config.optimizer.lower()
    if name == "lms":
        return LMS(step_size=config.step_size)
    if name == "idbd":
        return IDBD(
            initial_step_size=config.step_size,
            meta_step_size=config.meta_step_size,
        )
    if name == "autostep":
        return Autostep(
            initial_step_size=config.step_size,
            meta_step_size=config.meta_step_size,
        )
    if name == "autostep_gtd":
        # Autostep-for-GTD(lambda) per Kearney et al. 2019. The supervised
        # mode reduces to standard Autostep, providing a reproducible
        # implementation for Alberta Plan footnote 11 closure.
        return AutostepGTDLambda(
            initial_step_size=config.step_size,
            meta_step_size=config.meta_step_size,
        )
    if name == "adagain":
        return AdaGain(initial_step_size=config.step_size)
    if name == "adam":
        return Adam(step_size=config.step_size)
    if name == "rmsprop":
        return RMSprop(step_size=config.step_size)
    if name == "nadaline":
        return NADALINE(step_size=config.step_size)
    msg = f"unknown Step 1 optimizer {config.optimizer!r}"
    raise ValueError(msg)


def make_step1_normalizer(
    config: Step1KernelConfig,
) -> Normalizer[Any] | None:
    """Construct an online normalizer from ``config``."""
    name = config.normalizer.lower()
    if name == "none":
        return None
    if name == "ema":
        return EMANormalizer(decay=config.ema_decay)
    if name == "welford":
        return WelfordNormalizer()
    if name == "streaming_batch":
        return StreamingBatchNormalizer(momentum=config.streaming_batch_momentum)
    msg = f"unknown Step 1 normalizer {config.normalizer!r}"
    raise ValueError(msg)


def make_step1_stream(
    config: Step1KernelConfig,
) -> AlbertaPlanStep1Stream | XDistShiftStream:
    """Construct the configured Step 1 stream."""
    if config.stream == "alberta":
        return AlbertaPlanStep1Stream(
            feature_dim=config.feature_dim,
            num_relevant=config.num_relevant,
            drift_rate_w=config.drift_rate_w,
            drift_rate_b=config.drift_rate_b,
            noise_std=config.noise_std,
            feature_std=config.feature_std,
        )
    if config.stream == "xdist_shift":
        return XDistShiftStream(
            feature_dim=config.feature_dim,
            num_relevant=config.num_relevant,
            noise_in_target=config.noise_std > 0.0,
        )
    msg = f"unknown Step 1 stream {config.stream!r}"
    raise ValueError(msg)


def make_step1_learner(config: Step1KernelConfig | None = None) -> LinearLearner:
    """Create the production Step 1 learner."""
    cfg = config or Step1KernelConfig()
    return LinearLearner(
        optimizer=make_step1_optimizer(cfg),
        normalizer=make_step1_normalizer(cfg),
    )


def run_step1_smoke(
    config: Step1KernelConfig | None = None,
    *,
    steps: int = 256,
    seed: int = 0,
    final_window: int = 64,
) -> Step1SmokeResult:
    """Run a tiny deterministic Step 1 integration probe.

    The smoke probe is intentionally not a scientific claim.  It verifies that
    the production kernel can initialize, compile, update online, and return
    finite metrics.
    """
    if steps < 1:
        raise ValueError(f"steps must be positive, got {steps}")
    if final_window < 1 or final_window > steps:
        raise ValueError(
            f"final_window must be in [1, steps], got {final_window}"
        )
    cfg = config or Step1KernelConfig()
    learner = make_step1_learner(cfg)
    stream = make_step1_stream(cfg)
    loop_result = cast(
        tuple[Any, Array],
        run_learning_loop(
            learner,
            cast(Any, stream),
            num_steps=steps,
            key=jr.key(seed),
        ),
    )
    metrics = loop_result[1]
    metrics.block_until_ready()
    window = metrics[-final_window:, 0]
    final_window_mse = float(jnp.mean(window))
    return Step1SmokeResult(
        config=cfg,
        steps=steps,
        seed=seed,
        final_window_mse=final_window_mse,
        metrics_shape=tuple(int(dim) for dim in metrics.shape),
        finite=bool(jnp.all(jnp.isfinite(metrics))),
    )
