"""Tests for sliced isotropic Gaussian regularization."""

from __future__ import annotations

import chex
import jax.numpy as jnp
import jax.random as jr

from alberta_framework.core.sigreg import (
    SIGRegConfig,
    epps_pulley_gaussian_statistic,
    sample_sigreg_directions,
    sigreg_diagnostics,
    sliced_sigreg_loss,
)


def test_sigreg_config_roundtrip_and_direction_shapes() -> None:
    config = SIGRegConfig(n_projections=7, kernel_width=1.5)
    restored = SIGRegConfig.from_config(config.to_config())
    assert restored == config

    directions = sample_sigreg_directions(jr.key(0), latent_dim=5, config=config)

    chex.assert_shape(directions, (7, 5))
    chex.assert_trees_all_close(
        jnp.linalg.norm(directions, axis=1),
        jnp.ones((7,), dtype=jnp.float32),
        atol=1.0e-5,
    )


def test_epps_pulley_statistic_penalizes_collapsed_samples() -> None:
    gaussian = jr.normal(jr.key(1), (128,), dtype=jnp.float32)
    collapsed = jnp.zeros((128,), dtype=jnp.float32)

    gaussian_loss = epps_pulley_gaussian_statistic(gaussian)
    collapsed_loss = epps_pulley_gaussian_statistic(collapsed)

    assert float(collapsed_loss) > float(gaussian_loss)


def test_sliced_sigreg_penalizes_shifted_and_collapsed_embeddings() -> None:
    key = jr.key(2)
    z_key, dir_key = jr.split(key)
    gaussian = jr.normal(z_key, (96, 6), dtype=jnp.float32)
    shifted = 2.0 + 0.2 * gaussian
    collapsed = jnp.zeros_like(gaussian)
    directions = sample_sigreg_directions(
        dir_key,
        latent_dim=6,
        config=SIGRegConfig(n_projections=16),
    )

    gaussian_loss = sliced_sigreg_loss(gaussian, directions)
    shifted_loss = sliced_sigreg_loss(shifted, directions)
    collapsed_loss = sliced_sigreg_loss(collapsed, directions)

    assert float(shifted_loss) > float(gaussian_loss)
    assert float(collapsed_loss) > float(gaussian_loss)


def test_sigreg_diagnostics_are_finite() -> None:
    config = SIGRegConfig(n_projections=8)
    embeddings = jr.normal(jr.key(3), (32, 4), dtype=jnp.float32)
    directions = sample_sigreg_directions(jr.key(4), latent_dim=4, config=config)

    diagnostics = sigreg_diagnostics(embeddings, directions, config)

    chex.assert_tree_all_finite(diagnostics)
    chex.assert_shape(diagnostics.loss, ())
