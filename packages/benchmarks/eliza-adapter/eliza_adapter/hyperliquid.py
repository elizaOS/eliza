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
import os
import re
import subprocess
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

    decoder = json.JSONDecoder()
    parsed: Any | None = None
    last_error: Exception | None = None
    for match in re.finditer(r"[{[]", candidate):
        try:
            value, _end = decoder.raw_decode(candidate[match.start() :])
        except json.JSONDecodeError as exc:
            last_error = exc
            continue
        if isinstance(value, dict):
            parsed = value
            break
        if isinstance(value, list):
            parsed = {"steps": value}
            break
    if parsed is None:
        if last_error is not None:
            raise last_error
        raise ValueError("No JSON object found in LLM response")
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
        from benchmarks.HyperliquidBench.types import BenchmarkResult, Plan

        # Reset the bridge session for this scenario.
        await asyncio.to_thread(
            self._client.reset,
            scenario.scenario_id,
            "hyperliquid_bench",
        )

        best_result: "BenchmarkResult | None" = None
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

            # 3) Hand off to the Rust runner/evaluator path used by the
            # deterministic smoke agent, but with the bridge-generated plan.
            result = await asyncio.to_thread(
                self._execute_plan_dict_sync,
                scenario,
                plan_dict,
            )

            if not result.runner.success:
                last_error = result.error_message or result.runner.stderr or result.runner.stdout
                logger.warning("hl-runner failed: %s", last_error)
                last_feedback = (
                    f"Previous plan failed to execute: {last_error}. "
                    "Adjust the plan and try again."
                )
                continue

            best_result = result
            if best_result.evaluator is not None:
                found = best_result.evaluator.unique_signatures
                score = best_result.evaluator.final_score
                last_feedback = (
                    f"Score: {score}. Found {len(found)} signatures: {found}. "
                    "To IMPROVE: vary buy/sell, reduceOnly true/false, "
                    "all TIFs (GTC/ALO/IOC), transfer toPerp AND toSpot, "
                    "set leverage on ALL allowed coins. "
                    "Generate a DIFFERENT plan with MORE diverse actions."
                )

        if best_result:
            return best_result

        return BenchmarkResult(
            scenario_id=scenario.scenario_id,
            plan=Plan(steps=[]),  # raw plan dict already executed
            runner=self._empty_runner_result(),
            evaluator=None,
            error_message=last_error or "No plan was successfully executed",
        )

    def _empty_runner_result(self):
        from benchmarks.HyperliquidBench.types import RunnerResult

        return RunnerResult(
            success=False,
            out_dir="",
            run_meta_path="",
            per_action_path="",
            stdout="",
            stderr="",
            exit_code=-1,
        )

    def _execute_plan_dict_sync(
        self,
        scenario: "TradingScenario",
        plan_dict: dict[str, Any],
    ):
        from benchmarks.HyperliquidBench.eliza_agent import _binary_or_cargo, _read_json
        from benchmarks.HyperliquidBench.types import (
            BenchmarkResult,
            EvaluatorResult,
            Plan,
            RunnerResult,
        )

        bench_root = self._config.bench_root.resolve()
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        safe_id = "".join(
            ch if ch.isalnum() or ch in "._-" else "-"
            for ch in scenario.scenario_id
        )
        out_dir = bench_root / self._config.runs_dir / f"eliza-bridge-{safe_id}-{timestamp}"
        out_dir.mkdir(parents=True, exist_ok=True)
        plan_path = out_dir / "plan_input.json"
        plan_path.write_text(json.dumps(plan_dict, indent=2), encoding="utf-8")

        runner_cmd = [
            *_binary_or_cargo(bench_root, "hl-runner"),
            "--plan",
            str(plan_path),
            "--out",
            str(out_dir),
            "--network",
            self._config.network,
            "--effect-timeout-ms",
            str(self._config.effect_timeout_ms),
        ]
        if self._config.demo_mode:
            runner_cmd.append("--demo")
        if self._config.builder_code:
            runner_cmd.extend(["--builder-code", self._config.builder_code])

        env = os.environ.copy()
        runner_proc = subprocess.run(
            runner_cmd,
            cwd=bench_root,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
            env=env,
        )
        runner = RunnerResult(
            success=runner_proc.returncode == 0,
            out_dir=str(out_dir),
            run_meta_path=str(out_dir / "run_meta.json"),
            per_action_path=str(out_dir / "per_action.jsonl"),
            stdout=runner_proc.stdout,
            stderr=runner_proc.stderr,
            exit_code=runner_proc.returncode,
        )
        if not runner.success:
            return BenchmarkResult(
                scenario.scenario_id,
                Plan(steps=[]),
                runner,
                None,
                runner.stderr or runner.stdout,
            )

        evaluator_cmd = [
            *_binary_or_cargo(bench_root, "hl-evaluator"),
            "--input",
            str(out_dir / "per_action.jsonl"),
            "--domains",
            str(bench_root / self._config.domains_file),
            "--out-dir",
            str(out_dir),
        ]
        evaluator_proc = subprocess.run(
            evaluator_cmd,
            cwd=bench_root,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
            env=env,
        )
        score_path = out_dir / "eval_score.json"
        score = _read_json(score_path) if score_path.exists() else {}
        evaluator = EvaluatorResult(
            success=evaluator_proc.returncode == 0 and bool(score),
            final_score=float(score.get("finalScore", 0.0)),
            base=float(score.get("base", 0.0)),
            bonus=float(score.get("bonus", 0.0)),
            penalty=float(score.get("penalty", 0.0)),
            unique_signatures=list(score.get("uniqueSignatures", [])),
            eval_score_path=str(score_path),
            stdout=evaluator_proc.stdout,
            stderr=evaluator_proc.stderr,
            exit_code=evaluator_proc.returncode,
        )
        error = None if evaluator.success else (evaluator.stderr or evaluator.stdout or "evaluation failed")
        return BenchmarkResult(scenario.scenario_id, Plan(steps=[]), runner, evaluator, error)

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
