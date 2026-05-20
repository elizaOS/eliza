#!/usr/bin/env python3
"""
End-to-end proof pipeline: export → train → score held-out → compare.

Runs the full loop needed to prove that training improves benchmark scores
on held-out data. This is the reproducible proof path described in the paper.

Usage:
    # Full proof with held-out split (recommended)
    python scripts/run_proof_pipeline.py \
        --base-model mlx-community/Qwen3.5-4B-Instruct-4bit \
        --output ./proof_runs/$(date +%Y%m%d-%H%M%S)

    # Quick smoke test (fewer iterations, smaller data)
    python scripts/run_proof_pipeline.py \
        --base-model mlx-community/Qwen3.5-4B-Instruct-4bit \
        --output ./proof_runs/smoke \
        --quick
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
WORKSPACE_ROOT = SCRIPTS_DIR.parents[4]


def resolve_scambench_root(workspace_root: Path) -> Path:
    candidates = [
        workspace_root / "scambench",
        workspace_root / "benchmarks" / "scambench",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


SCAMBENCH_ROOT = resolve_scambench_root(WORKSPACE_ROOT)
DEFAULT_CATALOG = SCAMBENCH_ROOT / "generated" / "scenario-catalog-difraud-merged.json"
FALLBACK_CATALOG = SCAMBENCH_ROOT / "generated" / "scenario-catalog.json"


def run_step(
    label: str, cmd: list[str], env: dict[str, str] | None = None
) -> subprocess.CompletedProcess:
    """Run a pipeline step, printing status."""
    print(f"\n{'=' * 60}")
    print(f"  {label}")
    print(f"{'=' * 60}")
    print(f"  Command: {' '.join(cmd[:6])}{'...' if len(cmd) > 6 else ''}")
    result = subprocess.run(cmd, capture_output=False, text=True, env=env)
    if result.returncode != 0:
        print(f"  FAILED (exit {result.returncode})")
        raise SystemExit(result.returncode)
    print("  OK")
    return result


def find_catalog() -> Path:
    """Find the best available ScamBench catalog."""
    if DEFAULT_CATALOG.exists():
        return DEFAULT_CATALOG
    if FALLBACK_CATALOG.exists():
        return FALLBACK_CATALOG
    raise FileNotFoundError(
        f"No ScamBench catalog found at {DEFAULT_CATALOG} or {FALLBACK_CATALOG}. "
        "Run `bun run src/catalog.ts` in the scambench directory first."
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="End-to-end proof pipeline: export → train → score held-out → compare.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--base-model", required=True, help="Base MLX model id or path.")
    parser.add_argument("--output", required=True, help="Output directory for this proof run.")
    parser.add_argument(
        "--quick", action="store_true", help="Quick smoke test (10 iters, limited data)."
    )
    parser.add_argument("--held-out-ratio", type=float, default=0.15, help="Held-out split ratio.")
    parser.add_argument(
        "--iters", type=int, default=None, help="Training iterations (auto-selected if not set)."
    )
    parser.add_argument("--seed", type=int, default=42, help="Random seed for reproducibility.")
    parser.add_argument(
        "--include-format-recovery",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Include format recovery examples in export (use --no-include-format-recovery to disable).",
    )
    parser.add_argument(
        "--scenario-catalog",
        default=None,
        help="Path to ScamBench catalog JSON (auto-detected if not set).",
    )
    args = parser.parse_args()

    output_dir = Path(args.output).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    export_dir = output_dir / "export"
    train_dir = output_dir / "trained"
    baseline_dir = output_dir / "baseline"
    held_out_dir = export_dir / "held-out"
    catalog_path = (
        Path(args.scenario_catalog).resolve() if args.scenario_catalog else find_catalog()
    )

    iters = args.iters or (10 if args.quick else 30)
    max_samples = 200 if args.quick else 0

    print(f"\nProof pipeline run: {datetime.now(timezone.utc).isoformat()}")
    print(f"  Base model: {args.base_model}")
    print(f"  Output: {output_dir}")
    print(f"  Catalog: {catalog_path}")
    print(f"  Held-out ratio: {args.held_out_ratio}")
    print(f"  Iterations: {iters}")
    print(f"  Quick mode: {args.quick}")

    # Step 1: Export with held-out split
    export_cmd = [
        sys.executable,
        str(SCRIPTS_DIR / "data-prep" / "export_scam_defense_trajectories.py"),
        "--output-dir",
        str(export_dir),
        "--held-out-ratio",
        str(args.held_out_ratio),
        "--held-out-seed",
        str(args.seed),
        "--include-external-materialized",
        "--include-synthetic-training",
    ]
    if args.include_format_recovery:
        export_cmd.append("--include-format-recovery")
    run_step("Step 1: Export training data with held-out split", export_cmd)

    # Verify held-out directory was created
    held_out_trajectories = held_out_dir / "trajectories.jsonl"
    if not held_out_dir.exists():
        print(f"ERROR: Held-out directory not created at {held_out_dir}")
        print("  The export step may have failed or the --held-out-ratio may be too small.")
        return 1
    if not held_out_trajectories.exists():
        print(
            f"ERROR: Held-out directory exists but trajectories.jsonl is missing at {held_out_trajectories}"
        )
        return 1
    print(f"  Held-out data: {held_out_trajectories}")

    # Step 2: Train on training split (auto-detects held-out/)
    train_cmd = [
        sys.executable,
        str(SCRIPTS_DIR / "train_local.py"),
        "--backend",
        "mlx",
        "--model",
        args.base_model,
        "--source-dir",
        str(export_dir),
        "--auto-detect-held-out",
        "--output",
        str(train_dir),
        "--iters",
        str(iters),
        "--batch-size",
        "1",
        "--max-seq-length",
        "512",
        "--sample-profile",
        "raw",
        "--validate",
        "--seed",
        str(args.seed),
    ]
    if max_samples > 0:
        train_cmd.extend(["--max-samples", str(max_samples)])
    run_step("Step 2: Train on export (held-out auto-detected)", train_cmd)

    # Step 3: Score baseline (no adapter) on full catalog
    baseline_decisions = baseline_dir / "decisions.json"
    baseline_dir.mkdir(parents=True, exist_ok=True)
    baseline_cmd = [
        sys.executable,
        str(SCRIPTS_DIR / "run_scambench_local.py"),
        "--base-model",
        args.base_model,
        "--label",
        "baseline",
        "--output",
        str(baseline_decisions),
        "--scenario-catalog",
        str(catalog_path),
        "--score",
    ]
    run_step("Step 3: Score baseline (no adapter)", baseline_cmd)

    # Step 4: Score trained model on full catalog
    trained_decisions = train_dir / "scambench_decisions.json"
    adapter_path = train_dir / "adapters"
    if not adapter_path.exists():
        # Try looking for adapters dir in output
        for candidate in train_dir.rglob("adapter_config.json"):
            adapter_path = candidate.parent
            break
    trained_cmd = [
        sys.executable,
        str(SCRIPTS_DIR / "run_scambench_local.py"),
        "--base-model",
        args.base_model,
        "--label",
        "trained",
        "--output",
        str(trained_decisions),
        "--scenario-catalog",
        str(catalog_path),
        "--score",
    ]
    if adapter_path.exists():
        trained_cmd.extend(["--adapter-path", str(adapter_path)])
    else:
        print(f"ERROR: No adapter found in {train_dir}.")
        print("  Training may have failed or produced no adapter checkpoint.")
        print("  Cannot produce a valid proof without a trained adapter.")
        return 1
    run_step("Step 4: Score trained model (with adapter)", trained_cmd)

    # Step 5: Compare and produce proof report
    baseline_score_path = baseline_dir / "scambench_score.json"
    trained_score_path = train_dir / "scambench_score.json"

    baseline_report = (
        json.loads(baseline_score_path.read_text()) if baseline_score_path.exists() else None
    )
    trained_report = (
        json.loads(trained_score_path.read_text()) if trained_score_path.exists() else None
    )

    if not baseline_report:
        print(
            f"WARNING: Baseline score file missing at {baseline_score_path}. Scoring may have failed."
        )
    if not trained_report:
        print(
            f"WARNING: Trained score file missing at {trained_score_path}. Scoring may have failed."
        )

    baseline_overall = baseline_report["overallScore"] if baseline_report else 0.0
    trained_overall = trained_report["overallScore"] if trained_report else 0.0
    delta = trained_overall - baseline_overall

    # Per-category comparison
    categories: dict[str, dict[str, float]] = {}
    if baseline_report:
        for r in baseline_report.get("results", []):
            cat = r.get("category", "unknown")
            categories.setdefault(
                cat, {"baseline": 0.0, "trained": 0.0, "baseline_count": 0, "trained_count": 0}
            )
            categories[cat]["baseline"] += r["score"]["overallScore"]
            categories[cat]["baseline_count"] += 1
    if trained_report:
        for r in trained_report.get("results", []):
            cat = r.get("category", "unknown")
            categories.setdefault(
                cat, {"baseline": 0.0, "trained": 0.0, "baseline_count": 0, "trained_count": 0}
            )
            categories[cat]["trained"] += r["score"]["overallScore"]
            categories[cat]["trained_count"] += 1

    category_comparison = {}
    for cat, vals in categories.items():
        b_avg = vals["baseline"] / max(vals["baseline_count"], 1)
        t_avg = vals["trained"] / max(vals["trained_count"], 1)
        category_comparison[cat] = {
            "baseline": round(b_avg, 2),
            "trained": round(t_avg, 2),
            "delta": round(t_avg - b_avg, 2),
            "scenarios": max(int(vals["baseline_count"]), int(vals["trained_count"])),
        }

    # Check training manifest for validation result
    manifest_path = train_dir / "training_manifest.json"
    training_manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    validation_report_path = train_dir / "validation_report.json"
    validation_report = (
        json.loads(validation_report_path.read_text()) if validation_report_path.exists() else {}
    )

    proof_report = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "base_model": args.base_model,
        "seed": args.seed,
        "held_out_ratio": args.held_out_ratio,
        "training_iterations": iters,
        "quick_mode": args.quick,
        "catalog": str(catalog_path),
        "baseline_score": round(baseline_overall, 2),
        "trained_score": round(trained_overall, 2),
        "delta": round(delta, 2),
        "improved": delta > 0,
        "baseline_scenarios": baseline_report["scenariosRun"] if baseline_report else 0,
        "trained_scenarios": trained_report["scenariosRun"] if trained_report else 0,
        "category_comparison": category_comparison,
        "validation_passed": training_manifest.get("validation_passed"),
        "validation_gates": {
            "action_reason": validation_report.get("action_reason", {}).get("passed"),
            "decision_format": validation_report.get("decision_format", {}).get("passed"),
            "combined": validation_report.get("combined_passed"),
        },
        "training_samples": training_manifest.get("train_sample_count"),
        "eval_samples": training_manifest.get("eval_sample_count"),
        "paths": {
            "export_dir": str(export_dir),
            "held_out_dir": str(held_out_dir),
            "train_dir": str(train_dir),
            "baseline_dir": str(baseline_dir),
            "adapter_path": str(adapter_path),
        },
    }

    proof_path = output_dir / "proof_report.json"
    proof_path.write_text(json.dumps(proof_report, indent=2), encoding="utf-8")

    # Print summary
    print(f"\n{'=' * 60}")
    print("  PROOF PIPELINE COMPLETE")
    print(f"{'=' * 60}")
    print(f"  Baseline ScamBench score:  {baseline_overall:.2f}")
    print(f"  Trained ScamBench score:   {trained_overall:.2f}")
    print(f"  Delta:                     {delta:+.2f}")
    print(f"  Improved:                  {'YES' if delta > 0 else 'NO'}")
    print(f"  Validation passed:         {training_manifest.get('validation_passed', 'N/A')}")
    print()
    print("  Category breakdown:")
    for cat, vals in sorted(category_comparison.items()):
        indicator = "+" if vals["delta"] > 0 else ""
        print(
            f"    {cat:30s}  {vals['baseline']:6.2f} → {vals['trained']:6.2f}  ({indicator}{vals['delta']:.2f})"
        )
    print()
    print(f"  Proof report: {proof_path}")
    print(f"{'=' * 60}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
