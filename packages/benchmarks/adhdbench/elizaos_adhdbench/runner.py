"""Benchmark runner: orchestrates scenario execution across scale points."""

from __future__ import annotations

import asyncio
import itertools
import json
import logging
import time
import uuid
from pathlib import Path

from elizaos.runtime import AgentRuntime
from elizaos.types.memory import Memory
from elizaos.types.primitives import Content, as_uuid

from elizaos_adhdbench.baselines import (
    BOOTSTRAP_ACTION_NAMES,
    compute_always_reply_baseline,
    compute_random_baseline,
)
from elizaos_adhdbench.config import ADHDBenchConfig
from elizaos_adhdbench.distractor_plugin import get_distractor_plugin_actions_for_scale
from elizaos_adhdbench.evaluator import (
    compute_scenario_score,
    evaluate_outcome,
)
from elizaos_adhdbench.reporting import ADHDBenchReporter
from elizaos_adhdbench.runtime_wrapper import (
    InstrumentedCapture,
    create_benchmark_runtime,
    initialize_benchmark_runtime,
    prefill_conversation,
)
from elizaos_adhdbench.scenarios import get_scenarios
from elizaos_adhdbench.types import (
    BenchmarkResults,
    ScalingCurvePoint,
    Scenario,
    ScenarioResult,
    TurnResult,
)

logger = logging.getLogger("adhdbench")


