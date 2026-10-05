"""Benchmark orchestration for LifeOpsBench.

Drives an agent through each scenario, applies its tool calls against an
in-memory `LifeWorld`, and computes per-scenario + aggregate scores.

The agent function signature is `(history, tool_manifest) -> next_assistant_turn`.
Tool calls embedded in the assistant turn (`tool_calls=[{...}]`) are executed
against the world via `_execute_action`. Unknown action names raise
`UnsupportedAction` so gaps surface immediately rather than silently no-op.

Action-name vocabulary
----------------------
The executor speaks two distinct surfaces and dispatches both through the
same registry so adapters can mix-and-match:

1. **Umbrella verbs** (the canonical Eliza surface, also what the static
   scenario corpus authors): a single name per domain (e.g. `CALENDAR`, `MESSAGE`,
   `ENTITY`, `LIFE_CREATE`, `MONEY`) with a discriminator inside kwargs:

       Action(name="CALENDAR", kwargs={"subaction": "update_event", ...})

   The discriminator field is `subaction` for most umbrellas; the
   `MESSAGE` umbrella uses `operation` because that matches the Eliza
   message handler. These mirror the planner's surface.

2. **Fine-grained verbs** (kept for the inline conformance corpus and
   adapters that emit explicit tool ids): `<DOMAIN>.<verb>` like
   `CALENDAR.create`, `MAIL.archive`, `REMINDER.complete`. These remain
   supported because the inline conformance scenarios use them.

Determinism contract
--------------------
For state-hash scoring to work, two replays of the same `Action` against
two different worlds must produce identical mutations. Where a scenario
omits an explicit id (umbrella `LIFE_CREATE`, etc.), the executor derives
a deterministic synthetic id from kwargs via `_synthetic_id()`. Read-only
subactions return diagnostic payloads but never mutate state.
"""

from __future__ import annotations

import asyncio
import difflib
import hashlib
import json
import logging
import os
import re
import secrets
from collections.abc import Awaitable, Callable
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from typing import Any

from .lifeworld.action_common import UnsupportedAction, _try_parse_iso
from .lifeworld.executor import _execute_action, _normalize_action, build_tool_manifest
from .clients.base import BaseClient
from .evaluator import LifeOpsEvaluator
from .evidence import (
    EvidenceVerificationError,
    TrustedEvidenceVerifier,
    TrustedExecutionContext,
    TrustedToolExecutor,
    mark_authenticated_external_result,
    mark_deterministic_lifeworld_result,
    validate_action_policy,
    validate_tool_call_id,
    verify_result_trusted_evidence,
)
from .lifeworld import EntityKind, LifeWorld
from .lifeworld.entities import (
    EmailMessage,
    EmailThread,
    Reminder,
)
from .scorer import (
    compile_benchmark_result,
    output_substring_match,
    score_scenario,
    state_hash,
)
from .types import (
    Action,
    BenchmarkResult,
    Disruption,
    Domain,
    EvaluatorTraceEntry,
    MessageTurn,
    Scenario,
    ScenarioMode,
    ScenarioResult,
    StaticGradingMode,
    TurnResult,
    VerifiedEvidenceReceipt,
    compute_cache_hit_pct,
)

logger = logging.getLogger(__name__)


AgentFn = Callable[[list[MessageTurn], list[dict[str, Any]]], Awaitable[MessageTurn]]
WorldFactory = Callable[[int, str], LifeWorld]
AgentFactory = Callable[["Scenario"], AgentFn]


class CostBudgetExceeded(Exception):
    """Raised when the cumulative spend across scenarios exceeds the configured cap."""


# ---------------------------------------------------------------------------
# Action executor — top-level dispatch
# ---------------------------------------------------------------------------


def _initial_user_content(scenario: Scenario) -> str:
    return _benchmark_clock_context(scenario.now_iso) + f"\n\n{scenario.instruction}"


def _static_semantic_expectations(scenario: Scenario) -> bool:
    """Whether a STATIC scenario asks the judge to interpret response meaning."""
    return scenario.mode is ScenarioMode.STATIC and bool(
        scenario.required_outputs or scenario.static_rubric
    )


def _has_complete_static_semantic_trace(
    result: ScenarioResult,
    scenario: Scenario,
) -> bool:
    """Validate exact semantic-criterion coverage for publication metadata."""
    expected_ids = [
        f"output_{index + 1}" for index in range(len(scenario.required_outputs))
    ] + [f"rubric_{index + 1}" for index in range(len(scenario.static_rubric))]
    entries = [
        entry
        for entry in result.evaluator_trace
        if entry.role == "judge" and entry.judge_kind == "static_semantic"
    ]
    if len(entries) != 1:
        return False
    entry = entries[0]
    if entry.verdict_invalid or entry.criterion_verdicts is None:
        return False
    returned_ids = [item.get("id") for item in entry.criterion_verdicts]
    return returned_ids == expected_ids and all(
        isinstance(item.get("met"), bool) for item in entry.criterion_verdicts
    )


def _opening_leaks_hidden_goal(opening: str, hidden_goal: str) -> bool:
    """Detect verbatim and near-verbatim disclosure of an evaluator-only goal."""

    def tokens(value: str) -> list[str]:
        return re.findall(r"[^\W_]+", value.casefold(), flags=re.UNICODE)

    opening_tokens = tokens(opening)
    goal_tokens = tokens(hidden_goal)
    if not goal_tokens:
        return False
    normalized_opening = " ".join(opening_tokens)
    normalized_goal = " ".join(goal_tokens)
    if normalized_goal in normalized_opening:
        return True

    matcher = difflib.SequenceMatcher(
        None,
        goal_tokens,
        opening_tokens,
        autojunk=False,
    )
    matching_goal_tokens = sum(block.size for block in matcher.get_matching_blocks())
    longest = matcher.find_longest_match(
        0,
        len(goal_tokens),
        0,
        len(opening_tokens),
    ).size
    goal_coverage = matching_goal_tokens / len(goal_tokens)
    long_span_threshold = min(8, max(4, int(len(goal_tokens) * 0.65)))
    return len(goal_tokens) >= 5 and (
        goal_coverage >= 0.8 or longest >= long_span_threshold
    )


def _benchmark_clock_context(now_iso: str) -> str:
    """Render deterministic date context for model-facing benchmark prompts."""
    now = _try_parse_iso(now_iso)
    if now is None:
        return (
            f"Current benchmark time: {now_iso}. "
            "Interpret relative dates against this timestamp, not the wall-clock date."
        )

    weekday_name = now.strftime("%A")
    today = now.date()
    day_names = (
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
    )
    anchors: list[str] = []
    for index, day_name in enumerate(day_names):
        delta = (index - now.weekday()) % 7
        if delta == 0:
            delta = 7
        anchors.append(f"{day_name}={today + timedelta(days=delta)}")

    return (
        f"Current benchmark time: {now_iso} ({weekday_name}, {today}). "
        "Interpret relative dates against this timestamp, not the wall-clock date. "
        "For bare weekday names, use the next occurrence after the benchmark time. "
        "Upcoming weekday anchors: " + ", ".join(anchors) + "."
    )


# JSON-schema fragment for SCHEDULED_TASK_* trigger objects. Documented inline so
# the LLM sees the {kind, atIso}/{kind, rrule} shape rather than guessing.


