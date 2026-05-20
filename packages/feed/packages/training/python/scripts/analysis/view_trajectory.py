#!/usr/bin/env python3
"""
Trajectory Viewer - Debug and inspect agent trajectories.

Usage:
  python scripts/view_trajectory.py --file <path.jsonl> [options]

Options:
  --file PATH           Path to trajectory JSONL file
  --trajectory-id ID    Show specific trajectory by ID
  --show-context        Show full LLM prompt context
  --show-tokens         Show token breakdown per section
  --summary             Show summary only (no step details)
  --list                List all trajectory IDs in file
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def estimate_tokens(text: str) -> int:
    """Rough token estimate: ~4 chars per token for English text."""
    return len(text) // 4


def load_trajectories(path: Path) -> list[dict]:
    """Load trajectories from JSONL file."""
    trajectories = []
    with open(path) as f:
        for line_num, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                trajectories.append(json.loads(line))
            except json.JSONDecodeError as e:
                print(f"  Warning: Skipping malformed line {line_num}: {e}", file=sys.stderr)
    return trajectories


def list_trajectories(trajectories: list[dict]) -> None:
    """Print a summary table of all trajectories."""
    print(f"{'#':<4} {'Trajectory ID':<40} {'Agent':<20} {'Steps':<6} {'Reward':<8} {'Status':<12}")
    print("-" * 90)
    for i, traj in enumerate(trajectories):
        tid = traj.get("trajectoryId", traj.get("trajectory_id", "?"))[:38]
        agent = traj.get("metadata", {}).get("agentName", "?")[:18]
        steps = len(traj.get("steps", []))
        reward = traj.get("totalReward", traj.get("total_reward", 0))
        status = traj.get("metrics", {}).get("finalStatus", "?")
        print(f"{i:<4} {tid:<40} {agent:<20} {steps:<6} {reward:<8.2f} {status:<12}")


def print_trajectory(
    traj: dict, *, show_context: bool = False, show_tokens: bool = False, summary_only: bool = False
) -> None:
    """Pretty-print a single trajectory."""
    tid = traj.get("trajectoryId", traj.get("trajectory_id", "?"))
    agent = traj.get("metadata", {}).get("agentName", "?")
    steps = traj.get("steps", [])
    reward = traj.get("totalReward", traj.get("total_reward", 0))
    status = traj.get("metrics", {}).get("finalStatus", "?")
    duration = traj.get("durationMs", traj.get("duration_ms", 0))

    print(f"\n{'=' * 80}")
    print(f"Trajectory: {tid}")
    print(f"Agent: {agent}")
    print(f"Steps: {len(steps)} | Reward: {reward:.2f} | Status: {status} | Duration: {duration}ms")

    # Reward components
    rc = traj.get("rewardComponents", traj.get("reward_components", {}))
    if rc:
        print(f"Reward Components: {json.dumps(rc, indent=2)}")

    # Metrics
    metrics = traj.get("metrics", {})
    if metrics:
        print(
            f"Metrics: trades={metrics.get('tradesExecuted', '?')}, posts={metrics.get('postsCreated', '?')}, "
            f"final_balance=${metrics.get('finalBalance', '?')}, final_pnl=${metrics.get('finalPnL', '?')}"
        )

    if summary_only:
        return

    print(f"\n{'─' * 80}")
    print("STEPS:")

    for step in steps:
        step_num = step.get("stepNumber", "?")
        env = step.get("environmentState", {})
        action = step.get("action", {})
        llm_calls = step.get("llmCalls", step.get("llm_calls", []))

        print(f"\n  Step {step_num}:")
        print(
            f"    Balance: ${env.get('agentBalance', '?'):.2f} | PnL: ${env.get('agentPnL', '?'):.2f} | Positions: {env.get('openPositions', '?')}"
        )

        # Group chat context (new fields)
        gc_active = env.get("groupChatsActive")
        gc_facts = env.get("groupChatFacts", [])
        gc_tokens = env.get("groupChatIntelTokenEstimate")
        if gc_active is not None:
            print(
                f"    Group Chats: {gc_active} active, {len(gc_facts)} facts, ~{gc_tokens or 0} tokens"
            )
            if gc_facts and show_context:
                for fact in gc_facts[:5]:
                    print(f"      - {fact}")

        # Prompt token breakdown
        breakdown = env.get("contextBreakdown")
        prompt_tokens = env.get("promptTokenEstimate")
        if show_tokens and (breakdown or prompt_tokens):
            print(f"    Prompt Tokens: ~{prompt_tokens or '?'}")
            if breakdown:
                for section, tokens in breakdown.items():
                    print(f"      {section}: ~{tokens}")

        # Action
        print(
            f"    Action: {action.get('actionType', '?')} -> {'✓' if action.get('success') else '✗'}"
        )
        if action.get("parameters"):
            params = action["parameters"]
            # Truncate large params
            param_str = json.dumps(params)
            if len(param_str) > 200:
                param_str = param_str[:200] + "..."
            print(f"    Params: {param_str}")
        if action.get("error"):
            print(f"    Error: {action['error']}")

        # LLM calls
        for call in llm_calls:
            model = call.get("model", "?")
            purpose = call.get("purpose", "?")
            prompt_tok = call.get("promptTokens", "?")
            comp_tok = call.get("completionTokens", "?")
            latency = call.get("latencyMs", "?")
            print(f"    LLM: {model} ({purpose}) | {prompt_tok}+{comp_tok} tokens | {latency}ms")

            if show_context and call.get("userPrompt"):
                prompt_text = call["userPrompt"]
                if len(prompt_text) > 2000:
                    prompt_text = prompt_text[:2000] + "\n... [truncated]"
                print(f"    Prompt:\n{_indent(prompt_text, 6)}")

            if call.get("response"):
                resp = call["response"]
                if len(resp) > 500:
                    resp = resp[:500] + "..."
                print(f"    Response: {resp}")

    print(f"\n{'=' * 80}\n")


def _indent(text: str, spaces: int) -> str:
    """Indent each line of text."""
    prefix = " " * spaces
    return "\n".join(f"{prefix}{line}" for line in text.split("\n"))


def main() -> None:
    parser = argparse.ArgumentParser(description="View and debug agent trajectories")
    parser.add_argument("--file", type=Path, required=True, help="Path to trajectory JSONL file")
    parser.add_argument("--trajectory-id", type=str, default=None, help="Show specific trajectory")
    parser.add_argument("--show-context", action="store_true", help="Show full LLM prompt context")
    parser.add_argument(
        "--show-tokens", action="store_true", help="Show token breakdown per section"
    )
    parser.add_argument("--summary", action="store_true", help="Summary only (no step details)")
    parser.add_argument("--list", action="store_true", help="List all trajectory IDs")
    args = parser.parse_args()

    if not args.file.exists():
        print(f"Error: File not found: {args.file}", file=sys.stderr)
        sys.exit(1)

    trajectories = load_trajectories(args.file)
    print(f"Loaded {len(trajectories)} trajectories from {args.file}")

    if args.list:
        list_trajectories(trajectories)
        return

    if args.trajectory_id:
        matches = [
            t
            for t in trajectories
            if t.get("trajectoryId", t.get("trajectory_id", "")) == args.trajectory_id
        ]
        if not matches:
            print(f"Error: Trajectory {args.trajectory_id} not found", file=sys.stderr)
            sys.exit(1)
        for traj in matches:
            print_trajectory(
                traj,
                show_context=args.show_context,
                show_tokens=args.show_tokens,
                summary_only=args.summary,
            )
    else:
        for traj in trajectories:
            print_trajectory(
                traj,
                show_context=args.show_context,
                show_tokens=args.show_tokens,
                summary_only=args.summary,
            )


if __name__ == "__main__":
    main()
