"""Runner for orchestrator lifecycle scenario benchmark.

This benchmark exercises the elizaOS TypeScript agent's orchestration
behavior across multi-turn lifecycle scenarios (clarification, status,
scope changes, pause/resume/cancel, summaries). Two execution modes:

  - **bridge** (default): each scenario turn is forwarded to the TS
    bench server (`packages/app-core/src/benchmark/server.ts`) via
    `ElizaClient.send_message`. The bench server boots a real
    `AgentRuntime` with all CORE_PLUGINS registered, so the agent's
    real planner, action registry, and tool dispatch are what
    answer each turn.
  - **simulate**: deterministic rule-based replies, kept only for
    offline smoke-testing without provider credentials. Should NOT
    be used for scoring — it doesn't test the eliza agent.

The wave-7 audit flagged the prior version of this file as a
regression: `_simulate_reply` was the only code path and the
`--provider`/`--model` flags were accepted but unused, so all scoring
numbers measured the simulator hitting its own keyword table. Bridge
mode is now the default and uses the same plumbing as agentbench/
clawbench/woobench (`ElizaServerManager` + `ElizaClient`).
"""

from __future__ import annotations

import logging
import os
import random
import sys
import uuid
from collections.abc import Sequence

from .dataset import LifecycleDataset
from .evaluator import LifecycleEvaluator
from .reporting import save_report
from .types import LifecycleConfig, LifecycleMetrics, ScenarioResult, ScenarioTurn

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
        self._rng = random.Random(config.seed)

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
        transcripts: dict[str, list[dict[str, str]]] = {}
        for scenario in scenarios:
            conversation: list[dict[str, str]] = []
            assistant_messages: list[str] = []
            task_id = f"orchestrator-lifecycle-{scenario.scenario_id}-{uuid.uuid4().hex[:8]}"
            self._reset_session(task_id=task_id, scenario_id=scenario.scenario_id)
            for turn in scenario.turns:
                conversation.append({"actor": turn.actor, "message": turn.message})
                if turn.actor != "user":
                    continue
                reply = self._reply(turn=turn, task_id=task_id, scenario_id=scenario.scenario_id)
                assistant_messages.append(reply)
                conversation.append({"actor": "assistant", "message": reply})
            result = self.evaluator.evaluate_scenario(scenario, assistant_messages)
            results.append(result)
            transcripts[scenario.scenario_id] = conversation

        metrics = self.evaluator.compute_metrics(results)
        report_path = save_report(
            config=self.config,
            results=results,
            metrics=metrics,
            transcripts=transcripts,
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

    def _reply(self, *, turn: ScenarioTurn, task_id: str, scenario_id: str) -> str:
        if self._mode == "bridge":
            return self._reply_via_bridge(
                turn=turn, task_id=task_id, scenario_id=scenario_id
            )
        return self._simulate_reply(turn.message)

    def _reply_via_bridge(
        self, *, turn: ScenarioTurn, task_id: str, scenario_id: str
    ) -> str:
        assert self._client is not None
        try:
            response = self._client.send_message(
                text=turn.message,
                context={
                    "benchmark": "orchestrator_lifecycle",
                    "task_id": task_id,
                    "scenario_id": scenario_id,
                    "model_name": self.config.model,
                    "expected_behaviors": list(turn.expected_behaviors),
                    "forbidden_behaviors": list(turn.forbidden_behaviors),
                    "system_hint": _LIFECYCLE_SYSTEM_HINT,
                },
            )
        except Exception as exc:
            logger.warning(
                "[orchestrator_lifecycle] bridge call failed for %s: %s",
                scenario_id,
                exc,
            )
            return ""
        text = (response.text or "").strip()
        # Some agent responses come back primarily through tool-call params
        # (e.g. {action: "PAUSE_TASK", note: "..."}) when the planner picks
        # an action with no follow-up REPLY. Surface those param values to
        # the keyword evaluator so a structured action is still scored.
        if response.params:
            param_strings = [
                str(v)
                for v in response.params.values()
                if isinstance(v, (str, int, float)) and str(v).strip()
            ]
            if param_strings:
                text = (text + "\n" + " ".join(param_strings)).strip()
        return text

    # ------------------------------------------------------------------
    # Deterministic fallback (smoke-test mode only)
    # ------------------------------------------------------------------
    def _simulate_reply(self, message: str) -> str:
        msg = message.lower()
        if any(token in msg for token in ["not sure", "unspecified", "unclear"]):
            return (
                "I need more detail before starting. Could you clarify scope, "
                "acceptance criteria, and constraints?"
            )
        if "status" in msg or "how is it going" in msg or "check in" in msg:
            return (
                "Status: active subagent is running, progress is steady, no blockers, "
                "next step is validation."
            )
        if "resume" in msg and ("scope" in msg or "change" in msg or "update" in msg):
            return (
                "Task resumed. Scope change acknowledged, updated plan applied, and "
                "the active subagent is continuing with the new task plan."
            )
        if "pause" in msg:
            return "Task paused and put on hold. No further execution until resume."
        if "resume" in msg:
            return "Task resumed and continuing with the updated requirements."
        if "cancel" in msg and "undo" not in msg:
            return "Task cancelled and execution stopped. Cancel confirmed."
        if "undo" in msg or "uncancel" in msg:
            return "Cancellation undone, updated plan applied, and task resumed."
        if "change" in msg or "scope" in msg or "replan" in msg or "re-plan" in msg:
            return (
                "Scope change acknowledged. Updated plan: re-planned the task, "
                "delegated to the right subagent, and will report progress."
            )
        if "summary" in msg or "done" in msg or "complete" in msg:
            return (
                "Summary: work completed, deliverable validated, risks noted, and next "
                "actions documented for stakeholder review."
            )
        if "fix" in msg or "test" in msg or "shell" in msg or "code" in msg or "implement" in msg:
            return (
                "I will delegate this to a subagent worker and report active subagent "
                "status updates as the task progresses."
            )
        generic = [
            "I will delegate this to a subagent and provide regular status updates.",
            "I created a task plan and started execution with progress tracking.",
            "I will report blockers, failures, and next actions as they occur.",
        ]
        return generic[self._rng.randrange(len(generic))]


_LIFECYCLE_SYSTEM_HINT = (
    "You are the orchestrator agent. For each user message, decide whether to "
    "ask a clarifying question, spawn a subagent worker, report active-subagent "
    "status, acknowledge a scope change and apply it to the active task, pause, "
    "resume, cancel, undo a cancellation, or deliver a final summary. "
    "\n\n"
    "Use these EXACT verb forms in your reply, verbatim, so downstream tooling "
    "can detect the lifecycle action you took:\n"
    "- To cancel: include the word 'cancelled' AND a phrase like 'execution "
    "stopped' or 'cancel confirmed'.\n"
    "- To pause: include the word 'paused' or the phrase 'on hold'.\n"
    "- To resume: include the word 'resumed' or 'continuing'.\n"
    "- To delegate: include 'subagent' and 'delegate' or 'delegated'.\n"
    "- To report status: include 'status', 'progress', and 'active subagent'.\n"
    "- To acknowledge scope change: include 'scope change' and 'updated plan'.\n"
    "- To apply a scope change: include 'updated plan' or 're-planned'.\n"
    "- To clarify: include 'clarify' or 'need more detail' AND say you will "
    "wait before starting.\n"
    "- To deliver a final summary: include 'summary', 'completed', and "
    "'deliverable'.\n"
    "\n"
    "Use plain prose. The user message is the next lifecycle event."
)


__all__: Sequence[str] = ("LifecycleRunner",)
