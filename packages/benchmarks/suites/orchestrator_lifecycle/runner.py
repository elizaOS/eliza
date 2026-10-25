"""Run multi-turn orchestration scenarios through one shared TASKS contract.

Bridge mode gives elizaOS a dedicated AgentRuntime whose planner registry is
scoped to a capture-only TASKS action; Hermes and OpenClaw receive the same
schema and neutral capture result through their native tool bridges. Synthetic
targets are never executed, so structural events prove lifecycle intent rather
than external side effects. Only strict bridge runs are scored.

Simulate mode emits deterministic typed events for credential-free harness and
evaluator smoke tests. Its reports are marked unscored and withhold the overall
score so they cannot be published as benchmark results.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from copy import deepcopy
import hashlib
import logging
import os
from pathlib import Path
import sys
import uuid

from benchmarks.publication_contracts import (
    ORCHESTRATOR_LIFECYCLE_FULL_CORPUS_SHA256,
    ORCHESTRATOR_LIFECYCLE_FULL_SCENARIO_ID_MANIFEST_SHA256,
    ORCHESTRATOR_LIFECYCLE_FULL_SCENARIO_COUNT,
    ORCHESTRATOR_LIFECYCLE_FULL_USER_TURN_COUNT,
    ORCHESTRATOR_LIFECYCLE_FULL_USER_TURN_MANIFEST_SHA256,
    ORCHESTRATOR_LIFECYCLE_SYSTEM_HINT_SHA256,
    ORCHESTRATOR_LIFECYCLE_TOOL_CONTRACT_COUNT,
    ORCHESTRATOR_LIFECYCLE_TOOL_CONTRACT_NAMES,
    ORCHESTRATOR_LIFECYCLE_TOOL_CONTRACT_SHA256,
    canonical_identifier_manifest_sha256,
    canonical_json_sha256,
)

from .contract import (
    LIFECYCLE_SYSTEM_HINT as _LIFECYCLE_SYSTEM_HINT,
    LIFECYCLE_TASKS_TOOLS as _LIFECYCLE_TASKS_TOOLS,
)
from .dataset import LifecycleDataset, scenario_corpus_sha256
from .evaluator import LifecycleEvaluator
from .events import extract_lifecycle_events
from .reporting import save_report
from .types import (
    LifecycleConfig,
    LifecycleMetrics,
    Scenario,
    ScenarioResult,
    ScenarioTurn,
    TurnRecord,
)

logger = logging.getLogger(__name__)

_REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
_LIFECYCLE_WORKSPACE_ENV = "ORCHESTRATOR_LIFECYCLE_WORKSPACE_PATH"
_DEFAULT_REASONING_EFFORT = "medium"
_ALLOWED_REASONING_EFFORTS = frozenset({"low", "medium", "high", "xhigh", "max"})


def _ensure_eliza_adapter_on_path() -> None:
    """Make ``eliza_adapter`` importable across both runner entry points.

    Orchestrated and direct module execution establish different ``sys.path``
    roots, so the package-local adapter path is added idempotently.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.normpath(os.path.join(here, "..", "..", "harnesses", "eliza")),
        os.path.normpath(os.path.join(here, "..", "..", "..", "harnesses", "eliza")),
    ]
    for candidate in candidates:
        if os.path.isdir(candidate) and candidate not in sys.path:
            sys.path.insert(0, candidate)


def _restore_environment(previous_values: Mapping[str, str | None]) -> None:
    for name, previous in previous_values.items():
        if previous is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = previous


def _lifecycle_reasoning_effort() -> str:
    configured = {
        value.strip().lower()
        for name in (
            "BENCHMARK_REASONING_EFFORT",
            "OPENAI_REASONING_EFFORT",
            "OPENCLAW_THINKING_LEVEL",
        )
        if (value := os.environ.get(name)) is not None and value.strip()
    }
    if len(configured) > 1:
        raise RuntimeError("orchestrator_lifecycle: reasoning-effort controls disagree")
    effort = next(iter(configured), _DEFAULT_REASONING_EFFORT)
    if effort not in _ALLOWED_REASONING_EFFORTS:
        raise RuntimeError(
            f"orchestrator_lifecycle: unsupported reasoning effort {effort!r}"
        )
    return effort