# JSON-schema fragment for LIFE_CREATE details. Top-level fields are forbidden
# (title belongs at the top level of kwargs, not here).


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Fine-grained handlers (inline conformance corpus)
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Umbrella handlers
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Registry — every action name the executor knows
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Tool-call extraction + runner internals
# ---------------------------------------------------------------------------


def _extract_actions_from_turn(turn: MessageTurn) -> list[Action]:
    """Pull `Action(name, kwargs)` objects out of an assistant `MessageTurn`'s `tool_calls`."""
    if not turn.tool_calls:
        return []
    out: list[Action] = []
    for call in turn.tool_calls:
        # Two flavors supported: OpenAI-style `{"function": {"name", "arguments"}}`
        # and a flat `{"name", "arguments" | "kwargs"}` shape used by PerfectAgent.
        if "function" in call and isinstance(call["function"], dict):
            name = call["function"].get("name", "")
            raw_args = call["function"].get("arguments", {})
        else:
            name = call.get("name", "")
            raw_args = call.get("arguments", call.get("kwargs", {}))
        if isinstance(raw_args, str):
            try:
                raw_args = json.loads(raw_args)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Malformed arguments for tool {name!r}") from exc
        if not isinstance(raw_args, dict):
            raise ValueError(f"Arguments for tool {name!r} must be an object")
        out.append(Action(name=name, kwargs=raw_args))
    return out


def _replay_ground_truth(scenario: Scenario, world_factory: WorldFactory) -> str:
    """Produce the expected post-state hash by replaying ground_truth on a fresh world.

    Used to compute the ground-truth state hash without requiring scenarios
    to encode it explicitly.
    """
    expected_world = world_factory(scenario.world_seed, scenario.now_iso)
    for action in scenario.ground_truth_actions:
        _execute_action(action, expected_world)
    return state_hash(expected_world)


def _workload_sha256(scenarios: list[Scenario], seeds: int) -> str:
    """Fingerprint the exact authored workload and seed expansion for publication."""
    payload = {
        "schema_version": 3,
        "seeds_per_scenario": seeds,
        "scenarios": [
            {
                "id": scenario.id,
                "name": scenario.name,
                "domain": scenario.domain.value,
                "mode": scenario.mode.value,
                "persona": {
                    "id": scenario.persona.id,
                    "name": scenario.persona.name,
                    "traits": scenario.persona.traits,
                    "background": scenario.persona.background,
                    "communication_style": scenario.persona.communication_style,
                    "patience_turns": scenario.persona.patience_turns,
                },
                "instruction": scenario.instruction,
                "ground_truth_actions": [
                    {"name": action.name, "kwargs": action.kwargs}
                    for action in scenario.ground_truth_actions
                ],
                "required_outputs": scenario.required_outputs,
                "static_rubric": scenario.static_rubric,
                "soft_kwargs": scenario.soft_kwargs,
                "first_question_fallback": (
                    {
                        "canned_answer": scenario.first_question_fallback.canned_answer,
                        "applies_when": scenario.first_question_fallback.applies_when,
                    }
                    if scenario.first_question_fallback is not None
                    else None
                ),
                "world_seed": scenario.world_seed,
                "max_turns": scenario.max_turns,
                "description": scenario.description,
                "now_iso": scenario.now_iso,
                "success_criteria": scenario.success_criteria,
                "world_assertions": scenario.world_assertions,
                "disruptions": [
                    {
                        "at_turn": disruption.at_turn,
                        "kind": disruption.kind,
                        "payload": disruption.payload,
                        "note_for_user": disruption.note_for_user,
                    }
                    for disruption in scenario.disruptions
                ],
                "expected_world_mutation": scenario.expected_world_mutation,
                "tier": scenario.tier,
                "opening_mode": scenario.opening_mode,
                "opening_challenge": scenario.opening_challenge,
                "trusted_evidence_requirement": (
                    {
                        "contract_id": scenario.trusted_evidence_requirement.contract_id,
                        "contract_version": (
                            scenario.trusted_evidence_requirement.contract_version
                        ),
                        "contract_sha256": (
                            scenario.trusted_evidence_requirement.contract_sha256
                        ),
                        "required_assertion_ids": list(
                            scenario.trusted_evidence_requirement.required_assertion_ids
                        ),
                        "allowed_actions": [
                            {
                                "name": policy.name,
                                "discriminator_field": policy.discriminator_field,
                                "allowed_discriminators": list(
                                    policy.allowed_discriminators
                                ),
                                "risk": policy.risk,
                                "required_kwargs": list(policy.required_kwargs),
                                "max_calls": policy.max_calls,
                            }
                            for policy in (
                                scenario.trusted_evidence_requirement.allowed_actions
                            )
                        ],
                        "terminal_attestation_required": (
                            scenario.trusted_evidence_requirement.terminal_attestation_required
                        ),
                    }
                    if scenario.trusted_evidence_requirement is not None
                    else None
                ),
            }
            for scenario in scenarios
        ],
    }
    canonical = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


