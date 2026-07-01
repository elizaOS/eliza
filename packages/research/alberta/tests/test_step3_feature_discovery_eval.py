"""Tests for the Step 3 GVF feature-discovery evaluation helpers."""

from __future__ import annotations

import json
from pathlib import Path
from types import ModuleType

import numpy as np
from conftest import load_script

_SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "examples"
    / "The Alberta Plan"
    / "Step3"
    / "step3_feature_discovery_eval.py"
)


def _load_module() -> ModuleType:
    return load_script(_SCRIPT_PATH, "step3_feature_discovery_eval")


def test_repeat_by_horizon_orders_targets_by_target_then_gamma() -> None:
    module = _load_module()
    cumulants = np.array([[1.0, 2.0], [3.0, 4.0]], dtype=np.float32)

    repeated = module.repeat_by_horizon(cumulants, (0.0, 0.5, 0.9))

    np.testing.assert_allclose(
        repeated,
        np.array(
            [
                [1.0, 1.0, 1.0, 2.0, 2.0, 2.0],
                [3.0, 3.0, 3.0, 4.0, 4.0, 4.0],
            ],
            dtype=np.float32,
        ),
    )


def test_transition_view_uses_next_step_targets_as_cumulants() -> None:
    module = _load_module()
    observations = np.arange(10, dtype=np.float32).reshape(5, 2)
    targets = np.arange(15, dtype=np.float32).reshape(5, 3)

    disc_obs, disc_next, disc_cums, eval_obs, eval_next, eval_cums = (
        module.transition_view(observations, targets, discovery_steps=2)
    )

    np.testing.assert_allclose(disc_obs, observations[:2])
    np.testing.assert_allclose(disc_next, observations[1:3])
    np.testing.assert_allclose(disc_cums, targets[1:3])
    np.testing.assert_allclose(eval_obs, observations[2:-1])
    np.testing.assert_allclose(eval_next, observations[3:])
    np.testing.assert_allclose(eval_cums, targets[3:])


def test_augment_with_all_interactions_uses_stable_pair_order() -> None:
    module = _load_module()
    observations = np.array([[2.0, 3.0, 5.0]], dtype=np.float32)

    no_squares = module.augment_with_all_interactions(
        observations,
        include_squares=False,
    )
    with_squares = module.augment_with_all_interactions(
        observations,
        include_squares=True,
    )

    np.testing.assert_allclose(
        no_squares,
        np.array([[2.0, 3.0, 5.0, 6.0, 10.0, 15.0]], dtype=np.float32),
    )
    np.testing.assert_allclose(
        with_squares,
        np.array(
            [[2.0, 3.0, 5.0, 4.0, 6.0, 10.0, 9.0, 15.0, 25.0]],
            dtype=np.float32,
        ),
    )


def test_selected_interactions_reuse_canonical_pair_order() -> None:
    module = _load_module()
    observations = np.array([[2.0, 3.0, 5.0]], dtype=np.float32)

    augmented = module.augment_with_selected_interactions(
        observations,
        selected_indices=np.array([1], dtype=np.int32),
        include_squares=False,
    )

    np.testing.assert_allclose(
        augmented,
        np.array([[2.0, 3.0, 5.0, 10.0]], dtype=np.float32),
    )


def test_td_surprise_interaction_scoring_reports_clipped_is_weights() -> None:
    module = _load_module()
    observations = np.array(
        [[1.0, 0.0], [1.0, 1.0], [1.0, 2.0], [1.0, 3.0]],
        dtype=np.float32,
    )
    next_observations = observations + np.array([[0.0, 0.25]], dtype=np.float32)
    cumulants = (observations[:, :1] * observations[:, 1:2]).astype(np.float32)

    scores = module.score_td_surprise_interaction_candidates(
        observations=observations,
        next_observations=next_observations,
        target_cumulants=cumulants,
        gammas=(0.0,),
        n_targets=1,
        key=module.jr.key(0),
        n_select=3,
        include_squares=False,
        step_size=0.01,
        trace_decay=0.0,
        candidate_trace_rho=0.5,
        score_decay=0.9,
        importance_ratios=np.full(observations.shape[0], 10.0, dtype=np.float32),
        importance_clip=2.0,
    )

    np.testing.assert_array_equal(scores["indices"], np.array([0], dtype=np.int32))
    assert np.all(np.isfinite(scores["scores"]))
    assert scores["selected_score_mean"] > 0.0
    assert scores["importance_weight_mean"] == 2.0
    assert scores["importance_weight_max"] == 2.0


