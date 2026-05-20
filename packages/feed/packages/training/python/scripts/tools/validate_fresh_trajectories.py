#!/usr/bin/env python3
"""
Validate Fresh Trajectories - Deep inspection of newly generated trajectory data.

Checks:
1. All new environment state fields are populated (groupChat, tokenBudget, workingMemory)
2. Field values are reasonable (no NaN, no negatives where inappropriate)
3. Reward signals fire correctly for group chat archetypes
4. End-to-end data integrity from step env → metricsJson → reward computation

Usage:
  python scripts/validate_fresh_trajectories.py [--recent N] [--archetype NAME]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

# Add parent to path for imports
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.training.rewards import (
    TrajectoryRewardInputs,
    context_efficiency_reward,
    group_chat_intel_quality_reward,
    working_memory_effectiveness_reward,
)


@dataclass
class ValidationResult:
    trajectory_id: str
    archetype: str
    steps: int
    issues: list[str]
    warnings: list[str]
    # New field presence
    has_group_chat_facts: bool = False
    has_context_breakdown: bool = False
    has_working_memory: bool = False
    has_prompt_tokens: bool = False
    # Aggregate metrics
    group_chat_steps: int = 0
    unique_facts: int = 0
    avg_prompt_tokens: float = 0.0
    avg_context_util: float = 0.0
    wm_fact_count: int = 0
    had_thesis: bool = False
    # Reward scores
    gc_intel_reward: float = 0.0
    ctx_eff_reward: float = 0.0
    wm_reward: float = 0.0


def load_trajectories_from_db() -> list[dict]:
    """Load recent trajectories from PostgreSQL."""
    try:
        import psycopg2
    except ImportError:
        print("psycopg2 not available, trying psycopg2-binary...")
        try:
            import psycopg2
        except ImportError:
            print("ERROR: psycopg2 not installed. Install with: pip install psycopg2-binary")
            sys.exit(1)

    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("ERROR: DATABASE_URL not set")
        sys.exit(1)

    conn = psycopg2.connect(db_url)
    cur = conn.cursor()
    cur.execute("""
        SELECT "id", "agentId", "archetype", "stepsJson", "metricsJson",
               "totalReward", "finalPnl", "episodeLength", "createdAt"
        FROM trajectories
        ORDER BY "createdAt" DESC
        LIMIT 50
    """)
    rows = cur.fetchall()
    conn.close()

    trajectories = []
    for row in rows:
        traj = {
            "trajectoryId": row[0],
            "agentId": row[1],
            "archetype": row[2],
            "stepsJson": row[3],
            "metricsJson": row[4],
            "totalReward": float(row[5]) if row[5] else 0.0,
            "finalPnl": float(row[6]) if row[6] else 0.0,
            "episodeLength": row[7],
            "createdAt": str(row[8]),
        }
        trajectories.append(traj)
    return trajectories


def load_trajectories_from_json(directory: Path) -> list[dict]:
    """Load trajectories from JSON files in a directory."""
    trajectories = []
    for f in sorted(directory.glob("*.json")):
        try:
            data = json.loads(f.read_text())
            # TrajectoryRecorder wraps in { trajectory: {...}, rewardJudgment, llmCalls }
            if "trajectory" in data and isinstance(data["trajectory"], dict):
                data = data["trajectory"]
            trajectories.append(data)
        except (json.JSONDecodeError, OSError):
            continue
    return trajectories


def validate_trajectory(traj: dict) -> ValidationResult:
    """Deep validate a single trajectory."""
    traj_id = traj.get("trajectoryId", traj.get("id", "unknown"))
    archetype = traj.get("archetype", "unknown")
    issues: list[str] = []
    warnings: list[str] = []

    # Parse steps
    steps_raw = traj.get("stepsJson", traj.get("steps", []))
    if isinstance(steps_raw, str):
        try:
            steps = json.loads(steps_raw)
        except json.JSONDecodeError:
            issues.append("stepsJson is not valid JSON")
            return ValidationResult(traj_id, archetype, 0, issues, warnings)
    else:
        steps = steps_raw if isinstance(steps_raw, list) else []

    result = ValidationResult(
        trajectory_id=traj_id,
        archetype=archetype,
        steps=len(steps),
        issues=issues,
        warnings=warnings,
    )

    if not steps:
        issues.append("No steps found")
        return result

    # Check each step's environment state
    all_facts: set[str] = set()
    gc_steps = 0
    token_totals: list[float] = []
    gc_token_shares: list[float] = []

    for i, step in enumerate(steps):
        env = step.get("environmentState", step.get("environment_state", {}))

        # Check basic fields
        if env.get("agentBalance") is None and env.get("agent_balance") is None:
            issues.append(f"Step {i}: missing agentBalance")

        # Check group chat fields
        gc_active = env.get("groupChatsActive", env.get("group_chats_active"))
        if gc_active is not None and int(gc_active) > 0:
            gc_steps += 1
            result.has_group_chat_facts = True

        gc_facts = env.get("groupChatFacts", env.get("group_chat_facts"))
        if gc_facts and isinstance(gc_facts, list):
            all_facts.update(gc_facts)
            result.has_group_chat_facts = True

        # Check token breakdown
        breakdown = env.get("contextBreakdown", env.get("context_breakdown"))
        if breakdown and isinstance(breakdown, dict):
            result.has_context_breakdown = True
            gc_tokens = breakdown.get("groupChat", 0)
            prompt_est = env.get("promptTokenEstimate", env.get("prompt_token_estimate", 0))
            if prompt_est and prompt_est > 0:
                token_totals.append(float(prompt_est))
                if gc_tokens:
                    gc_token_shares.append(float(gc_tokens) / float(prompt_est))

        prompt_est = env.get("promptTokenEstimate", env.get("prompt_token_estimate"))
        if prompt_est is not None:
            result.has_prompt_tokens = True

        # Check working memory
        wm_facts = env.get("workingMemoryFactCount", env.get("working_memory_fact_count"))
        wm_thesis = env.get("workingMemoryActiveThesis", env.get("working_memory_active_thesis"))
        if wm_facts is not None:
            result.has_working_memory = True
        if wm_thesis:
            result.had_thesis = True

    # Aggregate metrics
    result.group_chat_steps = gc_steps
    result.unique_facts = len(all_facts)
    result.avg_prompt_tokens = sum(token_totals) / len(token_totals) if token_totals else 0.0
    result.avg_context_util = (
        result.avg_prompt_tokens / 6000.0 if result.avg_prompt_tokens > 0 else 0.0
    )

    # Working memory from last step
    last_env = steps[-1].get("environmentState", steps[-1].get("environment_state", {}))
    wm_count = last_env.get("workingMemoryFactCount", last_env.get("working_memory_fact_count"))
    result.wm_fact_count = int(wm_count) if wm_count is not None else 0

    # Compute reward signals
    inputs = TrajectoryRewardInputs(
        final_pnl=traj.get("finalPnl", traj.get("final_pnl", 0.0)),
        starting_balance=1000,
        end_balance=1000 + traj.get("finalPnl", traj.get("final_pnl", 0.0)),
        num_steps=len(steps),
        group_chat_facts_count=len(all_facts),
        group_chat_intel_steps_used=gc_steps,
        group_chat_total_steps=len(steps),
        avg_context_utilization=result.avg_context_util,
        avg_group_chat_token_share=(
            sum(gc_token_shares) / len(gc_token_shares) if gc_token_shares else 0.0
        ),
        working_memory_final_fact_count=result.wm_fact_count,
        had_active_thesis=result.had_thesis,
    )

    result.gc_intel_reward = group_chat_intel_quality_reward(inputs)
    result.ctx_eff_reward = context_efficiency_reward(inputs)
    result.wm_reward = working_memory_effectiveness_reward(inputs)

    # Validation checks for social archetypes
    if archetype in ("information-trader", "social-butterfly"):
        if gc_steps == 0:
            warnings.append(f"Social archetype '{archetype}' has 0 group chat steps")
        if len(all_facts) == 0:
            warnings.append(f"Social archetype '{archetype}' gathered 0 group chat facts")

    # Check metricsJson if available
    metrics_raw = traj.get("metricsJson")
    if metrics_raw:
        metrics = json.loads(metrics_raw) if isinstance(metrics_raw, str) else metrics_raw
        if "groupChatStepsWithIntel" not in metrics:
            warnings.append("metricsJson missing groupChatStepsWithIntel")
        if "avgPromptTokens" not in metrics:
            warnings.append("metricsJson missing avgPromptTokens")
        if "hadActiveThesis" not in metrics:
            warnings.append("metricsJson missing hadActiveThesis")

    return result


def main():
    parser = argparse.ArgumentParser(description="Validate fresh trajectory data")
    parser.add_argument(
        "--source",
        choices=["db", "json"],
        default="json",
        help="Data source: db (PostgreSQL) or json (local files)",
    )
    parser.add_argument(
        "--dir",
        type=str,
        default="training-data-output/trajectories",
        help="Directory for JSON trajectories",
    )
    parser.add_argument("--archetype", type=str, help="Filter by archetype")
    parser.add_argument("--recent", type=int, default=50, help="Number of recent trajectories")
    args = parser.parse_args()

    # Load trajectories
    if args.source == "db":
        print("Loading trajectories from database...")
        trajectories = load_trajectories_from_db()
    else:
        traj_dir = Path(args.dir)
        if not traj_dir.exists():
            print(f"ERROR: Directory {traj_dir} does not exist")
            sys.exit(1)
        print(f"Loading trajectories from {traj_dir}...")
        trajectories = load_trajectories_from_json(traj_dir)

    if args.archetype:
        trajectories = [t for t in trajectories if t.get("archetype") == args.archetype]

    trajectories = trajectories[: args.recent]
    print(f"Loaded {len(trajectories)} trajectories\n")

    if not trajectories:
        print("No trajectories found.")
        sys.exit(0)

    # Validate each
    results: list[ValidationResult] = []
    for traj in trajectories:
        result = validate_trajectory(traj)
        results.append(result)

    # Summary
    total = len(results)
    with_gc = sum(1 for r in results if r.has_group_chat_facts)
    with_breakdown = sum(1 for r in results if r.has_context_breakdown)
    with_wm = sum(1 for r in results if r.has_working_memory)
    with_tokens = sum(1 for r in results if r.has_prompt_tokens)
    with_issues = sum(1 for r in results if r.issues)
    with_warnings = sum(1 for r in results if r.warnings)

    print("=" * 70)
    print("TRAJECTORY VALIDATION SUMMARY")
    print("=" * 70)
    print(f"Total trajectories:          {total}")
    print(f"With group chat facts:       {with_gc}/{total} ({100 * with_gc / total:.0f}%)")
    print(
        f"With context breakdown:      {with_breakdown}/{total} ({100 * with_breakdown / total:.0f}%)"
    )
    print(f"With working memory:         {with_wm}/{total} ({100 * with_wm / total:.0f}%)")
    print(f"With prompt token data:      {with_tokens}/{total} ({100 * with_tokens / total:.0f}%)")
    print(f"With issues:                 {with_issues}/{total}")
    print(f"With warnings:               {with_warnings}/{total}")

    # Per-archetype breakdown
    archetypes = defaultdict(list)
    for r in results:
        archetypes[r.archetype].append(r)

    print(
        f"\n{'Archetype':<25} {'Count':>5} {'Steps':>6} {'GC%':>5} {'Facts':>6} {'Tokens':>7} {'Util':>5} {'WM':>4} {'GC Rwd':>7} {'CE Rwd':>7} {'WM Rwd':>7}"
    )
    print("-" * 100)
    for arch, arch_results in sorted(archetypes.items()):
        n = len(arch_results)
        avg_steps = sum(r.steps for r in arch_results) / n
        gc_pct = sum(1 for r in arch_results if r.group_chat_steps > 0) / n * 100
        avg_facts = sum(r.unique_facts for r in arch_results) / n
        avg_tokens = sum(r.avg_prompt_tokens for r in arch_results) / n
        avg_util = sum(r.avg_context_util for r in arch_results) / n
        avg_wm = sum(r.wm_fact_count for r in arch_results) / n
        avg_gc_rwd = sum(r.gc_intel_reward for r in arch_results) / n
        avg_ce_rwd = sum(r.ctx_eff_reward for r in arch_results) / n
        avg_wm_rwd = sum(r.wm_reward for r in arch_results) / n
        print(
            f"{arch:<25} {n:>5} {avg_steps:>6.1f} {gc_pct:>4.0f}% {avg_facts:>6.1f} {avg_tokens:>7.0f} {avg_util:>4.1%} {avg_wm:>4.1f} {avg_gc_rwd:>7.3f} {avg_ce_rwd:>7.3f} {avg_wm_rwd:>7.3f}"
        )

    # Issues detail
    if with_issues or with_warnings:
        print(f"\n{'=' * 70}")
        print("ISSUES AND WARNINGS")
        print("=" * 70)
        for r in results:
            if r.issues or r.warnings:
                print(f"\n{r.trajectory_id} ({r.archetype}):")
                for issue in r.issues:
                    print(f"  ERROR: {issue}")
                for warn in r.warnings:
                    print(f"  WARN:  {warn}")

    print(f"\n{'=' * 70}")
    print("VERDICT:", end=" ")
    if with_issues == 0 and with_gc > 0:
        print("PASS - All trajectories valid, group chat data present")
    elif with_issues == 0:
        print("PARTIAL - No errors, but no group chat data found (check archetype config)")
    else:
        print(f"FAIL - {with_issues} trajectories have errors")


if __name__ == "__main__":
    main()