class ADHDBenchRunner:
    """Main benchmark orchestrator."""

    def __init__(self, config: ADHDBenchConfig) -> None:
        self.config = config

    async def run(
        self,
        progress_callback: object | None = None,
    ) -> BenchmarkResults:
        """Execute the full benchmark and return results."""
        start_time = time.time()

        all_results: list[ScenarioResult] = []

        for config_name in self.config.config_names:
            is_full = config_name == "full"
            scenarios = get_scenarios(
                levels=self.config.levels,
                tags=self.config.tags,
                scenario_ids=self.config.scenario_ids,
                include_memory_scenarios=is_full,
                include_planning_scenarios=is_full,
            )

            if not scenarios:
                logger.warning(f"No scenarios match filters for config '{config_name}'")
                continue

            for scale_point in self.config.scale_points:
                results = await self._run_scale_point(
                    config_name=config_name,
                    scale_point=scale_point,
                    scenarios=scenarios,
                    progress_callback=progress_callback,
                )
                all_results.extend(results)

        # Compute baselines
        all_scenarios = get_scenarios(levels=self.config.levels, tags=self.config.tags, scenario_ids=self.config.scenario_ids)
        action_pool = BOOTSTRAP_ACTION_NAMES + [
            a.name for a in get_distractor_plugin_actions_for_scale(50, len(BOOTSTRAP_ACTION_NAMES))
        ]
        random_baseline = compute_random_baseline(all_scenarios, action_pool)
        reply_baseline = compute_always_reply_baseline(all_scenarios)

        # Build scaling curves
        scaling_curves = self._build_scaling_curves(all_results)

        duration_ms = (time.time() - start_time) * 1000
        benchmark_results = BenchmarkResults(
            metadata={
                "benchmark": "ADHDBench",
                "version": "0.1.0",
                "duration_ms": duration_ms,
                "total_scenarios": len(all_results),
                "model": self.config.model_name,
                "provider": self.config.model_provider,
            },
            results=all_results,
            scaling_curves=scaling_curves,
            baselines={
                "random": random_baseline,
                "always_reply": reply_baseline,
            },
        )

        # Generate report
        if self.config.generate_report:
            reporter = ADHDBenchReporter(self.config)
            reporter.generate_report(benchmark_results)

        # Save traces
        if self.config.save_traces:
            self._save_traces(benchmark_results)

        return benchmark_results

    async def _run_scale_point(
        self,
        config_name: str,
        scale_point: ScalePoint,
        scenarios: list[Scenario],
        progress_callback: object | None,
    ) -> list[ScenarioResult]:
        """Run all scenarios at one scale point with one config."""
        logger.info(
            f"Running config={config_name} scale={scale_point.label} "
            f"({len(scenarios)} scenarios)"
        )

        # Create and initialize runtime
        runtime, capture = create_benchmark_runtime(self.config, config_name)
        bootstrap_action_count = 0

        distractors = get_distractor_plugin_actions_for_scale(
            scale_point.action_count, 21  # ~21 bootstrap actions
        )
        await initialize_benchmark_runtime(runtime, capture, distractors)
        bootstrap_action_count = len(runtime.actions) - len(distractors)

        results: list[ScenarioResult] = []
        total = len(scenarios)

        for idx, scenario in enumerate(scenarios):
            logger.info(
                f"  [{idx + 1}/{total}] {scenario.id}: {scenario.name}"
            )
            result = await self._run_scenario(
                runtime=runtime,
                capture=capture,
                scenario=scenario,
                scale_point=scale_point,
                config_name=config_name,
            )
            results.append(result)

            if callable(progress_callback):
                progress_callback(config_name, scale_point.label, idx + 1, total)

        return results

    async def _run_scenario(
        self,
        runtime: AgentRuntime,
        capture: InstrumentedCapture,
        scenario: Scenario,
        scale_point: ScalePoint,
        config_name: str,
    ) -> ScenarioResult:
        """Execute a single scenario and return the result."""
        scenario_start = time.time()

        # Clear state cache between scenarios to prevent cross-contamination
        runtime._state_cache.clear()

        # Generate stable IDs for this scenario run
        entity_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"adhdbench-user-{scenario.id}"))
        room_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"adhdbench-room-{scenario.id}"))

        # Pre-fill conversation history
        if scale_point.conversation_prefill > 0:
            prefill_msgs = list(
                itertools.islice(
                    itertools.cycle(self.config.prefill_topic_pool),
                    scale_point.conversation_prefill,
                )
            )
            await prefill_conversation(runtime, room_id, entity_id, prefill_msgs)

        turn_results: list[TurnResult] = []
        error: str | None = None

        for turn_idx, turn in enumerate(scenario.turns):
            if turn.new_session:
                room_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"adhdbench-room-{scenario.id}-session-{turn_idx}"))

            if turn.delay_seconds > 0:
                await asyncio.sleep(turn.delay_seconds)

            capture.reset()
            turn_start = time.time()

            turn_result: TurnResult
            try:
                turn_result = await self._execute_turn(
                    runtime=runtime,
                    capture=capture,
                    turn_text=turn.text,
                    turn_role=turn.role,
                    turn_idx=turn_idx,
                    entity_id=entity_id,
                    room_id=room_id,
                )
            except Exception as exc:
                error = f"Turn {turn_idx} raised {type(exc).__name__}: {exc}"
                logger.error(f"  {scenario.id} turn {turn_idx} failed: {exc}")
                turn_result = TurnResult(
                    turn_index=turn_idx, actions_selected=[], providers_requested=[],
                    response_text="", providers_actually_run=[], outcome_results=[],
                    latency_ms=0.0,
                )
                # All remaining outcomes fail
                if turn.expected_outcomes:
                    from elizaos_adhdbench.types import OutcomeResult
                    turn_result.outcome_results = [
                        OutcomeResult(outcome=o, passed=False, actual_value="",
                                      detail=f"Turn failed: {exc}")
                        for o in turn.expected_outcomes
                    ]
                turn_results.append(turn_result)
                break  # Stop scenario on first error

            turn_result.latency_ms = (time.time() - turn_start) * 1000

            if turn.expected_outcomes:
                turn_result.outcome_results = [
                    evaluate_outcome(o, turn_result)
                    for o in turn.expected_outcomes
                ]

            if turn.expected_outcomes:
                passed = sum(1 for o in turn_result.outcome_results if o.passed)
                total = len(turn_result.outcome_results)
                logger.debug(
                    f"    turn {turn_idx}: {passed}/{total} outcomes passed, "
                    f"actions={turn_result.actions_selected}, {turn_result.latency_ms:.0f}ms"
                )

            turn_results.append(turn_result)

        score = compute_scenario_score(turn_results)
        total_latency = (time.time() - scenario_start) * 1000

        logger.info(f"    -> score={score:.1%}, {len(turn_results)} turns, {total_latency:.0f}ms")

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
        runtime: AgentRuntime,
        capture: InstrumentedCapture,
        turn_text: str,
        turn_role: str,
        turn_idx: int,
        entity_id: str,
        room_id: str,
    ) -> TurnResult:
        """Execute a single turn and capture the results."""

        # Create the message Memory with trajectory step ID for instrumentation.
        # Following the canonical pattern from elizaos_atropos_shared:
        # assign a MessageMetadata with trajectory_step_id directly to
        # Memory.metadata.  The runtime reads it via
        # getattr(message.metadata, "trajectoryStepId", None).
        message = Memory(
            id=as_uuid(str(uuid.uuid4())),
            entity_id=as_uuid(entity_id),
            room_id=as_uuid(room_id),
            content=Content(text=turn_text),
        )

        # If this is a system turn (context injection), just save to memory
        if turn_role == "system":
            await runtime.create_memory(message, "messages")
            return TurnResult(
                turn_index=turn_idx,
                actions_selected=[],
                providers_requested=[],
                response_text="",
                providers_actually_run=[],
                outcome_results=[],
                latency_ms=0.0,
            )

        # Process through the message service
        result = await runtime.message_service.handle_message(
            runtime, message, None
        )

        # Extract data from the processing result
        actions_selected: list[str] = []
        response_text = ""
        providers_requested: list[str] = []
        raw_llm_response = ""
        thought = ""

        if result.response_content is not None:
            response_text = result.response_content.text or ""
            if result.response_content.actions:
                actions_selected = [
                    str(a) for a in result.response_content.actions
                    if isinstance(a, str)
                ]

        # Extract providers from instrumented capture
        providers_actually_run = list(capture.capture.providers_run)

        return TurnResult(
            turn_index=turn_idx,
            actions_selected=actions_selected,
            providers_requested=providers_requested,
            response_text=response_text,
            providers_actually_run=providers_actually_run,
            outcome_results=[],
            latency_ms=0.0,
            raw_llm_response=raw_llm_response,
            thought=thought,
        )

    def _build_scaling_curves(
        self,
        results: list[ScenarioResult],
    ) -> dict[str, list[ScalingCurvePoint]]:
        """Aggregate results into scaling curves keyed by config name."""
        curves: dict[str, list[ScalingCurvePoint]] = {}

        # Group by (config_name, scale_point)
        groups: dict[tuple[str, str], list[ScenarioResult]] = {}
        for r in results:
            key = (r.config_name, r.scale_point.label)
            groups.setdefault(key, []).append(r)

        config_names = sorted(set(r.config_name for r in results))
        for config_name in config_names:
            points: list[ScalingCurvePoint] = []
            for sp in self.config.scale_points:
                key = (config_name, sp.label)
                group = groups.get(key, [])
                if not group:
                    continue
                avg_score = sum(r.score for r in group) / len(group)
                avg_latency = sum(r.total_latency_ms for r in group) / len(group)
                points.append(ScalingCurvePoint(
                    scale_label=sp.label,
                    action_count=sp.action_count,
                    provider_count=sp.provider_count,
                    conversation_prefill=sp.conversation_prefill,
                    score=avg_score,
                    latency_ms=avg_latency,
                    scenario_count=len(group),
                ))
            curves[config_name] = points

        return curves

    def _save_traces(self, results: BenchmarkResults) -> None:
        """Save full trace data to JSON for debugging."""
        output_dir = Path(self.config.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        trace_data = {
            "metadata": results.metadata,
            "baselines": results.baselines,
            "timestamp": results.timestamp,
            "results": [],
        }
        for sr in results.results:
            scenario_trace: dict[str, object] = {
                "scenario_id": sr.scenario_id,
                "scenario_name": sr.scenario_name,
                "level": sr.level.name,
                "scale_point": sr.scale_point.label,
                "config_name": sr.config_name,
                "score": sr.score,
                "total_latency_ms": sr.total_latency_ms,
                "model_name": sr.model_name,
                "error": sr.error,
                "turns": [],
            }
            for tr in sr.turn_results:
                turn_trace: dict[str, object] = {
                    "turn_index": tr.turn_index,
                    "actions_selected": tr.actions_selected,
                    "providers_requested": tr.providers_requested,
                    "response_text": tr.response_text[:500],
                    "providers_actually_run": tr.providers_actually_run,
                    "latency_ms": tr.latency_ms,
                    "thought": tr.thought[:300],
                    "outcomes": [
                        {
                            "type": o.outcome.outcome_type.value,
                            "expected": str(o.outcome.value),
                            "passed": o.passed,
                            "actual": o.actual_value[:200],
                            "detail": o.detail[:300],
                        }
                        for o in tr.outcome_results
                    ],
                }
                scenario_trace["turns"].append(turn_trace)  # type: ignore[union-attr]
            trace_data["results"].append(scenario_trace)  # type: ignore[union-attr]

        trace_path = output_dir / f"adhdbench_traces_{results.timestamp.replace(':', '-')}.json"
        with open(trace_path, "w") as f:
            json.dump(trace_data, f, indent=2, default=str)
        logger.info(f"Traces saved to {trace_path}")
