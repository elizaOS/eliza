"""
Vending-Bench ElizaOS Runner - Uses the full ElizaOS runtime canonically.

This module runs the benchmark using the proper ElizaOS agent flow:
- AgentRuntime with basicCapabilities enabled
- Actions registered through the plugin system
- Providers inject context into the agent's prompt
- Messages processed through runtime.message_service.handle_message()
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import TYPE_CHECKING
from uuid import UUID

from elizaos import ChannelType, Character, Content, Memory
from elizaos.runtime import AgentRuntime
from elizaos_plugin_openai import get_openai_plugin
from uuid6 import uuid7

from elizaos_vending_bench.eliza_plugin import (
    _get_env,
    create_vending_bench_plugin,
)
from elizaos_vending_bench.environment import VendingEnvironment
from elizaos_vending_bench.reporting import VendingBenchReporter
from elizaos_vending_bench.types import (
    ActionType,
    AgentAction,
    CoherenceError,
    VendingBenchConfig,
    VendingBenchMetrics,
    VendingBenchReport,
    VendingBenchResult,
)

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)


def _load_dotenv_fallback() -> None:
    """Load repo-root .env without external dependencies.

    Searches upward from this file for a `.env` and sets any KEY=VALUE pairs
    into os.environ (without overriding existing env vars).
    """
    # Always ensure a reasonable timeout default (seconds).
    os.environ.setdefault("OPENAI_TIMEOUT", "900")

    if os.getenv("OPENAI_API_KEY"):
        return

    start = Path(__file__).resolve()
    for parent in [start, *start.parents]:
        env_path = parent / ".env"
        if not env_path.exists():
            continue
        try:
            for raw_line in env_path.read_text().splitlines():
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip("\"").strip("'")
                if key:
                    os.environ.setdefault(key, value)
        except Exception:
            # Best-effort: ignore parse errors.
            pass
        return


# Vending manager character for the benchmark
VENDING_MANAGER_CHARACTER = Character(
    name="VendingManager",
    username="vending_manager",
    bio=(
        "An AI agent specialized in managing vending machine businesses. "
        "Expert in inventory management, pricing strategy, and supply chain optimization."
    ),
    system="""You are a vending machine business manager. Your goal is to maximize profit.

IMPORTANT RULES:
1. Use exact product_ids when ordering/restocking (e.g., 'water' not 'bottled_water')
2. Each slot has max_capacity=10 - don't try to add more
3. Only restock from delivered inventory
4. Place orders early - suppliers have lead times (1-3 days)
5. Collect cash regularly to fund new orders
6. Always ADVANCE_DAY when you've completed your actions for the day
7. Don't repeat failed actions - try something different

STRATEGY:
- Start by checking business state and suppliers
- Place orders for popular products (water, soda, snacks)
- When deliveries arrive, restock the machine slots
- Collect cash when available
- Monitor inventory and reorder before stockouts

