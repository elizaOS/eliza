#!/usr/bin/env python3
"""
End-to-End Test for Vending-Bench

This script tests the complete benchmark flow including:
1. Environment simulation
2. Agent decision making (heuristic and LLM)
3. Coherence evaluation
4. Report generation
5. OpenAI API integration (if OPENAI_API_KEY is set)

Usage:
    python test_e2e.py
    python test_e2e.py --with-llm  # Test with real LLM
"""

import asyncio
import os
import sys
from decimal import Decimal
from pathlib import Path

# Add the package to path
sys.path.insert(0, str(Path(__file__).parent))

# Load repo-root .env if present (optional)
try:
    from dotenv import load_dotenv  # type: ignore

    repo_root = Path(__file__).resolve().parents[3]
    env_path = repo_root / ".env"
    if env_path.exists():
        load_dotenv(env_path)
except ImportError:
    pass

from elizaos_vending_bench import (
    LEADERBOARD_SCORES,
    CoherenceEvaluator,
    MockLLMProvider,
    VendingAgent,
    VendingBenchConfig,
    VendingBenchRunner,
    VendingEnvironment,
)


class TestResults:
    """Tracks test results."""

    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.errors: list[str] = []

    def pass_test(self, name: str):
        self.passed += 1
        print(f"  PASS {name}")

    def fail_test(self, name: str, error: str):
        self.failed += 1
        self.errors.append(f"{name}: {error}")
        print(f"  FAIL {name}: {error}")

    def summary(self) -> bool:
        total = self.passed + self.failed
        print(f"\n{'=' * 60}")
        print(f"Test Results: {self.passed}/{total} passed")
        if self.errors:
            print("\nErrors:")
            for err in self.errors:
                print(f"  - {err}")
        print(f"{'=' * 60}")
        return self.failed == 0


async def test_environment(results: TestResults):
    """Test the VendingEnvironment."""
    print("\nTesting Environment...")

    try:
        # Test initialization
        env = VendingEnvironment(initial_cash=Decimal("500"), seed=42)
        assert env.state.cash_on_hand == Decimal("500")
        results.pass_test("Environment initialization")

        # Test products loaded
        assert len(env.products) >= 10
        assert "water" in env.products
        results.pass_test("Products loaded")

        # Test suppliers loaded
        assert len(env.suppliers) == 3
        results.pass_test("Suppliers loaded")

        # Test net worth calculation
        net_worth = env.get_net_worth()
        assert net_worth == Decimal("500")
        results.pass_test("Net worth calculation")

        # Test placing an order
        result = env.action_place_order("beverage_dist", {"water": 12, "soda_cola": 12})
        assert "Order" in result and "placed" in result
        assert env.state.cash_on_hand < Decimal("500")
        results.pass_test("Place order action")

        # Test simulate day
        summary = env.simulate_day()
        assert summary.day_number == 1
        assert summary.operational_fees > 0
        results.pass_test("Simulate day")

        # Test delivery flow (simulate 2 more days for delivery)
        env.simulate_day()  # Order in transit
        env.simulate_day()  # Should be delivered
        assert len(env.state.delivered_inventory) > 0
        results.pass_test("Delivery flow")

        # Test restocking
        delivered = env.state.delivered_inventory[0]
        result = env.action_restock_slot(0, 0, delivered.product_id, min(delivered.quantity, 5))
        assert "Restocked" in result
        results.pass_test("Restock action")

        # Test collect cash
        env.state.machine.cash_in_machine = Decimal("100")
        result = env.action_collect_cash()
        assert "Collected" in result
        results.pass_test("Collect cash action")

    except Exception as e:
        results.fail_test("Environment test", str(e))


async def test_agent_heuristic(results: TestResults):
    """Test the VendingAgent with heuristic decision making."""
    print("\nTesting Heuristic Agent...")

    try:
        env = VendingEnvironment(initial_cash=Decimal("500"), seed=42)
        agent = VendingAgent(environment=env)

        # Run a short simulation
        result = await agent.run_simulation(max_days=5, run_id="test_heuristic")

        assert result.run_id == "test_heuristic"
        results.pass_test("Simulation runs")

        assert len(result.actions) > 0
        results.pass_test("Actions recorded")

        assert result.simulation_days > 0
        results.pass_test("Days simulated")

        assert result.initial_cash == Decimal("500")
        results.pass_test("Initial cash tracked")

        # Check profit calculation
        assert result.profit == result.final_net_worth - result.initial_cash
        results.pass_test("Profit calculated")

    except Exception as e:
        results.fail_test("Heuristic agent test", str(e))


async def test_agent_with_mock_llm(results: TestResults):
    """Test the VendingAgent with mock LLM responses."""
    print("\nTesting Agent with Mock LLM...")

    try:
        responses = [
            '{"action": "VIEW_BUSINESS_STATE"}',
            '{"action": "VIEW_SUPPLIERS"}',
            '{"action": "PLACE_ORDER", "supplier_id": "beverage_dist", "items": {"water": 12}}',
            '{"action": "ADVANCE_DAY"}',
            '{"action": "CHECK_DELIVERIES"}',
            '{"action": "ADVANCE_DAY"}',
            '{"action": "RESTOCK_SLOT", "row": 0, "column": 0, "product_id": "water", "quantity": 10}',
            '{"action": "SET_PRICE", "row": 0, "column": 0, "price": 1.25}',
            '{"action": "ADVANCE_DAY"}',
        ]

        provider = MockLLMProvider(responses=responses)
        env = VendingEnvironment(initial_cash=Decimal("500"), seed=42)
        agent = VendingAgent(environment=env, llm_provider=provider)

        result = await agent.run_simulation(max_days=3, run_id="test_mock")

        assert result.total_tokens > 0
        results.pass_test("Tokens tracked with mock LLM")

        assert provider.call_count > 0
        results.pass_test("LLM provider called")

    except Exception as e:
        results.fail_test("Mock LLM test", str(e))


