"""Tests for the Step 2 conclusive learner runner."""

from __future__ import annotations

from pathlib import Path
from types import ModuleType

import jax.numpy as jnp
import jax.random as jr
from conftest import load_script

_SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "examples"
    / "The Alberta Plan"
    / "Step2"
    / "step2_conclusive_learner.py"
)


def load_module() -> ModuleType:
    return load_script(_SCRIPT_PATH, "step2_conclusive_learner")


def test_expand_benchmark_names_includes_controlled_and_universal() -> None:
    module = load_module()
    names = module.expand_benchmark_names("controlled_triple,digits_iid")
    assert names == ["controlled_triple", "digits_iid"]
    assert "controlled_polynomial" in module.expand_benchmark_names("controlled")
    assert "synthetic_frequency" in module.expand_benchmark_names("universal")


def test_route_selector_respects_guard_and_hysteresis() -> None:
    module = load_module()
    scores = jnp.full((len(module.ROUTE_NAMES),), 1.0, dtype=jnp.float32)
    all_route = module.ROUTE_NAMES.index("all_selector")
    mlp_route = module.ROUTE_NAMES.index("expert_mlp_32x32")
    scores = scores.at[all_route].set(0.1)
    scores = scores.at[mlp_route].set(0.5)

    warm = module.route_selector(
        scores,
        jnp.asarray(0, dtype=jnp.int32),
        warmup_steps=10,
        guard_margin=0.0,
        current_route=jnp.asarray(mlp_route, dtype=jnp.int32),
        switch_margin=0.0,
    )
    assert int(warm) == mlp_route

    selected = module.route_selector(
        scores,
        jnp.asarray(11, dtype=jnp.int32),
        warmup_steps=10,
        guard_margin=0.0,
        current_route=jnp.asarray(mlp_route, dtype=jnp.int32),
        switch_margin=0.0,
    )
    assert int(selected) == all_route

    sticky = module.route_selector(
        scores,
        jnp.asarray(11, dtype=jnp.int32),
        warmup_steps=10,
        guard_margin=0.0,
        current_route=jnp.asarray(mlp_route, dtype=jnp.int32),
        switch_margin=1.0,
    )
    assert int(sticky) == mlp_route


def test_route_loss_window_scores_penalize_recent_variance() -> None:
    module = load_module()
    sums = jnp.asarray([1.2, 1.6], dtype=jnp.float32)
    square_sums = jnp.asarray([0.56, 0.64], dtype=jnp.float32)
    fallback = jnp.asarray([9.0, 8.0], dtype=jnp.float32)

    mean_scores = module.route_loss_window_scores(
        sums,
        square_sums,
        jnp.asarray(4, dtype=jnp.int32),
        fallback,
        stderr_penalty=0.0,
    )
    robust_scores = module.route_loss_window_scores(
        sums,
        square_sums,
        jnp.asarray(4, dtype=jnp.int32),
        fallback,
        stderr_penalty=1.0,
    )
    cold_scores = module.route_loss_window_scores(
        sums,
        square_sums,
        jnp.asarray(0, dtype=jnp.int32),
        fallback,
        stderr_penalty=1.0,
    )

    assert jnp.allclose(mean_scores, jnp.asarray([0.3, 0.4], dtype=jnp.float32))
    assert float(robust_scores[0]) > float(robust_scores[1])
    assert jnp.allclose(cold_scores, fallback)


def test_route_selector_can_use_variance_penalized_scores() -> None:
    module = load_module()
    route_a = module.ROUTE_NAMES.index("expert_mlp_32x32")
    route_b = module.ROUTE_NAMES.index("expert_mlp_64x64_s01_no_ln")
    sums = jnp.full((len(module.ROUTE_NAMES),), 40.0, dtype=jnp.float32)
    square_sums = jnp.full((len(module.ROUTE_NAMES),), 400.0, dtype=jnp.float32)
    sums = sums.at[route_a].set(1.2)
    square_sums = square_sums.at[route_a].set(1.44)
    sums = sums.at[route_b].set(1.6)
    square_sums = square_sums.at[route_b].set(0.64)
    fallback = jnp.zeros(len(module.ROUTE_NAMES), dtype=jnp.float32)

    mean_scores = module.route_loss_window_scores(
        sums,
        square_sums,
        jnp.asarray(4, dtype=jnp.int32),
        fallback,
        stderr_penalty=0.0,
    )
    robust_scores = module.route_loss_window_scores(
        sums,
        square_sums,
        jnp.asarray(4, dtype=jnp.int32),
        fallback,
        stderr_penalty=1.0,
    )

    mean_selected = module.route_selector(
        mean_scores,
        jnp.asarray(10, dtype=jnp.int32),
        warmup_steps=0,
        guard_margin=0.0,
        current_route=jnp.asarray(route_b, dtype=jnp.int32),
        switch_margin=0.0,
    )
    robust_selected = module.route_selector(
        robust_scores,
        jnp.asarray(10, dtype=jnp.int32),
        warmup_steps=0,
        guard_margin=0.0,
        current_route=jnp.asarray(route_a, dtype=jnp.int32),
        switch_margin=0.0,
    )

    assert int(mean_selected) == route_a
    assert int(robust_selected) == route_b