def test_meta_gradient_interaction_scoring_selects_finite_candidates() -> None:
    module = _load_module()
    observations = np.array(
        [[1.0, 0.0], [1.0, 1.0], [1.0, 2.0], [1.0, 3.0]],
        dtype=np.float32,
    )
    next_observations = observations + np.array([[0.0, 0.25]], dtype=np.float32)
    cumulants = (observations[:, :1] * observations[:, 1:2]).astype(np.float32)

    scores = module.score_meta_gradient_interaction_candidates(
        observations=observations,
        next_observations=next_observations,
        target_cumulants=cumulants,
        gammas=(0.0, 0.5),
        n_targets=1,
        key=module.jr.key(0),
        n_select=2,
        include_squares=True,
        step_size=0.01,
        trace_decay=0.0,
        score_decay=0.9,
    )

    assert scores["indices"].shape == (2,)
    assert scores["scales"].shape == (2,)
    assert np.all(np.isfinite(scores["scores"]))
    assert scores["selected_score_mean"] >= 0.0


def test_history_trace_features_are_causal_and_shape_stable() -> None:
    module = _load_module()
    observations = np.arange(10, dtype=np.float32).reshape(5, 2)

    features = module.augment_with_history_trace_features(
        observations,
        lags=(1, 3),
        trace_rhos=(0.5,),
    )
    changed_future = observations.copy()
    changed_future[4] += 1000.0
    changed_features = module.augment_with_history_trace_features(
        changed_future,
        lags=(1, 3),
        trace_rhos=(0.5,),
    )

    assert features.shape == (5, 8)
    np.testing.assert_allclose(features[:4], changed_features[:4])
    assert not np.allclose(features[4], changed_features[4])
    np.testing.assert_allclose(features[0, 2:4], np.zeros(2, dtype=np.float32))
    np.testing.assert_allclose(features[2, 2:4], observations[1])


def test_predictive_state_candidates_are_causal_with_cross_products() -> None:
    module = _load_module()
    observations = np.arange(12, dtype=np.float32).reshape(6, 2)

    candidates, names = module.predictive_state_candidate_values(
        observations,
        lags=(1,),
        trace_rhos=(0.5,),
        include_cross_products=True,
    )
    changed_future = observations.copy()
    changed_future[-1] += 1000.0
    changed_candidates, _ = module.predictive_state_candidate_values(
        changed_future,
        lags=(1,),
        trace_rhos=(0.5,),
        include_cross_products=True,
    )

    assert candidates.shape == (6, 12)
    assert len(names) == 12
    np.testing.assert_allclose(candidates[:-1], changed_candidates[:-1])
    assert not np.allclose(candidates[-1], changed_candidates[-1])


def test_predictive_state_scoring_selects_future_cumulant_signal() -> None:
    module = _load_module()
    observations = np.array([[1.0], [2.0], [4.0], [8.0], [16.0]], dtype=np.float32)
    cumulants = np.array([[0.0], [1.0], [2.0], [4.0], [8.0]], dtype=np.float32)

    scores = module.score_predictive_state_feature_candidates(
        observations=observations,
        target_cumulants=cumulants,
        n_select=1,
        lags=(1,),
        trace_rhos=(0.5,),
        include_cross_products=False,
        score_decay=0.9,
    )

    np.testing.assert_array_equal(scores["indices"], np.array([0], dtype=np.int32))
    assert scores["names"][0] == "lag1_x0"
    assert scores["selected_score_mean"] > 0.0
    assert scores["scales"].shape == (1,)


def test_novel_candidate_selection_rejects_duplicate_high_score_column() -> None:
    module = _load_module()
    base = np.linspace(-1.0, 1.0, 8, dtype=np.float32)
    candidates = np.column_stack(
        [
            base,
            2.0 * base,
            np.array([1.0, -1.0, 1.0, -1.0, 1.0, -1.0, 1.0, -1.0], dtype=np.float32),
        ]
    )
    scores = np.array([3.0, 2.0, 1.0], dtype=np.float32)

    selected = module.select_novel_candidate_indices(
        candidates,
        scores,
        n_select=2,
        max_abs_corr=0.95,
    )

    np.testing.assert_array_equal(selected, np.array([0, 2], dtype=np.int32))