async def test_coherence_evaluator(results: TestResults):
    """Test the CoherenceEvaluator."""
    print("\nTesting Coherence Evaluator...")

    try:
        evaluator = CoherenceEvaluator()

        env = VendingEnvironment(initial_cash=Decimal("500"), seed=42)
        agent = VendingAgent(environment=env)

        # Run simulation
        result = await agent.run_simulation(max_days=10, run_id="test_eval")

        # Evaluate
        errors = evaluator.evaluate_run(result)

        # Just check it runs without error
        assert isinstance(errors, list)
        results.pass_test("Evaluator runs")

        # Test coherence score
        score = evaluator.calculate_coherence_score(errors, result.simulation_days)
        assert 0 <= score <= 1
        results.pass_test("Coherence score in range")

        # Test error breakdown
        breakdown = evaluator.get_error_breakdown(errors)
        assert isinstance(breakdown, dict)
        results.pass_test("Error breakdown")

    except Exception as e:
        results.fail_test("Evaluator test", str(e))


async def test_benchmark_runner(results: TestResults):
    """Test the VendingBenchRunner."""
    print("\nTesting Benchmark Runner...")

    try:
        config = VendingBenchConfig(
            num_runs=2,
            max_days_per_run=5,
            initial_cash=Decimal("500"),
            random_seed=42,
            generate_report=False,
            compare_leaderboard=True,
        )

        runner = VendingBenchRunner(config)
        report = await runner.run_benchmark()

        assert len(report.results) == 2
        results.pass_test("Multiple runs complete")

        assert report.metrics is not None
        results.pass_test("Metrics calculated")

        assert report.leaderboard_comparison is not None
        results.pass_test("Leaderboard comparison")

        assert "key_findings" in report.summary
        results.pass_test("Summary generated")

    except Exception as e:
        results.fail_test("Runner test", str(e))


async def test_leaderboard_data(results: TestResults):
    """Test leaderboard data."""
    print("\nTesting Leaderboard Data...")

    try:
        assert len(LEADERBOARD_SCORES) > 0
        results.pass_test("Leaderboard loaded")

        # Check Grok 4 (top score)
        assert "grok_4" in LEADERBOARD_SCORES
        assert LEADERBOARD_SCORES["grok_4"].top_score > Decimal("4000")
        results.pass_test("Top scores present")

    except Exception as e:
        results.fail_test("Leaderboard test", str(e))


async def test_with_openai(results: TestResults):
    """Test with real OpenAI API."""
    print("\nTesting with OpenAI API...")

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        print("  SKIP OPENAI_API_KEY not set")
        return

    try:
        from elizaos_vending_bench.providers.openai import OpenAIProvider

        provider = OpenAIProvider(
            api_key=api_key,
            model="gpt-5-mini",  # Use mini for faster/cheaper tests
        )

        env = VendingEnvironment(initial_cash=Decimal("500"), seed=42)
        agent = VendingAgent(environment=env, llm_provider=provider, temperature=0.0)

        # Run just 2 days to limit API calls
        result = await agent.run_simulation(max_days=2, run_id="test_openai")

        assert result.simulation_days > 0
        results.pass_test("OpenAI simulation runs")

        assert result.total_tokens > 0
        results.pass_test("OpenAI tokens counted")

        # Check for reasonable decisions
        action_types = [a.action_type.value for a in result.actions]
        print(f"  Actions taken: {action_types[:10]}...")
        results.pass_test("OpenAI actions parsed")

    except Exception as e:
        results.fail_test("OpenAI test", str(e))


async def test_plugin_structure(results: TestResults):
    """Test the ElizaOS plugin structure."""
    print("\nTesting Plugin Structure...")

    try:
        # Try importing the plugin (may fail if elizaos not installed)
        try:
            from elizaos_vending_bench.plugin import create_vending_bench_plugin

            results.pass_test("Plugin imports")
        except ImportError as e:
            print(f"  SKIP elizaos not installed ({e})")
            return

        # Test plugin creation
        plugin = create_vending_bench_plugin()
        assert plugin.name == "vending-bench"
        results.pass_test("Plugin created")

        # Check actions are defined (may be empty list if elizaos not available)
        # The create_vending_actions function requires elizaos types

    except Exception as e:
        results.fail_test("Plugin test", str(e))


async def main():
    """Run all end-to-end tests."""
    print("=" * 60)
    print("Vending-Bench End-to-End Tests")
    print("=" * 60)

    results = TestResults()

    # Run tests
    await test_environment(results)
    await test_agent_heuristic(results)
    await test_agent_with_mock_llm(results)
    await test_coherence_evaluator(results)
    await test_benchmark_runner(results)
    await test_leaderboard_data(results)

    # Check for --with-llm flag
    if "--with-llm" in sys.argv or os.getenv("OPENAI_API_KEY"):
        await test_with_openai(results)

    # Plugin test (may fail gracefully if elizaos not installed)
    await test_plugin_structure(results)

    # Summary
    success = results.summary()

    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
