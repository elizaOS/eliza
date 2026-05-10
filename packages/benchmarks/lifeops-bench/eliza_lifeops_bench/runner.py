"""Benchmark orchestration for LifeOpsBench.

Drives an agent through each scenario, applies its tool calls against an
in-memory `LifeWorld`, and computes per-scenario + aggregate scores.

The agent function signature is `(history, tool_manifest) -> next_assistant_turn`.
Tool calls embedded in the assistant turn (`tool_calls=[{...}]`) are executed
against the world via `_execute_action`. Unknown action names raise
`RuntimeError` so gaps surface immediately rather than silently no-op.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any

from .evaluator import LifeOpsEvaluator
from .lifeworld import EntityKind, LifeWorld
from .lifeworld.entities import Contact
from .scorer import (
    compile_benchmark_result,
    output_substring_match,
    score_scenario,
    state_hash,
)
from .types import (
    Action,
    BenchmarkResult,
    Domain,
    MessageTurn,
    Scenario,
    ScenarioMode,
    ScenarioResult,
    TurnResult,
)

logger = logging.getLogger(__name__)


AgentFn = Callable[[list[MessageTurn], list[dict[str, Any]]], Awaitable[MessageTurn]]
WorldFactory = Callable[[int, str], LifeWorld]


class CostBudgetExceeded(Exception):
    """Raised when the cumulative spend across scenarios exceeds the configured cap."""


class UnsupportedAction(RuntimeError):
    """Raised when the executor doesn't know how to apply an action against the world."""


# ---------------------------------------------------------------------------
# Action executor
# ---------------------------------------------------------------------------


def _execute_action(action: Action, world: LifeWorld) -> dict[str, Any]:
    """Apply a ground-truth-style `Action` to `world` and return a tool-result payload.

    Naming convention:
        <DOMAIN>.<verb>  e.g. CALENDAR.reschedule, MAIL.send, REMINDER.complete

    Unknown names raise `UnsupportedAction` — never silently no-op. The runner
    catches and surfaces these so gaps land in `LIFEOPS_BENCH_GAPS.md`.
    """
    handler = _ACTION_HANDLERS.get(action.name)
    if handler is None:
        raise UnsupportedAction(
            f"unsupported action in execute path: {action.name} — file gap in LIFEOPS_BENCH_GAPS.md"
        )
    return handler(world, action.kwargs)


def _h_calendar_create(world: LifeWorld, kw: dict[str, Any]) -> dict[str, Any]:
    event = world.create_calendar_event(
        event_id=kw["event_id"],
        calendar_id=kw["calendar_id"],
        title=kw["title"],
        start=kw["start"],
        end=kw["end"],
        description=kw.get("description", ""),
        location=kw.get("location"),
        attendees=kw.get("attendees"),
        all_day=kw.get("all_day", False),
        recurrence_rule=kw.get("recurrence_rule"),
    )
    return {"id": event.id, "title": event.title}


def _h_calendar_reschedule(world: LifeWorld, kw: dict[str, Any]) -> dict[str, Any]:
    event = world.move_event(kw["event_id"], start=kw["start"], end=kw["end"])
    return {"id": event.id, "start": event.start, "end": event.end}


def _h_calendar_cancel(world: LifeWorld, kw: dict[str, Any]) -> dict[str, Any]:
    event = world.cancel_event(kw["event_id"])
    return {"id": event.id, "status": event.status}


def _h_mail_send(world: LifeWorld, kw: dict[str, Any]) -> dict[str, Any]:
    msg = world.send_email(
        message_id=kw["message_id"],
        thread_id=kw["thread_id"],
        from_email=kw["from_email"],
        to_emails=list(kw["to_emails"]),
        subject=kw["subject"],
        body_plain=kw["body_plain"],
        cc_emails=kw.get("cc_emails"),
        attachments=kw.get("attachments"),
        labels=kw.get("labels"),
    )
    return {"id": msg.id, "thread_id": msg.thread_id}


def _h_mail_archive(world: LifeWorld, kw: dict[str, Any]) -> dict[str, Any]:
    msg = world.archive_email(kw["message_id"])
    return {"id": msg.id, "folder": msg.folder}


