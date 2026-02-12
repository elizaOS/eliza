#!/usr/bin/env python3
"""
Test The Judge (PR #4)

Loads trajectories and evaluates them using the new reward functions.
Verifies:
1. Financial Rewards (PnL, Risk)
2. Format Rewards (XML validation)
3. Reasoning Alignment (Financial Literacy)
"""

import sys
import logging
from pathlib import Path

# Add python directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from src.data_bridge.reader import JsonTrajectoryReader
from src.models import BabylonTrajectory
from src.training.rewards import (
    TrajectoryRewardInputs,
    composite_reward,
    calculate_pnl_reward,
    calculate_risk_reward
)
from src.training.quality_utils import (
    calculate_detailed_tick_quality,
    validate_xml_structure
)

logging.basicConfig(level=logging.INFO, format='%(message)s')
logger = logging.getLogger("TheJudge")


def evaluate_trajectory(traj: BabylonTrajectory):
    print(f"\n--- Judging Trajectory: {traj.trajectory_id} ---")

    # 1. Financials
    # In your current JSON, you might need to calculate start/end from steps if not top-level
    start_bal = 10000.0
    end_bal = start_bal + traj.final_pnl

    pnl_score = calculate_pnl_reward(start_bal, end_bal)
    print(f"💰 Financials: PnL ${traj.final_pnl:.2f} -> Score: {pnl_score:.2f}")

    # 2. Step-by-Step Analysis
    total_format = 0.0
    total_reasoning = 0.0
    risk_penalties = 0
    valid_steps = 0

    for i, step in enumerate(traj.steps):
        # Skip steps without LLM calls
        if not step.llm_calls:
            continue

        valid_steps += 1

        # Calculate Quality Scores
        fmt, rsn = calculate_detailed_tick_quality(
            step.llm_calls,
            step.action,
            None,  # Feedback
            "default"
        )

        # Calculate Risk (Mocking exposure calculation for this test)
        # Assuming open_positions count proxies for exposure roughly
        exposure = min(1.0, step.environment_state.open_positions * 0.1)
        action_type = step.action.action_type if step.action else "wait"
        risk_penalty = calculate_risk_reward(exposure, action_type)

        if risk_penalty < 0:
            risk_penalties += 1

        total_format += fmt
        total_reasoning += rsn

        # Log interesting steps (e.g., failed XML or high reasoning)
        if fmt < 0:
            print(f"   ⚠️ Step {i} Bad XML: {fmt}")
        if rsn > 0.6:
            print(f"   ✨ Step {i} Good Reasoning: {rsn:.2f}")

    # Averages
    avg_format = total_format / max(1, valid_steps)
    avg_reasoning = total_reasoning / max(1, valid_steps)

    print(
        f"📝 Quality: Avg XML {avg_format:.2f} | Avg Reasoning {avg_reasoning:.2f}")
    if risk_penalties > 0:
        print(f"🚨 Risk: {risk_penalties} dangerous actions detected")

    # 3. Final Composite Score
    inputs = TrajectoryRewardInputs(
        final_pnl=traj.final_pnl,
        starting_balance=start_bal,
        end_balance=end_bal,
        format_score=avg_format,
        reasoning_score=avg_reasoning,
        risky_actions_count=risk_penalties
    )

    final_score = composite_reward(inputs)

    verdict = "✅ PASSED" if final_score > 0 else "❌ FAILED"
    print(f"⚖️  FINAL SCORE: {final_score:.4f} ({verdict})")


def main():
    # Look for trajectory data in the training package output directory
    source_dir = Path(__file__).parent.parent.parent / "training-data-output" / "trajectories"
    if not source_dir.exists():
        # Fallback to engine output if training output doesn't exist
        source_dir = Path(__file__).parent.parent.parent.parent / "engine" / "training-data-output" / "trajectories"
    
    # Validate that at least one path exists
    if not source_dir.exists():
        logger.error("No trajectory data found. Checked paths:")
        logger.error(f"  - {Path(__file__).parent.parent.parent / 'training-data-output' / 'trajectories'}")
        logger.error(f"  - {source_dir}")
        logger.error("Run 'make tier4-generate' or 'bun run packages/engine/examples/generate-training-data.ts' first.")
        sys.exit(1)
    
    source_dir = str(source_dir)
    try:
        reader = JsonTrajectoryReader(source_dir)
        window_ids = reader.get_window_ids()

        count = 0
        for window_id in window_ids:
            raw_trajs = reader.get_trajectories_by_window(window_id)
            for raw in raw_trajs:
                if 'trajectory' in raw:
                    raw = raw['trajectory']
                if isinstance(raw.get('stepsJson'), str):
                    import json
                    raw['steps'] = json.loads(raw['stepsJson'])

                try:
                    traj = BabylonTrajectory.model_validate(raw)
                    evaluate_trajectory(traj)
                    count += 1
                    if count >= 5:
                        return  # Just test 5 for now
                except Exception as e:
                    print(f"Skipping invalid: {e}")

    except Exception as e:
        logger.error(f"Error: {e}")


if __name__ == "__main__":
    main()
