from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass

from benchmarks.HyperliquidBench.types import HLBenchConfig, ScenarioKind, TradingScenario
from eliza_adapter.hyperliquid import ElizaHyperliquidAgent, _extract_json_plan


@dataclass
class _Response:
    text: str


class _MalformedPlanClient:
    def __init__(self) -> None:
        self.messages: list[str] = []
        self.contexts: list[dict[str, object]] = []
        self.resets: list[tuple[str, str]] = []

    def reset(self, scenario_id: str, benchmark: str) -> None:
        self.resets.append((scenario_id, benchmark))

    def send_message(self, message: str, context: dict[str, object]) -> _Response:
        self.messages.append(message)
        self.contexts.append(context)
        return _Response(text="I would place an ETH order, then cancel it.")


def test_extract_json_plan_preserves_canonical_hyperliquid_schema() -> None:
    raw_plan = {
        "steps": [
            {
                "perp_orders": {
                    "orders": [
                        {
                            "coin": "ETH",
                            "side": "buy",
                            "tif": "GTC",
                            "sz": 0.01,
                            "reduceOnly": False,
                            "px": "mid+0%",
                        }
                    ]
                }
            }
        ]
    }

    assert _extract_json_plan(json.dumps(raw_plan)) == raw_plan


def test_extract_json_plan_normalizes_openclaw_batch_actions() -> None:
    raw_plan = """
    {
      "steps": [
        {
          "type": "batch",
          "actions": [
            {
              "action": "open_perp",
              "symbol": "BTC-PERP",
              "side": "buy",
              "size": 0.01,
              "price": "market",
              "demo_mode": true
            },
            {"action": "cancel_all", "symbol": "BTC-PERP", "demo_mode": true},
            {
              "action": "transfer",
              "currency": "USD",
              "amount": 100,
              "to_account": "demo_account",
              "demo_mode": true
            },
            {
              "action": "set_leverage",
              "symbol": "BTC-PERP",
              "leverage": 2,
              "demo_mode": true
            }
          ]
        }
      ]
    }
    """

    assert _extract_json_plan(raw_plan) == {
        "steps": [
            {
                "perp_orders": {
                    "orders": [
                        {
                            "coin": "BTC",
                            "side": "buy",
                            "tif": "GTC",
                            "sz": 0.01,
                            "reduceOnly": False,
                            "px": "mid+0%",
                        }
                    ]
                }
            },
            {"cancel_all": {"coin": "BTC"}},
            {"usd_class_transfer": {"toPerp": True, "usdc": 100.0}},
            {"set_leverage": {"coin": "BTC", "leverage": 2, "cross": False}},
        ]
    }


def test_hyperliquid_bridge_malformed_plans_fail_cleanly_after_bounded_retries(
    monkeypatch,
    tmp_path,
) -> None:
    client = _MalformedPlanClient()
    agent = ElizaHyperliquidAgent(
        config=HLBenchConfig(bench_root=tmp_path, max_iterations=2),
        client=client,  # type: ignore[arg-type]
    )
    scenario = TradingScenario(
        scenario_id="malformed-json",
        kind=ScenarioKind.COVERAGE,
        description="exercise malformed bridge output",
        allowed_coins=["ETH"],
        max_steps=1,
    )

    def fail_execute(*_args, **_kwargs):
        raise AssertionError("malformed bridge output should not reach hl-runner")

    monkeypatch.setattr(agent, "_execute_plan_dict_sync", fail_execute)

    result = asyncio.run(agent.solve_scenario(scenario))

    assert client.resets == [("malformed-json", "hyperliquid_bench")]
    assert len(client.messages) == 2
    assert client.contexts[0]["iteration"] == 0
    assert client.contexts[1]["iteration"] == 1
    assert result.scenario_id == "malformed-json"
    assert result.evaluator is None
    assert result.runner.success is False
    assert result.runner.exit_code == -1
    assert result.error_message is not None
    assert "Failed to parse plan from eliza response" in result.error_message
