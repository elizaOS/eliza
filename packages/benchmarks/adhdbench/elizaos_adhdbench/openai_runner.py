"""OpenAI-compatible runner for ADHDBench.

Mirrors the in-process Python runner but routes every per-turn "decide what
action to take" call through an OpenAI-compatible chat completions endpoint
(OpenAI, Cerebras, Groq, OpenRouter, vLLM, ...). Scoring, scenario loading,
and reporting all stay in Python so the same evaluators apply across
providers.

The previous mock runner was deterministic by construction: it generated
responses by concatenating the scenario's expected outcome values, which
trivially passes every evaluator and produces 100% scores in ~1ms. That is
a benchmark in name only. This runner actually exercises the LLM and
records real trajectories so scaling curves are meaningful.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import logging
import os
import time
from collections.abc import Callable
from dataclasses import dataclass

from elizaos_adhdbench.baselines import (
    BOOTSTRAP_ACTION_NAMES,
    compute_always_reply_baseline,
    compute_random_baseline,
)
from elizaos_adhdbench.config import ADHDBenchConfig
from elizaos_adhdbench.distractor_plugin import get_distractor_plugin_actions_for_scale
from elizaos_adhdbench.evaluator import compute_scenario_score, evaluate_outcome
from elizaos_adhdbench.reporting import ADHDBenchReporter
from elizaos_adhdbench.scenarios import get_scenarios
from elizaos_adhdbench.types import (
    BenchmarkResults,
    ScalePoint,
    ScalingCurvePoint,
    Scenario,
    ScenarioResult,
    Turn,
    TurnResult,
)

ProgressCallback = Callable[[str, str, int, int], None]

logger = logging.getLogger("adhdbench.openai_runner")


OPENAI_COMPAT_BASE_URLS: dict[str, str] = {
    "openai": "https://api.openai.com/v1",
    "groq": "https://api.groq.com/openai/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "cerebras": "https://api.cerebras.ai/v1",
    "vllm": "http://127.0.0.1:8001/v1",
}

PROVIDER_API_KEY_ENV: dict[str, str] = {
    "openai": "OPENAI_API_KEY",
    "groq": "GROQ_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "cerebras": "CEREBRAS_API_KEY",
    "vllm": "OPENAI_API_KEY",
}


def is_openai_compatible_provider(provider: str) -> bool:
    return provider.strip().lower() in OPENAI_COMPAT_BASE_URLS


@dataclass
class _LLMResponse:
    text: str
    actions: list[str]
    raw: str
    prompt_tokens: int
    completion_tokens: int


def _make_client(provider: str):
    from openai import OpenAI  # local import so the mock runner stays import-free

    provider = provider.strip().lower()
    base_url = (
        os.environ.get("OPENAI_BASE_URL")
        or OPENAI_COMPAT_BASE_URLS.get(provider)
    )
    if not base_url:
        raise SystemExit(f"--base-url required for provider {provider!r}")
    api_key_env = PROVIDER_API_KEY_ENV.get(provider, "OPENAI_API_KEY")
    api_key = os.environ.get(api_key_env) or os.environ.get("OPENAI_API_KEY", "EMPTY")
    return OpenAI(base_url=base_url, api_key=api_key)


def _build_tools(action_names: list[str]) -> list[dict]:
    """Build OpenAI tool schema where each action is a separate function.

    Each tool takes a single optional `text` field for the user-facing reply.
    The model picks one or more by emitting tool_calls; we read the names
    back as the selected actions.
    """
    tools: list[dict] = []
    for name in action_names:
        tools.append({
            "type": "function",
            "function": {
                "name": name,
                "description": f"Perform the {name} action.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "text": {
                            "type": "string",
                            "description": "Optional user-facing message for this action.",
                        },
                    },
                    "additionalProperties": False,
                },
            },
        })
    return tools


def _parse_tool_calls(
    tool_calls: list,
    fallback_text: str,
    valid_actions: set[str],
) -> tuple[list[str], str]:
    """Extract action names and the first non-empty text from tool_calls."""
    actions: list[str] = []
    text = fallback_text or ""
    for call in tool_calls or []:
        fn = getattr(call, "function", None)
        if fn is None:
            continue
        name = (getattr(fn, "name", "") or "").upper()
        if name not in valid_actions:
            continue
        actions.append(name)
        args_raw = getattr(fn, "arguments", "") or ""
        if args_raw and not text:
            try:
                parsed = json.loads(args_raw)
                if isinstance(parsed, dict):
                    candidate = parsed.get("text")
                    if isinstance(candidate, str) and candidate.strip():
                        text = candidate.strip()
            except (json.JSONDecodeError, TypeError):
                pass
    return actions, text


class OpenAICompatibleADHDBenchRunner:
    """Runs ADHDBench scenarios against an OpenAI-compatible chat endpoint."""

    def __init__(self, config: ADHDBenchConfig) -> None:
        self.config = config
        self._client = _make_client(config.model_provider)
        self._total_prompt_tokens = 0
        self._total_completion_tokens = 0
        # Trace records for offline inspection.
        self._traces: list[dict] = []

    async def run(self, progress_callback: ProgressCallback | None = None) -> BenchmarkResults:
        start = time.perf_counter()
        results: list[ScenarioResult] = []

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
                continue

            total = len(self.config.scale_points) * len(scenarios)
            current = 0
            for scale in self.config.scale_points:
                bootstrap_count = len(BOOTSTRAP_ACTION_NAMES)
                distractor_actions = get_distractor_plugin_actions_for_scale(
                    scale.action_count, bootstrap_count
                )
                action_names = list(BOOTSTRAP_ACTION_NAMES) + [a.name for a in distractor_actions]
                for scenario in scenarios:
                    current += 1
                    if progress_callback is not None:
                        progress_callback(config_name, scale.label, current, total)
                    results.append(
                        await self._run_scenario(scenario, scale, config_name, action_names)
                    )

        action_pool = list(BOOTSTRAP_ACTION_NAMES) + [
            a.name
            for a in get_distractor_plugin_actions_for_scale(
                max((sp.action_count for sp in self.config.scale_points), default=len(BOOTSTRAP_ACTION_NAMES)),
                len(BOOTSTRAP_ACTION_NAMES),
            )
        ]
        all_scenarios = get_scenarios(
            levels=self.config.levels,
            tags=self.config.tags,
            scenario_ids=self.config.scenario_ids,
        )
        benchmark_results = BenchmarkResults(
            metadata={
                "benchmark": "ADHDBench",
                "model": self.config.model_name,
                "provider": self.config.model_provider,
                "duration_ms": round((time.perf_counter() - start) * 1000, 1),
                "total_scenarios": len(results),
                "prompt_tokens": self._total_prompt_tokens,
                "completion_tokens": self._total_completion_tokens,
            },
            results=results,
            scaling_curves=self._build_scaling_curves(results),
            baselines={
                "random": compute_random_baseline(all_scenarios, action_pool),
                "always_reply": compute_always_reply_baseline(all_scenarios),
            },
        )

        if self.config.generate_report:
            ADHDBenchReporter(self.config).generate_report(benchmark_results)
        self._save_traces()
        return benchmark_results

    def _save_traces(self) -> None:
        if not self.config.save_traces or not self._traces:
            return
        out_dir = self.config.output_dir
        os.makedirs(out_dir, exist_ok=True)
        path = os.path.join(out_dir, "trajectories.jsonl")
        with open(path, "w", encoding="utf-8") as fh:
            for record in self._traces:
                fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        logger.info("Wrote %d trajectory records to %s", len(self._traces), path)

    async def _run_scenario(
        self,
        scenario: Scenario,
        scale: ScalePoint,
        config_name: str,
        action_names: list[str],
    ) -> ScenarioResult:
        valid_actions = {n.upper() for n in action_names}
        turn_results: list[TurnResult] = []
        prefill = list(itertools.islice(itertools.cycle(self.config.prefill_topic_pool), scale.conversation_prefill))
        history: list[dict[str, str]] = [{"role": "user", "content": p} for p in prefill]
        total_latency = 0.0

        for idx, turn in enumerate(scenario.turns):
            if turn.role == "system":
                history.append({"role": "system", "content": turn.text})
                turn_results.append(
                    TurnResult(
                        turn_index=idx,
                        actions_selected=[],
                        providers_requested=[],
                        response_text="",
                        providers_actually_run=[],
                        outcome_results=[],
                        latency_ms=0.0,
                    )
                )
                continue

            history.append({"role": "user", "content": turn.text})
            started = time.perf_counter()
            try:
                llm = await asyncio.to_thread(
                    self._call_llm,
                    history,
                    action_names,
                    scenario.name,
                )
            except Exception as exc:
                logger.error("%s turn %d LLM call failed: %s", scenario.id, idx, exc)
                latency_ms = round((time.perf_counter() - started) * 1000, 3)
                total_latency += latency_ms
                turn_result = TurnResult(
                    turn_index=idx,
                    actions_selected=[],
                    providers_requested=[],
                    response_text="",
                    providers_actually_run=[],
                    outcome_results=[],
                    latency_ms=latency_ms,
                    raw_llm_response=f"ERROR: {exc}",
                )
                if turn.expected_outcomes:
                    turn_result.outcome_results = [
                        evaluate_outcome(o, turn_result) for o in turn.expected_outcomes
                    ]
                turn_results.append(turn_result)
                break

            latency_ms = round((time.perf_counter() - started) * 1000, 3)
            total_latency += latency_ms
            self._total_prompt_tokens += llm.prompt_tokens
            self._total_completion_tokens += llm.completion_tokens

            actions = list(llm.actions)
            response_text = llm.text
            history.append({"role": "assistant", "content": llm.raw or response_text})

            turn_result = TurnResult(
                turn_index=idx,
                actions_selected=actions,
                providers_requested=[],
                response_text=response_text,
                providers_actually_run=[],
                outcome_results=[],
                latency_ms=latency_ms,
                raw_llm_response=llm.raw,
                thought=response_text,
            )
            if turn.expected_outcomes:
                turn_result.outcome_results = [
                    evaluate_outcome(o, turn_result) for o in turn.expected_outcomes
                ]
            turn_results.append(turn_result)

            self._traces.append({
                "scenario_id": scenario.id,
                "scenario_name": scenario.name,
                "config": config_name,
                "scale": scale.label,
                "turn": idx,
                "user_text": turn.text,
                "raw_llm_response": llm.raw,
                "actions_selected": actions,
                "prompt_tokens": llm.prompt_tokens,
                "completion_tokens": llm.completion_tokens,
                "latency_ms": latency_ms,
                "outcomes": [
                    {"type": o.outcome.outcome_type.value, "passed": o.passed, "detail": o.detail}
                    for o in turn_result.outcome_results
                ],
            })

        # OpenAI-compatible providers can't observe runtime provider
        # invocations, so PROVIDERS_REQUESTED outcomes are skipped at
        # scoring time.
        score = compute_scenario_score(turn_results, has_runtime_signal=False)
        return ScenarioResult(
            scenario_id=scenario.id,
            scenario_name=scenario.name,
            level=scenario.level,
            scale_point=scale,
            config_name=config_name,
            turn_results=turn_results,
            score=score,
            total_latency_ms=total_latency,
            model_name=self.config.model_name,
        )

    def _call_llm(
        self,
        history: list[dict[str, str]],
        action_names: list[str],
        scenario_name: str,
    ) -> _LLMResponse:
        valid_actions = {n.upper() for n in action_names}
        system = (
            f"You are an agent being benchmarked on attention/distraction handling.\n"
            f"Scenario: {scenario_name}\n\n"
            f"Pick the most semantically appropriate action (or one or two actions) "
            f"by calling the matching function. Pass your user-facing reply, if any, "
            f"as the `text` argument. Be concise."
        )
        messages = [{"role": "system", "content": system}] + history
        tools = _build_tools(action_names)
        completion = self._client.chat.completions.create(
            model=self.config.model_name,
            messages=messages,
            temperature=0.0,
            max_tokens=512,
            tools=tools,
            tool_choice="auto",
        )
        choice = completion.choices[0]
        message = choice.message
        content_text = message.content or ""
        tool_calls = getattr(message, "tool_calls", None) or []
        actions, parsed_text = _parse_tool_calls(tool_calls, content_text, valid_actions)
        # Synthesize a raw record that captures both the structured tool calls
        # and any free-form text the model emitted so traces stay debuggable.
        raw_payload = {
            "content": content_text,
            "tool_calls": [
                {
                    "name": getattr(getattr(c, "function", None), "name", ""),
                    "arguments": getattr(getattr(c, "function", None), "arguments", ""),
                }
                for c in tool_calls
            ],
        }
        raw = json.dumps(raw_payload, ensure_ascii=False)
        usage = getattr(completion, "usage", None)
        prompt_tokens = getattr(usage, "prompt_tokens", 0) if usage else 0
        completion_tokens = getattr(usage, "completion_tokens", 0) if usage else 0
        return _LLMResponse(
            text=parsed_text,
            actions=actions,
            raw=raw,
            prompt_tokens=int(prompt_tokens or 0),
            completion_tokens=int(completion_tokens or 0),
        )

    def _build_scaling_curves(self, results: list[ScenarioResult]) -> dict[str, list[ScalingCurvePoint]]:
        curves: dict[str, list[ScalingCurvePoint]] = {}
        for config_name in self.config.config_names:
            points: list[ScalingCurvePoint] = []
            for scale in self.config.scale_points:
                matching = [
                    r for r in results
                    if r.config_name == config_name and r.scale_point.label == scale.label
                ]
                if not matching:
                    continue
                points.append(
                    ScalingCurvePoint(
                        scale_label=scale.label,
                        action_count=scale.action_count,
                        provider_count=scale.provider_count,
                        conversation_prefill=scale.conversation_prefill,
                        score=sum(r.score for r in matching) / len(matching),
                        latency_ms=sum(r.total_latency_ms for r in matching) / len(matching),
                        scenario_count=len(matching),
                    )
                )
            curves[config_name] = points
        return curves