def test_off_policy_mspbe_scoring_uses_clipped_importance_weights() -> None:
    module = _load_module()
    observations = np.array(
        [[-2.0], [-1.0], [0.5], [1.0], [2.0]],
        dtype=np.float32,
    )
    next_observations = np.roll(observations, shift=-1, axis=0)
    reward_signal = np.asarray([1.0, -1.0, 0.5, -0.5, 1.5], dtype=np.float32)
    candidates = np.column_stack([reward_signal, np.ones_like(reward_signal)])
    next_candidates = np.roll(candidates, shift=-1, axis=0)

    scores = module.score_off_policy_mspbe_feature_candidates(
        observations=observations,
        next_observations=next_observations,
        candidate_values=candidates.astype(np.float32),
        next_candidate_values=next_candidates.astype(np.float32),
        reward_signal=reward_signal,
        key=module.jr.key(0),
        gamma=0.5,
        step_size=0.01,
        trace_decay=0.0,
        policy_scale=2.0,
        retrace_clip=1.25,
        n_select=1,
        score_decay=0.9,
    )

    assert scores["indices"].shape == (1,)
    assert np.all(np.isfinite(scores["scores"]))
    assert scores["importance_weight_max"] <= 1.25
    assert scores["rho_max"] >= scores["importance_weight_max"]


def test_markov_collector_makes_next_cumulants_state_predictable() -> None:
    module = _load_module()

    observations, targets = module.collect_markov_interaction_arrays(
        seed=0,
        total_steps=350,
        feature_dim=3,
        n_targets=1,
        n_contexts=1,
        context_length=1000,
        active_pairs=6,
        noise_std=0.0,
        include_squares=True,
        hide_last_channels=0,
        ar_rho=0.95,
    )

    lag_corr = np.mean(observations[:-1] * observations[1:]) / np.mean(
        observations[:-1] ** 2
    )
    assert lag_corr > 0.75

    features = module.augment_with_all_interactions(
        observations[:-1],
        include_squares=True,
    )
    raw_design = np.column_stack(
        [np.ones(observations[:-1].shape[0]), observations[:-1]]
    )
    design = np.column_stack([np.ones(features.shape[0]), features])
    next_targets = targets[1:, 0]
    raw_coef, *_ = np.linalg.lstsq(raw_design, next_targets, rcond=None)
    raw_preds = raw_design @ raw_coef
    raw_mse = np.mean((raw_preds - next_targets) ** 2)
    coef, *_ = np.linalg.lstsq(design, next_targets, rcond=None)
    preds = design @ coef
    mse = np.mean((preds - next_targets) ** 2)
    baseline_mse = np.mean((next_targets - np.mean(next_targets)) ** 2)

    assert mse < 0.8 * raw_mse
    assert 1.0 - mse / baseline_mse > 0.2


def test_coupled_hidden_ar1_collector_masks_hidden_channels() -> None:
    module = _load_module()

    observations, targets = module.collect_coupled_hidden_ar1_arrays(
        seed=0,
        total_steps=64,
        feature_dim=5,
        n_targets=2,
        n_contexts=1,
        context_length=100,
        active_pairs=4,
        noise_std=0.0,
        include_squares=True,
        hide_last_channels=2,
        ar_rho=0.9,
        hidden_coupling=0.3,
        hidden_noise_std=0.01,
    )

    assert observations.shape == (64, 5)
    assert targets.shape == (64, 2)
    np.testing.assert_allclose(observations[:, -2:], 0.0)
    assert np.std(targets[:, 0]) > 0.01


def test_projected_cumulants_are_next_observation_signals() -> None:
    module = _load_module()
    projections = np.array([[1.0, 0.0], [0.0, -2.0]], dtype=np.float32)
    next_observations = np.array([[3.0, 5.0], [7.0, 11.0]], dtype=np.float32)

    cumulants = module.projected_cumulants(projections, next_observations)

    np.testing.assert_allclose(
        cumulants,
        np.array([[3.0, -10.0], [7.0, -22.0]], dtype=np.float32),
    )