def test_route_loss_history_window_scores_support_multiple_windows() -> None:
    module = load_module()
    buffer = jnp.asarray(
        [
            [0.1, 1.0],
            [0.2, 0.8],
            [2.0, 0.1],
        ],
        dtype=jnp.float32,
    )
    scores = module.route_loss_history_window_scores(
        buffer,
        route_buffer_idx=jnp.asarray(0, dtype=jnp.int32),
        route_buffer_count=jnp.asarray(3, dtype=jnp.int32),
        window_sizes=jnp.asarray([1, 3], dtype=jnp.int32),
        fallback_scores=jnp.asarray([9.0, 9.0], dtype=jnp.float32),
        stderr_penalty=0.0,
    )

    assert jnp.allclose(scores[0], jnp.asarray([2.0, 0.1], dtype=jnp.float32))
    assert jnp.allclose(scores[1], jnp.asarray([2.3 / 3.0, 1.9 / 3.0]))


def test_parse_route_selector_windows_defaults_and_dedupes() -> None:
    module = load_module()
    default_args = module.argparse.Namespace(
        selector_window=0,
        final_window=300,
        route_selector_windows="",
        route_policy_mode="score",
    )
    multi_args = module.argparse.Namespace(
        selector_window=100,
        final_window=300,
        route_selector_windows="60,100,60,150",
        route_policy_mode="score",
    )
    telemetry_args = module.argparse.Namespace(
        selector_window=100,
        final_window=300,
        route_selector_windows="",
        route_policy_mode="telemetry_worker_b",
    )

    assert module.parse_route_selector_windows(default_args) == (300,)
    assert module.parse_route_selector_windows(multi_args) == (60, 100, 150)
    assert module.parse_route_selector_windows(telemetry_args) == (100, 150)


def test_telemetry_worker_b_gate_detects_safe_churn_signature() -> None:
    module = load_module()
    safe_poly = module.ROUTE_NAMES.index("safe_polynomial_mlp_32x32")
    safe_rec = module.ROUTE_NAMES.index("safe_recursive_mlp_32x32")
    route_ids = jnp.asarray([safe_poly] * 8 + [safe_rec] * 2, dtype=jnp.int32)
    selector_ids = jnp.asarray(
        [module.EXPERT_NAMES.index("polynomial_features")] * 10,
        dtype=jnp.int32,
    )

    assert bool(
        module.telemetry_worker_b_gate(
            route_ids,
            selector_ids,
            telemetry_count=jnp.asarray(10, dtype=jnp.int32),
        )
    )


def test_telemetry_worker_b_gate_ignores_cold_or_mlp_expert_heavy_buffers() -> None:
    module = load_module()
    expert_mlp = module.ROUTE_NAMES.index("expert_mlp_32x32")
    route_ids = jnp.asarray([expert_mlp] * 10, dtype=jnp.int32)
    selector_ids = jnp.asarray(
        [module.EXPERT_NAMES.index("polynomial_features")] * 10,
        dtype=jnp.int32,
    )

    assert not bool(
        module.telemetry_worker_b_gate(
            route_ids,
            selector_ids,
            telemetry_count=jnp.asarray(0, dtype=jnp.int32),
        )
    )
    assert not bool(
        module.telemetry_worker_b_gate(
            route_ids,
            selector_ids,
            telemetry_count=jnp.asarray(10, dtype=jnp.int32),
        )
    )


def test_route_scoring_mse_matches_masked_mse_by_default() -> None:
    module = load_module()
    prediction = jnp.asarray([0.0, 0.5, 10.0], dtype=jnp.float32)
    target = jnp.asarray([1.0, 1.5, jnp.nan], dtype=jnp.float32)

    assert jnp.allclose(
        module.route_scoring_mse(
            prediction,
            target,
            rare_active_step_weight=0.0,
        ),
        module.masked_mse(prediction, target),
    )


def test_route_scoring_mse_emphasizes_multi_head_steps() -> None:
    module = load_module()
    prediction = jnp.asarray([0.0, 0.0, 10.0], dtype=jnp.float32)
    rare_target = jnp.asarray([1.0, 2.0, jnp.nan], dtype=jnp.float32)
    single_target = jnp.asarray([1.0, jnp.nan, jnp.nan], dtype=jnp.float32)

    rare_raw = module.masked_mse(prediction, rare_target)
    rare_weighted = module.route_scoring_mse(
        prediction,
        rare_target,
        rare_active_step_weight=3.0,
    )
    single_raw = module.masked_mse(prediction, single_target)
    single_weighted = module.route_scoring_mse(
        prediction,
        single_target,
        rare_active_step_weight=3.0,
    )

    assert jnp.allclose(rare_weighted, rare_raw * 4.0)
    assert jnp.allclose(single_weighted, single_raw)


