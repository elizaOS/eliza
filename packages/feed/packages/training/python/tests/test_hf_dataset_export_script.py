from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

SCRIPT_PATH = (
    Path(__file__).resolve().parent.parent / "scripts" / "hf" / "trajectories_to_hf_dataset.py"
)
MODULE_SPEC = importlib.util.spec_from_file_location("trajectories_to_hf_dataset", SCRIPT_PATH)
assert MODULE_SPEC and MODULE_SPEC.loader
HF_EXPORT = importlib.util.module_from_spec(MODULE_SPEC)
sys.modules[MODULE_SPEC.name] = HF_EXPORT
MODULE_SPEC.loader.exec_module(HF_EXPORT)


def make_step(index: int) -> dict:
    return {
        "stepNumber": index,
        "observation": {
            "market": {"price": 100 + index, "priceChange24h": index, "volume24h": 1000},
            "task": "rank trust trajectories",
        },
        "action": {
            "type": "HOLD",
            "parameters": {"reasoning": f"hold because signal {index}"},
        },
    }


def make_market_step(index: int, market_id: str, action_type: str = "BUY") -> dict:
    return {
        "stepNumber": index,
        "observation": {
            "market": {
                "marketId": market_id,
                "price": 100 + index,
                "priceChange24h": index,
                "volume24h": 1000,
            },
            "task": "rank trust trajectories",
        },
        "action": {
            "type": action_type,
            "parameters": {
                "marketId": market_id,
                "reasoning": f"{action_type.lower()} because signal {index}",
            },
        },
    }


def make_llm_trade_step(
    index: int,
    market_id: str,
    *,
    reward: float,
    reasoning: str,
    response: str | None = None,
) -> dict:
    return {
        "stepNumber": index,
        "timestamp": 1000 + index,
        "reward": reward,
        "environmentState": {
            "agentBalance": 25000 - (index * 100),
            "agentPnL": reward * 100,
            "openPositions": 0,
        },
        "action": {
            "actionType": "TRADE",
            "parameters": {
                "marketId": market_id,
                "side": "buy_yes",
                "amount": 100,
                "reasoning": reasoning,
            },
            "reasoning": reasoning,
        },
        "llmCalls": [
            {
                "purpose": "action",
                "model": "qwen/test",
                "systemPrompt": "You are a Feed trust agent. Output the next action in a structured way.",
                "userPrompt": (
                    f"You are testing market {market_id}.\n"
                    f"Step {index + 1}: decide the next trade using the live market context."
                ),
                "response": response
                or f'{{"action":"trade","marketId":"{market_id}","reasoning":"{reasoning}"}}',
            }
        ],
    }


def make_trajectory(
    trajectory_id: str,
    total_reward: float,
    final_pnl: float,
    window_id: str = "window-1",
    scenario_id: str = "scenario-a",
) -> HF_EXPORT.TrajectoryData:
    return HF_EXPORT.TrajectoryData(
        trajectory_id=trajectory_id,
        agent_id=f"agent-{trajectory_id}",
        agent_name=f"Agent {trajectory_id}",
        window_id=window_id,
        scenario_id=scenario_id,
        archetype="trust-agent",
        steps=[make_step(0)],
        final_pnl=final_pnl,
        final_balance=10000 + final_pnl,
        episode_length=1,
        total_reward=total_reward,
        metadata={"source": "test"},
    )


def test_create_ranked_groups_orders_by_reward_then_pnl() -> None:
    config = HF_EXPORT.ExportConfig(format="rankings", min_actions=1)
    trajectories = [
        make_trajectory("low", total_reward=0.2, final_pnl=10),
        make_trajectory("mid", total_reward=0.5, final_pnl=50),
        make_trajectory("high", total_reward=0.5, final_pnl=100),
    ]

    groups = HF_EXPORT.create_ranked_groups(trajectories, config)

    assert len(groups) == 1
    group = groups[0]
    assert group.group_id == "unknown_batch__window-1_scenario-a__dominant_action_type_hold"
    assert group.score_field == "total_reward"
    assert group.tie_breaker_field == "final_pnl"
    assert group.metadata["candidate_count"] == 3
    assert group.metadata["batch_scope"] == "unknown_batch"
    assert group.metadata["grouping_field"] == "dominant_action_type"
    assert group.metadata["grouping_value"] == "hold"
    assert [candidate["trajectory_id"] for candidate in group.candidates] == [
        "high",
        "mid",
        "low",
    ]
    assert [candidate["rank"] for candidate in group.candidates] == [1, 2, 3]


