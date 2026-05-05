"""In-process HyperliquidBench agent wiring.

This module keeps the default benchmark path self-contained and safe: it
generates a deterministic demo plan, executes it through ``hl-runner`` in
``--demo`` mode, and scores the resulting ``per_action.jsonl`` with
``hl-evaluator``. Live network execution is only reached when the caller
explicitly disables demo mode in the CLI.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Any

from .types import (
    BenchmarkResult,
    CancelAllStep,
    CancelLastStep,
    EvaluatorResult,
    HLBenchConfig,
    OrderSide,
    PerpOrder,
    PerpOrdersStep,
    PerpTif,
    Plan,
    RunnerResult,
    ScenarioKind,
    SetLeverageStep,
    TradingScenario,
    UsdClassTransferStep,
)


logger = logging.getLogger(__name__)


def make_coverage_scenario(
    allowed_coins: list[str] | None = None,
    max_steps: int = 5,
    builder_code: str | None = None,
) -> TradingScenario:
    coins = [coin.strip().upper() for coin in (allowed_coins or ["ETH", "BTC"]) if coin.strip()]
    if not coins:
        coins = ["ETH"]
    return TradingScenario(
        scenario_id="coverage_smoke",
        kind=ScenarioKind.COVERAGE,
        description=(
            "Generate a safe demo-mode Hyperliquid plan that covers perp orders, "
            "cancels, USD class transfers, and leverage actions."
        ),
        allowed_coins=coins,
        max_steps=max(1, int(max_steps)),
        builder_code=builder_code,
    )


def load_scenarios_from_tasks(
    bench_root: Path,
    task_files: list[str] | None = None,
) -> list[TradingScenario]:
    """Load JSON/JSONL task scenarios when present.

    The current checked-in dataset only contains the HiaN fixture, so missing
    task files simply produce no scenarios and the CLI falls back to coverage.
    """
    tasks_dir = bench_root / "dataset" / "tasks"
    if not task_files:
        task_files = [path.name for path in sorted(tasks_dir.glob("*.jsonl"))] if tasks_dir.exists() else []

    scenarios: list[TradingScenario] = []
    for task_file in task_files:
        path = Path(task_file)
        if not path.is_absolute():
            path = tasks_dir / path
        if not path.exists():
            raise FileNotFoundError(f"HyperliquidBench task file not found: {path}")
        with path.open("r", encoding="utf-8") as handle:
            for line_no, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                data = json.loads(line)
                if not isinstance(data, dict):
                    continue
                coins_raw = data.get("allowed_coins") or data.get("coins") or ["ETH", "BTC"]
                coins = [str(coin).upper() for coin in coins_raw] if isinstance(coins_raw, list) else ["ETH", "BTC"]
                scenarios.append(
                    TradingScenario(
                        scenario_id=str(data.get("id") or data.get("scenario_id") or f"{path.stem}_{line_no}"),
                        kind=ScenarioKind(str(data.get("kind", ScenarioKind.CUSTOM.value))),
                        description=str(data.get("description") or data.get("prompt") or "HyperliquidBench task"),
                        allowed_coins=coins,
                        max_steps=int(data.get("max_steps") or 5),
                        builder_code=data.get("builder_code") if isinstance(data.get("builder_code"), str) else None,
                        plan_spec=f"{path}:{line_no}",
                    )
                )
    return scenarios


def _deterministic_plan(scenario: TradingScenario) -> Plan:
    coin = scenario.allowed_coins[0] if scenario.allowed_coins else "ETH"
    second = scenario.allowed_coins[1] if len(scenario.allowed_coins) > 1 else coin
    steps = [
        PerpOrdersStep(
            orders=[
                PerpOrder(coin=coin, side=OrderSide.BUY, sz=0.01, px="mid-1%", tif=PerpTif.ALO),
                PerpOrder(coin=second, side=OrderSide.SELL, sz=0.01, px="mid+1%", tif=PerpTif.IOC, reduce_only=True),
            ],
            builder_code=scenario.builder_code,
        ),
        CancelLastStep(coin=coin),
        UsdClassTransferStep(to_perp=True, usdc=5.0),
        SetLeverageStep(coin=coin, leverage=3, cross=False),
        CancelAllStep(coin=second),
    ]
    return Plan(steps=steps[: max(1, scenario.max_steps)])


def _binary_or_cargo(bench_root: Path, package: str) -> list[str]:
    binary = bench_root / "target" / "release" / package
    if binary.exists() and os.access(binary, os.X_OK):
        return [str(binary)]
    cargo = shutil.which("cargo")
    if cargo:
        return [cargo, "run", "-q", "-p", package, "--"]
    raise FileNotFoundError(f"could not find {package} binary and cargo is unavailable")


def _read_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


class ElizaHyperliquidAgent:
    """Default safe HyperliquidBench agent."""

    def __init__(self, config: HLBenchConfig | None = None, verbose: bool = False) -> None:
        self.config = config or HLBenchConfig()
        self.verbose = verbose or self.config.verbose

    async def run_benchmark(self, scenarios: list[TradingScenario] | None = None) -> list[BenchmarkResult]:
        if scenarios is None:
            scenarios = load_scenarios_from_tasks(self.config.bench_root)
        if not scenarios:
            scenarios = [make_coverage_scenario()]

        results: list[BenchmarkResult] = []
        for scenario in scenarios:
            results.append(await self.solve_scenario(scenario))
        return results

    async def solve_scenario(self, scenario: TradingScenario) -> BenchmarkResult:
        return await asyncio.to_thread(self._solve_scenario_sync, scenario)

    def _solve_scenario_sync(self, scenario: TradingScenario) -> BenchmarkResult:
        bench_root = self.config.bench_root.resolve()
        plan = _deterministic_plan(scenario)
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        safe_id = "".join(ch if ch.isalnum() or ch in "._-" else "-" for ch in scenario.scenario_id)
        out_dir = bench_root / self.config.runs_dir / f"python-{safe_id}-{timestamp}"
        out_dir.mkdir(parents=True, exist_ok=True)
        plan_path = out_dir / "plan_input.json"
        plan_path.write_text(json.dumps(plan.to_dict(), indent=2), encoding="utf-8")

        runner_cmd = [
            *_binary_or_cargo(bench_root, "hl-runner"),
            "--plan",
            str(plan_path),
            "--out",
            str(out_dir),
            "--network",
            self.config.network,
            "--effect-timeout-ms",
            str(self.config.effect_timeout_ms),
        ]
        if self.config.demo_mode:
            runner_cmd.append("--demo")
        if self.config.builder_code:
            runner_cmd.extend(["--builder-code", self.config.builder_code])

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
            return BenchmarkResult(scenario.scenario_id, plan, runner, None, runner.stderr or runner.stdout)

        evaluator_cmd = [
            *_binary_or_cargo(bench_root, "hl-evaluator"),
            "--input",
            str(out_dir / "per_action.jsonl"),
            "--domains",
            str(bench_root / self.config.domains_file),
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
        logger.info("Scenario %s wrote artifacts to %s", scenario.scenario_id, out_dir)
        return BenchmarkResult(scenario.scenario_id, plan, runner, evaluator, error)

    async def cleanup(self) -> None:
        return None


__all__ = ["ElizaHyperliquidAgent", "load_scenarios_from_tasks", "make_coverage_scenario"]