def _h_mail_mark_read(world: LifeWorld, kw: dict[str, Any]) -> dict[str, Any]:
    msg = world.mark_read(kw["message_id"])
    return {"id": msg.id, "is_read": msg.is_read}


def _h_mail_star(world: LifeWorld, kw: dict[str, Any]) -> dict[str, Any]:
    msg = world.star_email(kw["message_id"], starred=kw.get("starred", True))
    return {"id": msg.id, "is_starred": msg.is_starred}


def _h_mail_trash(world: LifeWorld, kw: dict[str, Any]) -> dict[str, Any]:
    msg = world.trash_email(kw["message_id"])
    return {"id": msg.id, "folder": msg.folder}


def _h_message_send(world: LifeWorld, kw: dict[str, Any]) -> dict[str, Any]:
    msg = world.send_message(
        message_id=kw["message_id"],
        conversation_id=kw["conversation_id"],
        from_handle=kw["from_handle"],
        to_handles=list(kw["to_handles"]),
        text=kw["text"],
        attachments=kw.get("attachments"),
    )
    return {"id": msg.id, "conversation_id": msg.conversation_id}


def _h_contact_add(world: LifeWorld, kw: dict[str, Any]) -> dict[str, Any]:
    contact = Contact(
        id=kw["id"],
        display_name=kw["display_name"],
        given_name=kw["given_name"],
        family_name=kw["family_name"],
        primary_email=kw["primary_email"],
        phones=list(kw.get("phones", [])),
        company=kw.get("company"),
        role=kw.get("role"),
        relationship=kw.get("relationship", "acquaintance"),
        importance=int(kw.get("importance", 0)),
        tags=list(kw.get("tags", [])),
        birthday=kw.get("birthday"),
    )
    world.add(EntityKind.CONTACT, contact)
    return {"id": contact.id}


def _h_contact_update(world: LifeWorld, kw: dict[str, Any]) -> dict[str, Any]:
    contact_id = kw["id"]
    patches = {k: v for k, v in kw.items() if k != "id"}
    updated = world.update(EntityKind.CONTACT, contact_id, **patches)
    return {"id": updated.id}


def _h_contact_delete(world: LifeWorld, kw: dict[str, Any]) -> dict[str, Any]:
    world.delete(EntityKind.CONTACT, kw["id"])
    return {"id": kw["id"], "deleted": True}


def _h_reminder_create(world: LifeWorld, kw: dict[str, Any]) -> dict[str, Any]:
    reminder = world.create_reminder(
        reminder_id=kw["reminder_id"],
        list_id=kw["list_id"],
        title=kw["title"],
        notes=kw.get("notes", ""),
        due_at=kw.get("due_at"),
        priority=kw.get("priority", "none"),
        tags=kw.get("tags"),
    )
    return {"id": reminder.id}


def _h_reminder_complete(world: LifeWorld, kw: dict[str, Any]) -> dict[str, Any]:
    reminder = world.complete_reminder(kw["reminder_id"])
    return {"id": reminder.id, "completed_at": reminder.completed_at}


def _h_note_create(world: LifeWorld, kw: dict[str, Any]) -> dict[str, Any]:
    note = world.create_note(
        note_id=kw["note_id"],
        title=kw["title"],
        body_markdown=kw["body_markdown"],
        tags=kw.get("tags"),
        source=kw.get("source", "apple-notes"),
    )
    return {"id": note.id}


# Domain-prefixed registry. Add new handlers here AND mirror them in
# LIFEOPS_BENCH_GAPS.md when scenarios start asking for new ones.
_ACTION_HANDLERS: dict[str, Callable[[LifeWorld, dict[str, Any]], dict[str, Any]]] = {
    "CALENDAR.create": _h_calendar_create,
    "CALENDAR.reschedule": _h_calendar_reschedule,
    "CALENDAR.cancel": _h_calendar_cancel,
    "MAIL.send": _h_mail_send,
    "MAIL.archive": _h_mail_archive,
    "MAIL.mark_read": _h_mail_mark_read,
    "MAIL.star": _h_mail_star,
    "MAIL.trash": _h_mail_trash,
    "MESSAGE.send": _h_message_send,
    "CONTACTS.add": _h_contact_add,
    "CONTACTS.update": _h_contact_update,
    "CONTACTS.delete": _h_contact_delete,
    "REMINDER.create": _h_reminder_create,
    "REMINDER.complete": _h_reminder_complete,
    "NOTE.create": _h_note_create,
}