def test_create_ranked_groups_skips_singletons() -> None:
    config = HF_EXPORT.ExportConfig(format="rankings", min_actions=1)
    trajectories = [make_trajectory("solo", total_reward=0.1, final_pnl=5)]

    groups = HF_EXPORT.create_ranked_groups(trajectories, config)

    assert groups == []


def test_create_ranked_groups_partitions_by_dominant_market() -> None:
    config = HF_EXPORT.ExportConfig(format="rankings", min_actions=1)
    trajectories = [
        HF_EXPORT.TrajectoryData(
            trajectory_id="m1-high",
            agent_id="agent-m1-high",
            agent_name="Agent m1-high",
            window_id="window-1",
            scenario_id="scenario-a",
            archetype="trust-agent",
            steps=[make_market_step(0, "market-one"), make_market_step(1, "market-one")],
            final_pnl=200,
            final_balance=10200,
            episode_length=2,
            total_reward=0.9,
            metadata={},
        ),
        HF_EXPORT.TrajectoryData(
            trajectory_id="m1-low",
            agent_id="agent-m1-low",
            agent_name="Agent m1-low",
            window_id="window-1",
            scenario_id="scenario-a",
            archetype="trust-agent",
            steps=[make_market_step(0, "market-one"), make_market_step(1, "market-one")],
            final_pnl=100,
            final_balance=10100,
            episode_length=2,
            total_reward=0.7,
            metadata={},
        ),
        HF_EXPORT.TrajectoryData(
            trajectory_id="m2-high",
            agent_id="agent-m2-high",
            agent_name="Agent m2-high",
            window_id="window-1",
            scenario_id="scenario-a",
            archetype="trust-agent",
            steps=[make_market_step(0, "market-two"), make_market_step(1, "market-two")],
            final_pnl=90,
            final_balance=10090,
            episode_length=2,
            total_reward=0.8,
            metadata={},
        ),
        HF_EXPORT.TrajectoryData(
            trajectory_id="m2-low",
            agent_id="agent-m2-low",
            agent_name="Agent m2-low",
            window_id="window-1",
            scenario_id="scenario-a",
            archetype="trust-agent",
            steps=[make_market_step(0, "market-two"), make_market_step(1, "market-two")],
            final_pnl=10,
            final_balance=10010,
            episode_length=2,
            total_reward=0.4,
            metadata={},
        ),
    ]

    groups = HF_EXPORT.create_ranked_groups(trajectories, config)

    assert len(groups) == 2
    group_ids = {group.group_id for group in groups}
    assert group_ids == {
        "unknown_batch__window-1_scenario-a__dominant_market_market-one",
        "unknown_batch__window-1_scenario-a__dominant_market_market-two",
    }
    assert all(group.metadata["grouping_field"] == "dominant_market" for group in groups)


def test_create_ranked_groups_partitions_by_batch_scope() -> None:
    config = HF_EXPORT.ExportConfig(format="rankings", min_actions=1)
    trajectories = [
        make_trajectory("a-high", total_reward=0.9, final_pnl=120),
        make_trajectory("a-low", total_reward=0.6, final_pnl=40),
        make_trajectory("b-high", total_reward=0.8, final_pnl=90),
        make_trajectory("b-low", total_reward=0.3, final_pnl=10),
    ]
    trajectories[0].batch_id = "batch-a"
    trajectories[1].batch_id = "batch-a"
    trajectories[2].batch_id = "batch-b"
    trajectories[3].batch_id = "batch-b"

    groups = HF_EXPORT.create_ranked_groups(trajectories, config)

    assert len(groups) == 2
    group_ids = {group.group_id for group in groups}
    assert group_ids == {
        "batch-a__window-1_scenario-a__dominant_action_type_hold",
        "batch-b__window-1_scenario-a__dominant_action_type_hold",
    }