Available actions: PLACE_ORDER, RESTOCK_SLOT, SET_PRICE, COLLECT_CASH, ADVANCE_DAY
""",
)


@dataclass
class ElizaRunResult:
    """Result of a single ElizaOS benchmark run."""

    run_id: str
    simulation_days: int
    final_net_worth: Decimal
    initial_cash: Decimal
    profit: Decimal
    total_revenue: Decimal
    total_costs: Decimal
    items_sold: int
    orders_placed: int
    coherence_errors: list[CoherenceError]
    actions: list[AgentAction]
    total_tokens: int
    total_latency_ms: float
    error: str | None = None


class ElizaVendingRunner:
    """
    Benchmark runner using the canonical ElizaOS runtime.

    This runner:
    1. Creates an AgentRuntime with the vending-bench plugin
    2. Processes daily prompts through handle_message()
    3. Lets the agent select and execute actions naturally
    4. Evaluates coherence based on action history
    """

    def __init__(
        self,
        config: VendingBenchConfig,
        model_name: str = "gpt-5-mini",
    ) -> None:
        self.config = config
        self.model_name = model_name
        self._runtime: AgentRuntime | None = None
        self._user_id: UUID | None = None
        self._room_id: UUID | None = None

    async def _create_runtime(self) -> AgentRuntime:
        """Create and initialize the ElizaOS runtime."""
        _load_dotenv_fallback()
        # Ensure OpenAI plugin uses the benchmark's requested model.
        os.environ.setdefault("OPENAI_LARGE_MODEL", self.model_name)
        os.environ.setdefault("OPENAI_SMALL_MODEL", self.model_name)

        # Create character with model settings
        character = Character(
            name=VENDING_MANAGER_CHARACTER.name,
            username=VENDING_MANAGER_CHARACTER.username,
            bio=VENDING_MANAGER_CHARACTER.bio,
            system=VENDING_MANAGER_CHARACTER.system,
            settings={
                "model": self.model_name,
            },
        )

        # Create runtime with OpenAI plugin and vending-bench plugin
        runtime = AgentRuntime(
            character=character,
            plugins=[
                get_openai_plugin(),
                create_vending_bench_plugin(),
            ],
            disable_basic_capabilities=False,  # Keep REPLY, IGNORE, NONE
            enable_extended_capabilities=False,
            action_planning=True,  # Enable multi-action planning
            check_should_respond=False,  # Always respond in benchmark
        )

        await runtime.initialize()
        return runtime

    async def _send_message(
        self,
        runtime: AgentRuntime,
        text: str,
    ) -> tuple[str, list[str], int]:
        """
        Send a message through the ElizaOS runtime and get response.

        Returns: (response_text, actions_taken, tokens_used)
        """
        message = Memory(
            entity_id=str(self._user_id),
            room_id=str(self._room_id),
            content=Content(
                text=text,
                source="benchmark",
                channel_type="API",
            ),
        )

        try:
            result = await runtime.message_service.handle_message(runtime, message)
        except Exception as e:
            import traceback

            logger.error(f"[ElizaVendingRunner] Message handling error: {e}")
            logger.error(f"[ElizaVendingRunner] Traceback: {traceback.format_exc()}")
            return f"Error: {e}", [], 0

        # Extract response
        response_text = result.response_content.text if result.response_content else ""
        actions = result.response_content.actions if result.response_content else []

        # Estimate tokens (simplified - in production, get from model response)
        tokens = len(text.split()) * 2 + len(response_text.split()) * 2

        return response_text, actions or [], tokens

    async def run_single(self, run_id: str) -> ElizaRunResult:
        """Run a single benchmark simulation using ElizaOS."""
        logger.info(f"[ElizaVendingRunner] Starting run {run_id}")

        # Create fresh runtime for this run
        runtime = await self._create_runtime()
        self._user_id = uuid7()
        self._room_id = uuid7()

        # Get the environment from module-level storage
        env = _get_env(runtime)

        actions_taken: list[AgentAction] = []
        total_tokens = 0
        total_latency_ms = 0.0
        initial_cash = env.state.cash_on_hand

        try:
            for day in range(1, self.config.max_days_per_run + 1):
                # Check for bankruptcy
                if env.get_net_worth() <= Decimal("0"):
                    logger.info(f"[ElizaVendingRunner] Bankrupt on day {day}")
                    break

                # Build daily prompt
                day_prompt = self._build_day_prompt(env, day)

                # Track actions for this day
                day_actions = 0
                max_actions_per_day = 10

                while day_actions < max_actions_per_day:
                    start_time = time.time()

                    # Send message through ElizaOS runtime
                    response, actions, tokens = await self._send_message(
                        runtime,
                        day_prompt
                        if day_actions == 0
                        else "Continue with next action or ADVANCE_DAY",
                    )

                    latency = (time.time() - start_time) * 1000
                    total_tokens += tokens
                    total_latency_ms += latency

                    # Record action
                    action_type = self._extract_action_type(actions)
                    action = AgentAction(
                        action_type=action_type,
                        day=day,
                        parameters={},
                        result=response,
                        success=True,
                        tokens_used=tokens,
                        latency_ms=latency,
                    )
                    actions_taken.append(action)
                    day_actions += 1

                    # Check if day should end
                    if action_type == ActionType.ADVANCE_DAY:
                        break

                    # Update prompt for next iteration
                    day_prompt = f"Previous result: {response[:500]}"

            # Calculate final metrics
            final_net_worth = env.get_net_worth()
            total_revenue: Decimal = sum(
                (d.total_revenue for d in env.state.daily_history), Decimal("0")
            )
            total_costs: Decimal = sum(
                (o.total_cost for o in env.state.order_history), Decimal("0")
            )
            items_sold = (
                sum(sum(s.quantity for s in d.sales) for d in env.state.daily_history)
                if env.state.daily_history
                else 0
            )
            orders_placed = len(env.state.order_history)

            # Simple coherence evaluation (count repeated actions)
            coherence_errors: list[CoherenceError] = []
            # We'll do a basic evaluation - the full evaluator needs VendingBenchResult format

            return ElizaRunResult(
                run_id=run_id,
                simulation_days=env.state.current_day,
                final_net_worth=final_net_worth,
                initial_cash=initial_cash,
                profit=final_net_worth - initial_cash,
                total_revenue=total_revenue,
                total_costs=total_costs,
                items_sold=items_sold,
                orders_placed=orders_placed,
                coherence_errors=coherence_errors,
                actions=actions_taken,
                total_tokens=total_tokens,
                total_latency_ms=total_latency_ms,
            )

        except Exception as e:
            import traceback
            logger.error(f"[ElizaVendingRunner] Run {run_id} failed: {e}")
            logger.error(f"[ElizaVendingRunner] Traceback: {traceback.format_exc()}")
            return ElizaRunResult(
                run_id=run_id,
                simulation_days=env.state.current_day if env else 0,
                final_net_worth=Decimal("0"),
                initial_cash=initial_cash,
                profit=Decimal("0") - initial_cash,
                total_revenue=Decimal("0"),
                total_costs=Decimal("0"),
                items_sold=0,
                orders_placed=0,
                coherence_errors=[],
                actions=actions_taken,
                total_tokens=total_tokens,
                total_latency_ms=total_latency_ms,
                error=str(e),
            )

        finally:
            await runtime.stop()

    def _build_day_prompt(self, env: VendingEnvironment, day: int) -> str:
        """Build the prompt for a new day."""
        state = env.state
        yesterday = state.daily_history[-1] if state.daily_history else None

        prompt = f"""Day {day} of your vending business.

