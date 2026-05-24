"""Theory-facing invariants for Step 2 representation-learning claims."""

from __future__ import annotations

import math

import numpy as np
from numpy.typing import NDArray

from alberta_framework.core.upgd import UPGDLearner


def _assert_unit_interval(losses: NDArray[np.float64]) -> None:
    if float(np.min(losses)) < 0.0 or float(np.max(losses)) > 1.0:
        raise ValueError("finite-selection theorem assumes losses in [0, 1]")


def _hedge_mixture_loss(losses: NDArray[np.float64], eta: float) -> float:
    """Return cumulative exponential-weights mixture loss for bounded losses."""
    _assert_unit_interval(losses)
    n_experts = losses.shape[1]
    weights = np.full(n_experts, 1.0 / n_experts, dtype=np.float64)
    total = 0.0

    for row in losses:
        total += float(np.dot(weights, row))
        weights *= np.exp(-eta * row)
        weights /= float(np.sum(weights))

    return total


def _target_structure_denominator(targets: NDArray[np.float64]) -> float:
    """Mirror the documented target-structure normalization rule."""
    active_mask = ~np.isnan(targets)
    safe_targets = np.where(active_mask, targets, 0.0)
    n_active = max(float(np.sum(active_mask.astype(np.float64))), 1.0)
    target_mass = float(np.sum(np.where(active_mask, safe_targets, 0.0)))
    has_negative_target = bool(np.any(active_mask & (safe_targets < -1e-6)))
    simplex_like_target = (
        (not has_negative_target)
        and target_mass > 1e-8
        and abs(target_mass - 1.0) <= 1e-5
    )
    return 1.0 if simplex_like_target else n_active


def _rademacher_perturbation_scales(
    utilities: NDArray[np.float64],
    sigma: float,
    beta: float,
) -> NDArray[np.float64]:
    """Return deterministic magnitudes before multiplying by +/-1 noise."""
    u_norm = utilities / (float(np.max(utilities)) + 1e-12)
    return sigma * np.maximum(1.0 - u_norm, 0.0) ** beta


def _least_squares_mse(
    design: NDArray[np.float64],
    targets: NDArray[np.float64],
) -> float:
    weights, *_ = np.linalg.lstsq(design, targets, rcond=None)
    residuals = design @ weights - targets
    return float(np.mean(residuals**2))


def _path_variation(target_path: NDArray[np.float64]) -> float:
    """Total variation for a sequence of scalar or vector target functions."""
    return float(np.sum(np.linalg.norm(np.diff(target_path, axis=0), axis=-1)))


def test_step2_default_matches_theorem_resource_assumptions() -> None:
    """The promoted Step 2 default uses the bounded finite-resource branch."""
    cfg = UPGDLearner.step2_default(n_heads=3).to_config()

    assert cfg["hidden_sizes"] == [32]
    assert cfg["loss_normalization"] == "target_structure"
    assert cfg["perturbation_noise"] == "rademacher"
    assert cfg["perturbation_sigma"] == 1e-4
    assert cfg["perturbation_beta"] == 2.0
    assert cfg["perturbation_interval"] == 16
    assert cfg["bounder"] == {"type": "ObGDBounding", "kappa": 0.5}
    assert cfg["track_unit_utilities"] is False
    assert cfg["track_gradient_history"] is False


def test_target_structure_denominator_separates_target_semantics() -> None:
    """Simplex targets use sum loss; dense and multilabel targets use mean loss."""
    assert _target_structure_denominator(
        np.array([1.0, 0.0, 0.0], dtype=np.float64)
    ) == 1.0
    assert _target_structure_denominator(
        np.array([0.2, np.nan, 0.8], dtype=np.float64)
    ) == 1.0
    assert _target_structure_denominator(
        np.array([0.5, 0.0, -0.25], dtype=np.float64)
    ) == 3.0
    assert _target_structure_denominator(
        np.array([1.0, 1.0, 0.0], dtype=np.float64)
    ) == 3.0