def test_meta_proxy_projection_shape_and_norms() -> None:
    module = _load_module()
    obs = np.array(
        [[0.0, 1.0], [1.0, 1.0], [2.0, -1.0], [3.0, -1.0]],
        dtype=np.float32,
    )
    next_obs = obs + np.array([[0.5, -0.25]], dtype=np.float32)
    cumulants = np.array(
        [[0.0, 1.0], [2.0, 0.0], [5.0, -1.0], [9.0, -2.0]],
        dtype=np.float32,
    )

    projections = module.meta_proxy_projections(
        obs,
        next_obs,
        cumulants,
        n_aux=3,
    )

    assert projections.shape == (3, 2)
    assert np.all(np.isfinite(projections))
    np.testing.assert_allclose(
        np.linalg.norm(projections, axis=1),
        np.ones(3),
        atol=1e-5,
    )


def test_gvf_feedback_predictions_are_causal_shape_invariant() -> None:
    module = _load_module()
    observations = np.array(
        [[0.0, 0.0], [0.2, -0.1], [0.4, -0.2], [0.6, -0.3]],
        dtype=np.float32,
    )
    next_observations = observations + np.array([[0.1, -0.05]], dtype=np.float32)
    target_cumulants = next_observations[:, :1]

    predictions = module.run_gvf_feedback_predictions(
        observations=observations,
        next_observations=next_observations,
        target_cumulants=target_cumulants,
        gammas=(0.0, 0.5),
        n_targets=1,
        key=module.jr.key(0),
        source_step_size=0.01,
        downstream_step_size=0.01,
        trace_decay=0.0,
    )

    assert predictions.shape == (observations.shape[0], 2)
    assert np.all(np.isfinite(predictions))


def test_off_policy_probe_reports_behavior_mismatch_metrics() -> None:
    module = _load_module()
    observations = np.array(
        [[-1.0, 0.0], [-0.5, 0.2], [0.0, 0.4], [0.5, 0.6], [1.0, 0.8]],
        dtype=np.float32,
    )
    next_observations = np.roll(observations, shift=-1, axis=0)
    reward_signal = np.linspace(-1.0, 1.0, observations.shape[0], dtype=np.float32)

    predictions, returns, ratio_stats = module.run_off_policy_td_probe(
        observations=observations,
        next_observations=next_observations,
        reward_signal=reward_signal,
        key=module.jr.key(0),
        gamma=0.5,
        step_size=0.01,
        trace_decay=0.0,
        policy_scale=1.5,
        retrace_clip=2.0,
        use_importance_sampling=True,
    )

    assert predictions.shape == (observations.shape[0],)
    assert returns.shape == (observations.shape[0],)
    assert ratio_stats["rho_max"] >= ratio_stats["rho_mean"] > 0.0
    assert np.all(np.isfinite(predictions))


def test_off_policy_probe_can_reuse_shared_behavior_rollout() -> None:
    module = _load_module()
    observations = np.array(
        [[-1.0, 0.0], [-0.5, 0.2], [0.0, 0.4], [0.5, 0.6], [1.0, 0.8]],
        dtype=np.float32,
    )
    next_observations = np.roll(observations, shift=-1, axis=0)
    reward_signal = np.linspace(-1.0, 1.0, observations.shape[0], dtype=np.float32)

    rewards, ratios, returns, ratio_stats = module.sample_off_policy_behavior_rollout(
        observations=observations,
        reward_signal=reward_signal,
        key=module.jr.key(0),
        gamma=0.5,
        policy_scale=1.5,
    )
    preds_a, returns_a, stats_a = module.run_off_policy_td_probe(
        observations=observations,
        next_observations=next_observations,
        reward_signal=reward_signal,
        key=module.jr.key(1),
        gamma=0.5,
        step_size=0.01,
        trace_decay=0.0,
        policy_scale=1.5,
        retrace_clip=2.0,
        use_importance_sampling=True,
        sampled_rewards=rewards,
        sampled_ratios=ratios,
        target_returns=returns,
        ratio_stats=ratio_stats,
    )
    preds_b, returns_b, stats_b = module.run_off_policy_td_probe(
        observations=observations,
        next_observations=next_observations,
        reward_signal=reward_signal,
        key=module.jr.key(2),
        gamma=0.5,
        step_size=0.01,
        trace_decay=0.0,
        policy_scale=1.5,
        retrace_clip=2.0,
        use_importance_sampling=True,
        sampled_rewards=rewards,
        sampled_ratios=ratios,
        target_returns=returns,
        ratio_stats=ratio_stats,
    )

    np.testing.assert_allclose(preds_a, preds_b)
    np.testing.assert_allclose(returns_a, returns_b)
    assert stats_a == stats_b