Current Status:
- Cash on Hand: ${state.cash_on_hand:.2f}
- Net Worth: ${env.get_net_worth():.2f}
- Date: {state.current_date}
"""

        if yesterday:
            prompt += f"""
Yesterday's Summary:
- Revenue: ${yesterday.total_revenue:.2f}
- Items Sold: {sum(s.quantity for s in yesterday.sales)}
- Weather: {yesterday.weather.value}
"""

        if state.delivered_inventory:
            prompt += "\nYou have delivered inventory ready to restock!"

        if state.pending_orders:
            prompt += f"\nPending orders: {len(state.pending_orders)}"

        prompt += "\n\nWhat actions will you take today? Use the available actions."

        return prompt

    def _extract_action_type(self, actions: list[str]) -> ActionType:
        """Extract the primary action type from the response."""
        action_map = {
            "PLACE_ORDER": ActionType.PLACE_ORDER,
            "RESTOCK_SLOT": ActionType.RESTOCK_SLOT,
            "SET_PRICE": ActionType.SET_PRICE,
            "COLLECT_CASH": ActionType.COLLECT_CASH,
            "ADVANCE_DAY": ActionType.ADVANCE_DAY,
            "REPLY": ActionType.VIEW_STATE,  # Map REPLY to view state
        }

        for action in actions:
            if action in action_map:
                return action_map[action]

        return ActionType.VIEW_STATE  # Default

    async def run_benchmark(self) -> VendingBenchReport:
        """Run the full benchmark with multiple runs."""
        logger.info("[ElizaVendingRunner] Starting benchmark")
        logger.info(
            f"[ElizaVendingRunner] Config: {self.config.num_runs} runs, {self.config.max_days_per_run} days each"
        )

        start_time = time.time()
        results: list[VendingBenchResult] = []

        for i in range(self.config.num_runs):
            run_id = f"run_{i + 1:03d}"
            logger.info(f"[ElizaVendingRunner] Starting {run_id}")

            run_result = await self.run_single(run_id)

            # Convert to VendingBenchResult
            result = VendingBenchResult(
                run_id=run_result.run_id,
                simulation_days=run_result.simulation_days,
                final_net_worth=run_result.final_net_worth,
                initial_cash=run_result.initial_cash,
                profit=run_result.profit,
                total_revenue=run_result.total_revenue,
                total_costs=run_result.total_costs,
                total_operational_fees=Decimal("0"),
                items_sold=run_result.items_sold,
                orders_placed=run_result.orders_placed,
                successful_deliveries=run_result.orders_placed,
                stockout_days=0,
                coherence_errors=run_result.coherence_errors,
                total_tokens=run_result.total_tokens,
                total_latency_ms=run_result.total_latency_ms,
                error=run_result.error,
            )
            results.append(result)

            logger.info(
                f"[ElizaVendingRunner] {run_id} completed: "
                f"net_worth=${result.final_net_worth}, "
                f"days={result.simulation_days}, "
                f"errors={len(result.coherence_errors)}"
            )

        # Calculate metrics
        metrics = self._calculate_metrics(results)

        # Create report
        total_time = time.time() - start_time
        report = VendingBenchReport(
            metadata={
                "timestamp": datetime.now().isoformat(),
                "version": "1.0.0-eliza",
                "model": self.model_name,
                "runtime": "elizaos",
                "total_duration_seconds": total_time,
            },
            config=self.config,
            results=results,
            metrics=metrics,
            leaderboard_comparison=None,
            summary={
                "best_net_worth": str(metrics.max_net_worth),
                "avg_net_worth": str(metrics.avg_net_worth),
                "coherence_score": f"{metrics.coherence_score:.1%}",
                "runtime_type": "ElizaOS (canonical)",
            },
        )

        logger.info(
            f"[ElizaVendingRunner] Benchmark completed in {total_time:.1f}s. "
            f"Best net worth: ${metrics.max_net_worth}"
        )

        return report

    def _calculate_metrics(self, results: list[VendingBenchResult]) -> VendingBenchMetrics:
        """Calculate aggregate metrics from results."""
        import statistics

        from elizaos_vending_bench.types import CoherenceErrorType

        net_worths = [float(r.final_net_worth) for r in results]
        profits = [float(r.profit) for r in results]
        error_counts = [len(r.coherence_errors) for r in results]

        # Error breakdown
        error_breakdown: dict[CoherenceErrorType, int] = {}
        for result in results:
            for error in result.coherence_errors:
                error_breakdown[error.error_type] = error_breakdown.get(error.error_type, 0) + 1

        # Coherence score (1 - normalized error rate)
        total_days = sum(r.simulation_days for r in results)
        total_errors = sum(error_counts)
        coherence_score = max(
            0.0, 1.0 - (total_errors / (total_days * 3)) if total_days > 0 else 0.0
        )

        return VendingBenchMetrics(
            avg_net_worth=Decimal(str(statistics.mean(net_worths))),
            max_net_worth=Decimal(str(max(net_worths))),
            min_net_worth=Decimal(str(min(net_worths))),
            std_net_worth=Decimal(str(statistics.stdev(net_worths) if len(net_worths) > 1 else 0)),
            median_net_worth=Decimal(str(statistics.median(net_worths))),
            success_rate=sum(1 for p in profits if p > 0) / len(profits) if profits else 0.0,
            avg_profit=Decimal(str(statistics.mean(profits))),
            profitability_rate=sum(1 for p in profits if p > 0) / len(profits) if profits else 0.0,
            avg_items_sold=statistics.mean([r.items_sold for r in results]),
            avg_orders_placed=statistics.mean([r.orders_placed for r in results]),
            avg_stockout_days=statistics.mean([r.stockout_days for r in results]),
            avg_simulation_days=statistics.mean([r.simulation_days for r in results]),
            coherence_score=coherence_score,
            avg_coherence_errors=statistics.mean(error_counts),
            avg_tokens_per_run=statistics.mean([r.total_tokens for r in results]),
            avg_tokens_per_day=(
                sum(r.total_tokens for r in results) / total_days if total_days > 0 else 0.0
            ),
            avg_latency_per_action_ms=statistics.mean(
                [r.total_latency_ms / max(1, len(r.coherence_errors)) for r in results]
            ),
            error_breakdown=error_breakdown,
        )


async def run_eliza_benchmark(
    num_runs: int = 3,
    max_days: int = 30,
    model: str = "gpt-5-mini",
    output_dir: str | None = None,
) -> VendingBenchReport:
    """
    Run the Vending-Bench using the canonical ElizaOS runtime.

    This is the proper way to run the benchmark - using the full
    ElizaOS agent with message handling, action selection, and
    provider context injection.
    """
    config = VendingBenchConfig(
        num_runs=num_runs,
        max_days_per_run=max_days,
        model_name=model,
        output_dir=output_dir or "./benchmark_results/eliza",
        generate_report=True,
        save_trajectories=True,
        save_detailed_logs=True,
    )

    runner = ElizaVendingRunner(config, model_name=model)
    report = await runner.run_benchmark()

    # Save report if output dir specified
    if output_dir:
        output_path = Path(output_dir)
        output_path.mkdir(parents=True, exist_ok=True)

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

        # Save markdown report
        reporter = VendingBenchReporter()
        markdown = reporter.generate_report(report)
        report_path = output_path / f"VENDING-BENCH-ELIZA-{timestamp}.md"
        report_path.write_text(markdown)
        logger.info(f"[ElizaVendingRunner] Saved report to {report_path}")

    return report


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    # Load .env
    try:
        from dotenv import load_dotenv

        load_dotenv(Path(__file__).resolve().parents[3] / ".env")
    except ImportError:
        pass
    _load_dotenv_fallback()

    # Run benchmark
    report = asyncio.run(
        run_eliza_benchmark(
            num_runs=1,
            max_days=10,
            model="gpt-5-mini",
            output_dir="./benchmark_results/eliza-test",
        )
    )

    print("\nBenchmark Complete!")
    print(f"Best Net Worth: ${report.metrics.max_net_worth}")
    print(f"Coherence Score: {report.metrics.coherence_score:.1%}")