def _canonical_external_turn_history(
    *,
    turn_message: str,
    record: TurnRecord,
    turn_index: int,
) -> list[dict[str, object]]:
    """Mirror Eliza's persisted user/final-reply history for isolated lanes."""

    del turn_index
    return [
        {"role": "user", "content": turn_message},
        {"role": "assistant", "content": record.reply_text},
    ]


def _assert_external_workspace_provenance(params: Mapping[str, object]) -> None:
    harness = (
        (
            os.environ.get("ELIZA_BENCH_HARNESS")
            or os.environ.get("BENCHMARK_HARNESS")
            or ""
        )
        .strip()
        .lower()
    )
    if harness not in {"hermes", "openclaw"}:
        return
    meta = params.get("_meta")
    if not isinstance(meta, Mapping):
        raise RuntimeError(
            "orchestrator_lifecycle: external bridge omitted workspace provenance"
        )
    provenance: Mapping[str, object]
    if harness == "openclaw":
        openclaw = meta.get("openclaw_adapter")
        if not isinstance(openclaw, Mapping):
            raise RuntimeError(
                "orchestrator_lifecycle: OpenClaw omitted adapter provenance"
            )
        provenance = openclaw
    else:
        provenance = meta
    target = provenance.get("benchmark_workspace_path")
    if not isinstance(target, str) or Path(target).resolve() != _REPOSITORY_ROOT:
        raise RuntimeError(
            f"orchestrator_lifecycle: {harness} benchmark workspace drifted"
        )
    if harness == "hermes":
        native_cwd = provenance.get("native_process_cwd")
        if (
            not isinstance(native_cwd, str)
            or Path(native_cwd).resolve() != _REPOSITORY_ROOT
        ):
            raise RuntimeError(
                "orchestrator_lifecycle: Hermes native process cwd drifted"
            )
    elif provenance.get("runtime_workspace_isolated") is not True:
        raise RuntimeError(
            "orchestrator_lifecycle: OpenClaw runtime workspace isolation is unproven"
        )


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

        self._strict_scenarios = self._validate_strict_configuration_before_runtime()

        self._server_manager = None
        self._client = None
        if self._mode == "bridge":
            _ensure_eliza_adapter_on_path()
            from eliza_adapter.client import ElizaClient
            from eliza_adapter.server_manager import ElizaServerManager

            reasoning_effort = _lifecycle_reasoning_effort()
            construction_env = {
                _LIFECYCLE_WORKSPACE_ENV: str(_REPOSITORY_ROOT),
                "BENCHMARK_REASONING_EFFORT": reasoning_effort,
                "OPENAI_REASONING_EFFORT": reasoning_effort,
                "OPENCLAW_THINKING_LEVEL": reasoning_effort,
            }
            previous_values = {name: os.environ.get(name) for name in construction_env}
            existing_server_env = ("ELIZA_BENCH_URL", "ELIZA_BENCH_TOKEN")
            existing_server_previous = {
                name: os.environ.get(name) for name in existing_server_env
            }
            strict_subscription = (
                self.config.strict
                and self.config.provider.strip().lower() == "claude-subscription"
            )
            os.environ.update(construction_env)
            if strict_subscription:
                for name in existing_server_env:
                    os.environ.pop(name, None)
            try:
                existing_url = os.environ.get("ELIZA_BENCH_URL", "").strip()
                if existing_url:
                    self._client = ElizaClient(existing_url)
                    self._client.wait_until_ready(timeout=120)
                else:
                    lifecycle_env = {
                        "ELIZA_BENCH_REQUIRE_ORCHESTRATOR": "1",
                        "ELIZA_BENCH_LIFECYCLE_PROFILE": "1",
                    }
                    lifecycle_previous = {
                        name: os.environ.get(name) for name in lifecycle_env
                    }
                    if not _uses_external_lifecycle_bridge():
                        os.environ.update(lifecycle_env)
                    try:
                        self._server_manager = ElizaServerManager(
                            repo_root=_REPOSITORY_ROOT
                        )
                        self._server_manager.start()
                        self._client = self._server_manager.client
                    finally:
                        _restore_environment(lifecycle_previous)
            finally:
                _restore_environment(previous_values)
                if strict_subscription:
                    _restore_environment(existing_server_previous)
            self._assert_lifecycle_runtime_ready()

    def _validate_strict_configuration_before_runtime(
        self,
    ) -> list[Scenario] | None:
        """Pin scored runs before any adapter, server, or client can start."""

        if not self.config.strict:
            return None
        if self._mode != "bridge":
            raise RuntimeError(
                "orchestrator_lifecycle: strict mode requires bridge mode; use "
                "--no-strict for diagnostics"
            )
        if self.config.max_scenarios is not None or self.config.scenario_filter:
            raise RuntimeError(
                "orchestrator_lifecycle: strict mode does not permit scenario "
                "filters or limits; use --no-strict for diagnostics"
            )

        validation = self.dataset.validate_scenarios()
        if not validation["valid"]:
            raise RuntimeError(
                f"orchestrator_lifecycle: invalid strict scenario corpus: {validation}"
            )
        scenarios = self.dataset.load()
        scenario_ids = [scenario.scenario_id for scenario in scenarios]
        user_turn_manifest = [
            {
                "scenario_id": scenario.scenario_id,
                "turn_index": turn_index,
                "message": turn.message,
            }
            for scenario in sorted(scenarios, key=lambda item: item.scenario_id)
            for turn_index, turn in enumerate(
                candidate for candidate in scenario.turns if candidate.actor == "user"
            )
        ]
        if (
            hashlib.sha256(_LIFECYCLE_SYSTEM_HINT.encode("utf-8")).hexdigest()
            != ORCHESTRATOR_LIFECYCLE_SYSTEM_HINT_SHA256
        ):
            raise RuntimeError(
                "orchestrator_lifecycle: strict mode requires the pinned shared "
                "system hint"
            )

        if (
            len(scenarios) != ORCHESTRATOR_LIFECYCLE_FULL_SCENARIO_COUNT
            or len(user_turn_manifest) != ORCHESTRATOR_LIFECYCLE_FULL_USER_TURN_COUNT
            or scenario_corpus_sha256(scenarios)
            != ORCHESTRATOR_LIFECYCLE_FULL_CORPUS_SHA256
            or canonical_identifier_manifest_sha256(scenario_ids)
            != ORCHESTRATOR_LIFECYCLE_FULL_SCENARIO_ID_MANIFEST_SHA256
            or canonical_json_sha256(user_turn_manifest)
            != ORCHESTRATOR_LIFECYCLE_FULL_USER_TURN_MANIFEST_SHA256
        ):
            raise RuntimeError(
                "orchestrator_lifecycle: strict mode requires the pinned "
                "132-scenario/154-turn corpus and manifests"
            )

        tool_contracts = list(_LIFECYCLE_TASKS_TOOLS)
        tool_names = [
            contract.get("function", {}).get("name")
            for contract in tool_contracts
            if isinstance(contract.get("function"), Mapping)
        ]
        if (
            len(tool_contracts) != ORCHESTRATOR_LIFECYCLE_TOOL_CONTRACT_COUNT
            or tool_names != list(ORCHESTRATOR_LIFECYCLE_TOOL_CONTRACT_NAMES)
            or canonical_json_sha256(tool_contracts)
            != ORCHESTRATOR_LIFECYCLE_TOOL_CONTRACT_SHA256
        ):
            raise RuntimeError(
                "orchestrator_lifecycle: strict mode requires the pinned single "
                "TASKS tool contract"
            )
        return scenarios

    def _assert_lifecycle_runtime_ready(self) -> None:
        """Fail before scoring unless Eliza has the isolated subscription profile."""

        if _uses_external_lifecycle_bridge() or self._client is None:
            return
        health = self._client.health()
        action_catalog = health.get("lifecycle_action_catalog")
        expected_contexts = [
            "general",
            "code",
            "automation",
            "agent_internal",
            "connectors",
        ]
        expected_model_handlers = {
            model_type: [{"provider": "openai", "priority": 0}]
            for model_type in (
                "ACTION_PLANNER",
                "RESPONSE_HANDLER",
                "TEXT_LARGE",
                "TEXT_MEDIUM",
                "TEXT_MEGA",
                "TEXT_NANO",
                "TEXT_SMALL",
                "TEXT_TOKENIZER_DECODE",
                "TEXT_TOKENIZER_ENCODE",
            )
        }
        if (
            health.get("lifecycle_profile_active") is not True
            or health.get("lifecycle_task_action_registered") is not True
            or action_catalog != ["TASKS"]
            or health.get("lifecycle_action_count") != 1
            or health.get("lifecycle_task_contexts") != expected_contexts
            or health.get("lifecycle_tool_bridge") != "lifecycle_capture_only"
            or health.get("lifecycle_task_unconditionally_planner_available")
            is not True
            or health.get("lifecycle_force_tool_call_disabled") is not True
            or health.get("lifecycle_benchmark_provider_mode")
            != "shared_system_hint_only"
            or health.get("lifecycle_benchmark_provider_registered") is not True
            or health.get("lifecycle_benchmark_provider_payload_neutral") is not True
            or health.get("subscription_chat_only") is not True
            or health.get("embeddingMode") != "disabled-text-only"
            or health.get("semanticMemoryEnabled") is not False
            or health.get("standIn") is not False
            or health.get("releaseEvidence") is not True
            or health.get("model_handlers") != expected_model_handlers
        ):
            raise RuntimeError(
                "orchestrator_lifecycle: Eliza benchmark runtime lacks the "
                "scoped native TASKS catalog or subscription-only model profile; "
                "start a dedicated server with "
                "ELIZA_BENCH_LIFECYCLE_PROFILE=1 and "
                "ELIZA_BENCH_REQUIRE_ORCHESTRATOR=1"
            )

    def close(self) -> None:
        if self._server_manager is not None:
            try:
                self._server_manager.stop()
            except Exception as exc:  # pragma: no cover - cleanup
                # error-policy:J6 Shutdown must not hide the benchmark result.
                logger.debug("ElizaServerManager.stop failed: %s", exc)

    def __enter__(self) -> "LifecycleRunner":
        return self

    def __exit__(self, *_exc_info: object) -> None:
        self.close()

    # ------------------------------------------------------------------
    # Scenario execution
    # ------------------------------------------------------------------
    def run(self) -> tuple[list[ScenarioResult], LifecycleMetrics, str]:
        validate = getattr(self.dataset, "validate_scenarios", None)
        if callable(validate):
            validation = validate()
            if not validation["valid"]:
                raise RuntimeError(
                    f"orchestrator_lifecycle: invalid scenario corpus: {validation}"
                )
        scenarios = (
            list(self._strict_scenarios)
            if getattr(self, "_strict_scenarios", None) is not None
            else self.dataset.load()
        )
        if not scenarios:
            raise RuntimeError("orchestrator_lifecycle: scenario corpus is empty")
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
        if not scenarios:
            raise RuntimeError(
                "orchestrator_lifecycle: selection contains no scenarios"
            )

        results: list[ScenarioResult] = []
        transcripts: dict[str, list[dict[str, object]]] = {}
        for scenario in scenarios:
            conversation: list[dict[str, object]] = []
            benchmark_messages: list[dict[str, object]] = []
            turn_records: list[TurnRecord] = []
            # Correlation IDs remain opaque so a future adapter cannot expose
            # scenario labels such as `cancel_task` through model context.
            task_id = f"orchestrator-lifecycle-{uuid.uuid4().hex}"
            self._reset_session(task_id=task_id, scenario_id=scenario.scenario_id)
            for scenario_turn_index, turn in enumerate(scenario.turns):
                conversation.append({"actor": turn.actor, "message": turn.message})
                if turn.actor != "user":
                    if turn.actor == "assistant":
                        benchmark_messages.append(
                            {"role": "assistant", "content": turn.message}
                        )
                    continue
                record = self._reply(
                    turn=turn,
                    task_id=task_id,
                    scenario_id=scenario.scenario_id,
                    benchmark_messages=benchmark_messages,
                )
                turn_records.append(record)
                conversation.append(
                    {
                        "actor": "assistant",
                        "message": record.reply_text,
                        "actions": list(record.actions),
                        "params": dict(record.params),
                        "events": list(record.events),
                    }
                )
                benchmark_messages.extend(
                    _canonical_external_turn_history(
                        turn_message=turn.message,
                        record=record,
                        turn_index=scenario_turn_index,
                    )
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
            raise RuntimeError(
                "orchestrator_lifecycle: reset failed for "
                f"scenario {scenario_id} task {task_id}"
            ) from exc

    def _reply(
        self,
        *,
        turn: ScenarioTurn,
        task_id: str,
        scenario_id: str,
        benchmark_messages: Sequence[Mapping[str, object]] = (),
    ) -> TurnRecord:
        if self._mode == "bridge":
            return self._reply_via_bridge(
                turn=turn,
                task_id=task_id,
                scenario_id=scenario_id,
                benchmark_messages=benchmark_messages,
            )
        return _simulate_turn(turn)

    def _reply_via_bridge(
        self,
        *,
        turn: ScenarioTurn,
        task_id: str,
        scenario_id: str,
        benchmark_messages: Sequence[Mapping[str, object]] = (),
    ) -> TurnRecord:
        assert self._client is not None
        base_context = {
            "benchmark": "orchestrator_lifecycle",
            "task_id": task_id,
            "model_name": self.config.model,
            "system_hint": _LIFECYCLE_SYSTEM_HINT,
            "reasoning_effort": _lifecycle_reasoning_effort(),
        }
        if _uses_external_lifecycle_bridge():
            # Eliza owns a persistent room and its scoped TASKS action. The
            # isolated Hermes/OpenClaw turns instead need an explicit history
            # carrier and the equivalent benchmark-scoped action surface.
            base_context.update(
                {
                    "benchmark_messages": [
                        dict(message) for message in benchmark_messages
                    ],
                    "benchmark_workspace_path": str(_REPOSITORY_ROOT),
                    "tools": deepcopy(list(_LIFECYCLE_TASKS_TOOLS)),
                    "tool_choice": "auto",
                }
            )
        try:
            response = self._client.send_message(
                text=turn.message,
                context=dict(base_context),
            )
        except Exception as exc:
            # error-policy:J2 A transport failure is not a zero-scoring model reply.
            raise RuntimeError(
                "orchestrator_lifecycle: bridge call failed for "
                f"scenario {scenario_id} task {task_id}"
            ) from exc
        text = (response.text or "").strip()
        params: Mapping[str, object] = (
            response.params if isinstance(response.params, Mapping) else {}
        )
        _assert_external_workspace_provenance(params)
        actions: Sequence[str] = (
            response.actions if isinstance(response.actions, Sequence) else []
        )
        return TurnRecord(
            reply_text=text,
            actions=[str(name) for name in actions],
            params=dict(params),
            events=extract_lifecycle_events(actions, params),
        )


def _uses_external_lifecycle_bridge() -> bool:
    harness = (
        (
            os.environ.get("ELIZA_BENCH_HARNESS")
            or os.environ.get("BENCHMARK_HARNESS")
            or ""
        )
        .strip()
        .lower()
    )
    return harness in {"hermes", "openclaw"}


# ----------------------------------------------------------------------
# Deterministic simulator (smoke-test mode only — never scored)
# ----------------------------------------------------------------------
def _simulate_turn(turn: ScenarioTurn) -> TurnRecord:
    """Deterministic ideal-orchestrator stand-in for offline smoke tests.

    Emits the typed lifecycle events a correct orchestrator would emit for
    the user message, plus natural prose. The prose intentionally shares no
    vocabulary contract with the evaluator — a simulator (or agent) that
    only *says* things without emitting the events fails evaluation.
    """
    msg = turn.message.lower()
    expected = set(turn.expected_behaviors)

    def record(
        reply: str,
        events: list[str],
    ) -> TurnRecord:
        arguments_by_event: dict[str, dict[str, object]] = {
            "spawn": {"action": "spawn_agent", "task": turn.message},
            "send": {"action": "send", "input": turn.message},
            "pause": {"action": "control", "controlAction": "pause"},
            "resume": {
                "action": "control",
                "controlAction": "resume",
                "instruction": turn.message,
            },
            "cancel": {"action": "cancel"},
            "status_query": {"action": "list_agents"},
            "share": {"action": "share"},
        }
        lifecycle_results = [
            {
                "name": "TASKS",
                "arguments": arguments_by_event[event],
                "result": {
                    "captured": True,
                    "effect": "not_executed",
                    "sequence": sequence,
                    "tool": "TASKS",
                },
            }
            for sequence, event in enumerate(events)
            if event in arguments_by_event
        ]
        params: dict[str, object] = (
            {"lifecycle_results": lifecycle_results} if lifecycle_results else {}
        )
        return TurnRecord(
            reply_text=reply,
            actions=[],
            params=params,
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
            "I captured the cancellation request; this benchmark did not execute it.",
            ["cancel"],
        )
    if any(
        token in msg
        for token in ("fix", "test", "shell", "code", "implement", "research")
    ):
        events = ["spawn"]
        if "report_active_subagent_status" in expected:
            events.append("status_query")
        return record(
            "I have put a dedicated worker on this and will flag anything "
            "notable as it lands.",
            events,
        )
    if "change" in msg or "scope" in msg or "replan" in msg or "re-plan" in msg:
        return record(
            "Got it — I folded that into the running work and adjusted the approach.",
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
