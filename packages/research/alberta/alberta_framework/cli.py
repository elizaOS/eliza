"""Command line helpers for production Step 1/2 smoke and evidence checks."""

from __future__ import annotations

import argparse
import json
from collections.abc import Sequence
from pathlib import Path
from typing import cast

from alberta_framework.steps.step1 import (
    Step1KernelConfig,
    Step1NormalizerName,
    Step1OptimizerName,
    run_step1_smoke,
)
from alberta_framework.steps.step2 import (
    Step2KernelConfig,
    Step2StreamName,
    run_step2_smoke,
)

REPO_ROOT = Path(__file__).resolve().parents[1]


def _print_json(payload: dict[str, object]) -> None:
    print(json.dumps(payload, indent=2, sort_keys=True))


def step1_smoke_main(argv: Sequence[str] | None = None) -> int:
    """Entry point for ``alberta-step1-smoke``."""
    parser = argparse.ArgumentParser(description="Run a Step 1 kernel smoke test.")
    parser.add_argument("--steps", type=int, default=256)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--final-window", type=int, default=64)
    parser.add_argument(
        "--optimizer",
        choices=(
            "lms",
            "idbd",
            "autostep",
            "autostep_gtd",
            "adagain",
            "adam",
            "rmsprop",
            "nadaline",
        ),
        default="autostep",
    )
    parser.add_argument(
        "--normalizer",
        choices=("none", "ema", "welford", "streaming_batch"),
        default="ema",
    )
    args = parser.parse_args(argv)
    result = run_step1_smoke(
        Step1KernelConfig(
            optimizer=cast(Step1OptimizerName, args.optimizer),
            normalizer=cast(Step1NormalizerName, args.normalizer),
        ),
        steps=args.steps,
        seed=args.seed,
        final_window=args.final_window,
    )
    _print_json(result.to_dict())
    return 0 if result.finite else 1


def step2_smoke_main(argv: Sequence[str] | None = None) -> int:
    """Entry point for ``alberta-step2-smoke``."""
    parser = argparse.ArgumentParser(description="Run a Step 2 UPGD kernel smoke test.")
    parser.add_argument("--steps", type=int, default=128)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--final-window", type=int, default=32)
    parser.add_argument(
        "--stream",
        choices=("polynomial", "frequency", "compositional"),
        default="polynomial",
    )
    parser.add_argument("--n-heads", type=int, default=3)
    parser.add_argument("--feature-dim", type=int, default=8)
    args = parser.parse_args(argv)
    result = run_step2_smoke(
        Step2KernelConfig(
            stream=cast(Step2StreamName, args.stream),
            n_heads=args.n_heads,
            feature_dim=args.feature_dim,
        ),
        steps=args.steps,
        seed=args.seed,
        final_window=args.final_window,
    )
    _print_json(result.to_dict())
    return 0 if result.finite else 1


def evidence_gate_main(argv: Sequence[str] | None = None) -> int:
    """Check that promoted Step 1/2 evidence artifacts are present.

    This intentionally checks file presence and minimal parseability only.  The
    scientific threshold assertions live in ``tests/test_step1_replication.py``
    and ``tests/test_step2_canonical.py``.
    """
    parser = argparse.ArgumentParser(description="Check Step 1/2 evidence artifacts.")
    parser.add_argument("--root", type=Path, default=REPO_ROOT)
    parser.add_argument("--step", choices=("1", "2", "all"), default="all")
    args = parser.parse_args(argv)

    required: list[Path] = []
    if args.step in {"1", "all"}:
        required.extend(
            [
                Path("outputs/step1_canonical/multi_baseline_results.json"),
                Path("outputs/step1_canonical/normalization_ablation_results.json"),
                Path("outputs/step1_canonical/robustness_study_results.json"),
                Path("docs/research/step1_results.md"),
            ]
        )
    if args.step in {"2", "all"}:
        required.extend(
            [
                Path("docs/research/step2_current_best.md"),
                Path("docs/research/step2_final_gap_audit.md"),
                Path("docs/research/step2_universal_representation_theory.md"),
                Path("docs/research/step2_upgd_recursive_feature_discovery_theory.md"),
                Path("docs/research/step2_associative_memory_theory.md"),
                Path("docs/research/step2_distribution_free_limits.md"),
                Path("docs/research/step2_compositional_no_regret.md"),
                Path("docs/research/step2_completion_criteria.md"),
                Path("outputs/step2_canonical/out_of_class_results.json"),
                Path("outputs/step2_canonical/opmnist_true_mnist_40block_mse_results.json"),
            ]
        )

    missing: list[str] = []
    invalid_json: list[str] = []
    for rel_path in required:
        path = args.root / rel_path
        if not path.exists():
            missing.append(str(rel_path))
            continue
        if path.suffix == ".json":
            try:
                json.loads(path.read_text())
            except json.JSONDecodeError:
                invalid_json.append(str(rel_path))

    payload: dict[str, object] = {
        "root": str(args.root),
        "step": args.step,
        "required_count": len(required),
        "missing": missing,
        "invalid_json": invalid_json,
        "passed": not missing and not invalid_json,
    }
    _print_json(payload)
    return 0 if payload["passed"] else 1
