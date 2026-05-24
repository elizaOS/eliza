"""Tests for the Step 2 universal portfolio script helpers."""

from __future__ import annotations

import json
from argparse import Namespace
from pathlib import Path
from types import ModuleType

import numpy as np
import pytest
from conftest import load_script

_SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "examples"
    / "The Alberta Plan"
    / "Step2"
    / "step2_universal_portfolio.py"
)


def load_module() -> ModuleType:
    return load_script(_SCRIPT_PATH, "step2_universal_portfolio")


def test_paired_mixture_vs_group_lower_is_better() -> None:
    """Positive MSE differences favor the mixture."""
    module = load_module()
    records = [
        {
            "methods": {
                "mixture": {"final_window_mse": 0.8},
                "mlp_h64": {"final_window_mse": 1.0},
                "mlp_h128": {"final_window_mse": 0.9},
            }
        },
        {
            "methods": {
                "mixture": {"final_window_mse": 1.2},
                "mlp_h64": {"final_window_mse": 1.0},
                "mlp_h128": {"final_window_mse": 1.4},
            }
        },
    ]

    row = module.paired_mixture_vs_group(
        records,
        "final_window_mse",
        ("mlp_h64", "mlp_h128"),
        "best_mlp",
    )

    assert row["wins_for_mixture"] == 1
    assert row["wins_for_baseline"] == 1
    assert row["diffs"] == pytest.approx([0.1, -0.2])


def test_paired_mixture_vs_group_higher_is_better() -> None:
    """Positive accuracy differences favor the mixture."""
    module = load_module()
    records = [
        {
            "methods": {
                "mixture": {"test_accuracy": 0.9},
                "mlp_h64": {"test_accuracy": 0.8},
                "mlp_h128": {"test_accuracy": 0.85},
            }
        }
    ]

    row = module.paired_mixture_vs_group(
        records,
        "test_accuracy",
        ("mlp_h64", "mlp_h128"),
        "best_mlp",
    )

    assert row["wins_for_mixture"] == 1
    assert row["paired_diff_mean_positive_favors_mixture"] == pytest.approx(0.05)


def test_retention_deployment_can_force_upgd() -> None:
    """Class-imbalance retention routing can force held-out UPGD deployment."""
    module = load_module()
    labels = np.asarray([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 9, 9])
    args = Namespace(
        retention_router="class_imbalance",
        retention_upgd_deployment_weight=1.0,
        retention_min_lifetime_class_fraction=0.8,
        retention_max_recent_class_fraction=0.4,
    )

    weights, signal = module.deployment_weights(
        tracking_weights=np.asarray([0.9, 0.1, 0.0, 0.0, 0.0], dtype=np.float32),
        labels=labels,
        n_heads=10,
        final_window=4,
        args=args,
    )

    assert signal["retention_hazard"] is True
    assert signal["deployment_source"] == "class_imbalance_retention"
    assert weights[module.UPGD_INDEX] == pytest.approx(1.0)


def test_accuracy_deployment_weights_use_accuracy_router_columns() -> None:
    """Held-out digits can deploy from the causal online accuracy router."""
    module = load_module()
    metrics = np.zeros((1, module.PRED_START + len(module.METHOD_NAMES)), dtype=np.float32)
    metrics[0, module.WEIGHT_START : module.WEIGHT_START + len(module.EXPERT_NAMES)] = (
        np.asarray([1.0, 0.0, 0.0, 0.0, 0.0], dtype=np.float32)
    )
    metrics[0, module.ACC_WEIGHT_START : module.ACC_WEIGHT_START + len(module.EXPERT_NAMES)] = (
        np.asarray([0.0, 1.0, 0.0, 0.0, 0.0], dtype=np.float32)
    )
    args = Namespace(digits_deployment_objective="accuracy")

    weights = module.final_deployment_tracking_weights(metrics, args)

    assert weights.tolist() == pytest.approx([0.0, 1.0, 0.0, 0.0, 0.0])


