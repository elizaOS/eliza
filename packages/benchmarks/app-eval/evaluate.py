#!/usr/bin/env python3
"""
Unified benchmark evaluator for elizaOS app agents.

Takes a results directory (from run-benchmarks.ts) and produces a
scored report. Can also re-evaluate historical runs.

Usage:
    python3 app-eval/evaluate.py app-eval/results/latest/
    python3 app-eval/evaluate.py app-eval/results/latest/ --output report.json
    python3 app-eval/evaluate.py app-eval/results/latest/ --format table
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

# Add tasks directory to path for evaluator imports
SCRIPT_DIR = Path(__file__).parent.resolve()
sys.path.insert(0, str(SCRIPT_DIR / "tasks"))

from research_evaluator import evaluate_task as evaluate_research_task  # noqa: E402
from coding_evaluator import evaluate_coding_task  # noqa: E402


def load_task_definitions() -> dict[str, dict[str, Any]]:
    """Load all task definitions keyed by task ID."""
    tasks_dir = SCRIPT_DIR / "tasks"
    definitions: dict[str, dict[str, Any]] = {}

    for filename in ["research-tasks.json", "coding-tasks.json"]:
        filepath = tasks_dir / filename
        if not filepath.exists():
            continue
        with open(filepath) as f:
            task_list = json.load(f)
        for task in task_list:
            definitions[task["id"]] = task

    return definitions


def load_results(results_dir: Path) -> list[dict[str, Any]]:
    """Load individual result JSON files from a results directory."""
    results = []
    for filepath in sorted(results_dir.glob("*.json")):
        if filepath.name == "summary.json":
            continue
        if filepath.name == "evaluation.json":
            continue
        try:
            with open(filepath) as f:
                data = json.load(f)
            if isinstance(data, dict) and "id" in data:
                results.append(data)
        except (json.JSONDecodeError, KeyError):
            print(f"[evaluate] Skipping invalid file: {filepath}", file=sys.stderr)
    return results


def evaluate_result(
    task_def: dict[str, Any],
    result: dict[str, Any],
) -> dict[str, Any]:
    """Route to the appropriate evaluator based on task type."""
    task_type = task_def.get("type", "research")

    if task_type == "coding":
        return evaluate_coding_task(task_def, result)
    else:
        # Research evaluator expects (task, response_string)
        response_text = result.get("response", "")
        eval_result = evaluate_research_task(task_def, response_text)
        # Normalize output keys
        return {
            "task_id": task_def["id"],
            "score": eval_result.get("overall_score", 0),
            "max_score": task_def.get("evaluation", {}).get("scoring", {}).get("max_score", 10),
            "pass": eval_result.get("overall_score", 0) > 0,
            "feedback": eval_result.get("rubric_band", ""),
            "breakdown": eval_result.get("components", {}),
        }


def build_report(
    evaluations: list[dict[str, Any]],
    task_defs: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """Build a unified score report from individual evaluations."""
    research_evals = [
        e for e in evaluations
        if task_defs.get(e["task_id"], {}).get("type") == "research"
    ]
    coding_evals = [
        e for e in evaluations
        if task_defs.get(e["task_id"], {}).get("type") == "coding"
    ]

    def category_summary(evals: list[dict[str, Any]]) -> dict[str, Any]:
        if not evals:
            return {"avg": 0, "min": 0, "max": 0, "tasks": []}
        scores = [e["score"] for e in evals]
        return {
            "avg": round(sum(scores) / len(scores), 1),
            "min": min(scores),
            "max": max(scores),
            "tasks": [
                {
                    "id": e["task_id"],
                    "score": e["score"],
                    "max_score": e["max_score"],
                    "pass": e["pass"],
                    "feedback": e.get("feedback", ""),
                    "breakdown": e.get("breakdown", {}),
                }
                for e in evals
            ],
        }

    all_scores = [e["score"] for e in evaluations]
    overall = round(sum(all_scores) / len(all_scores), 1) if all_scores else 0

    report: dict[str, Any] = {
        "total_tasks": len(evaluations),
        "completed": sum(1 for e in evaluations if e["score"] > 0),
        "failed": sum(1 for e in evaluations if e["score"] == 0),
        "scores": {},
        "overall_score": overall,
    }

    if research_evals:
        report["scores"]["research"] = category_summary(research_evals)
    if coding_evals:
        report["scores"]["coding"] = category_summary(coding_evals)

    return report


def print_table(report: dict[str, Any]) -> None:
    """Print a human-readable table of results."""
    print()
    print("=" * 70)
    print("  APP BENCHMARK EVALUATION")
    print("=" * 70)
    print(f"  Total: {report['total_tasks']}  |  "
          f"Completed: {report['completed']}  |  "
          f"Failed: {report['failed']}  |  "
          f"Overall: {report['overall_score']}")
    print("-" * 70)

    for category, data in report.get("scores", {}).items():
        print(f"\n  {category.upper()} (avg={data['avg']}  "
              f"min={data['min']}  max={data['max']})")
        print(f"  {'Task':<18} {'Score':>6} {'Max':>5} {'Pass':>6}  Feedback")
        print(f"  {'-'*16}  {'-'*5} {'-'*4} {'-'*5}  {'-'*30}")

        for task in data["tasks"]:
            status = "PASS" if task["pass"] else "FAIL"
            feedback = task.get("feedback", "")[:40]
            print(f"  {task['id']:<18} {task['score']:>5.1f} "
                  f"/{task['max_score']:<4} {status:>5}  {feedback}")

    print()
    print("-" * 70)
    print(f"  OVERALL SCORE: {report['overall_score']}")
    print("=" * 70)
    print()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Evaluate elizaOS app benchmark results",
    )
    parser.add_argument(
        "results_dir",
        help="Path to results directory (e.g. app-eval/results/latest/)",
    )
    parser.add_argument(
        "--output", "-o",
        help="Write evaluation report to this JSON file",
    )
    parser.add_argument(
        "--format", "-f",
        choices=["json", "table"],
        default="table",
        help="Output format (default: table)",
    )
    args = parser.parse_args()

    results_dir = Path(args.results_dir).resolve()
    if not results_dir.is_dir():
        print(f"Error: {results_dir} is not a directory", file=sys.stderr)
        sys.exit(1)

    # Load task definitions and results
    task_defs = load_task_definitions()
    results = load_results(results_dir)

    if not results:
        print(f"Error: No result files found in {results_dir}", file=sys.stderr)
        sys.exit(1)

    print(f"[evaluate] Loaded {len(results)} result(s) from {results_dir}")
    print(f"[evaluate] Loaded {len(task_defs)} task definition(s)")

    # Evaluate each result
    evaluations: list[dict[str, Any]] = []
    for result in results:
        task_id = result.get("id", "unknown")
        task_def = task_defs.get(task_id)
        if not task_def:
            print(f"[evaluate] Warning: No task definition for {task_id}, skipping",
                  file=sys.stderr)
            continue
        evaluation = evaluate_result(task_def, result)
        evaluations.append(evaluation)

    if not evaluations:
        print("Error: No evaluations produced", file=sys.stderr)
        sys.exit(1)

    # Build report
    report = build_report(evaluations, task_defs)

    # Add run metadata from summary.json if present
    summary_path = results_dir / "summary.json"
    if summary_path.exists():
        with open(summary_path) as f:
            summary = json.load(f)
        report["run_id"] = summary.get("run_id", "unknown")
        report["started_at"] = summary.get("started_at")
        report["completed_at"] = summary.get("completed_at")

    # Output
    if args.format == "json" or args.output:
        json_output = json.dumps(report, indent=2)
        if args.format == "json":
            print(json_output)
    else:
        print_table(report)

    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w") as f:
            json.dump(report, f, indent=2)
        print(f"[evaluate] Report written to {output_path}")

    # Also write to the results directory
    eval_path = results_dir / "evaluation.json"
    with open(eval_path, "w") as f:
        json.dump(report, f, indent=2)
    print(f"[evaluate] Evaluation written to {eval_path}")


if __name__ == "__main__":
    main()
