"""ADHDBench runner backed by the eliza benchmark server.

Mirrors the in-process Python runner (``elizaos_adhdbench.runner.ADHDBenchRunner``)
but routes every turn's "decide what action to take" call through the eliza
TypeScript benchmark server via ``ElizaClient.send_message``.

The TS bridge already loads CORE_PLUGINS server-side, which provides REPLY /
IGNORE / NONE actions and a real LLM. The Python side keeps full ownership of:
  - scenario loading / outcome evaluation
  - distractor action *names* (sent as context so the LLM can pick from them)
  - scoring + reporting

Distractors-as-handlers cannot cross the bridge — but the benchmark only
checks ``actions_selected`` (names), so we list the available distractor
names in the prompt and let the LLM pick a name. This preserves the
attention-scaling pressure (the scoring signal we care about) without
requiring the TS server to register dynamic per-test actions.
"""

from __future__ import annotations

import logging
import time
import uuid
from typing import TYPE_CHECKING

from eliza_adapter.client import ElizaClient

if TYPE_CHECKING:
    from elizaos_adhdbench.config import ADHDBenchConfig
    from elizaos_adhdbench.types import (
        BenchmarkResults,
        ScalePoint,
        Scenario,
        ScenarioResult,
        TurnResult,
    )

logger = logging.getLogger(__name__)


def _adhdbench_types():
    """Lazy import of elizaos_adhdbench types."""
    from elizaos_adhdbench.types import (
        BenchmarkResults,
        OutcomeResult,
        ScalePoint,
        Scenario,
        ScenarioResult,
        TurnResult,
    )

    return BenchmarkResults, OutcomeResult, ScalePoint, Scenario, ScenarioResult, TurnResult


def _adhdbench_helpers():
    """Lazy import of supporting modules."""
    from elizaos_adhdbench.baselines import (
        BOOTSTRAP_ACTION_NAMES,
        compute_always_reply_baseline,
        compute_random_baseline,
    )
    from elizaos_adhdbench.distractor_plugin import (
        get_distractor_plugin_actions_for_scale,
    )
    from elizaos_adhdbench.evaluator import (
        compute_scenario_score,
        evaluate_outcome,
    )
    from elizaos_adhdbench.reporting import ADHDBenchReporter
    from elizaos_adhdbench.scenarios import get_scenarios

    return {
        "BOOTSTRAP_ACTION_NAMES": BOOTSTRAP_ACTION_NAMES,
        "compute_always_reply_baseline": compute_always_reply_baseline,
        "compute_random_baseline": compute_random_baseline,
        "get_distractor_plugin_actions_for_scale": get_distractor_plugin_actions_for_scale,
        "compute_scenario_score": compute_scenario_score,
        "evaluate_outcome": evaluate_outcome,
        "ADHDBenchReporter": ADHDBenchReporter,
        "get_scenarios": get_scenarios,
    }