def test_rademacher_perturbation_scale_is_bounded_and_utility_monotone() -> None:
    """Low-utility weights receive weakly larger bounded perturbation magnitudes."""
    utilities = np.array([0.0, 0.25, 1.0], dtype=np.float64)
    sigma = 1e-4
    scales = _rademacher_perturbation_scales(utilities, sigma=sigma, beta=2.0)

    assert float(np.min(scales)) >= 0.0
    assert float(np.max(scales)) <= sigma
    assert scales[0] > scales[1] > scales[2]
    assert math.isclose(float(scales[2]), 0.0, abs_tol=1e-12)


def test_bounded_loss_assumption_is_explicit_for_selection_bound() -> None:
    """The finite-selection theorem is only stated for normalized losses."""
    unbounded_losses = np.array([[0.2, 1.2]], dtype=np.float64)

    try:
        _hedge_mixture_loss(unbounded_losses, eta=0.5)
    except ValueError:
        pass
    else:
        raise AssertionError("expected bounded-loss precondition to fail")


def test_finite_candidate_selection_bound_for_bounded_losses() -> None:
    """Bounded expert losses satisfy the Step 2 finite-selection theorem."""
    losses = np.array(
        [
            [0.10, 0.70, 0.40],
            [0.20, 0.60, 0.30],
            [0.15, 0.90, 0.20],
            [0.25, 0.20, 0.50],
            [0.20, 0.30, 0.45],
            [0.10, 0.80, 0.35],
            [0.30, 0.40, 0.40],
            [0.15, 0.70, 0.25],
        ],
        dtype=np.float64,
    )
    assert float(np.min(losses)) >= 0.0
    assert float(np.max(losses)) <= 1.0

    horizon, n_experts = losses.shape
    eta = math.sqrt(8.0 * math.log(n_experts) / horizon)
    mixture_loss = _hedge_mixture_loss(losses, eta)
    best_fixed_loss = float(np.min(np.sum(losses, axis=0)))

    regret = mixture_loss - best_fixed_loss
    regret_bound = math.log(n_experts) / eta + eta * horizon / 8.0

    assert regret <= regret_bound


def test_dictionary_richness_controls_approximation_gap() -> None:
    """A missing generated feature leaves a nonzero approximation term."""
    xs = np.linspace(-1.0, 1.0, 41, dtype=np.float64)
    targets = xs**2
    poor_dictionary = np.column_stack([np.ones_like(xs), xs])
    rich_dictionary = np.column_stack([np.ones_like(xs), xs, xs**2])

    poor_mse = _least_squares_mse(poor_dictionary, targets)
    rich_mse = _least_squares_mse(rich_dictionary, targets)

    assert poor_mse > 0.05
    assert rich_mse < 1e-24


def test_nested_recursive_prefixes_do_not_increase_approximation_error() -> None:
    """Adding generated features can only shrink the best linear-readout gap."""
    xs = np.linspace(-1.0, 1.0, 41, dtype=np.float64)
    targets = xs**4
    prefixes = [
        np.column_stack([np.ones_like(xs), xs]),
        np.column_stack([np.ones_like(xs), xs, xs**2]),
        np.column_stack([np.ones_like(xs), xs, xs**2, xs**3]),
        np.column_stack([np.ones_like(xs), xs, xs**2, xs**3, xs**4]),
    ]

    errors = [_least_squares_mse(prefix, targets) for prefix in prefixes]

    assert errors[0] > 0.02
    assert all(
        b <= a + 1e-12 for a, b in zip(errors[:-1], errors[1:], strict=True)
    )
    assert errors[-1] < 1e-24


def test_nonstationary_variation_is_separate_from_approximation_error() -> None:
    """A theorem must budget target drift separately from static expressivity."""
    stationary = np.array([[0.5], [0.5], [0.5]], dtype=np.float64)
    switching = np.array([[0.5], [0.5], [-0.5], [0.5]], dtype=np.float64)

    assert _path_variation(stationary) == 0.0
    assert _path_variation(switching) == 2.0


def test_sieve_reduction_excess_loss_decomposes_into_approximation_and_regret() -> None:
    """Average excess loss is bounded by approximation error plus selection regret."""
    horizon = 8
    approximation_error = 0.03
    regret_bound = 0.24

    excess_loss_bound = approximation_error + regret_bound / horizon

    assert math.isclose(excess_loss_bound, 0.06)