def test_contextual_route_enabled_mask_keeps_matching_safe_source_only() -> None:
    module = load_module()
    route_enabled = jnp.ones(len(module.ROUTE_NAMES), dtype=bool)
    polynomial_idx = module.EXPERT_NAMES.index("polynomial_features")

    gated = module.contextual_route_enabled_mask(
        route_enabled,
        jnp.asarray(polynomial_idx, dtype=jnp.int32),
        "source_selector",
    )

    assert bool(gated[module.ROUTE_NAMES.index("safe_polynomial_mlp_32x32")])
    assert not bool(gated[module.ROUTE_NAMES.index("safe_recursive_mlp_32x32")])
    assert bool(gated[module.ROUTE_NAMES.index("all_convex")])
    assert bool(gated[module.ROUTE_NAMES.index("expert_mlp_32x32")])


def test_contextual_route_enabled_mask_off_preserves_routes() -> None:
    module = load_module()
    route_enabled = jnp.ones(len(module.ROUTE_NAMES), dtype=bool)
    gated = module.contextual_route_enabled_mask(
        route_enabled,
        jnp.asarray(module.EXPERT_NAMES.index("mlp_32x32"), dtype=jnp.int32),
        "off",
    )

    assert jnp.all(gated == route_enabled)


def test_ablation_masks_expand_disabled_experts_and_routes() -> None:
    module = load_module()
    args = module.argparse.Namespace(
        disable_experts="recursive_features,upgd_low_noise",
        disable_routes="safe_recursive,all_convex",
    )
    expert_mask = module.expert_enabled_mask(args)
    route_mask = module.route_enabled_mask(args)

    assert not bool(expert_mask[module.EXPERT_NAMES.index("recursive_features")])
    assert not bool(expert_mask[module.EXPERT_NAMES.index("upgd_low_noise")])
    assert not bool(route_mask[module.ROUTE_NAMES.index("all_convex")])
    for route in module.SAFE_ROUTE_NAMES:
        assert not bool(route_mask[module.ROUTE_NAMES.index(route)])
    assert bool(route_mask[module.ROUTE_NAMES.index("expert_mlp_32x32")])


def test_safe_route_sources_enable_only_requested_specialists() -> None:
    module = load_module()
    args = module.argparse.Namespace(
        disable_experts="",
        disable_routes="",
        safe_route_sources="recursive_features,polynomial_features",
    )
    route_mask = module.route_enabled_mask(args)

    assert bool(route_mask[module.ROUTE_NAMES.index("safe_recursive_mlp_32x32")])
    assert bool(route_mask[module.ROUTE_NAMES.index("safe_polynomial_mlp_32x32")])
    assert not bool(route_mask[module.ROUTE_NAMES.index("safe_fourier_mlp_32x32")])


def test_masked_log_weight_softmax_excludes_disabled_entries() -> None:
    module = load_module()
    weights = module.masked_log_weight_softmax(
        jnp.asarray([0.0, 10.0, 0.0], dtype=jnp.float32),
        jnp.asarray([True, False, True]),
    )

    assert float(weights[1]) == 0.0
    assert float(weights[0]) > 0.0
    assert float(weights[2]) > 0.0


def test_route_softmax_weights_favor_low_enabled_scores() -> None:
    module = load_module()
    weights = module.route_softmax_weights_from_scores(
        jnp.asarray([0.2, 0.1, 0.0], dtype=jnp.float32),
        jnp.asarray([True, True, False]),
        eta=10.0,
    )

    assert float(weights[1]) > float(weights[0])
    assert float(weights[2]) == 0.0
    assert jnp.allclose(jnp.sum(weights), 1.0)


def test_blend_predictions_moves_toward_floor() -> None:
    module = load_module()
    base = jnp.asarray([2.0, -2.0], dtype=jnp.float32)
    floor = jnp.asarray([0.0, 0.0], dtype=jnp.float32)

    blended = module.blend_predictions(base, floor, floor_weight=0.25)

    assert jnp.allclose(blended, jnp.asarray([1.5, -1.5], dtype=jnp.float32))


def test_named_mlp_floor_source_is_cli_choice() -> None:
    module = load_module()
    old_argv = module.sys.argv
    module.sys.argv = [
        "step2_conclusive_learner.py",
        "--mlp-floor-source",
        "mlp_64x64_s01_no_ln",
    ]
    try:
        args = module.parse_args()
    finally:
        module.sys.argv = old_argv

    assert args.mlp_floor_source == "mlp_64x64_s01_no_ln"