def test_create_ranked_groups_prefers_decision_level_groups_when_llm_calls_exist() -> None:
    config = HF_EXPORT.ExportConfig(format="rankings", min_actions=1)
    trajectories = [
        HF_EXPORT.TrajectoryData(
            trajectory_id="alpha",
            agent_id="agent-alpha",
            agent_name="Agent alpha",
            window_id="window-1",
            scenario_id="scenario-a",
            archetype="trust-agent",
            steps=[
                make_llm_trade_step(
                    0,
                    "market-one",
                    reward=0.9,
                    reasoning="The market is underpriced versus the visible catalyst.",
                )
            ],
            final_pnl=120,
            final_balance=10120,
            episode_length=1,
            total_reward=1.8,
            metadata={"roundNumber": 1, "modelSize": "0.5b"},
            batch_id="batch-a",
        ),
        HF_EXPORT.TrajectoryData(
            trajectory_id="beta",
            agent_id="agent-beta",
            agent_name="Agent beta",
            window_id="window-1",
            scenario_id="scenario-a",
            archetype="trust-agent",
            steps=[
                make_llm_trade_step(
                    0,
                    "market-one",
                    reward=0.2,
                    reasoning="The signal is weaker and should be sized smaller.",
                )
            ],
            final_pnl=20,
            final_balance=10020,
            episode_length=1,
            total_reward=0.4,
            metadata={"roundNumber": 1, "modelSize": "1.5b"},
            batch_id="batch-a",
        ),
    ]

    groups = HF_EXPORT.create_ranked_groups(trajectories, config)

    assert len(groups) == 1
    group = groups[0]
    assert group.score_field == "step_reward"
    assert group.tie_breaker_field == "trajectory_total_reward"
    assert group.metadata["group_kind"] == "decision_step"
    assert group.group_id == ("window-1_scenario-a__step_0__action_trade__target_market-one")
    assert [candidate["trajectory_id"] for candidate in group.candidates] == [
        "alpha",
        "beta",
    ]
    assert group.candidates[0]["completion"].startswith("Action: trade")


def test_create_ranked_groups_merges_decision_level_groups_across_batches_and_rounds() -> None:
    config = HF_EXPORT.ExportConfig(format="rankings", min_actions=1)
    trajectories = [
        HF_EXPORT.TrajectoryData(
            trajectory_id="alpha",
            agent_id="agent-alpha",
            agent_name="Agent alpha",
            window_id="window-1",
            scenario_id="scenario-a",
            archetype="trust-agent",
            steps=[
                make_llm_trade_step(
                    0,
                    "market-one",
                    reward=0.9,
                    reasoning="The market is underpriced versus the visible catalyst.",
                )
            ],
            final_pnl=120,
            final_balance=10120,
            episode_length=1,
            total_reward=1.8,
            metadata={"roundNumber": 1, "modelSize": "0.5b"},
            batch_id="batch-a",
        ),
        HF_EXPORT.TrajectoryData(
            trajectory_id="beta",
            agent_id="agent-beta",
            agent_name="Agent beta",
            window_id="window-1",
            scenario_id="scenario-a",
            archetype="trust-agent",
            steps=[
                make_llm_trade_step(
                    0,
                    "market-one",
                    reward=0.5,
                    reasoning="The market setup is decent but less asymmetric.",
                )
            ],
            final_pnl=60,
            final_balance=10060,
            episode_length=1,
            total_reward=1.0,
            metadata={"roundNumber": 2, "modelSize": "1.5b"},
            batch_id="batch-b",
        ),
    ]

    groups = HF_EXPORT.create_ranked_groups(trajectories, config)

    assert len(groups) == 1
    group = groups[0]
    assert group.group_id == "window-1_scenario-a__step_0__action_trade__target_market-one"
    assert group.metadata["candidate_count"] == 2
    assert group.metadata["group_kind"] == "decision_step"


def test_create_sft_dataset_uses_decision_level_messages_when_available() -> None:
    trajectories = [
        HF_EXPORT.TrajectoryData(
            trajectory_id="alpha",
            agent_id="agent-alpha",
            agent_name="Agent alpha",
            window_id="window-1",
            scenario_id="scenario-a",
            archetype="trust-agent",
            steps=[
                make_llm_trade_step(
                    0,
                    "market-one",
                    reward=0.9,
                    reasoning="The market is underpriced versus the visible catalyst.",
                ),
                make_llm_trade_step(
                    1,
                    "market-two",
                    reward=0.5,
                    reasoning="The second market still offers upside with limited downside.",
                ),
            ],
            final_pnl=120,
            final_balance=10120,
            episode_length=2,
            total_reward=1.8,
            metadata={"roundNumber": 1},
            batch_id="batch-a",
        )
    ]

    sft_data = HF_EXPORT.create_sft_dataset(trajectories)

    assert len(sft_data) == 2
    assert all(record["prompt"] for record in sft_data)
    assert all(record["completion"].startswith("Action:") for record in sft_data)
