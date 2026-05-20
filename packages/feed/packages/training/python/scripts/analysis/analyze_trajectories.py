#!/usr/bin/env python3
"""
Trajectory Analyzer - Token breakdown, intel usage, and quality metrics.

Usage:
  python scripts/analyze_trajectories.py --file <path.jsonl> [options]

Options:
  --file PATH           Path to trajectory JSONL file
  --token-breakdown     Show token usage breakdown across all trajectories
  --unused-intel        Find trajectories where group chat info was available but unused
  --action-stats        Show action distribution statistics
  --reward-dist         Show reward distribution
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path


def load_trajectories(path: Path) -> list[dict]:
    """Load trajectories from JSONL file."""
    trajectories = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                trajectories.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return trajectories


def analyze_token_breakdown(trajectories: list[dict]) -> None:
    """Analyze token usage across all trajectories."""
    section_totals: dict[str, list[int]] = defaultdict(list)
    prompt_totals: list[int] = []

    for traj in trajectories:
        for step in traj.get("steps", []):
            env = step.get("environmentState", {})
            breakdown = env.get("contextBreakdown", {})
            prompt_est = env.get("promptTokenEstimate", 0)

            if prompt_est:
                prompt_totals.append(prompt_est)

            for section, tokens in breakdown.items():
                if isinstance(tokens, (int, float)):
                    section_totals[section].append(int(tokens))

    if not prompt_totals:
        print("No token data found in trajectories.")
        print("Hint: Token data is captured when using the enhanced trajectory logger.")
        return

    print(f"\n{'=' * 60}")
    print(f"TOKEN BREAKDOWN ACROSS {len(trajectories)} TRAJECTORIES")
    print(f"{'=' * 60}")
    print(f"\nTotal prompt estimates: {len(prompt_totals)} steps")
    print(f"  Mean: ~{sum(prompt_totals) // len(prompt_totals)} tokens")
    print(f"  Min:  ~{min(prompt_totals)} tokens")
    print(f"  Max:  ~{max(prompt_totals)} tokens")

    if section_totals:
        print("\nPer-Section Breakdown:")
        print(f"{'Section':<20} {'Mean':>8} {'Min':>8} {'Max':>8} {'Count':>8}")
        print("-" * 52)
        for section in sorted(section_totals.keys()):
            values = section_totals[section]
            mean = sum(values) // len(values)
            print(f"{section:<20} {mean:>8} {min(values):>8} {max(values):>8} {len(values):>8}")


def find_unused_intel(trajectories: list[dict]) -> None:
    """Find trajectories where group chat intel was available but agent didn't use it for trading."""
    results: list[dict] = []

    for traj in trajectories:
        steps = traj.get("steps", [])
        had_intel = False
        traded = False
        intel_facts: list[str] = []

        for step in steps:
            env = step.get("environmentState", {})
            facts = env.get("groupChatFacts", [])
            gc_active = env.get("groupChatsActive", 0)

            if gc_active and gc_active > 0:
                had_intel = True
                intel_facts.extend(facts)

            action = step.get("action", {})
            if action.get("actionType") == "TRADE" and action.get("success"):
                traded = True

        if had_intel and not traded:
            results.append(
                {
                    "trajectoryId": traj.get("trajectoryId", "?"),
                    "agent": traj.get("metadata", {}).get("agentName", "?"),
                    "factCount": len(intel_facts),
                    "sampleFacts": intel_facts[:3],
                }
            )

    print(f"\n{'=' * 60}")
    print("UNUSED INTEL ANALYSIS")
    print(f"{'=' * 60}")
    print(f"\n{len(results)} trajectories had group chat intel but did NOT trade:")

    for r in results[:20]:
        print(f"\n  {r['trajectoryId'][:30]}... ({r['agent']})")
        print(f"    {r['factCount']} facts available:")
        for fact in r["sampleFacts"]:
            print(f"      - {fact[:80]}")

    total_with_intel = sum(
        1
        for t in trajectories
        if any(
            s.get("environmentState", {}).get("groupChatsActive", 0) > 0 for s in t.get("steps", [])
        )
    )
    print(
        f"\nSummary: {len(results)}/{total_with_intel} trajectories with intel didn't trade ({len(results) / max(total_with_intel, 1) * 100:.1f}%)"
    )