class LifeOpsBenchRunner:
    """Orchestrates LifeOpsBench runs across a set of scenarios.

    The agent function takes `(history, tool_manifest)` and returns the next
    assistant `MessageTurn`. The world factory yields a fresh `LifeWorld`
    seeded deterministically per scenario+seed.
    """

    def __init__(
        self,
        agent_fn: AgentFn | None = None,
        world_factory: WorldFactory | None = None,
        evaluator_model: str = "gemma-4-31b",
        judge_model: str = "claude-opus-4-7",
        evaluator_provider: str | None = None,
        judge_provider: str | None = None,
        agent_model_name: str | None = None,
        agent_adapter: str | None = None,
        agent_provider: str | None = None,
        scenarios: list[Scenario] | None = None,
        concurrency: int = 4,
        seeds: int = 1,
        max_cost_usd: float = 10.0,
        per_scenario_timeout_s: int = 300,
        simulated_user_client: BaseClient | None = None,
        judge_client: BaseClient | None = None,
        evaluator: LifeOpsEvaluator | None = None,
        live_judge_min_turn: int = 5,
        abort_on_budget_exceeded: bool = True,
        agent_factory: AgentFactory | None = None,
        trusted_tool_executor: TrustedToolExecutor | None = None,
        trusted_evidence_verifier: TrustedEvidenceVerifier | None = None,
        static_grading_mode: StaticGradingMode = "semantic",
    ) -> None:
        if agent_fn is None and agent_factory is None:
            raise ValueError("LifeOpsBenchRunner requires agent_fn or agent_factory")
        if world_factory is None:
            raise ValueError("LifeOpsBenchRunner requires world_factory")
        if concurrency <= 0:
            raise ValueError("LifeOpsBenchRunner concurrency must be positive")
        if seeds <= 0:
            raise ValueError("LifeOpsBenchRunner seeds must be positive")
        if (trusted_tool_executor is None) != (trusted_evidence_verifier is None):
            raise ValueError(
                "trusted_tool_executor and trusted_evidence_verifier must be "
                "configured together"
            )
        if static_grading_mode not in {"semantic", "offline_conformance"}:
            raise ValueError(
                "static_grading_mode must be 'semantic' or 'offline_conformance'"
            )
        self.agent_fn = agent_fn
        self.agent_factory = agent_factory
        self.world_factory = world_factory
        self.evaluator_model = evaluator_model
        self.judge_model = judge_model
        self.evaluator_provider = evaluator_provider
        self.judge_provider = judge_provider
        self.agent_model_name = agent_model_name
        self.agent_adapter = agent_adapter
        self.agent_provider = agent_provider
        self.concurrency = concurrency
        self.seeds = seeds
        self.max_cost_usd = max_cost_usd
        self.per_scenario_timeout_s = per_scenario_timeout_s
        self.live_judge_min_turn = live_judge_min_turn
        self.abort_on_budget_exceeded = abort_on_budget_exceeded
        self.trusted_tool_executor = trusted_tool_executor
        self.trusted_evidence_verifier = trusted_evidence_verifier
        self.static_grading_mode = static_grading_mode

        if scenarios is not None:
            self.scenarios = scenarios
        else:
            from .scenarios import ALL_SCENARIOS

            self.scenarios = ALL_SCENARIOS

        # Semantic STATIC runs use the same two-model evaluator boundary as
        # LIVE runs: one model renders persona turns and the independent judge
        # grades natural-language criteria. Explicit offline conformance is
        # the only path that omits these clients.
        if evaluator is not None:
            self.evaluator: LifeOpsEvaluator | None = evaluator
        elif simulated_user_client is not None and judge_client is not None:
            self.evaluator = LifeOpsEvaluator(
                simulated_user_client=simulated_user_client,
                judge_client=judge_client,
                simulated_user_provider=evaluator_provider,
                judge_provider=judge_provider,
            )
        else:
            self.evaluator = None

        self._agent_spent_usd = 0.0
        self._eval_spent_usd = 0.0
        self._spent_lock = asyncio.Lock()
        # Set to True the first time `_charge` raises CostBudgetExceeded so
        # subsequent scenarios can short-circuit when
        # ``abort_on_budget_exceeded`` is on. Avoids racing many in-flight
        # scenarios past the cap before the gather sees the first failure.
        self._budget_exhausted = False
        # Failure artifacts retain every fully assembled turn and evaluator
        # exchange completed before a timeout or provider exception.
        self._partial_turns: dict[tuple[str, int], list[TurnResult]] = {}
        self._partial_evaluator_traces: dict[
            tuple[str, int], list[EvaluatorTraceEntry]
        ] = {}

    async def run_all(self) -> BenchmarkResult:
        """Run every configured scenario across `seeds` repetitions and aggregate."""
        return await self.run_filtered()

    async def run_filtered(
        self,
        domain: Domain | None = None,
        mode: ScenarioMode | None = None,
    ) -> BenchmarkResult:
        """Run scenarios filtered by domain and/or mode."""
        scenarios = [
            s
            for s in self.scenarios
            if (domain is None or s.domain == domain)
            and (mode is None or s.mode == mode)
        ]
        if not scenarios:
            raise ValueError(
                "No LifeOpsBench scenarios matched filters "
                f"(domain={domain}, mode={mode})"
            )
        evaluator_required = any(
            scenario.mode is ScenarioMode.LIVE
            or (
                scenario.mode is ScenarioMode.STATIC
                and self.static_grading_mode == "semantic"
                and (
                    scenario.opening_mode == "simulated"
                    or _static_semantic_expectations(scenario)
                )
            )
            for scenario in scenarios
        )
        if evaluator_required and self.evaluator is None:
            raise RuntimeError(
                "selected scenarios require the independent evaluator/judge "
                "boundary; configure simulated_user_client and judge_client, "
                "or explicitly select static_grading_mode='offline_conformance' "
                "for non-publishable harness conformance"
            )
        if self.static_grading_mode == "offline_conformance":
            rubric_scenarios = [
                scenario.id
                for scenario in scenarios
                if scenario.mode is ScenarioMode.STATIC and scenario.static_rubric
            ]
            if rubric_scenarios:
                raise RuntimeError(
                    "offline conformance cannot grade authored static_rubric "
                    f"criteria: {', '.join(rubric_scenarios[:5])}"
                )

        expected_keys = [
            (scenario.id, scenario.world_seed + seed_offset)
            for scenario in scenarios
            for seed_offset in range(self.seeds)
        ]
        if len(set(expected_keys)) != len(expected_keys):
            raise ValueError(
                "LifeOpsBench workload contains duplicate (scenario_id, seed) pairs"
            )

        semaphore = asyncio.Semaphore(self.concurrency)
        tasks: list[Awaitable[ScenarioResult]] = []
        for scenario in scenarios:
            for seed_offset in range(self.seeds):
                seed = scenario.world_seed + seed_offset
                tasks.append(self._run_one_guarded(semaphore, scenario, seed))

        results = await asyncio.gather(*tasks)
        completed_keys = [(result.scenario_id, result.seed) for result in results]
        if completed_keys != expected_keys:
            raise RuntimeError(
                "LifeOpsBench completed workload does not match the scheduled "
                f"workload: expected={expected_keys!r}, completed={completed_keys!r}"
            )
        scenarios_by_id = {s.id: s for s in scenarios}
        bench_result = compile_benchmark_result(
            list(results),
            scenarios_by_id,
            seeds=self.seeds,
            model_name=self.evaluator_model,
            judge_model_name=self.judge_model,
            timestamp=datetime.now(timezone.utc).isoformat(),
            trusted_evidence_verifier=self.trusted_evidence_verifier,
        )
        # Attach the agent / eval cost split. ``compile_benchmark_result``
        # only sees per-turn agent cost, so fold the eval ledger in here so
        # the headline matches the wall budget.
        bench_result.agent_cost_usd = self._agent_spent_usd
        bench_result.eval_cost_usd = self._eval_spent_usd
        bench_result.total_cost_usd = self._agent_spent_usd + self._eval_spent_usd
        bench_result.expected_run_count = len(expected_keys)
        bench_result.completed_run_count = len(completed_keys)
        bench_result.successful_run_count = sum(
            result.error is None
            and result.terminated_reason not in {"error", "timeout", "cost_exceeded"}
            for result in results
        )
        bench_result.complete = (
            bench_result.completed_run_count == bench_result.expected_run_count
            and bench_result.successful_run_count == bench_result.expected_run_count
        )
        bench_result.workload_sha256 = _workload_sha256(scenarios, self.seeds)
        bench_result.agent_model_name = self.agent_model_name
        bench_result.agent_adapter = self.agent_adapter
        bench_result.agent_provider = self.agent_provider
        bench_result.evaluator_provider = self.evaluator_provider
        bench_result.judge_provider = self.judge_provider
        bench_result.static_grading_mode = self.static_grading_mode
        static_ids = {
            scenario.id
            for scenario in scenarios
            if scenario.mode is ScenarioMode.STATIC
        }
        bench_result.static_run_count = sum(
            result.scenario_id in static_ids for result in results
        )
        bench_result.unpriced_agent_call_count = sum(
            turn.cost_usd is None for result in results for turn in result.turns
        )
        bench_result.unpriced_eval_call_count = sum(
            entry.cost_usd is None
            for result in results
            for entry in result.evaluator_trace
        )
        semantic_static_ids = {
            scenario.id
            for scenario in scenarios
            if _static_semantic_expectations(scenario)
        }
        bench_result.semantic_static_run_count = sum(
            result.scenario_id in semantic_static_ids for result in results
        )
        bench_result.semantic_static_judged_count = sum(
            result.scenario_id in semantic_static_ids
            and result.static_grading_mode == "semantic"
            and _has_complete_static_semantic_trace(
                result,
                scenarios_by_id[result.scenario_id],
            )
            for result in results
        )
        return bench_result

    async def _run_one_guarded(
        self,
        semaphore: asyncio.Semaphore,
        scenario: Scenario,
        seed: int,
    ) -> ScenarioResult:
        async with semaphore:
            # Short-circuit any scenario that hasn't started its agent_fn yet
            # once another scenario has tripped the cost cap and abort is on.
            # This keeps the run from racing pending scenarios past the cap
            # in the time between the first failure and the gather collecting
            # results.
            if self.abort_on_budget_exceeded and self._budget_exhausted:
                return self._failure_result(
                    scenario,
                    seed,
                    "cost_exceeded",
                    "skipped — cumulative cost cap "
                    f"${self.max_cost_usd:.4f} already exceeded",
                )
            run_key = (scenario.id, seed)
            self._partial_turns[run_key] = []
            self._partial_evaluator_traces[run_key] = []
            try:
                result = await asyncio.wait_for(
                    self.run_one(scenario, seed),
                    timeout=self.per_scenario_timeout_s,
                )
                self._partial_turns.pop(run_key, None)
                self._partial_evaluator_traces.pop(run_key, None)
                return result
            # error-policy:J1 scenario boundary preserves partial evidence on timeout.
            except asyncio.TimeoutError:
                logger.warning(
                    "Scenario %s seed=%d timed out after %ds",
                    scenario.id,
                    seed,
                    self.per_scenario_timeout_s,
                )
                return self._failure_result(
                    scenario,
                    seed,
                    "timeout",
                    "timed out",
                    turns=self._partial_turns.pop(run_key, []),
                    evaluator_trace=self._partial_evaluator_traces.pop(run_key, []),
                )
            # error-policy:J1 scenario boundary records a typed cost failure.
            except CostBudgetExceeded as exc:
                logger.error(
                    "Cost budget exceeded on %s seed=%d: %s", scenario.id, seed, exc
                )
                return self._failure_result(
                    scenario,
                    seed,
                    "cost_exceeded",
                    str(exc),
                    turns=self._partial_turns.pop(run_key, []),
                    evaluator_trace=self._partial_evaluator_traces.pop(run_key, []),
                )
            # error-policy:J1 outer scenario boundary retains diagnostics and fails.
            except Exception as exc:
                logger.exception("Scenario %s seed=%d errored", scenario.id, seed)
                return self._failure_result(
                    scenario,
                    seed,
                    "error",
                    str(exc),
                    turns=self._partial_turns.pop(run_key, []),
                    evaluator_trace=self._partial_evaluator_traces.pop(run_key, []),
                )

    async def run_one(self, scenario: Scenario, seed: int) -> ScenarioResult:
        """Run a single scenario at a single seed and return its result.

        Both modes honor ``Scenario.opening_mode``. In semantic runs,
        ``simulated`` asks the persona model to render a fresh, in-character
        opening from the hidden goal; explicit offline conformance uses the
        authored goal because it has no model boundary. STATIC ends after the
        optional first-question fallback and then receives exactly one
        independent semantic grade. LIVE continues with simulated user turns,
        periodic satisfaction judging, and scripted world disruptions.
        """
        if scenario.mode is ScenarioMode.LIVE and self.evaluator is None:
            raise RuntimeError(
                f"scenario {scenario.id} is LIVE but no evaluator was wired; "
                "construct LifeOpsBenchRunner with simulated_user_client and judge_client."
            )
        if (
            scenario.mode is ScenarioMode.STATIC
            and self.static_grading_mode == "semantic"
            and (
                scenario.opening_mode == "simulated"
                or _static_semantic_expectations(scenario)
            )
            and self.evaluator is None
        ):
            raise RuntimeError(
                f"scenario {scenario.id} requires semantic STATIC evaluation but "
                "no evaluator/judge was wired; configure both clients or "
                "explicitly use offline_conformance"
            )
        if (
            scenario.mode is ScenarioMode.STATIC
            and self.static_grading_mode == "offline_conformance"
            and scenario.static_rubric
        ):
            raise RuntimeError(
                f"scenario {scenario.id} has authored static_rubric criteria "
                "that offline conformance cannot grade"
            )
        scenario_evaluator = (
            self.evaluator.fork() if self.evaluator is not None else None
        )
        run_key = (scenario.id, seed)
        turns = self._partial_turns.setdefault(run_key, [])
        if scenario_evaluator is not None:
            self._partial_evaluator_traces[run_key] = scenario_evaluator.trace

        world = self.world_factory(seed, scenario.now_iso)
        run_id = secrets.token_hex(16)
        run_nonce = secrets.token_hex(32)
        run_started_at = datetime.now(timezone.utc)
        seen_receipt_ids: set[str] = set()
        seen_tool_call_ids: set[str] = set()
        policy_call_counts: dict[int, int] = {}
        request_ordinal = 0
        use_simulated_opening = scenario.opening_mode == "simulated" and (
            scenario.mode is ScenarioMode.LIVE or self.static_grading_mode == "semantic"
        )
        if use_simulated_opening:
            pre_opening_eval_cost = scenario_evaluator.cost_usd  # type: ignore[union-attr]
            opening_turn = await scenario_evaluator.simulate_user_turn(  # type: ignore[union-attr]
                scenario,
                [],
                world,
            )
            opening_text = opening_turn.content.strip()
            if _opening_leaks_hidden_goal(opening_text, scenario.instruction):
                raise ValueError(
                    "simulated-user opening exposed the hidden goal verbatim"
                )
            history = [
                MessageTurn(
                    role="user",
                    content=(
                        _benchmark_clock_context(scenario.now_iso)
                        + "\n\n"
                        + opening_text
                    ),
                )
            ]
            await self._charge(
                scenario_evaluator.cost_usd - pre_opening_eval_cost,  # type: ignore[union-attr]
                scenario.id,
                seed,
                bucket="eval",
            )
        else:
            history = [
                MessageTurn(
                    role="user",
                    content=_initial_user_content(scenario),
                )
            ]
        terminated_reason: str = "max_turns"

        # Pre-bucket disruptions by the turn they fire after.
        disruptions_by_turn: dict[int, list[Disruption]] = {}
        for d in scenario.disruptions:
            disruptions_by_turn.setdefault(d.at_turn, []).append(d)

        # Per-scenario agents (PerfectAgent/WrongAgent) need a fresh instance
        # per scenario because they hold scenario-specific state (action index,
        # ground-truth lookup). A factory wins over a singleton agent_fn.
        active_agent_fn: AgentFn = (
            self.agent_factory(scenario)
            if self.agent_factory is not None
            else self.agent_fn  # type: ignore[assignment]
        )

        requirement = scenario.trusted_evidence_requirement
        for turn_number in range(1, scenario.max_turns + 1):
            tool_manifest = build_tool_manifest(world, requirement)
            agent_turn = await active_agent_fn(list(history), tool_manifest)
            if agent_turn.role != "assistant":
                raise ValueError(
                    "agent adapter crossed the role boundary: expected an "
                    f"assistant turn, received {agent_turn.role!r}"
                )
            history.append(agent_turn)

            try:
                agent_actions = _extract_actions_from_turn(agent_turn)
            except ValueError:
                # Preserve the exact rejected provider turn; never execute invented empty arguments.
                turns.append(
                    TurnResult(
                        turn_number=turn_number,
                        agent_message=agent_turn.content,
                        agent_actions=[],
                        user_response="",
                        latency_ms=int(agent_turn.latency_ms)
                        if agent_turn.latency_ms is not None
                        else None,
                        input_tokens=agent_turn.input_tokens or 0,
                        output_tokens=agent_turn.output_tokens or 0,
                        cost_usd=agent_turn.cost_usd,
                        model_name=agent_turn.model_name,
                        raw_tool_calls=deepcopy(agent_turn.tool_calls or []),
                    )
                )
                raise
            tool_call_ids = [
                _extract_tool_call_id(
                    agent_turn,
                    action,
                    action_index,
                )
                or f"runner-{run_id}-{turn_number}-{action_index}"
                for action_index, action in enumerate(agent_actions)
            ]
            if requirement is not None:
                for tool_call_id in tool_call_ids:
                    validate_tool_call_id(tool_call_id)
                    if tool_call_id in seen_tool_call_ids:
                        raise ValueError(
                            "agent reused tool_call_id "
                            f"{tool_call_id!r} within one evidence-gated run"
                        )
                    seen_tool_call_ids.add(tool_call_id)
            external_execution_enabled = (
                requirement is not None
                and self.trusted_tool_executor is not None
                and self.trusted_evidence_verifier is not None
            )
            canonical_actions = [_normalize_action(action) for action in agent_actions]
            # A batch that violates the evidence contract is denied whole:
            # the shadow pass exists so a later unauthorized call cannot leave
            # an earlier one partially committed. The denial is reported back
            # as a tool result the model can react to — an out-of-contract call
            # is scenario signal about the model, not a harness crash.
            policy_denial: str | None = None
            if external_execution_enabled:
                shadow = deepcopy(world)
                next_policy_counts = dict(policy_call_counts)
                for canonical_action in canonical_actions:
                    try:
                        validate_action_policy(
                            canonical_action,
                            requirement,
                            next_policy_counts,
                        )
                    except EvidenceVerificationError as exc:
                        # error-policy:J3 the contract rejected untrusted model
                        # output; surface the refusal instead of dispatching.
                        policy_denial = str(exc)
                        break
                    _execute_action(canonical_action, shadow)
                if policy_denial is None:
                    policy_call_counts = next_policy_counts

            tool_results: list[dict[str, Any]] = []
            turn_verified_receipts: list[VerifiedEvidenceReceipt] = []
            for action_index, action in enumerate(canonical_actions):
                # Execution failures don't crash the run — we surface them as
                # tool-error messages and let scoring penalize via state mismatch.
                tool_call_id = tool_call_ids[action_index]
                if policy_denial is not None:
                    denial_payload = mark_deterministic_lifeworld_result(
                        {"error": "policy_denied", "message": policy_denial}
                    )
                    tool_results.append(
                        {
                            "name": action.name,
                            "tool_call_id": tool_call_id,
                            "content": json.dumps(denial_payload),
                            "payload": denial_payload,
                        }
                    )
                    history.append(
                        MessageTurn(
                            role="tool",
                            content=json.dumps(denial_payload),
                            name=action.name,
                            tool_call_id=tool_call_id,
                        )
                    )
                    continue
                try:
                    if external_execution_enabled:
                        request_ordinal += 1
                        context = TrustedExecutionContext(
                            run_id=run_id,
                            run_nonce=run_nonce,
                            run_started_at=run_started_at,
                            scenario_id=scenario.id,
                            seed=seed,
                            tool_call_id=tool_call_id,
                            request_ordinal=request_ordinal,
                            action=action,
                            contract_id=requirement.contract_id,
                            contract_version=requirement.contract_version,
                            contract_sha256=requirement.contract_sha256,
                            requested_at=datetime.now(timezone.utc),
                        )
                        execution = await self.trusted_tool_executor.execute(context)
                        receipt = self.trusted_evidence_verifier.verify(
                            context,
                            execution,
                            requirement,
                        )
                        if receipt.receipt_id in seen_receipt_ids:
                            raise RuntimeError(
                                "trusted executor reused receipt_id "
                                f"{receipt.receipt_id!r} within one run"
                            )
                        seen_receipt_ids.add(receipt.receipt_id)
                        turn_verified_receipts.append(receipt)
                        result_payload = mark_authenticated_external_result(
                            execution.payload,
                            receipt,
                        )
                        if receipt.success:
                            # The deterministic world is a scoring shadow only;
                            # authenticated artifacts, not this replay, establish
                            # that the provider-side operation really occurred.
                            try:
                                _execute_action(action, world)
                            except UnsupportedAction as exc:
                                raise RuntimeError(
                                    "authenticated action has no LifeWorld shadow "
                                    f"implementation: {action.name}"
                                ) from exc
                    else:
                        result_payload = _execute_action(action, world)
                        result_payload = mark_deterministic_lifeworld_result(
                            result_payload
                        )
                    tool_results.append(
                        {
                            "name": action.name,
                            "tool_call_id": tool_call_id,
                            "content": json.dumps(result_payload),
                            "payload": result_payload,
                        }
                    )
                    history.append(
                        MessageTurn(
                            role="tool",
                            content=json.dumps(result_payload),
                            name=action.name,
                            tool_call_id=tool_call_id,
                        )
                    )
                except UnsupportedAction as exc:
                    logger.warning(
                        "Unsupported action in scenario %s: %s", scenario.id, exc
                    )
                    error_payload = {"error": "unsupported_action", "message": str(exc)}
                    error_payload = mark_deterministic_lifeworld_result(error_payload)
                    tool_results.append(
                        {
                            "name": action.name,
                            "tool_call_id": tool_call_id,
                            "content": json.dumps(error_payload),
                            "payload": error_payload,
                        }
                    )
                    history.append(
                        MessageTurn(
                            role="tool",
                            content=json.dumps(error_payload),
                            name=action.name,
                            tool_call_id=tool_call_id,
                        )
                    )
                except (KeyError, ValueError, TypeError, PermissionError) as exc:
                    logger.warning(
                        "Action %s failed in scenario %s: %s",
                        action.name,
                        scenario.id,
                        exc,
                    )
                    # A PermissionError is the world enforcing a confirmation or
                    # authorization gate (e.g. BLOCK/unblock without
                    # confirmed=True). Production surfaces that to the model as a
                    # denied result it can react to, so the deterministic shadow
                    # must too — a refused tool call is scenario signal, never a
                    # harness crash.
                    error_payload = {
                        "error": (
                            "permission_denied"
                            if isinstance(exc, PermissionError)
                            else "execution_failed"
                        ),
                        "message": str(exc),
                    }
                    error_payload = mark_deterministic_lifeworld_result(error_payload)
                    tool_results.append(
                        {
                            "name": action.name,
                            "tool_call_id": tool_call_id,
                            "content": json.dumps(error_payload),
                            "payload": error_payload,
                        }
                    )
                    history.append(
                        MessageTurn(
                            role="tool",
                            content=json.dumps(error_payload),
                            name=action.name,
                            tool_call_id=tool_call_id,
                        )
                    )

            # Per-turn cost / latency are nullable on MessageTurn — `None`
            # means the provider didn't expose the number (unpriced model,
            # pre-flight error). Per AGENTS.md Cmd #8 we keep the None
            # through to the TurnResult rather than masking with 0.0. The
            # budget charge uses 0.0 locally because there is no real spend
            # to charge against when the value is unknown.
            agent_cost_raw = getattr(agent_turn, "cost_usd", None)
            agent_cost: float | None = (
                float(agent_cost_raw)
                if isinstance(agent_cost_raw, (int, float))
                else None
            )
            latency_raw = getattr(agent_turn, "latency_ms", None)
            latency_value: int | None = (
                int(latency_raw) if isinstance(latency_raw, (int, float)) else None
            )

            # Cache telemetry: adapters set these as attributes on the
            # MessageTurn when the provider reported them. `None` means the
            # provider did not report — we keep it as None so downstream
            # aggregators can distinguish "no data" from "zero hits".
            input_tokens_val = int(getattr(agent_turn, "input_tokens", 0) or 0)
            cache_read_attr = getattr(agent_turn, "cache_read_input_tokens", None)
            cache_creation_attr = getattr(
                agent_turn, "cache_creation_input_tokens", None
            )
            cache_read = (
                int(cache_read_attr)
                if isinstance(cache_read_attr, (int, float))
                else None
            )
            cache_creation = (
                int(cache_creation_attr)
                if isinstance(cache_creation_attr, (int, float))
                else None
            )
            # cache_supported defaults to True (every provider in scope —
            # Cerebras gpt-oss-120b, OpenAI, Anthropic — supports prompt
            # caching). Adapters explicitly override to False when on a
            # local-tier provider that does not.
            cache_supported_attr = getattr(agent_turn, "cache_supported", True)
            cache_supported = bool(cache_supported_attr)
            turn_result = TurnResult(
                turn_number=turn_number,
                agent_message=agent_turn.content,
                agent_actions=agent_actions,
                raw_tool_calls=deepcopy(agent_turn.tool_calls or []),
                user_response="",
                latency_ms=latency_value,
                input_tokens=input_tokens_val,
                output_tokens=int(getattr(agent_turn, "output_tokens", 0) or 0),
                cost_usd=agent_cost,
                tool_results=tool_results,
                cache_read_input_tokens=cache_read,
                cache_creation_input_tokens=cache_creation,
                cache_hit_pct=compute_cache_hit_pct(
                    input_tokens_val, cache_read, cache_creation
                ),
                cache_supported=cache_supported,
                model_tier=getattr(agent_turn, "model_tier", None),
                prompt_cache_key=getattr(agent_turn, "prompt_cache_key", None),
                # Attested provenance only: the adapter stamps model_name on
                # the MessageTurn when the provider reported it. Backfilling
                # from the config-declared agent_model_name would fabricate
                # per-turn attribution; unattributed turns stay None and the
                # run-level BenchmarkResult.agent_model_name carries the
                # configured identity separately.
                model_name=agent_turn.model_name,
                verified_evidence=turn_verified_receipts,
            )
            # The provider response and every resulting tool effect are already
            # facts at this point. Retain them before budget enforcement or an
            # evaluator call can fail so diagnostics never erase a real effect.
            turns.append(turn_result)
            await self._charge(
                agent_cost if agent_cost is not None else 0.0,
                scenario.id,
                seed,
                bucket="agent",
            )

            # Terminal detection: assistant turn with no tool_calls signals
            # the agent is done responding. Tool-call-only turns continue the
            # loop so multi-step plans can execute one tool per turn.
            agent_terminal = not agent_actions

            if scenario.mode is ScenarioMode.STATIC:
                if agent_terminal:
                    # Plain text means the agent is responding. Apply the
                    # first-question fallback once if it's a clarifier; else
                    # terminate.
                    pre_eval_cost = (
                        scenario_evaluator.cost_usd
                        if scenario_evaluator is not None
                        else 0.0
                    )
                    user_turn = await self._next_static_user_turn(
                        scenario,
                        agent_turn,
                        turn_number,
                        evaluator=scenario_evaluator,
                    )
                    if scenario_evaluator is not None:
                        await self._charge(
                            scenario_evaluator.cost_usd - pre_eval_cost,
                            scenario.id,
                            seed,
                            bucket="eval",
                        )
                    if user_turn is None:
                        terminated_reason = "respond"
                        break
                    history.append(user_turn)
                    turn_result.user_response = user_turn.content
            else:
                # LIVE mode. Apply scripted disruptions queued for this turn
                # BEFORE judging or asking the simulated user — the judge
                # should see the new world state and the simulated user can
                # surface the change naturally.
                disruption_note = await self._apply_disruptions(
                    disruptions_by_turn.get(turn_number, []), world
                )

                pre_eval_cost = scenario_evaluator.cost_usd  # type: ignore[union-attr]
                if turn_number >= self.live_judge_min_turn:
                    satisfied, _reason = await scenario_evaluator.judge_satisfaction(  # type: ignore[union-attr]
                        scenario,
                        history,
                        world,
                        evidence_verification=verify_result_trusted_evidence(
                            scenario,
                            turns,
                            seed=seed,
                            verifier=self.trusted_evidence_verifier,
                        ),
                    )
                    await self._charge(
                        scenario_evaluator.cost_usd - pre_eval_cost,  # type: ignore[union-attr]
                        scenario.id,
                        seed,
                        bucket="eval",
                    )
                    pre_eval_cost = scenario_evaluator.cost_usd  # type: ignore[union-attr]
                    if satisfied:
                        terminated_reason = "satisfied"
                        break

                # Always advance the conversation by one user turn in LIVE
                # mode (judge said NO, or we haven't started judging yet).
                user_turn = await scenario_evaluator.simulate_user_turn(  # type: ignore[union-attr]
                    scenario, history, world
                )
                if disruption_note:
                    user_turn = MessageTurn(
                        role="user",
                        content=f"{disruption_note}\n\n{user_turn.content}",
                    )
                history.append(user_turn)
                turn_result.user_response = user_turn.content
                await self._charge(
                    scenario_evaluator.cost_usd - pre_eval_cost,  # type: ignore[union-attr]
                    scenario.id,
                    seed,
                    bucket="eval",
                )

        # Compute the ground-truth post-state by replaying scenario actions on
        # a fresh world. If the executor doesn't support every gt action, the
        # replay raises and we mark the scenario as non-matchable.
        try:
            expected_hash = _replay_ground_truth(scenario, self.world_factory)
            state_match = state_hash(world) == expected_hash
        except UnsupportedAction as exc:
            logger.warning(
                "Cannot compute expected state hash for %s: %s", scenario.id, exc
            )
            state_match = False

        if (
            scenario.mode is ScenarioMode.STATIC
            and self.static_grading_mode == "semantic"
            and _static_semantic_expectations(scenario)
        ):
            pre_eval_cost = scenario_evaluator.cost_usd  # type: ignore[union-attr]
            await scenario_evaluator.judge_static_semantics(  # type: ignore[union-attr]
                scenario,
                history,
            )
            await self._charge(
                scenario_evaluator.cost_usd - pre_eval_cost,  # type: ignore[union-attr]
                scenario.id,
                seed,
                bucket="eval",
            )

        # Literal matching exists only for the explicitly named offline
        # conformance lane. Semantic and LIVE results never route their
        # natural-language expectations through this heuristic.
        substring_matches = (
            output_substring_match(history, scenario.required_outputs)
            if (
                scenario.mode is ScenarioMode.STATIC
                and self.static_grading_mode == "offline_conformance"
            )
            else []
        )
        result = ScenarioResult(
            scenario_id=scenario.id,
            seed=seed,
            static_grading_mode=(
                self.static_grading_mode
                if scenario.mode is ScenarioMode.STATIC
                else None
            ),
            turns=turns,
            state_hash_match=state_match,
            output_substring_matches=substring_matches,
            total_score=0.0,
            max_score=1.0,
            terminated_reason=terminated_reason,  # type: ignore[arg-type]
            # Skip None per-turn values when aggregating — "unpriced" /
            # "no timing data" is distinct from "$0" / "0 ms" (AGENTS.md
            # Cmd #8). Invariant: ``total_cost_usd ==
            # sum(t.cost_usd for t in turns if t.cost_usd is not None)``.
            total_cost_usd=sum(t.cost_usd for t in turns if t.cost_usd is not None),
            total_latency_ms=sum(
                t.latency_ms for t in turns if t.latency_ms is not None
            ),
            error=None,
            evaluator_trace=(
                list(scenario_evaluator.trace) if scenario_evaluator is not None else []
            ),
        )
        result.total_score = score_scenario(
            result,
            scenario,
            trusted_evidence_verifier=self.trusted_evidence_verifier,
        )
        self._partial_turns.pop(run_key, None)
        self._partial_evaluator_traces.pop(run_key, None)
        return result

    async def _apply_disruptions(
        self,
        disruptions: list[Disruption],
        world: LifeWorld,
    ) -> str:
        """Mutate ``world`` per each scripted disruption; return a user-facing note.

        REALM-Bench-style perturbations: a new urgent email lands mid-flow, a
        meeting moves, a reminder fires. Returns a short natural-language note
        (``""`` if no disruptions or no notes) that gets prepended to the
        next simulated user turn so the persona organically surfaces the
        change.

        Invalid kinds, payloads, and missing targets raise. Emitting the note
        without applying its world mutation would create a false trajectory in
        which the user describes a change that never happened.
        """
        notes: list[str] = []
        for d in disruptions:
            if d.kind == "new_message":
                msg = EmailMessage(
                    id=d.payload["message_id"],
                    thread_id=d.payload["thread_id"],
                    folder="inbox",
                    from_email=d.payload["from_email"],
                    to_emails=list(d.payload.get("to_emails", ["owner@example.test"])),
                    cc_emails=[],
                    subject=d.payload["subject"],
                    body_plain=d.payload.get("body", ""),
                    sent_at=world.now_iso,
                    received_at=world.now_iso,
                    is_read=False,
                    is_starred=False,
                    labels=list(d.payload.get("labels", [])),
                    attachments=[],
                )
                world.add(EntityKind.EMAIL, msg)
                if d.payload["thread_id"] not in world.email_threads:
                    world.add(
                        EntityKind.EMAIL_THREAD,
                        EmailThread(
                            id=d.payload["thread_id"],
                            subject=d.payload["subject"],
                            message_ids=[d.payload["message_id"]],
                            participants=[d.payload["from_email"]],
                            last_activity_at=world.now_iso,
                        ),
                    )
            elif d.kind == "calendar_change":
                action = d.payload.get("action", "cancel")
                event_id = d.payload["event_id"]
                if action == "cancel":
                    world.cancel_event(event_id)
                elif action == "move":
                    world.move_event(
                        event_id,
                        start=d.payload["start"],
                        end=d.payload["end"],
                    )
                else:
                    raise ValueError(f"unknown calendar_change action: {action!r}")
            elif d.kind == "reminder_due":
                reminder = Reminder(
                    id=d.payload["reminder_id"],
                    list_id=d.payload["list_id"],
                    title=d.payload["title"],
                    notes=d.payload.get("notes", ""),
                    due_at=d.payload.get("due_at", world.now_iso),
                    completed_at=None,
                    priority=d.payload.get("priority", "high"),
                    tags=list(d.payload.get("tags", [])),
                )
                world.add(EntityKind.REMINDER, reminder)
            elif d.kind == "rule_change":
                # The note is the complete effect for a conversational rule change.
                pass
            else:
                raise ValueError(f"unknown disruption kind: {d.kind!r}")

            if d.note_for_user:
                notes.append(d.note_for_user)

        return "\n".join(notes)

    async def _next_static_user_turn(
        self,
        scenario: Scenario,
        agent_turn: MessageTurn,
        turn_number: int,
        *,
        evaluator: LifeOpsEvaluator | None,
    ) -> MessageTurn | None:
        """STATIC mode: only respond on the FIRST agent turn if the fallback applies; otherwise terminate.

        Explicit offline-conformance runs have no evaluator, so they use the
        punctuation gate and canned fact source. Publishable semantic runs ask
        the persona model to apply ``applies_when`` and answer in character.
        """
        if turn_number != 1:
            return None
        if evaluator is not None:
            return await evaluator.apply_first_question_fallback(
                scenario, agent_turn.content
            )
        fallback = scenario.first_question_fallback
        if fallback is None:
            return None
        if "?" not in (agent_turn.content or ""):
            return None
        return MessageTurn(role="user", content=fallback.canned_answer)

    async def _charge(
        self,
        cost_usd: float,
        scenario_id: str,
        seed: int,
        bucket: str = "agent",
    ) -> None:
        """Add ``cost_usd`` to the named bucket and enforce the global cap.

        Buckets are ``"agent"`` and ``"eval"`` so the runner can report a split
        in ``BenchmarkResult.{agent_cost_usd, eval_cost_usd}``. The cost cap is
        applied to the combined total — operators care about wall-spend.
        """
        if cost_usd <= 0:
            return
        async with self._spent_lock:
            if bucket == "agent":
                self._agent_spent_usd += cost_usd
            elif bucket == "eval":
                self._eval_spent_usd += cost_usd
            else:
                raise ValueError(f"unknown cost bucket: {bucket!r}")
            total = self._agent_spent_usd + self._eval_spent_usd
            if total > self.max_cost_usd:
                self._budget_exhausted = True
                raise CostBudgetExceeded(
                    f"spent ${total:.4f} exceeded cap "
                    f"${self.max_cost_usd:.4f} on {scenario_id}#{seed} (bucket={bucket})"
                )

    def _failure_result(
        self,
        scenario: Scenario,
        seed: int,
        reason: str,
        message: str,
        *,
        turns: list[TurnResult] | None = None,
        evaluator_trace: list[EvaluatorTraceEntry] | None = None,
    ) -> ScenarioResult:
        retained_turns = list(turns or [])
        return ScenarioResult(
            scenario_id=scenario.id,
            seed=seed,
            static_grading_mode=(
                self.static_grading_mode
                if scenario.mode is ScenarioMode.STATIC
                else None
            ),
            turns=retained_turns,
            state_hash_match=False,
            output_substring_matches=[False] * len(scenario.required_outputs),
            total_score=0.0,
            max_score=1.0,
            terminated_reason=reason,  # type: ignore[arg-type]
            total_cost_usd=sum(
                turn.cost_usd for turn in retained_turns if turn.cost_usd is not None
            ),
            total_latency_ms=sum(
                turn.latency_ms
                for turn in retained_turns
                if turn.latency_ms is not None
            ),
            error=message,
            evaluator_trace=list(evaluator_trace or []),
        )

    @staticmethod
    def _serialize_result_value(obj: Any) -> Any:
        """Convert nested result dataclasses and enums into JSON values."""
        if hasattr(obj, "__dataclass_fields__"):
            return {
                key: LifeOpsBenchRunner._serialize_result_value(value)
                for key, value in obj.__dict__.items()
            }
        if isinstance(obj, list):
            return [LifeOpsBenchRunner._serialize_result_value(item) for item in obj]
        if isinstance(obj, dict):
            return {
                key: LifeOpsBenchRunner._serialize_result_value(value)
                for key, value in obj.items()
            }
        if hasattr(obj, "value"):
            return obj.value
        return obj

    @staticmethod
    def save_results(
        result: BenchmarkResult,
        output_dir: str = "lifeops_bench_results",
    ) -> str:
        """Serialize a BenchmarkResult to JSON under `output_dir` and return the path."""
        if not result.complete:
            raise RuntimeError(
                "refusing to publish incomplete LifeOpsBench result: "
                f"successful={result.successful_run_count}/"
                f"{result.expected_run_count}, completed={result.completed_run_count}"
            )
        if (
            result.expected_run_count <= 0
            or result.completed_run_count != result.expected_run_count
            or result.successful_run_count != result.expected_run_count
            or not re.fullmatch(r"[0-9a-f]{64}", result.workload_sha256)
        ):
            raise RuntimeError(
                "refusing to publish LifeOpsBench result with invalid completeness "
                "or workload provenance"
            )
        if not all(
            (
                result.agent_model_name,
                result.agent_adapter,
                result.agent_provider,
            )
        ):
            raise RuntimeError(
                "refusing to publish LifeOpsBench result without acting-agent "
                "provenance"
            )
        if result.static_run_count and result.static_grading_mode != "semantic":
            raise RuntimeError(
                "refusing to publish STATIC LifeOpsBench results from the "
                "offline_conformance lane"
            )
        if result.semantic_static_judged_count != result.semantic_static_run_count:
            raise RuntimeError(
                "refusing to publish LifeOpsBench result without complete, "
                "valid semantic judge coverage: "
                f"judged={result.semantic_static_judged_count}/"
                f"{result.semantic_static_run_count}"
            )
        os.makedirs(output_dir, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        safe = (
            re.sub(r"[^A-Za-z0-9_.-]+", "-", result.agent_model_name).strip("-")
            or "model"
        )
        path = os.path.join(output_dir, f"lifeops_{safe}_{timestamp}.json")

        with open(path, "w") as fh:
            json.dump(
                LifeOpsBenchRunner._serialize_result_value(result),
                fh,
                indent=2,
                default=str,
            )
        logger.info("Results saved to %s", path)
        return path

    @staticmethod
    def save_diagnostic_results(
        result: BenchmarkResult,
        output_dir: str = "lifeops_bench_results",
    ) -> str:
        """Persist an incomplete run as explicitly non-publishable evidence.

        Provider failures, timeouts, and harness errors are evidence too. They
        live under a diagnostic subdirectory so result collectors cannot
        mistake them for publishable benchmark artifacts.
        """
        if result.complete:
            raise RuntimeError(
                "save_diagnostic_results accepts only incomplete benchmark runs"
            )
        diagnostic_dir = os.path.join(output_dir, "diagnostics")
        os.makedirs(diagnostic_dir, exist_ok=True)
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S_%f")
        safe = (
            re.sub(
                r"[^A-Za-z0-9_.-]+",
                "-",
                result.agent_model_name or "unknown-model",
            ).strip("-")
            or "unknown-model"
        )
        path = os.path.join(
            diagnostic_dir,
            f"lifeops_diagnostic_{safe}_{timestamp}.json",
        )
        reasons = [
            "incomplete workload: "
            f"successful={result.successful_run_count}/"
            f"{result.expected_run_count}, "
            f"completed={result.completed_run_count}",
            *[
                f"{scenario.scenario_id}#{scenario.seed}: "
                f"{scenario.terminated_reason}: {scenario.error}"
                for scenario in result.scenarios
                if scenario.error is not None
            ],
        ]
        payload = LifeOpsBenchRunner._serialize_result_value(result)
        if not isinstance(payload, dict):
            raise RuntimeError("serialized benchmark diagnostic must be an object")
        payload["artifact_tier"] = "diagnostic_nonpublishable"
        payload["publishable"] = False
        payload["nonpublishable_reasons"] = reasons
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, default=str)
        logger.warning("Non-publishable diagnostic results saved to %s", path)
        return path

    @staticmethod
    def save_conformance_results(
        result: BenchmarkResult,
        output_dir: str = "lifeops_bench_results",
    ) -> str:
        """Persist an explicitly non-publishable offline-conformance artifact."""
        if result.static_grading_mode != "offline_conformance":
            raise RuntimeError(
                "save_conformance_results requires offline_conformance mode"
            )
        if not result.complete:
            raise RuntimeError(
                "refusing to save incomplete LifeOpsBench conformance result"
            )
        os.makedirs(output_dir, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        path = os.path.join(
            output_dir,
            f"lifeops_conformance_{timestamp}.json",
        )
        with open(path, "w") as fh:
            json.dump(
                LifeOpsBenchRunner._serialize_result_value(result),
                fh,
                indent=2,
                default=str,
            )
        logger.info("Non-publishable conformance results saved to %s", path)
        return path

    @staticmethod
    def print_summary(result: BenchmarkResult) -> None:
        """Print a human-readable summary."""
        print("\n" + "=" * 60)
        print("  LifeOpsBench Results Summary")
        print("=" * 60)
        evaluator_label = (
            f"{result.evaluator_provider} → {result.model_name}"
            if result.evaluator_provider
            else result.model_name
        )
        judge_label = (
            f"{result.judge_provider} → {result.judge_model_name}"
            if result.judge_provider
            else result.judge_model_name
        )
        agent_label = (
            f"{result.agent_provider} → {result.agent_model_name}"
            if result.agent_provider
            else result.agent_model_name
        )
        if result.agent_adapter:
            agent_label = f"{result.agent_adapter} / {agent_label}"
        print(f"  Agent:              {agent_label}")
        print(f"  Evaluator:          {evaluator_label}")
        print(f"  Judge:              {judge_label}")
        print(f"  Seeds per scenario: {result.seeds}")
        print(f"  Scenarios run:      {len(result.scenarios)}")
        print(f"  pass@1:             {result.pass_at_1:.3f}")
        print(f"  pass@k:             {result.pass_at_k:.3f}")
        print(f"  Known cost:         ${result.total_cost_usd:.4f}")
        print(f"    agent:            ${result.agent_cost_usd:.4f}")
        print(f"    eval:             ${result.eval_cost_usd:.4f}")
        if result.unpriced_agent_call_count or result.unpriced_eval_call_count:
            print(
                "  Unpriced calls:     "
                f"{result.unpriced_agent_call_count} agent + "
                f"{result.unpriced_eval_call_count} evaluator/judge"
            )
        print(f"  Total latency:      {result.total_latency_ms / 1000:.2f}s")
        print()
        print("  Mean score per domain:")
        for domain, score in sorted(result.mean_score_per_domain.items()):
            print(f"    {domain:<12} {score:.3f}")
        print("=" * 60 + "\n")


def _extract_tool_call_id(
    agent_turn: MessageTurn,
    action: Action,
    action_index: int,
) -> str | None:
    """Correlate an extracted action with the same-position raw tool call."""
    if not agent_turn.tool_calls:
        return None
    if action_index >= len(agent_turn.tool_calls):
        return None
    call = agent_turn.tool_calls[action_index]
    name = (
        call.get("function", {}).get("name")
        if isinstance(call.get("function"), dict)
        else call.get("name")
    )
    if name == action.name:
        call_id = call.get("id")
        return call_id if isinstance(call_id, str) and call_id else None
    return None
