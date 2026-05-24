"""Tests for the focused Step 2 SCR router search runner."""

from __future__ import annotations

from pathlib import Path
from types import ModuleType

import pytest
from conftest import load_script

_SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "examples"
    / "The Alberta Plan"
    / "Step2"
    / "step2_scr_router_search.py"
)


def load_module() -> ModuleType:
    return load_script(_SCRIPT_PATH, "step2_scr_router_search")


def test_expand_variant_names_accepts_all_and_rejects_unknown() -> None:
    module = load_module()

    names = module.expand_variant_names("all")

    assert "convex_reference" in names
    assert "guarded_best_mlp" in names
    with pytest.raises(ValueError, match="unknown router variant"):
        module.expand_variant_names("guarded_best_mlp,missing")


def test_long_scr_preset_sets_dohare_small_shape() -> None:
    module = load_module()
    args = module.build_parser().parse_args(["--long-scr"])

    module.apply_run_preset(args)

    assert args.steps == 20_000
    assert args.n_seeds == 3
    assert args.final_window == 5_000
    assert args.scr_preset == "dohare_small"
    assert args.regression_bits == 20
    assert args.regression_slow_bits == 15
    assert args.regression_flip_interval == 1_000
    assert args.dynamic_rewire_interval == 500


def test_million_scr_preset_sets_published_scale_shape() -> None:
    module = load_module()
    args = module.build_parser().parse_args(["--million-scr"])

    module.apply_run_preset(args)

    assert args.steps == 1_000_000
    assert args.n_seeds == 1
    assert args.final_window == 100_000
    assert args.scr_preset == "dohare_paper"
    assert args.regression_bits == 20
    assert args.regression_slow_bits == 15
    assert args.regression_flip_interval == 10_000
    assert args.dynamic_rewire_interval == 2_000


def test_args_for_variant_does_not_mutate_base_args() -> None:
    module = load_module()
    args = module.build_parser().parse_args([])
    variant = module.VARIANTS_BY_NAME["guarded_best_mlp"]

    run_args = module.args_for_variant(args, variant)

    assert args.router_policy == "convex"
    assert args.guard_tolerance == 0.0
    assert run_args.router_policy == "guarded_best_mlp"
    assert run_args.guard_tolerance == pytest.approx(1e-4)


def test_smoke_run_produces_scr_router_result(tmp_path: Path) -> None:
    module = load_module()
    args = module.build_parser().parse_args(
        [
            "--smoke",
            "--router-variants",
            "stable_mlp_selector",
            "--output-dir",
            str(tmp_path),
        ]
    )

    results = module.run_search(args)

    assert results["best_variant"] == "stable_mlp_selector"
    assert "stable_mlp_selector" in results["variants"]
    variant = results["variants"]["stable_mlp_selector"]
    assert variant["aggregate"]["mixture"]["final_window_mse"]["mean"] >= 0.0
    assert "final_window_mse" in variant["aggregate"]["comparisons"]
    assert variant["scr_protocol"]["uses_dohare_public_scr_config"] is False
    assert variant["published_scale_scr_closed"] is False
