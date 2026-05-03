"""HyperliquidBench agent backed by the eliza TypeScript benchmark server.

This is the bridge counterpart to ``benchmarks.HyperliquidBench.eliza_agent``
(the in-process Python ``elizaos`` runtime). Instead of spinning up a Python
``AgentRuntime`` and registering the HL plugin in-process, this agent routes
plan generation through the eliza TypeScript benchmark server via
``ElizaClient.send_message`` and then hands the resulting JSON plan off to
the existing Rust execution path (``hl-runner`` + ``hl-evaluator``) by
calling the canonical ``_handle_execute_plan`` action handler.

Design notes:

- ``benchmarks.HyperliquidBench.types`` is imported lazily under
  ``TYPE_CHECKING`` so this module loads cleanly when only
  ``eliza_adapter`` is on ``sys.path`` (e.g. ``python3 -c
  "from eliza_adapter.hyperliquid import ElizaHyperliquidAgent"``).
- The plan-extraction logic (markdown fences, leading commentary, ``{...}``
  span detection) is mirrored from
  ``benchmarks.HyperliquidBench.plugin.actions.generate_plan._extract_json_plan``
  so the bridge accepts the same shapes the in-process action accepts.
- The Rust execution path is reused as-is via the EXECUTE_PLAN handler, which
  needs only ``CURRENT_PLAN_JSON`` + ``BENCH_CONFIG`` + ``BENCH_ROOT`` set on
  a runtime-shaped object. We use a tiny ``_RuntimeShim`` instead of spinning
  up a full Python ``AgentRuntime`` — the handler only ever calls
  ``get_setting`` / ``set_setting``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from eliza_adapter.client import ElizaClient

if TYPE_CHECKING:
    from benchmarks.HyperliquidBench.types import (
        BenchmarkResult,
        HLBenchConfig,
        TradingScenario,
    )


logger = logging.getLogger(__name__)


# Mirrors the action's parser so we accept the same shapes (markdown fences,
# leading commentary, etc.). Kept in sync with
# benchmarks.HyperliquidBench.plugin.actions.generate_plan._extract_json_plan.
def _extract_json_plan(raw_text: str) -> dict[str, Any]:
    """Extract a JSON plan from potentially messy LLM output."""
    fence_match = re.search(r"```(?:json)?\s*\n?(.*?)```", raw_text, re.DOTALL)
    candidate = fence_match.group(1).strip() if fence_match else raw_text.strip()

    start = candidate.find("{")
    end = candidate.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("No JSON object found in LLM response")

    json_str = candidate[start : end + 1]
    parsed = json.loads(json_str)
    if "steps" not in parsed:
        raise ValueError("Plan JSON must contain a 'steps' key")
    if not isinstance(parsed["steps"], list) or not parsed["steps"]:
        raise ValueError("Plan must have at least one step")
    return {"steps": parsed["steps"]}


class _RuntimeShim:
    """Minimal runtime stub that satisfies ``_handle_execute_plan``.

    The EXECUTE_PLAN handler only ever reads/writes settings via
    ``get_setting`` / ``set_setting`` — we don't need a full
    ``AgentRuntime`` for the Rust shell-out path.
    """

    def __init__(self) -> None:
        self._settings: dict[str, Any] = {}

    def get_setting(self, key: str) -> Any:
        return self._settings.get(key)

    def set_setting(self, key: str, value: Any) -> None:
        self._settings[key] = value


def _build_message_text(scenario: "TradingScenario", last_feedback: str | None) -> str:
    """Build the prompt sent to the eliza TS bridge for one iteration."""
    if last_feedback:
        return last_feedback

    parts: list[str] = [
        "You are a professional crypto trader on Hyperliquid DEX.",
        "Generate a trading plan as a JSON object that conforms to this schema:",
        "",
        "```",
        '{"steps": [',
        '  {"perp_orders": {"orders": [{"coin": "ETH", "side": "buy"|"sell", '
        '"tif": "GTC"|"ALO"|"IOC", "sz": number, "reduceOnly": bool, '
        '"px": number|"mid+X%"|"mid-X%"}]}},',
        '  {"cancel_last": {"coin": "ETH"}},',
        '  {"cancel_all": {"coin": "BTC"}},',
        '  {"usd_class_transfer": {"toPerp": true, "usdc": 5.0}},',
        '  {"set_leverage": {"coin": "ETH", "leverage": 5, "cross": false}}',
        ']}',
        "```",
        "",
        "Rules:",
        "- Use only the allowed coins.",
        "- Sizes must be positive (e.g., 0.001 to 1).",
        "- Leverage in [1, 20].",
        "- Do NOT include a 'trigger' field on orders (demo mode rejects it).",
        '- Total steps must be <= the provided max.',
        "- Maximize coverage of distinct action signatures (different TIFs, "
        "buy AND sell, reduceOnly true AND false, transfers in BOTH directions, "
        "leverage on each allowed coin).",
        "",
        f"Scenario: {scenario.description}",
        f"Allowed coins: {', '.join(scenario.allowed_coins)}",
        f"Max steps: {scenario.max_steps}",
    ]
    if scenario.builder_code:
        parts.append(f"Builder code: {scenario.builder_code}")
    parts.extend([
        "",
        "Return ONLY the JSON object — no markdown fences, no commentary.",
    ])
    return "\n".join(parts)


def _scenario_context(scenario: "TradingScenario", iteration: int) -> dict[str, Any]:
    """Pack the scenario into the context payload for the TS bridge."""
    ctx: dict[str, Any] = {
        "benchmark": "hyperliquid_bench",
        "scenario_id": scenario.scenario_id,
        "kind": scenario.kind.value,
        "description": scenario.description,
        "allowed_coins": list(scenario.allowed_coins),
        "max_steps": scenario.max_steps,
        "iteration": iteration,
    }
    if scenario.builder_code:
        ctx["builder_code"] = scenario.builder_code
    if scenario.plan_spec:
        ctx["plan_spec"] = scenario.plan_spec
    return ctx


class ElizaHyperliquidAgent:
    """HyperliquidBench agent that uses the eliza TS bridge for planning.

    Drop-in alternative to ``benchmarks.HyperliquidBench.eliza_agent.ElizaHyperliquidAgent``
    — same ``solve_scenario`` / ``run_benchmark`` / ``cleanup`` interface,
    same ``BenchmarkResult`` shape — but the LLM call is routed through the
    eliza TypeScript benchmark server instead of an in-process Python
    ``AgentRuntime``.
    """

    def __init__(
        self,
        config: "HLBenchConfig | None" = None,
        client: ElizaClient | None = None,
        verbose: bool = False,
    ) -> None:
        # Lazy import to keep module-load cheap and PYTHONPATH-free.
        from benchmarks.HyperliquidBench.types import HLBenchConfig

        self._config = config or HLBenchConfig()
        self._client = client or ElizaClient()
        self._verbose = verbose or self._config.verbose

    async def initialize(self) -> None:
        """Verify the eliza benchmark server is reachable."""
        # Run the blocking poll in a thread so we don't block the event loop
        # if a caller drives this agent inside an existing loop.
        await asyncio.to_thread(self._client.wait_until_ready, 120.0)

    async def solve_scenario(self, scenario: "TradingScenario") -> "BenchmarkResult":
        """Generate a plan via the eliza TS bridge and execute it via Rust."""
        from benchmarks.HyperliquidBench.plugin.actions.execute_plan import (
            _handle_execute_plan,
        )
        from benchmarks.HyperliquidBench.types import (
            BenchmarkResult,
            EvaluatorResult,
            Plan,
            RunnerResult,
        )

        # Reset the bridge session for this scenario.
        await asyncio.to_thread(
            self._client.reset,
            scenario.scenario_id,
            "hyperliquid_bench",
        )

        shim = _RuntimeShim()
        # Set up the same settings the in-process Python runtime would set,
        # so EXECUTE_PLAN's existing reads work unchanged.
        shim.set_setting("CURRENT_SCENARIO", asdict(scenario))
        shim.set_setting("BENCH_ROOT", str(self._config.bench_root))
        config_dict = asdict(self._config)
        config_dict["bench_root"] = str(self._config.bench_root)
        shim.set_setting("BENCH_CONFIG", config_dict)

        best_result: dict[str, Any] | None = None
        last_feedback: str | None = None
        last_error: str | None = None

        for iteration in range(self._config.max_iterations):
            logger.info(
                "Scenario %s — iteration %d/%d (eliza-bridge mode)",
                scenario.scenario_id,
                iteration + 1,
                self._config.max_iterations,
            )

            # 1) Ask the eliza TS bridge for a plan.
            message_text = _build_message_text(scenario, last_feedback)
            context = _scenario_context(scenario, iteration)

            try:
                response = await asyncio.to_thread(
                    self._client.send_message, message_text, context
                )
            except Exception as exc:
                last_error = f"eliza bridge call failed: {exc}"
                logger.error(last_error)
                last_feedback = (
                    "Previous attempt failed to reach the eliza bridge. "
                    "Retry generating a JSON plan."
                )
                continue

            raw_text = response.text or ""
            if self._verbose:
                logger.debug("Eliza bridge response text: %s", raw_text[:500])

            # 2) Extract the JSON plan from the response.
            try:
                plan_dict = _extract_json_plan(raw_text)
            except (json.JSONDecodeError, ValueError) as exc:
                last_error = f"Failed to parse plan from eliza response: {exc}"
                logger.warning(last_error)
                last_feedback = (
                    f"Your previous response did not contain a valid JSON plan: {exc}. "
                    "Reply with ONLY a JSON object matching the schema."
                )
                continue

            plan_json = json.dumps(plan_dict, separators=(",", ":"))
            shim.set_setting("CURRENT_PLAN_JSON", plan_json)
            shim.set_setting("CURRENT_PLAN_DICT", plan_dict)
            shim.set_setting("PLAN_EXECUTED", False)
            shim.set_setting("LAST_RESULT_JSON", None)

            # 3) Hand off to the canonical Rust execution path.
            exec_result = await _handle_execute_plan(
                shim, None, None, None, None, None,  # type: ignore[arg-type]
            )

            if not exec_result.success:
                last_error = exec_result.error or "EXECUTE_PLAN failed"
                logger.warning("EXECUTE_PLAN failed: %s", last_error)
                last_feedback = (
                    f"Previous plan failed to execute: {last_error}. "
                    "Adjust the plan and try again."
                )
                continue

            last_result_str = shim.get_setting("LAST_RESULT_JSON")
            if isinstance(last_result_str, str):
                try:
                    best_result = json.loads(last_result_str)
                except json.JSONDecodeError:
                    best_result = None

            if best_result and best_result.get("evaluator"):
                eval_data = best_result["evaluator"]
                found = eval_data.get("uniqueSignatures", [])
                score = eval_data.get("finalScore", 0)
                last_feedback = (
                    f"Score: {score}. Found {len(found)} signatures: {found}. "
                    "To IMPROVE: vary buy/sell, reduceOnly true/false, "
                    "all TIFs (GTC/ALO/IOC), transfer toPerp AND toSpot, "
                    "set leverage on ALL allowed coins. "
                    "Generate a DIFFERENT plan with MORE diverse actions."
                )

            # Reset for the next iteration.
            shim.set_setting("PLAN_EXECUTED", False)
            shim.set_setting("CURRENT_PLAN_JSON", None)

        # Build the BenchmarkResult — same shape the in-process agent returns.
        runner_result = RunnerResult(
            success=False, out_dir="", run_meta_path="", per_action_path="",
            stdout="", stderr="", exit_code=-1,
        )
        evaluator_result: "EvaluatorResult | None" = None
        error_message: str | None = None

        if best_result:
            runner_data = best_result.get("runner", {})
            if isinstance(runner_data, dict):
                out_dir = str(runner_data.get("outDir", ""))
                runner_result = RunnerResult(
                    success=bool(runner_data.get("success", False)),
                    out_dir=out_dir,
                    run_meta_path=str(Path(out_dir) / "run_meta.json") if out_dir else "",
                    per_action_path=str(Path(out_dir) / "per_action.jsonl") if out_dir else "",
                    stdout="",
                    stderr=str(runner_data.get("stderr", "")),
                    exit_code=int(runner_data.get("exitCode", -1)),
                )
            eval_data = best_result.get("evaluator")
            if isinstance(eval_data, dict):
                sigs = eval_data.get("uniqueSignatures", [])
                evaluator_result = EvaluatorResult(
                    success=bool(eval_data.get("success", False)),
                    final_score=float(eval_data.get("finalScore", 0.0)),
                    base=float(eval_data.get("base", 0.0)),
                    bonus=float(eval_data.get("bonus", 0.0)),
                    penalty=float(eval_data.get("penalty", 0.0)),
                    unique_signatures=list(sigs) if isinstance(sigs, list) else [],
                    eval_score_path=str(Path(runner_result.out_dir) / "eval_score.json"),
                    stdout="",
                    stderr="",
                    exit_code=int(eval_data.get("exitCode", -1)),
                )
        else:
            error_message = last_error or "No plan was successfully executed"

        return BenchmarkResult(
            scenario_id=scenario.scenario_id,
            plan=Plan(steps=[]),  # raw plan dict already executed
            runner=runner_result,
            evaluator=evaluator_result,
            error_message=error_message,
        )

    async def run_benchmark(
        self,
        scenarios: "list[TradingScenario] | None" = None,
    ) -> "list[BenchmarkResult]":
        """Run the benchmark across multiple scenarios via the eliza bridge."""
        from benchmarks.HyperliquidBench.eliza_agent import (
            load_scenarios_from_tasks,
            make_coverage_scenario,
        )

        if scenarios is None:
            scenarios = load_scenarios_from_tasks(self._config.bench_root)
        if not scenarios:
            scenarios = [make_coverage_scenario()]

        await self.initialize()

        results: list[Any] = []
        for scenario in scenarios:
            logger.info("━━━ Running scenario: %s ━━━", scenario.scenario_id)
            result = await self.solve_scenario(scenario)
            results.append(result)
            if result.evaluator:
                logger.info(
                    "  Score: %.3f  (base=%.1f bonus=%.1f penalty=%.1f)",
                    result.evaluator.final_score,
                    result.evaluator.base,
                    result.evaluator.bonus,
                    result.evaluator.penalty,
                )
            elif result.error_message:
                logger.warning("  Error: %s", result.error_message)
        return results

    async def cleanup(self) -> None:
        """No-op — the ElizaServerManager (if any) handles process cleanup."""
        return None


def make_eliza_hyperliquid_planner(
    config: "HLBenchConfig | None" = None,
    client: ElizaClient | None = None,
    verbose: bool = False,
) -> ElizaHyperliquidAgent:
    """Convenience factory mirroring the existing ``ElizaHyperliquidAgent`` constructor."""
    return ElizaHyperliquidAgent(config=config, client=client, verbose=verbose)


__all__ = ["ElizaHyperliquidAgent", "make_eliza_hyperliquid_planner"]
