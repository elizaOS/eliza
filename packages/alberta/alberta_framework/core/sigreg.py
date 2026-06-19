# mypy: disable-error-code="call-arg"
"""Sliced isotropic Gaussian regularization for latent representations.

SIGReg is useful whenever a learner emits a batch of latent features that
should avoid collapse while retaining a simple Gaussian prior. The functions
here are model-agnostic: callers can use them as a diagnostic, an auxiliary
loss in a batch learner, or a gate before trusting imagined rollouts.
"""

from __future__ import annotations

import dataclasses
from typing import Any

import chex
import jax
import jax.numpy as jnp
from jax import Array
from jaxtyping import Float


@dataclasses.dataclass(frozen=True)
class SIGRegConfig:
    """Configuration for sliced Gaussian regularization.

    Args:
        n_projections: Number of random unit directions.
        kernel_width: Gaussian-kernel width used in the Epps-Pulley/BHEP
            statistic. ``1.0`` is the standard simple setting.
        eps: Numerical floor for norms and square roots.
    """

    n_projections: int = 32
    kernel_width: float = 1.0
    eps: float = 1.0e-8

    def __post_init__(self) -> None:
        """Validate the configuration."""
        if self.n_projections <= 0:
            raise ValueError("n_projections must be positive")
        if self.kernel_width <= 0.0:
            raise ValueError("kernel_width must be positive")
        if self.eps <= 0.0:
            raise ValueError("eps must be positive")

    def to_config(self) -> dict[str, Any]:
        """Serialize to a JSON-compatible dictionary."""
        payload = dataclasses.asdict(self)
        payload["type"] = "SIGRegConfig"
        return payload

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> SIGRegConfig:
        """Reconstruct from :meth:`to_config` output."""
        payload = dict(config)
        payload.pop("type", None)
        return cls(**payload)


@chex.dataclass(frozen=True)
class SIGRegDiagnostics:
    """Distribution diagnostics for a latent batch."""

    loss: Float[Array, ""]
    latent_mean_abs: Float[Array, ""]
    latent_std_mean: Float[Array, ""]
    latent_std_min: Float[Array, ""]
    projected_mean_abs: Float[Array, ""]
    projected_std_mean: Float[Array, ""]


def sample_sigreg_directions(
    key: Array,
    latent_dim: int,
    config: SIGRegConfig | None = None,
) -> Float[Array, "n_projections latent_dim"]:
    """Sample random unit directions for sliced SIGReg."""
    cfg = config or SIGRegConfig()
    if latent_dim <= 0:
        raise ValueError("latent_dim must be positive")
    directions = jax.random.normal(
        key,
        (cfg.n_projections, latent_dim),
        dtype=jnp.float32,
    )
    norms = jnp.linalg.norm(directions, axis=1, keepdims=True)
    return directions / jnp.maximum(norms, jnp.asarray(cfg.eps, dtype=jnp.float32))


def epps_pulley_gaussian_statistic(
    samples: Array,
    *,
    kernel_width: float = 1.0,
) -> Float[Array, ""]:
    """Return the one-dimensional Epps-Pulley/BHEP Gaussian statistic.

    This is the biased Gaussian-kernel MMD between the empirical one-
    dimensional sample distribution and ``N(0, 1)``. It is zero only when the
    projected distribution matches the target Gaussian in the population limit.
    """
    width = jnp.asarray(kernel_width, dtype=jnp.float32)
    x = jnp.ravel(jnp.asarray(samples, dtype=jnp.float32))
    diffs = x[:, None] - x[None, :]
    empirical = jnp.mean(jnp.exp(-(diffs**2) / (2.0 * width**2)))
    cross_scale = jnp.sqrt((width**2) / (width**2 + 1.0))
    cross = jnp.mean(
        cross_scale * jnp.exp(-(x**2) / (2.0 * (width**2 + 1.0)))
    )
    target = jnp.sqrt((width**2) / (width**2 + 2.0))
    return jnp.maximum(empirical - 2.0 * cross + target, 0.0)


def sliced_sigreg_loss(
    embeddings: Array,
    directions: Array,
    *,
    kernel_width: float = 1.0,
) -> Float[Array, ""]:
    """Compute sliced isotropic Gaussian regularization loss.

    Args:
        embeddings: Array with shape ``(..., latent_dim)``.
        directions: Unit projection directions with shape
            ``(n_projections, latent_dim)``.
        kernel_width: Gaussian-kernel width for each projected normality test.

    Returns:
        Mean one-dimensional Epps-Pulley/BHEP statistic across directions.
    """
    z = jnp.asarray(embeddings, dtype=jnp.float32)
    dirs = jnp.asarray(directions, dtype=jnp.float32)
    if z.ndim < 2:
        raise ValueError("embeddings must have shape (..., latent_dim)")
    flat = jnp.reshape(z, (-1, z.shape[-1]))
    projections = flat @ dirs.T
    per_projection = jax.vmap(
        lambda values: epps_pulley_gaussian_statistic(
            values,
            kernel_width=kernel_width,
        ),
        in_axes=1,
    )(projections)
    return jnp.mean(per_projection)


def sigreg_diagnostics(
    embeddings: Array,
    directions: Array,
    config: SIGRegConfig | None = None,
) -> SIGRegDiagnostics:
    """Return SIGReg loss plus simple latent distribution diagnostics."""
    cfg = config or SIGRegConfig()
    z = jnp.asarray(embeddings, dtype=jnp.float32)
    dirs = jnp.asarray(directions, dtype=jnp.float32)
    flat = jnp.reshape(z, (-1, z.shape[-1]))
    projected = flat @ dirs.T
    latent_std = jnp.std(flat, axis=0)
    projected_std = jnp.std(projected, axis=0)
    return SIGRegDiagnostics(
        loss=sliced_sigreg_loss(flat, dirs, kernel_width=cfg.kernel_width),
        latent_mean_abs=jnp.mean(jnp.abs(jnp.mean(flat, axis=0))),
        latent_std_mean=jnp.mean(latent_std),
        latent_std_min=jnp.min(latent_std),
        projected_mean_abs=jnp.mean(jnp.abs(jnp.mean(projected, axis=0))),
        projected_std_mean=jnp.mean(projected_std),
    )


__all__ = [
    "SIGRegConfig",
    "SIGRegDiagnostics",
    "epps_pulley_gaussian_statistic",
    "sample_sigreg_directions",
    "sigreg_diagnostics",
    "sliced_sigreg_loss",
]