class ElizaADHDBenchRunner:
    """ADHDBench runner that delegates LLM decisions to the eliza TS bridge.

    Drop-in replacement for ``ADHDBenchRunner.run`` — same return type
    (``BenchmarkResults``) but the per-turn LLM call goes through
    ``ElizaClient.send_message`` instead of binding a model plugin into a
    Python AgentRuntime.
    """

    def __init__(
        self,
        config: "ADHDBenchConfig",
        client: ElizaClient | None = None,
    ) -> None:
        self.config = config
        self._client = client or ElizaClient()
        self._initialized = False

    def initialize(self) -> None:
        """Verify the eliza server is reachable."""
        if self._initialized:
            return
        self._client.wait_until_ready(timeout=120)
        self._initialized = True

    async def run(
        self,
        progress_callback: object | None = None,
    ) -> "BenchmarkResults":
        """Execute the full benchmark via the eliza bridge."""
        if not self._initialized:
            self.initialize()

        helpers = _adhdbench_helpers()
        BenchmarkResults, *_ = _adhdbench_types()

        start_time = time.time()
        all_results = []

        for config_name in self.config.config_names:
            is_full = config_name == "full"
            scenarios = helpers["get_scenarios"](
                levels=self.config.levels,
                tags=self.config.tags,
                scenario_ids=self.config.scenario_ids,
                include_memory_scenarios=is_full,
                include_planning_scenarios=is_full,
            )
            if not scenarios:
                logger.warning("No scenarios match filters for config '%s'", config_name)
                continue

            for scale_point in self.config.scale_points:
                results = await self._run_scale_point(
                    config_name=config_name,
                    scale_point=scale_point,
                    scenarios=scenarios,
                    progress_callback=progress_callback,
                )
                all_results.extend(results)

        # Baselines
        all_scenarios = helpers["get_scenarios"](
            levels=self.config.levels,
            tags=self.config.tags,
            scenario_ids=self.config.scenario_ids,
        )
        bootstrap_count = len(helpers["BOOTSTRAP_ACTION_NAMES"])
        action_pool = list(helpers["BOOTSTRAP_ACTION_NAMES"]) + [
            a.name for a in helpers["get_distractor_plugin_actions_for_scale"](50, bootstrap_count)
        ]
        random_baseline = helpers["compute_random_baseline"](all_scenarios, action_pool)
        reply_baseline = helpers["compute_always_reply_baseline"](all_scenarios)

        scaling_curves = self._build_scaling_curves(all_results)

        duration_ms = (time.time() - start_time) * 1000
        benchmark_results = BenchmarkResults(
            metadata={
                "benchmark": "ADHDBench",
                "version": "0.1.0-eliza-bridge",
                "duration_ms": duration_ms,
                "total_scenarios": len(all_results),
                "model": self.config.model_name,
                "provider": "eliza",
            },
            results=all_results,
            scaling_curves=scaling_curves,
            baselines={"random": random_baseline, "always_reply": reply_baseline},
        )

        if self.config.generate_report:
            reporter = helpers["ADHDBenchReporter"](self.config)
            reporter.generate_report(benchmark_results)

        if self.config.save_traces:
            self._save_traces(benchmark_results)

        return benchmark_results

    async def _run_scale_point(
        self,
        config_name: str,
        scale_point: "ScalePoint",
        scenarios: list["Scenario"],
        progress_callback: object | None,
    ) -> list["ScenarioResult"]:
        helpers = _adhdbench_helpers()
        bootstrap_names = list(helpers["BOOTSTRAP_ACTION_NAMES"])
        bootstrap_count = len(bootstrap_names)
        distractor_actions = helpers["get_distractor_plugin_actions_for_scale"](
            scale_point.action_count, bootstrap_count
        )
        distractor_names = [a.name for a in distractor_actions]
        all_action_names = bootstrap_names + distractor_names

        results: list[ScenarioResult] = []
        total = len(scenarios)
        for idx, scenario in enumerate(scenarios):
            logger.info("[%d/%d] %s: %s", idx + 1, total, scenario.id, scenario.name)
            result = await self._run_scenario(
                scenario=scenario,
                scale_point=scale_point,
                config_name=config_name,
                action_names=all_action_names,
            )
            results.append(result)

            if callable(progress_callback):
                progress_callback(config_name, scale_point.label, idx + 1, total)
        return results

    async def _run_scenario(
        self,
        scenario: "Scenario",
        scale_point: "ScalePoint",
        config_name: str,
        action_names: list[str],
    ) -> "ScenarioResult":
        _, OutcomeResult, _, _, ScenarioResult, TurnResult = _adhdbench_types()
        helpers = _adhdbench_helpers()

        scenario_start = time.time()
        task_id = f"adhdbench-{config_name}-{scale_point.label}-{scenario.id}"

        # Reset bench session per scenario
        try:
            self._client.reset(task_id=task_id, benchmark="adhdbench")
        except Exception as exc:
            logger.debug("Eliza reset failed (continuing): %s", exc)

        turn_results: list[TurnResult] = []
        error: str | None = None

        # Track conversation history Python-side so each prompt has context.
        history: list[dict[str, str]] = []

        for turn_idx, turn in enumerate(scenario.turns):
            if turn.role == "system":
                # System turns just inject context — record them in history.
                history.append({"role": "system", "text": turn.text})
                turn_results.append(
                    TurnResult(
                        turn_index=turn_idx,
                        actions_selected=[],
                        providers_requested=[],
                        response_text="",
                        providers_actually_run=[],
                        outcome_results=[],
                        latency_ms=0.0,
                    )
                )
                continue

            history.append({"role": "user", "text": turn.text})
            turn_start = time.time()

            try:
                turn_result = await self._execute_turn(
                    turn_text=turn.text,
                    turn_idx=turn_idx,
                    task_id=task_id,
                    action_names=action_names,
                    scenario_name=scenario.name,
                    history=history,
                )
            except Exception as exc:
                error = f"Turn {turn_idx} raised {type(exc).__name__}: {exc}"
                logger.error("%s turn %d failed: %s", scenario.id, turn_idx, exc)
                turn_result = TurnResult(
                    turn_index=turn_idx,
                    actions_selected=[],
                    providers_requested=[],
                    response_text="",
                    providers_actually_run=[],
                    outcome_results=[],
                    latency_ms=0.0,
                )
                if turn.expected_outcomes:
                    turn_result.outcome_results = [
                        OutcomeResult(
                            outcome=o, passed=False, actual_value="",
                            detail=f"Turn failed: {exc}",
                        )
                        for o in turn.expected_outcomes
                    ]
                turn_results.append(turn_result)
                break

            turn_result.latency_ms = (time.time() - turn_start) * 1000
            history.append({"role": "assistant", "text": turn_result.response_text})

            if turn.expected_outcomes:
                turn_result.outcome_results = [
                    helpers["evaluate_outcome"](o, turn_result)
                    for o in turn.expected_outcomes
                ]
            turn_results.append(turn_result)

        # The eliza-bridge path can populate providers_requested from a
        # real runtime, so PROVIDERS_REQUESTED outcomes are scoreable here.
        score = helpers["compute_scenario_score"](turn_results, has_runtime_signal=True)
        total_latency = (time.time() - scenario_start) * 1000
        logger.info("    -> score=%.1f%%, %d turns, %.0fms", score * 100, len(turn_results), total_latency)

        return ScenarioResult(
            scenario_id=scenario.id,
            scenario_name=scenario.name,
            level=scenario.level,
            scale_point=scale_point,
            config_name=config_name,
            turn_results=turn_results,
            score=score,
            total_latency_ms=total_latency,
            model_name=self.config.model_name,
            error=error,
        )

    async def _execute_turn(
        self,
        turn_text: str,
        turn_idx: int,
        task_id: str,
        action_names: list[str],
        scenario_name: str,
        history: list[dict[str, str]],
    ) -> "TurnResult":
        _, _, _, _, _, TurnResult = _adhdbench_types()

        # Build the prompt: list every available action so the LLM has to pick
        # the correct one against semantic-distractor pressure.
        action_menu = "\n".join(f"- {name}" for name in action_names)
        history_text = "\n".join(
            f"[{h['role']}] {h['text']}" for h in history[-10:]
        )

        prompt = (
            f"You are an agent being benchmarked on attention/distraction handling.\n\n"
            f"Scenario: {scenario_name}\n\n"
            f"Available actions (pick the most semantically appropriate one(s)):\n"
            f"{action_menu}\n\n"
            f"Conversation so far:\n{history_text}\n\n"
            f"Current user message: {turn_text}\n\n"
            f"Respond with the selected action(s) in the standard XML format. "
            f"Use <actions>NAME[,NAME2]</actions> and provide a <text> response."
        )

        response = self._client.send_message(
            text=prompt,
            context={
                "benchmark": "adhdbench",
                "task_id": task_id,
                "available_actions": action_names,
                "turn_index": turn_idx,
            },
        )

        actions_selected = [str(a).upper() for a in response.actions if isinstance(a, str)]
        # Filter against the menu — drop bridge-internal actions like REPLY if the
        # benchmark's bootstrap menu also includes REPLY (it does).
        valid_set = {n.upper() for n in action_names} | {"REPLY", "IGNORE", "NONE"}

        # The bridge sometimes returns ["BENCHMARK_ACTION"] when the LLM emitted
        # `<actions>BENCHMARK_ACTION</actions>` with `<command>REAL_ACTION</command>`,
        # or ["REPLY"] with the real action buried inside the XML body. Recover
        # the intended real action by inspecting the raw text + params.
        import re as _re
        raw_text = response.text or ""
        nested_actions: list[str] = []
        # 1. Pull from response.params nested BENCHMARK_ACTION block
        bench_params = response.params.get("BENCHMARK_ACTION") if isinstance(response.params, dict) else None
        if isinstance(bench_params, dict):
            cmd = bench_params.get("command") or bench_params.get("action")
            if isinstance(cmd, str) and cmd.strip():
                nested_actions.append(cmd.strip().upper())
        # 2. Pull from XML <command> tags inside the body (any depth)
        for m in _re.finditer(r"<command>\s*([A-Z][A-Z0-9_]*)\s*</command>", raw_text, _re.IGNORECASE):
            nested_actions.append(m.group(1).upper())
        # 3. Pull from <actions>NAME[,NAME2]</actions> directly
        ax = _re.search(r"<actions>\s*([^<]+)\s*</actions>", raw_text, _re.IGNORECASE)
        if ax:
            for tok in ax.group(1).split(","):
                tok = tok.strip().upper()
                if tok:
                    nested_actions.append(tok)

        # If the bridge's actions list is empty/REPLY-only/BENCHMARK_ACTION, prefer
        # the recovered nested action name when it matches a real menu entry.
        recovered = [a for a in nested_actions if a in valid_set and a != "REPLY"]
        if recovered:
            # Replace generic REPLY/BENCHMARK_ACTION with the recovered intent.
            generic = {"REPLY", "BENCHMARK_ACTION"}
            if not actions_selected or all(a in generic for a in actions_selected):
                actions_selected = recovered
            else:
                # Merge: keep validated bridge actions, append recovered if not present.
                for a in recovered:
                    if a not in actions_selected:
                        actions_selected.append(a)

        actions_selected = [a for a in actions_selected if a in valid_set]

        return TurnResult(
            turn_index=turn_idx,
            actions_selected=actions_selected,
            providers_requested=[],
            response_text=response.text or "",
            providers_actually_run=[],
            outcome_results=[],
            latency_ms=0.0,
            raw_llm_response=response.text or "",
            thought=response.thought or "",
        )

    def _build_scaling_curves(
        self,
        results: list["ScenarioResult"],
    ) -> dict[str, list[object]]:
        """Aggregate results into per-config scaling curves (label -> point list)."""
        from elizaos_adhdbench.types import ScalingCurvePoint

        curves: dict[str, list[ScalingCurvePoint]] = {}
        groups: dict[tuple[str, str], list] = {}
        for r in results:
            key = (r.config_name, r.scale_point.label)
            groups.setdefault(key, []).append(r)

        config_names = sorted({r.config_name for r in results})
        for config_name in config_names:
            points: list[ScalingCurvePoint] = []
            for sp in self.config.scale_points:
                key = (config_name, sp.label)
                group = groups.get(key, [])
                if not group:
                    continue
                avg_score = sum(r.score for r in group) / len(group)
                avg_latency = sum(r.total_latency_ms for r in group) / len(group)
                points.append(
                    ScalingCurvePoint(
                        scale_label=sp.label,
                        action_count=sp.action_count,
                        provider_count=sp.provider_count,
                        conversation_prefill=sp.conversation_prefill,
                        score=avg_score,
                        latency_ms=avg_latency,
                        scenario_count=len(group),
                    )
                )
            curves[config_name] = points
        return curves

    def _save_traces(self, results: "BenchmarkResults") -> None:
        """Save trace JSON to the configured output directory."""
        import json
        from pathlib import Path

        output_dir = Path(self.config.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        trace_data = {
            "metadata": results.metadata,
            "baselines": results.baselines,
            "timestamp": results.timestamp,
            "results": [
                {
                    "scenario_id": sr.scenario_id,
                    "scenario_name": sr.scenario_name,
                    "level": sr.level.name,
                    "scale_point": sr.scale_point.label,
                    "config_name": sr.config_name,
                    "score": sr.score,
                    "total_latency_ms": sr.total_latency_ms,
                    "model_name": sr.model_name,
                    "error": sr.error,
                    "turns": [
                        {
                            "turn_index": tr.turn_index,
                            "actions_selected": tr.actions_selected,
                            "response_text": (tr.response_text or "")[:500],
                            "latency_ms": tr.latency_ms,
                            "thought": (tr.thought or "")[:300],
                            "outcomes": [
                                {
                                    "type": o.outcome.outcome_type.value,
                                    "expected": str(o.outcome.value),
                                    "passed": o.passed,
                                    "actual": (o.actual_value or "")[:200],
                                    "detail": (o.detail or "")[:300],
                                }
                                for o in tr.outcome_results
                            ],
                        }
                        for tr in sr.turn_results
                    ],
                }
                for sr in results.results
            ],
        }
        trace_path = output_dir / f"adhdbench_traces_{results.timestamp.replace(':', '-')}.json"
        with open(trace_path, "w") as f:
            json.dump(trace_data, f, indent=2, default=str)
        logger.info("Traces saved to %s", trace_path)