def test_online_retention_guard_route_recovers_current_block_mlp() -> None:
    """The online class-imbalance guard has an explicit deployment weight path."""
    module = load_module()
    metrics = np.zeros((1, module.PRED_START + len(module.METHOD_NAMES)), dtype=np.float32)
    metrics[0, module.ROUTER_START] = float(module.ONLINE_RETENTION_GUARD_ROUTE_ID)
    metrics[0, module.MLP_SELECTOR_START] = 0.0

    weights = module.guarded_tracking_weights(metrics)

    expected = np.zeros(len(module.EXPERT_NAMES), dtype=np.float32)
    expected[module.EXPERT_NAMES.index("mlp_h64_64")] = 1.0
    assert weights.tolist() == pytest.approx(expected.tolist())


def test_all_fronts_summary_stays_partial_for_incomplete_opmnist(
    tmp_path: Path,
) -> None:
    """Artifact-only all-fronts assessment does not overclaim OPMNIST closure."""
    module = load_module()

    artifacts = {
        "strict_supervised": {
            "evidence_level": "prediction_space_mlp_upgd_dynamic_sparse_portfolio",
            "aggregate": {
                "synthetic_polynomial": {
                    "comparisons": {
                        "final_window_mse": {
                            "mixture_vs_best_mlp": {
                                "paired_diff_mean_positive_favors_mixture": 0.1
                            }
                        }
                    }
                },
                "digits_iid": {
                    "comparisons": {
                        "final_window_mse": {
                            "mixture_vs_best_mlp": {
                                "paired_diff_mean_positive_favors_mixture": 0.01
                            }
                        },
                        "test_accuracy": {
                            "mixture_vs_best_mlp": {
                                "paired_diff_mean_positive_favors_mixture": 0.02
                            }
                        },
                    }
                },
            },
        },
        "recursive_controlled": {
            "aggregate": {
                "suite_summary": {
                    "tasks": 6,
                    "recursive_mlp_router_beats_best_mlp_tasks": 6,
                    "recursive_mlp_router_ties_best_mlp_tasks": 0,
                }
            }
        },
        "opmnist_partial": {
            "status": {
                "matches_dohare_opmnist_core_protocol": True,
                "matches_dohare_opmnist_published_task_count": False,
                "all_primary_nonnegative_vs_best_mlp": True,
            },
            "datasets": {
                "permuted_mnist_like": {
                    "completed_full_task_blocks": 20,
                    "n_permutations": 800,
                }
            },
        },
        "scr_million": {
            "published_scale_scr_closed": True,
            "best_variant": "slow_meta",
            "best_variant_status": {"matches_dohare_public_scr_protocol": True},
        },
        "td_gvf_bridge": {
            "best_discovery_method": "step2_interaction_features_linear_gvf",
            "best_discovery_beats_linear": True,
            "best_discovery_beats_mlp": True,
        },
    }
    for name, payload in artifacts.items():
        path = tmp_path / module.ALL_FRONTS_ARTIFACTS[name]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload), encoding="utf-8")

    summary = module.build_all_fronts_portfolio_summary(tmp_path)

    assert summary["decision"] == "partial"
    assert summary["fronts"]["strict_supervised"]["status"] == "closed"
    assert summary["fronts"]["recursive_controlled"]["status"] == "closed"
    assert summary["fronts"]["scr"]["status"] == "closed"
    assert summary["fronts"]["opmnist"]["status"] == "partial"
    assert summary["fronts"]["td_gvf_bridge"]["status"] == "partial"


def test_all_fronts_summary_markdown_records_decision(tmp_path: Path) -> None:
    """Markdown writer records the portfolio-level decision and route audit."""
    module = load_module()
    summary = {
        "decision": "partial",
        "fronts": {
            "strict_supervised": {
                "status": "closed",
                "claim": "strict supervised matrix",
                "summary": "closed",
            },
            "opmnist": {
                "status": "partial",
                "claim": "published-scale Online Permuted MNIST",
                "summary": "20/800 blocks",
            },
        },
        "artifact_paths": {"strict_supervised": "a.json", "opmnist": "b.json"},
    }
    path = tmp_path / "assessment.md"

    module.write_all_fronts_portfolio_summary(path, summary)

    text = path.read_text(encoding="utf-8")
    assert "Decision: **PARTIAL**." in text
    assert "does not import Step 3 harnesses into Step 2" in text
    assert "`opmnist` | `partial`" in text