def test_softmax_rare_active_is_cli_choice() -> None:
    module = load_module()
    old_argv = module.sys.argv
    module.sys.argv = [
        "step2_conclusive_learner.py",
        "--route-deployment-mode",
        "softmax_rare_active",
    ]
    try:
        args = module.parse_args()
    finally:
        module.sys.argv = old_argv

    assert args.route_deployment_mode == "softmax_rare_active"


def test_effective_mlp_floor_weight_increases_on_multi_head_steps() -> None:
    module = load_module()
    single_target = jnp.asarray([1.0, jnp.nan], dtype=jnp.float32)
    multi_target = jnp.asarray([1.0, 2.0], dtype=jnp.float32)
    missing_seen = jnp.asarray(True)

    assert jnp.allclose(
        module.effective_mlp_floor_weight(
            single_target,
            missing_seen,
            base_weight=0.25,
            rare_active_extra_weight=0.5,
        ),
        0.25,
    )
    assert jnp.allclose(
        module.effective_mlp_floor_weight(
            multi_target,
            missing_seen,
            base_weight=0.25,
            rare_active_extra_weight=0.5,
        ),
        0.75,
    )


def test_effective_mlp_floor_weight_can_be_rare_only() -> None:
    module = load_module()
    single_target = jnp.asarray([1.0, jnp.nan], dtype=jnp.float32)
    multi_target = jnp.asarray([1.0, 2.0], dtype=jnp.float32)
    missing_seen = jnp.asarray(True)

    assert jnp.allclose(
        module.effective_mlp_floor_weight(
            single_target,
            missing_seen,
            base_weight=0.0,
            rare_active_extra_weight=1.0,
        ),
        0.0,
    )
    assert jnp.allclose(
        module.effective_mlp_floor_weight(
            multi_target,
            missing_seen,
            base_weight=0.0,
            rare_active_extra_weight=1.0,
        ),
        1.0,
    )


def test_rare_active_step_requires_previous_missing_target() -> None:
    module = load_module()
    multi_target = jnp.asarray([1.0, 2.0], dtype=jnp.float32)

    assert not bool(module.rare_active_step_mask(multi_target, jnp.asarray(False)))
    assert bool(module.rare_active_step_mask(multi_target, jnp.asarray(True)))


def test_stacker_update_can_improve_over_anchor_prediction() -> None:
    module = load_module()
    preds = jnp.asarray(
        [
            [0.0],
            [1.0],
            [0.5],
            [0.5],
            [0.5],
            [0.5],
            [0.5],
            [0.5],
            [0.5],
            [0.5],
            [0.5],
            [0.5],
        ],
        dtype=jnp.float32,
    )
    target = jnp.asarray([1.0], dtype=jnp.float32)
    weights = jnp.zeros((1, len(module.EXPERT_NAMES) + 1), dtype=jnp.float32)
    weights = weights.at[:, 1].set(1.0)
    before = float((module.stacker_predict(weights, preds)[0] - target[0]) ** 2)
    weights = module.stacker_update(weights, preds, target, step_size=0.5)
    after = float((module.stacker_predict(weights, preds)[0] - target[0]) ** 2)

    assert after < before


def test_polynomial_feature_learner_fits_representable_signal() -> None:
    module = load_module()
    learner = module.PolynomialFeatureLearner(
        n_heads=1,
        max_input_dim=3,
        step_size=0.5,
        feature_clip=3.0,
    )
    state = learner.init(feature_dim=3, key=jr.key(0))
    obs = jnp.asarray([0.5, -0.25, 0.75], dtype=jnp.float32)
    target = jnp.asarray([obs[0] * obs[1] + obs[2] ** 2], dtype=jnp.float32)
    before = float((learner.predict(state, obs)[0] - target[0]) ** 2)
    for _ in range(20):
        state = learner.update(state, obs, target).state
    after = float((learner.predict(state, obs)[0] - target[0]) ** 2)
    assert after < before


def test_paired_mse_diff_positive_favors_conclusive() -> None:
    module = load_module()
    records = [
        {
            "methods": {
                "conclusive": {"final_window_mse": 0.1},
                "mlp_a": {"final_window_mse": 0.2},
                "mlp_b": {"final_window_mse": 0.15},
            }
        },
        {
            "methods": {
                "conclusive": {"final_window_mse": 0.3},
                "mlp_a": {"final_window_mse": 0.25},
                "mlp_b": {"final_window_mse": 0.4},
            }
        },
    ]
    comparison = module.paired_conclusive_vs_group(
        records,
        "final_window_mse",
        ("mlp_a", "mlp_b"),
        "best_mlp",
    )
    assert comparison["wins_for_conclusive"] == 1
    assert comparison["wins_for_baseline"] == 1