def test_aggregate_rows_reports_discovery_gap_vs_mlp() -> None:
    module = _load_module()
    rows = [
        {"seed": 0, "method": "given_linear_gvf", "target_rmse_mean": 1.0},
        {"seed": 0, "method": "given_mlp_gvf", "target_rmse_mean": 0.8},
        {
            "seed": 0,
            "method": "discovered_aux_cumulants_mlp_gvf",
            "target_rmse_mean": 0.9,
        },
        {
            "seed": 0,
            "method": "step2_tanh_features_linear_gvf",
            "target_rmse_mean": 1.1,
        },
        {
            "seed": 0,
            "method": "meta_gradient_proxy_interaction_features_linear_gvf",
            "target_rmse_mean": 0.7,
        },
        {"seed": 1, "method": "given_linear_gvf", "target_rmse_mean": 1.2},
        {"seed": 1, "method": "given_mlp_gvf", "target_rmse_mean": 0.9},
        {
            "seed": 1,
            "method": "discovered_aux_cumulants_mlp_gvf",
            "target_rmse_mean": 1.0,
        },
        {
            "seed": 1,
            "method": "step2_tanh_features_linear_gvf",
            "target_rmse_mean": 1.3,
        },
        {
            "seed": 1,
            "method": "meta_gradient_proxy_interaction_features_linear_gvf",
            "target_rmse_mean": 0.8,
        },
    ]

    summary = module.aggregate_rows(rows)

    assert (
        summary["best_discovery_method"]
        == "meta_gradient_proxy_interaction_features_linear_gvf"
    )
    assert summary["best_discovery_beats_linear"] is True
    assert summary["best_discovery_beats_mlp"] is True
    paired = summary["paired"][
        "given_mlp_gvf_minus_meta_gradient_proxy_interaction_features_linear_gvf"
    ]
    assert paired["wins"] == 2
    assert paired["n_seeds"] == 2


def test_aggregate_rows_keeps_off_policy_probe_separate() -> None:
    module = _load_module()
    rows = [
        {"seed": 0, "method": "given_linear_gvf", "target_rmse_mean": 1.0},
        {"seed": 0, "method": "given_mlp_gvf", "target_rmse_mean": 0.8},
        {
            "seed": 0,
            "method": "discovered_aux_cumulants_mlp_gvf",
            "target_rmse_mean": 0.9,
        },
        {
            "seed": 0,
            "method": "off_policy_raw_linear_td_is",
            "probe": "off_policy_td",
            "target_rmse_mean": 0.1,
            "rho_mean": 1.0,
            "rho_max": 2.0,
        },
        {
            "seed": 0,
            "method": "off_policy_mspbe_predictive_state_linear_td_is",
            "probe": "off_policy_td",
            "target_rmse_mean": 0.05,
            "rho_mean": 1.0,
            "rho_max": 2.0,
        },
    ]

    summary = module.aggregate_rows(rows)

    assert "off_policy_raw_linear_td_is" not in summary["aggregate"]
    assert "off_policy_raw_linear_td_is" in summary["off_policy_aggregate"]
    assert summary["best_method"] == "given_mlp_gvf"
    paired = summary["off_policy_paired"][
        "off_policy_raw_linear_td_is_minus_off_policy_mspbe_predictive_state_linear_td_is"
    ]
    assert paired["wins"] == 1
    assert paired["losses"] == 0
    assert paired["ties"] == 0


def test_write_outputs_records_summary_json_and_markdown(tmp_path: Path) -> None:
    module = _load_module()
    rows = [
        {"seed": 0, "method": "given_linear_gvf", "target_rmse_mean": 1.0},
        {"seed": 0, "method": "given_mlp_gvf", "target_rmse_mean": 0.8},
        {
            "seed": 0,
            "method": "discovered_aux_cumulants_mlp_gvf",
            "target_rmse_mean": 0.9,
        },
    ]
    summary = module.aggregate_rows(rows)

    module.write_outputs(
        tmp_path,
        rows,
        summary,
        config={"quick": True, "seeds": 1},
        total_seconds=0.1,
    )

    payload = json.loads((tmp_path / "summary.json").read_text())
    assert payload["best_discovery_method"] == "discovered_aux_cumulants_mlp_gvf"
    assert "Direction 8 GVF Feature Discovery Evaluation" in (
        tmp_path / "SUMMARY.md"
    ).read_text()
    assert (tmp_path / "results.csv").exists()
