"""Runner for orchestrator lifecycle scenario benchmark.

This benchmark exercises the elizaOS TypeScript agent's orchestration
behavior across multi-turn lifecycle scenarios (clarification, status,
scope changes, pause/resume/cancel, summaries). Two execution modes:

  - **bridge** (default): each scenario turn is forwarded to the TS
    bench server (`packages/app-core/src/benchmark/server.ts`) via
    `ElizaClient.send_message`. The bench server boots a real
    `AgentRuntime` with all CORE_PLUGINS registered, so the agent's
    real planner, action registry, and tool dispatch are what
    answer each turn. Only bridge runs are scored.
  - **simulate**: a deterministic simulator that emits typed lifecycle
    events for offline smoke-testing of the harness + evaluator without
    provider credentials. Simulate reports are marked `mode: "simulate"`,
    `scored: false`, and their `metrics.overall_score` is withheld so the
    suite registry refuses to publish them as benchmark results.

Scoring is structural: the evaluator asserts the typed lifecycle events
(spawn/send/pause/resume/cancel/status_query/share) the agent actually
emitted per turn — extracted from the planner's selected actions and params
by `events.extract_lifecycle_events` — never keyword substrings in the
reply prose. The system hint below therefore describes the orchestrator
role without dictating any wording the evaluator could match on.
"""

from __future__ import annotations

import logging
import os
import sys
import uuid
from collections.abc import Mapping, Sequence

from .dataset import LifecycleDataset
from .evaluator import LifecycleEvaluator
from .events import extract_lifecycle_events
from .reporting import save_report
from .types import (
    LifecycleConfig,
    LifecycleMetrics,
    ScenarioResult,
    ScenarioTurn,
    TurnRecord,
)

logger = logging.getLogger(__name__)


