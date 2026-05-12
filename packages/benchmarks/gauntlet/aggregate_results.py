#!/usr/bin/env python3
"""
Aggregate multi-run benchmark results and compute statistics.
Produces a summary JSON and Markdown comparison table.
"""

import json
import os
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from statistics import mean, stdev

@dataclass
class AgentStats:
    agent_name: str
    runs: int
    mean_score: float
    std_dev: float
    min_score: float
    max_score: float
    mean_safety: float
    mean_task_completion: float
    passed_count: int
    failed_count: int
    seeds: list[int]

def extract_score_from_json(json_path: Path) -> dict:
    """Extract scores from a run JSON file."""
    with open(json_path) as f:
        data = json.load(f)
    return {
        "overall_score": data["results"]["overall_score"],
        "passed": data["results"]["passed"],
        "safety": data["results"]["components"]["safety"],
        "task_completion": data["results"]["components"]["task_completion"],
        "seed": data["run"]["seed"],
        "run_id": data["run"]["run_id"],
    }

def aggregate_agent_runs(agent_dir: Path) -> AgentStats:
    """Aggregate all runs for a single agent."""
    run_dirs = sorted(agent_dir.glob("run_*"))
    scores = []
    
    for run_dir in run_dirs:
        json_files = list(run_dir.glob("*.json"))
        if json_files:
            # Skip results.db
            json_file = [f for f in json_files if not f.name.startswith("results")][0]
            scores.append(extract_score_from_json(json_file))
    
    if not scores:
        return None
    
    overall_scores = [s["overall_score"] for s in scores]
    safety_scores = [s["safety"] for s in scores]
    task_scores = [s["task_completion"] for s in scores]
    
    return AgentStats(
        agent_name=agent_dir.name,
        runs=len(scores),
        mean_score=round(mean(overall_scores), 1),
        std_dev=round(stdev(overall_scores), 2) if len(overall_scores) > 1 else 0.0,
        min_score=min(overall_scores),
        max_score=max(overall_scores),
        mean_safety=round(mean(safety_scores), 1),
        mean_task_completion=round(mean(task_scores), 1),
        passed_count=sum(1 for s in scores if s["passed"]),
        failed_count=sum(1 for s in scores if not s["passed"]),
        seeds=[s["seed"] for s in scores],
    )

def generate_markdown_table(stats: list[AgentStats]) -> str:
    """Generate Markdown comparison table."""
    lines = [
        "# Benchmark Results Summary",
        "",
        f"*Generated from multi-run benchmark data*",
        "",
        "## Agent Comparison",
        "",
        "| Agent | Runs | Mean Score | Std Dev | Min | Max | Safety | Task Comp | Pass/Fail |",
        "|-------|------|------------|---------|-----|-----|--------|-----------|-----------|",
    ]
    
    for s in stats:
        status = f"✅ {s.passed_count}/{s.runs}" if s.failed_count == 0 else f"❌ {s.passed_count}/{s.runs}"
        lines.append(
            f"| {s.agent_name} | {s.runs} | {s.mean_score} | ±{s.std_dev} | "
            f"{s.min_score} | {s.max_score} | {s.mean_safety}% | {s.mean_task_completion}% | {status} |"
        )
    
    lines.extend([
        "",
        "## Key Findings",
        "",
    ])
    
    # Find best and worst
    sorted_by_score = sorted(stats, key=lambda x: x.mean_score, reverse=True)
    best = sorted_by_score[0]
    worst = sorted_by_score[-1]
    
    lines.append(f"- **Best performing**: {best.agent_name} (mean: {best.mean_score})")
    lines.append(f"- **Worst performing**: {worst.agent_name} (mean: {worst.mean_score})")
    
    # Check for failures
    failures = [s for s in stats if s.failed_count > 0]
    if failures:
        lines.append(f"- **Agents that failed**: {', '.join(s.agent_name for s in failures)}")
    
    # Variance check
    high_variance = [s for s in stats if s.std_dev > 5.0]
    if high_variance:
        lines.append(f"- **High variance agents (std > 5)**: {', '.join(s.agent_name for s in high_variance)}")
    else:
        lines.append("- **All agents show stable performance** (std ≤ 5)")
    
    lines.extend([
        "",
        "## Reproducibility",
        "",
        "Each agent was run with the following seeds: `12345, 23456, 34567, 45678, 56789`",
        "",
        "To reproduce:",
        "```bash",
        "gauntlet run --agent agents/<agent>.py --mock --seed <seed>",
        "```",
    ])
    
    return "\n".join(lines)

def main():
    if len(sys.argv) < 2:
        print("Usage: python aggregate_results.py <multi_run_dir>")
        sys.exit(1)
    
    base_dir = Path(sys.argv[1])
    if not base_dir.exists():
        print(f"Directory not found: {base_dir}")
        sys.exit(1)
    
    print(f"Aggregating results from: {base_dir}")
    
    # Find all agent directories
    agent_dirs = [d for d in base_dir.iterdir() if d.is_dir() and not d.name.startswith(".")]
    
    all_stats = []
    for agent_dir in sorted(agent_dirs):
        stats = aggregate_agent_runs(agent_dir)
        if stats:
            all_stats.append(stats)
            print(f"  {stats.agent_name}: {stats.runs} runs, mean={stats.mean_score}, std={stats.std_dev}")
    
    # Export JSON
    summary_json = {
        "benchmark_version": "v1.0",
        "results_dir": str(base_dir),
        "agents": [asdict(s) for s in all_stats],
    }
    
    json_path = base_dir / "aggregate_summary.json"
    with open(json_path, "w") as f:
        json.dump(summary_json, f, indent=2)
    print(f"\nJSON summary: {json_path}")
    
    # Export Markdown
    md_content = generate_markdown_table(all_stats)
    md_path = base_dir / "COMPARISON.md"
    with open(md_path, "w") as f:
        f.write(md_content)
    print(f"Markdown summary: {md_path}")

if __name__ == "__main__":
    main()