def supported_actions() -> set[str]:
    """Return every action name the executor knows how to apply against a LifeWorld."""
    return set(_ACTION_HANDLERS.keys())


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
            except json.JSONDecodeError:
                raw_args = {}
        if not isinstance(raw_args, dict):
            raw_args = {}
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


def _empty_tool_manifest(world: LifeWorld) -> list[dict[str, Any]]:
    """Placeholder tool manifest. Wave 4 surfaces real per-action JSON Schemas."""
    return []


class LifeOpsBenchRunner:
    """Orchestrates LifeOpsBench runs across a set of scenarios.

    The agent function takes `(history, tool_manifest)` and returns the next
    assistant `MessageTurn`. The world factory yields a fresh `LifeWorld`
    seeded deterministically per scenario+seed.
    """

    def __init__(
        self,
        agent_fn: AgentFn,
        world_factory: WorldFactory,
        evaluator_model: str = "gpt-oss-120b",
        judge_model: str = "claude-opus-4-7",
        scenarios: list[Scenario] | None = None,
        concurrency: int = 4,
        seeds: int = 1,
        max_cost_usd: float = 10.0,
        per_scenario_timeout_s: int = 300,
    ) -> None:
        self.agent_fn = agent_fn
        self.world_factory = world_factory
        self.evaluator_model = evaluator_model
        self.judge_model = judge_model
        self.concurrency = concurrency
        self.seeds = seeds
        self.max_cost_usd = max_cost_usd
        self.per_scenario_timeout_s = per_scenario_timeout_s

        if scenarios is not None:
            self.scenarios = scenarios
        else:
            from .scenarios import ALL_SCENARIOS

            self.scenarios = ALL_SCENARIOS

        self.evaluator = LifeOpsEvaluator(
            evaluator_model=evaluator_model,
            judge_model=judge_model,
        )

        self._spent_usd = 0.0
        self._spent_lock = asyncio.Lock()

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
            logger.warning(
                "No scenarios matched filters (domain=%s, mode=%s)", domain, mode
            )

        semaphore = asyncio.Semaphore(self.concurrency)
        tasks: list[Awaitable[ScenarioResult]] = []
        for scenario in scenarios:
            for seed_offset in range(self.seeds):
                seed = scenario.world_seed + seed_offset
                tasks.append(self._run_one_guarded(semaphore, scenario, seed))

        results = await asyncio.gather(*tasks)
        scenarios_by_id = {s.id: s for s in scenarios}
        return compile_benchmark_result(
            list(results),
            scenarios_by_id,
            seeds=self.seeds,
            model_name=self.evaluator_model,
            judge_model_name=self.judge_model,
            timestamp=datetime.now(timezone.utc).isoformat(),
        )

    async def _run_one_guarded(
        self,
        semaphore: asyncio.Semaphore,
        scenario: Scenario,
        seed: int,
    ) -> ScenarioResult:
        async with semaphore:
            try:
                return await asyncio.wait_for(
                    self.run_one(scenario, seed),
                    timeout=self.per_scenario_timeout_s,
                )
            except asyncio.TimeoutError:
                logger.warning(
                    "Scenario %s seed=%d timed out after %ds",
                    scenario.id,
                    seed,
                    self.per_scenario_timeout_s,
                )
                return self._failure_result(scenario, seed, "timeout", "timed out")
            except CostBudgetExceeded as exc:
                logger.error("Cost budget exceeded on %s seed=%d: %s", scenario.id, seed, exc)
                return self._failure_result(scenario, seed, "cost_exceeded", str(exc))
            except Exception as exc:  # noqa: BLE001 - boundary translates to typed result
                logger.exception("Scenario %s seed=%d errored", scenario.id, seed)
                return self._failure_result(scenario, seed, "error", str(exc))

    async def run_one(self, scenario: Scenario, seed: int) -> ScenarioResult:
        """Run a single scenario at a single seed and return its result."""
        world = self.world_factory(seed, scenario.now_iso)
        history: list[MessageTurn] = [
            MessageTurn(role="user", content=scenario.instruction),
        ]
        turns: list[TurnResult] = []
        terminated_reason: str = "max_turns"

        for turn_number in range(1, scenario.max_turns + 1):
            tool_manifest = _empty_tool_manifest(world)
            agent_turn = await self.agent_fn(list(history), tool_manifest)
            history.append(agent_turn)

            agent_actions = _extract_actions_from_turn(agent_turn)
            for action in agent_actions:
                # Execution failures don't crash the run — we surface them as
                # tool-error messages and let scoring penalize via state mismatch.
                try:
                    result_payload = _execute_action(action, world)
                    history.append(
                        MessageTurn(
                            role="tool",
                            content=json.dumps(result_payload),
                            name=action.name,
                            tool_call_id=_extract_tool_call_id(agent_turn, action),
                        )
                    )
                except UnsupportedAction as exc:
                    logger.warning("Unsupported action in scenario %s: %s", scenario.id, exc)
                    history.append(
                        MessageTurn(
                            role="tool",
                            content=json.dumps({"error": "unsupported_action", "message": str(exc)}),
                            name=action.name,
                            tool_call_id=_extract_tool_call_id(agent_turn, action),
                        )
                    )
                except (KeyError, ValueError, TypeError) as exc:
                    logger.warning(
                        "Action %s failed in scenario %s: %s", action.name, scenario.id, exc
                    )
                    history.append(
                        MessageTurn(
                            role="tool",
                            content=json.dumps({"error": "execution_failed", "message": str(exc)}),
                            name=action.name,
                            tool_call_id=_extract_tool_call_id(agent_turn, action),
                        )
                    )

            cost = float(getattr(agent_turn, "cost_usd", 0.0) or 0.0)
            await self._charge(cost, scenario.id, seed)

            turn_result = TurnResult(
                turn_number=turn_number,
                agent_message=agent_turn.content,
                agent_actions=agent_actions,
                user_response="",
                latency_ms=int(getattr(agent_turn, "latency_ms", 0) or 0),
                input_tokens=int(getattr(agent_turn, "input_tokens", 0) or 0),
                output_tokens=int(getattr(agent_turn, "output_tokens", 0) or 0),
                cost_usd=cost,
            )

            # Terminal detection: assistant turn with no tool_calls signals
            # the agent is done responding. Tool-call-only turns continue the
            # loop so multi-step plans can execute one tool per turn.
            agent_terminal = not agent_actions

            if scenario.mode == ScenarioMode.STATIC:
                if agent_terminal:
                    # Plain text means the agent is responding. Apply the
                    # first-question fallback once if it's a clarifier; else
                    # terminate.
                    user_turn = await self._next_static_user_turn(
                        scenario, agent_turn, turn_number
                    )
                    if user_turn is None:
                        terminated_reason = "respond"
                        turns.append(turn_result)
                        break
                    history.append(user_turn)
                    turn_result.user_response = user_turn.content
            else:
                if await self.evaluator.judge_satisfaction(scenario, history, world):
                    terminated_reason = "satisfied"
                    turns.append(turn_result)
                    break
                if agent_terminal:
                    user_turn = await self.evaluator.simulate_user_turn(
                        scenario, history, world
                    )
                    history.append(user_turn)
                    turn_result.user_response = user_turn.content

            turns.append(turn_result)

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

        substring_matches = output_substring_match(history, scenario.required_outputs)
        result = ScenarioResult(
            scenario_id=scenario.id,
            seed=seed,
            turns=turns,
            state_hash_match=state_match,
            output_substring_matches=substring_matches,
            total_score=0.0,
            max_score=1.0,
            terminated_reason=terminated_reason,  # type: ignore[arg-type]
            total_cost_usd=sum(t.cost_usd for t in turns),
            total_latency_ms=sum(t.latency_ms for t in turns),
            error=None,
        )
        result.total_score = score_scenario(result, scenario)
        return result

    async def _next_static_user_turn(
        self,
        scenario: Scenario,
        agent_turn: MessageTurn,
        turn_number: int,
    ) -> MessageTurn | None:
        """STATIC mode: only respond on the FIRST agent turn if the fallback applies; otherwise terminate."""
        if turn_number != 1:
            return None
        return await self.evaluator.apply_first_question_fallback(
            scenario, agent_turn.content
        )

    async def _charge(self, cost_usd: float, scenario_id: str, seed: int) -> None:
        if cost_usd <= 0:
            return
        async with self._spent_lock:
            self._spent_usd += cost_usd
            if self._spent_usd > self.max_cost_usd:
                raise CostBudgetExceeded(
                    f"spent ${self._spent_usd:.4f} exceeded cap "
                    f"${self.max_cost_usd:.4f} on {scenario_id}#{seed}"
                )

    @staticmethod
    def _failure_result(
        scenario: Scenario,
        seed: int,
        reason: str,
        message: str,
    ) -> ScenarioResult:
        return ScenarioResult(
            scenario_id=scenario.id,
            seed=seed,
            turns=[],
            state_hash_match=False,
            output_substring_matches=[False] * len(scenario.required_outputs),
            total_score=0.0,
            max_score=1.0,
            terminated_reason=reason,  # type: ignore[arg-type]
            total_cost_usd=0.0,
            total_latency_ms=0,
            error=message,
        )

    @staticmethod
    def save_results(
        result: BenchmarkResult,
        output_dir: str = "lifeops_bench_results",
    ) -> str:
        """Serialize a BenchmarkResult to JSON under `output_dir` and return the path."""
        os.makedirs(output_dir, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        safe = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(result.model_name)).strip("-") or "model"
        path = os.path.join(output_dir, f"lifeops_{safe}_{timestamp}.json")

        def _serialize(obj: Any) -> Any:
            if hasattr(obj, "__dataclass_fields__"):
                return {k: _serialize(v) for k, v in obj.__dict__.items()}
            if isinstance(obj, list):
                return [_serialize(item) for item in obj]
            if isinstance(obj, dict):
                return {k: _serialize(v) for k, v in obj.items()}
            if hasattr(obj, "value"):
                return obj.value
            return obj

        with open(path, "w") as fh:
            json.dump(_serialize(result), fh, indent=2, default=str)
        logger.info("Results saved to %s", path)
        return path

    @staticmethod
    def print_summary(result: BenchmarkResult) -> None:
        """Print a human-readable summary."""
        print("\n" + "=" * 60)
        print("  LifeOpsBench Results Summary")
        print("=" * 60)
        print(f"  Model:              {result.model_name}")
        print(f"  Judge:              {result.judge_model_name}")
        print(f"  Seeds per scenario: {result.seeds}")
        print(f"  Scenarios run:      {len(result.scenarios)}")
        print(f"  pass@1:             {result.pass_at_1:.3f}")
        print(f"  pass@k:             {result.pass_at_k:.3f}")
        print(f"  Total cost:         ${result.total_cost_usd:.4f}")
        print(f"  Total latency:      {result.total_latency_ms / 1000:.2f}s")
        print()
        print("  Mean score per domain:")
        for domain, score in sorted(result.mean_score_per_domain.items()):
            print(f"    {domain:<12} {score:.3f}")
        print("=" * 60 + "\n")


def _extract_tool_call_id(agent_turn: MessageTurn, action: Action) -> str | None:
    """Find the tool_call_id matching `action.name` in the assistant turn."""
    if not agent_turn.tool_calls:
        return None
    for call in agent_turn.tool_calls:
        name = (
            call.get("function", {}).get("name")
            if isinstance(call.get("function"), dict)
            else call.get("name")
        )
        if name == action.name:
            return call.get("id")
    return None