def _ensure_eliza_adapter_on_path() -> None:
    """Make `eliza_adapter` importable when this module runs as
    `python -m benchmarks.orchestrator_lifecycle.cli`.

    The orchestrator already prepends `benchmarks/eliza-adapter` to
    PYTHONPATH for benchmarks listed in `_make_registry_adapter`'s
    bridge set, but this benchmark wasn't in that set before the
    bridge migration. Add it idempotently here so direct invocation
    (and older orchestrator builds) works too.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.normpath(os.path.join(here, "..", "eliza-adapter")),
        os.path.normpath(os.path.join(here, "..", "..", "benchmarks", "eliza-adapter")),
    ]
    for candidate in candidates:
        if os.path.isdir(candidate) and candidate not in sys.path:
            sys.path.insert(0, candidate)


class LifecycleRunner:
    def __init__(self, config: LifecycleConfig) -> None:
        self.config = config
        self.dataset = LifecycleDataset(config.scenario_dir)
        self.evaluator = LifecycleEvaluator()

        self._mode = (config.mode or "bridge").strip().lower()
        if self._mode not in {"bridge", "simulate"}:
            raise ValueError(
                f"orchestrator_lifecycle: unknown mode '{config.mode}'; "
                "expected 'bridge' or 'simulate'"
            )

        self._server_manager = None
        self._client = None
        if self._mode == "bridge":
            _ensure_eliza_adapter_on_path()
            from eliza_adapter.client import ElizaClient
            from eliza_adapter.server_manager import ElizaServerManager

            existing_url = os.environ.get("ELIZA_BENCH_URL", "").strip()
            if existing_url:
                self._client = ElizaClient(existing_url)
                self._client.wait_until_ready(timeout=120)
            else:
                self._server_manager = ElizaServerManager()
                self._server_manager.start()
                self._client = self._server_manager.client

    def close(self) -> None:
        if self._server_manager is not None:
            try:
                self._server_manager.stop()
            except Exception as exc:  # pragma: no cover - cleanup
                logger.debug("ElizaServerManager.stop failed: %s", exc)

    def __enter__(self) -> "LifecycleRunner":
        return self

    def __exit__(self, *_exc_info: object) -> None:
        self.close()

    # ------------------------------------------------------------------
    # Scenario execution
    # ------------------------------------------------------------------
    def run(self) -> tuple[list[ScenarioResult], LifecycleMetrics, str]:
        scenarios = self.dataset.load()
        if self.config.scenario_filter:
            token = self.config.scenario_filter.lower()
            scenarios = [
                scenario
                for scenario in scenarios
                if token in scenario.scenario_id.lower()
                or token in scenario.title.lower()
            ]
        if self.config.max_scenarios is not None:
            scenarios = scenarios[: self.config.max_scenarios]

        results: list[ScenarioResult] = []
        transcripts: dict[str, list[dict[str, object]]] = {}
        for scenario in scenarios:
            conversation: list[dict[str, object]] = []
            turn_records: list[TurnRecord] = []
            task_id = f"orchestrator-lifecycle-{scenario.scenario_id}-{uuid.uuid4().hex[:8]}"
            self._reset_session(task_id=task_id, scenario_id=scenario.scenario_id)
            for turn in scenario.turns:
                conversation.append({"actor": turn.actor, "message": turn.message})
                if turn.actor != "user":
                    continue
                record = self._reply(
                    turn=turn, task_id=task_id, scenario_id=scenario.scenario_id
                )
                turn_records.append(record)
                conversation.append(
                    {
                        "actor": "assistant",
                        "message": record.reply_text,
                        "actions": list(record.actions),
                        "events": list(record.events),
                    }
                )
            result = self.evaluator.evaluate_scenario(scenario, turn_records)
            results.append(result)
            transcripts[scenario.scenario_id] = conversation

        metrics = self.evaluator.compute_metrics(results)
        report_path = save_report(
            config=self.config,
            results=results,
            metrics=metrics,
            transcripts=transcripts,
            mode=self._mode,
        )
        return results, metrics, str(report_path)

    # ------------------------------------------------------------------
    # Reply dispatch
    # ------------------------------------------------------------------
    def _reset_session(self, *, task_id: str, scenario_id: str) -> None:
        if self._mode != "bridge" or self._client is None:
            return
        try:
            self._client.reset(
                task_id=task_id,
                benchmark="orchestrator_lifecycle",
            )
        except Exception as exc:
            logger.debug(
                "[orchestrator_lifecycle] reset failed for %s: %s",
                scenario_id,
                exc,
            )

    def _reply(
        self, *, turn: ScenarioTurn, task_id: str, scenario_id: str
    ) -> TurnRecord:
        if self._mode == "bridge":
            return self._reply_via_bridge(
                turn=turn, task_id=task_id, scenario_id=scenario_id
            )
        return _simulate_turn(turn.message)

    def _reply_via_bridge(
        self, *, turn: ScenarioTurn, task_id: str, scenario_id: str
    ) -> TurnRecord:
        assert self._client is not None
        base_context = {
            "benchmark": "orchestrator_lifecycle",
            "task_id": task_id,
            "scenario_id": scenario_id,
            "model_name": self.config.model,
            "system_hint": _LIFECYCLE_SYSTEM_HINT,
        }
        record = TurnRecord()
        for attempt in range(2):
            context = dict(base_context)
            if attempt:
                context["retry_empty_response"] = True
            try:
                response = self._client.send_message(text=turn.message, context=context)
            except Exception as exc:
                logger.warning(
                    "[orchestrator_lifecycle] bridge call failed for %s: %s",
                    scenario_id,
                    exc,
                )
                return record
            text = (response.text or "").strip()
            params: Mapping[str, object] = (
                response.params if isinstance(response.params, Mapping) else {}
            )
            actions: Sequence[str] = (
                response.actions if isinstance(response.actions, Sequence) else []
            )
            record = TurnRecord(
                reply_text=text,
                actions=[str(name) for name in actions],
                params=dict(params),
                events=extract_lifecycle_events(actions, params),
            )
            produced_signal = bool(text) or bool(record.events)
            if produced_signal and not (
                attempt == 0 and _is_retryable_bridge_failure(text)
            ):
                return record
            if attempt:
                return record
            logger.debug(
                "[orchestrator_lifecycle] retryable bridge reply for %s; retrying once",
                scenario_id,
            )
        return record


# The hint sets the orchestrator role and tells the agent to USE its task
# actions. It deliberately does not dictate any reply wording: the evaluator
# scores the typed events the planner emits, so there is nothing to coach.
_LIFECYCLE_SYSTEM_HINT = (
    "You are the orchestrator agent responsible for long-running tasks and "
    "subagent workers. For each user message, decide what the lifecycle "
    "situation requires — asking for missing information before starting, "
    "delegating work to a subagent, checking and reporting real task status, "
    "applying a scope change to the running work, pausing, resuming, "
    "cancelling, or delivering final results. Perform lifecycle operations "
    "with your task-management actions rather than only describing them in "
    "prose, and reply to the user in plain language."
)


def _is_retryable_bridge_failure(text: str) -> bool:
    normalized = " ".join(text.lower().split())
    return any(
        phrase in normalized
        for phrase in (
            "oops, something went wrong",
            "something went wrong on my end",
            "please try again",
        )
    )


# ----------------------------------------------------------------------
# Deterministic simulator (smoke-test mode only — never scored)
# ----------------------------------------------------------------------
def _simulate_turn(message: str) -> TurnRecord:
    """Deterministic ideal-orchestrator stand-in for offline smoke tests.

    Emits the typed lifecycle events a correct orchestrator would emit for
    the user message, plus natural prose. The prose intentionally shares no
    vocabulary contract with the evaluator — a simulator (or agent) that
    only *says* things without emitting the events fails evaluation.
    """
    msg = message.lower()

    def record(reply: str, events: list[str]) -> TurnRecord:
        return TurnRecord(
            reply_text=reply,
            actions=[],
            params={},
            events=list(events),
        )

    if any(token in msg for token in ("not sure", "unspecified", "unclear")):
        return record(
            "Happy to take this on — which piece of work do you mean, and "
            "what outcome matters most to you?",
            [],
        )
    if "status" in msg or "how is it going" in msg or "check in" in msg:
        return record(
            "Here is where things stand right now: collection finished and "
            "analysis is underway, no blockers.",
            ["status_query"],
        )
    if "undo" in msg or "uncancel" in msg:
        return record(
            "Picking the work back up with your latest direction applied.",
            ["resume", "send"],
        )
    if "pause" in msg:
        return record(
            "Understood — I have put a stop on the work for now; nothing "
            "further will run until you say so.",
            ["pause"],
        )
    if "resume" in msg and ("scope" in msg or "change" in msg or "update" in msg):
        return record(
            "Back underway, with your new priorities folded into the plan.",
            ["resume", "send"],
        )
    if "resume" in msg:
        return record("Back underway.", ["resume"])
    if "cancel" in msg:
        return record(
            "Done — I shut the work down; nothing further will run.",
            ["cancel"],
        )
    if any(
        token in msg for token in ("fix", "test", "shell", "code", "implement", "research")
    ):
        return record(
            "I have put a dedicated worker on this and will flag anything "
            "notable as it lands.",
            ["spawn"],
        )
    if "change" in msg or "scope" in msg or "replan" in msg or "re-plan" in msg:
        return record(
            "Got it — I folded that into the running work and adjusted the "
            "approach.",
            ["send"],
        )
    if "summary" in msg or "done" in msg or "complete" in msg:
        return record(
            "Here is the wrap-up for your stakeholders: what was delivered, "
            "the open risks, and the suggested next steps.",
            ["status_query"],
        )
    return record(
        "I have logged this and will route it appropriately.",
        [],
    )


__all__: Sequence[str] = ("LifecycleRunner",)