def action_stats(trajectories: list[dict]) -> None:
    """Show action type distribution."""
    action_counts: Counter[str] = Counter()
    action_success: Counter[str] = Counter()

    for traj in trajectories:
        for step in traj.get("steps", []):
            action = step.get("action", {})
            action_type = action.get("actionType", "unknown")
            action_counts[action_type] += 1
            if action.get("success"):
                action_success[action_type] += 1

    print(f"\n{'=' * 60}")
    print(f"ACTION DISTRIBUTION ACROSS {len(trajectories)} TRAJECTORIES")
    print(f"{'=' * 60}")
    print(f"\n{'Action':<25} {'Count':>8} {'Success':>8} {'Rate':>8}")
    print("-" * 49)

    for action, count in action_counts.most_common():
        success = action_success.get(action, 0)
        rate = success / count * 100 if count else 0
        print(f"{action:<25} {count:>8} {success:>8} {rate:>7.1f}%")

    total = sum(action_counts.values())
    total_success = sum(action_success.values())
    print("-" * 49)
    print(
        f"{'TOTAL':<25} {total:>8} {total_success:>8} {total_success / max(total, 1) * 100:>7.1f}%"
    )


def reward_distribution(trajectories: list[dict]) -> None:
    """Show reward distribution."""
    rewards = [t.get("totalReward", t.get("total_reward", 0)) for t in trajectories]

    if not rewards:
        print("No reward data found.")
        return

    print(f"\n{'=' * 60}")
    print(f"REWARD DISTRIBUTION ({len(rewards)} trajectories)")
    print(f"{'=' * 60}")
    print(f"  Mean:   {sum(rewards) / len(rewards):.4f}")
    print(f"  Median: {sorted(rewards)[len(rewards) // 2]:.4f}")
    print(f"  Min:    {min(rewards):.4f}")
    print(f"  Max:    {max(rewards):.4f}")
    print(f"  Std:    {_std(rewards):.4f}")

    # Histogram
    print("\n  Distribution:")
    buckets = [0] * 10
    for r in rewards:
        clamped = max(0.0, min(1.0, r))
        idx = min(int(clamped * 10), 9)
        buckets[idx] += 1

    max_count = max(buckets) if buckets else 1
    for i, count in enumerate(buckets):
        low = i * 0.1
        high = (i + 1) * 0.1
        bar = "█" * int(count / max_count * 40) if max_count > 0 else ""
        print(f"  {low:.1f}-{high:.1f}: {bar} ({count})")


def _std(values: list[float]) -> float:
    """Standard deviation."""
    if len(values) < 2:
        return 0.0
    mean = sum(values) / len(values)
    variance = sum((x - mean) ** 2 for x in values) / (len(values) - 1)
    return variance**0.5


def main() -> None:
    parser = argparse.ArgumentParser(description="Analyze agent trajectories")
    parser.add_argument("--file", type=Path, required=True, help="Path to trajectory JSONL file")
    parser.add_argument("--token-breakdown", action="store_true", help="Show token usage breakdown")
    parser.add_argument("--unused-intel", action="store_true", help="Find unused group chat intel")
    parser.add_argument("--action-stats", action="store_true", help="Show action distribution")
    parser.add_argument("--reward-dist", action="store_true", help="Show reward distribution")
    args = parser.parse_args()

    if not args.file.exists():
        print(f"Error: File not found: {args.file}", file=sys.stderr)
        sys.exit(1)

    trajectories = load_trajectories(args.file)
    print(f"Loaded {len(trajectories)} trajectories from {args.file}")

    ran_any = False
    if args.token_breakdown:
        analyze_token_breakdown(trajectories)
        ran_any = True
    if args.unused_intel:
        find_unused_intel(trajectories)
        ran_any = True
    if args.action_stats:
        action_stats(trajectories)
        ran_any = True
    if args.reward_dist:
        reward_distribution(trajectories)
        ran_any = True

    if not ran_any:
        # Default: show everything
        analyze_token_breakdown(trajectories)
        action_stats(trajectories)
        reward_distribution(trajectories)
        find_unused_intel(trajectories)


if __name__ == "__main__":
    main()
