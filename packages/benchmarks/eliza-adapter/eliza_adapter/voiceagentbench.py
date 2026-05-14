"""VoiceAgentBench adapter backed by the eliza TS benchmark server.

The base benchmark exposes a small fixed catalog of *bench-side* tool
names (``schedule``, ``play_music``, ``send_message`` …) to the agent
via ``MessageTurn.tool_calls``. Scoring (see
:mod:`elizaos_voiceagentbench.evaluator`) compares the agent's emitted
``name`` against the dataset's ``ToolCallExpectation.tool_name`` — a
bench-side string. We therefore must report bench names back to the
runner, even though the underlying eliza planner emits *canonical*
action names like ``CALENDAR`` (with ``subaction=create_event``) or
``MUSIC_PLAY`` (a "promoted" virtual tool).

Two pieces of glue:

1. ``_VOICE_TOOL_TO_ELIZA_ACTION`` documents the canonical mapping for
   each known bench tool and is the source of truth for the inverse
   lookup ``eliza_to_voice_tool``. Every entry references an Action +
   subaction that exists in the monorepo (verified against
   ``plugins/`` source — see the test suite).
2. :class:`ElizaBridgeVoiceAgentBenchAgent` runs the per-turn loop:
   forward the transcript to the bridge, parse ``response.params`` for
   tool calls, translate canonical action names back to bench names
   when possible, and pass through any name that already matches the
   benchmark's expected tool.

Goal: voice fine-tuning data captured via the bench server uses the
canonical eliza action vocabulary, while bench scoring keeps working
unchanged because the adapter translates back at the boundary.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping, Sequence
from typing import Any, Optional

from eliza_adapter.client import ElizaClient

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Mapping table
# ---------------------------------------------------------------------------
#
# Every entry references an Action whose ``name`` is declared in the
# monorepo source (verified by the unit test suite via grep), and a
# subaction value accepted by that action's dispatcher.
#
# Notes on the canonical targets:
#   * CALENDAR — plugins/app-lifeops/src/actions/calendar.ts. Accepts
#     subactions {feed, next_event, search_events, create_event,
#     update_event, delete_event, …}.
#   * OWNER_REMINDERS — plugins/app-lifeops/src/actions/owner-surfaces.ts.
#     The owner-surface action uses the parameter ``action`` (mirrored
#     into ``subaction``) drawn from {create, update, delete, complete,
#     skip, snooze, review}.
#   * OWNER_TODOS — same file, same action enum. We point ``add_todo`` at
#     this surface (per the task spec) rather than the planner-store
#     TODO action in plugin-todos because OWNER_TODOS is the
#     owner-scoped surface that matches a voice assistant request.
#   * MUSIC — plugins/plugin-music/src/actions/music.ts. Verb subactions:
#     play, pause, resume, skip, stop, … The bench's ``next_song`` maps
#     to ``skip`` (with ``next`` declared as a SUBACTION_ALIAS).
#   * MESSAGE — packages/core/src/features/messaging/triage/actions/
#     sendDraft.ts (also draftReply, draftFollowup, manageMessage,
#     etc. share the umbrella). For send-style intent we route to
#     MESSAGE with operation/subaction ``send`` so the planner picks
#     the sendDraft handler.
#   * BROWSER — plugins/plugin-browser/src/actions/browser.ts. Used as
#     a best-effort target for ``find_restaurant`` / ``book_table``
#     because there is no canonical "restaurant search" action.
#   * ALARM — packages/native-plugins/macosalarm/src/actions.ts.
#     Subactions: set, cancel, list.

_VOICE_TOOL_TO_ELIZA_ACTION: dict[str, dict[str, str]] = {
    # Calendar
    "schedule": {"action": "CALENDAR", "subaction": "create_event"},
    "reschedule": {"action": "CALENDAR", "subaction": "update_event"},
    "check_calendar": {"action": "CALENDAR", "subaction": "feed"},
    "cancel_event": {"action": "CALENDAR", "subaction": "delete_event"},
    # Reminders (owner-scoped)
    "set_reminder": {"action": "OWNER_REMINDERS", "subaction": "create"},
    "cancel_reminder": {"action": "OWNER_REMINDERS", "subaction": "delete"},
    # Todos (owner-scoped)
    "add_todo": {"action": "OWNER_TODOS", "subaction": "create"},
    # Music transport
    "play_music": {"action": "MUSIC", "subaction": "play"},
    "pause_music": {"action": "MUSIC", "subaction": "pause"},
    "next_song": {"action": "MUSIC", "subaction": "skip"},
    # Messaging (send a new draft → confirm; bench scores name only)
    "send_message": {"action": "MESSAGE", "subaction": "send"},
    "send_email": {"action": "MESSAGE", "subaction": "send"},
    # Voice calls
    "make_call": {"action": "VOICE_CALL", "subaction": "dial"},
    # Inbox / read email — best-effort to MESSAGE listInbox handler
    "read_email": {"action": "MESSAGE", "subaction": "list"},
    # Best-effort: no canonical restaurant search, route via BROWSER
    "find_restaurant": {"action": "BROWSER", "subaction": "navigate"},
    "book_table": {"action": "BROWSER", "subaction": "click"},
    # Native alarm / timer
    "set_timer": {"action": "ALARM", "subaction": "set"},
    "cancel_timer": {"action": "ALARM", "subaction": "cancel"},
}


# Tools the audit identified that we explicitly do *not* map to eliza
# canonical actions — there is no good canonical target. The agent will
# fall back to passing the bench name through if eliza emits it
# verbatim, which is the safest behavior for scoring.
_UNMAPPED_VOICE_TOOLS: frozenset[str] = frozenset({
    "get_time",
    "get_weather",
})


# ---------------------------------------------------------------------------
# Reverse lookup
# ---------------------------------------------------------------------------


def _build_inverse_index() -> dict[tuple[str, str], str]:
    """Map ``(canonical_action, subaction)`` → bench tool name.

    The first bench tool registered for a given pair wins so that the
    adapter is deterministic. Subactions are normalised to the empty
    string when missing so umbrella matches without a subaction still
    resolve (rare; included for defence in depth).
    """
    inverse: dict[tuple[str, str], str] = {}
    for bench_name, target in _VOICE_TOOL_TO_ELIZA_ACTION.items():
        key = (target["action"], target.get("subaction", ""))
        inverse.setdefault(key, bench_name)
    return inverse


_INVERSE_INDEX: dict[tuple[str, str], str] = _build_inverse_index()


def _split_promoted_name(name: str) -> tuple[str, str]:
    """Split a promoted virtual action like ``MUSIC_PLAY`` into
    ``("MUSIC", "play")``.

    The eliza planner can promote subactions to top-level virtual
    action names (e.g. ``CALENDAR_CREATE_EVENT``). We try every prefix
    that maps to a known umbrella in :data:`_VOICE_TOOL_TO_ELIZA_ACTION`
    so the longest umbrella name wins (avoids accidentally splitting
    ``OWNER_REMINDERS`` into ``OWNER`` + ``REMINDERS``).
    """
    if "_" not in name:
        return name, ""
    known_umbrellas = sorted(
        {entry["action"] for entry in _VOICE_TOOL_TO_ELIZA_ACTION.values()},
        key=len,
        reverse=True,
    )
    upper = name.upper()
    for umbrella in known_umbrellas:
        prefix = f"{umbrella}_"
        if upper.startswith(prefix):
            tail = upper[len(prefix):].lower()
            return umbrella, tail
    return name, ""


def eliza_to_voice_tool(
    action_name: str, params: Mapping[str, Any] | None
) -> Optional[tuple[str, dict[str, Any]]]:
    """Translate an eliza-emitted action into a bench tool call.

    Parameters
    ----------
    action_name:
        The action name from ``response.actions`` /
        ``response.params``. May be an umbrella (``CALENDAR``) or a
        promoted virtual (``CALENDAR_CREATE_EVENT``).
    params:
        Action parameters; the subaction is read from ``subaction``,
        ``action``, or ``operation`` to match the planner conventions
        used across owner surfaces and the music/calendar umbrellas.

    Returns the ``(bench_tool_name, arguments)`` pair when a mapping
    exists, otherwise ``None``. ``arguments`` is a shallow copy of
    ``params`` minus the routing-discriminator keys so it is safe to
    forward to a stub tool executor.
    """
    if not isinstance(action_name, str) or not action_name.strip():
        return None
    raw = action_name.strip()

    # Direct bench-name passthrough: if eliza emits a bench tool name
    # verbatim (e.g. the planner picked one up via tools-context), keep
    # it so scoring sees what it expects.
    if raw in _VOICE_TOOL_TO_ELIZA_ACTION or raw in _UNMAPPED_VOICE_TOOLS:
        args = dict(params) if isinstance(params, Mapping) else {}
        return raw, args

    params_dict: dict[str, Any] = (
        dict(params) if isinstance(params, Mapping) else {}
    )

    # Read subaction discriminator using the same precedence as the
    # owner-surfaces / calendar / music handlers.
    subaction = ""
    for key in ("subaction", "action", "operation", "op"):
        value = params_dict.get(key)
        if isinstance(value, str) and value.strip():
            subaction = value.strip().lower()
            break

    umbrella, promoted = _split_promoted_name(raw)
    umbrella = umbrella.upper()
    if not subaction and promoted:
        subaction = promoted

    bench_name = _INVERSE_INDEX.get((umbrella, subaction))
    if bench_name is None:
        # Try umbrella-only match (some actions have no subaction).
        bench_name = _INVERSE_INDEX.get((umbrella, ""))
    if bench_name is None:
        return None

    arguments = {
        k: v
        for k, v in params_dict.items()
        if k not in {"subaction", "action", "operation", "op"}
    }
    return bench_name, arguments


# ---------------------------------------------------------------------------
# Adapter class
# ---------------------------------------------------------------------------


def _coerce_args(value: Any) -> dict[str, Any]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return {}
    if isinstance(value, Mapping):
        return dict(value)
    return {}


def _extract_tool_calls_from_response(
    response_params: Mapping[str, Any],
    response_actions: Sequence[str],
) -> list[dict[str, Any]]:
    """Pull a flat list of ``{name, arguments}`` from a bridge response.

    Three fallbacks are tried in order:
      1. ``params["tool_calls"]`` — the canonical chat-completions shape
         that the bridge already normalises for most adapters.
      2. ``params["BENCHMARK_ACTIONS"]`` — the captured-actions list
         emitted by the eliza planner when no tool-calls field is
         populated.
      3. ``response_actions`` paired with ``params`` — last resort when
         the bridge only reports the action name.
    """
    raw = response_params.get("tool_calls")
    if isinstance(raw, Sequence) and not isinstance(raw, (str, bytes)):
        out: list[dict[str, Any]] = []
        for entry in raw:
            if not isinstance(entry, Mapping):
                continue
            fn = entry.get("function") if isinstance(entry.get("function"), Mapping) else None
            if fn is not None:
                name = str(fn.get("name") or "")
                args = _coerce_args(fn.get("arguments"))
            else:
                name = str(entry.get("name") or entry.get("tool_name") or "")
                args = _coerce_args(
                    entry.get("arguments")
                    or entry.get("parameters")
                    or entry.get("params")
                )
            if name:
                out.append({"name": name, "arguments": args})
        if out:
            return out

    captured = response_params.get("BENCHMARK_ACTIONS")
    if isinstance(captured, Sequence) and not isinstance(captured, (str, bytes)):
        out = []
        for entry in captured:
            if not isinstance(entry, Mapping):
                continue
            name = str(
                entry.get("action")
                or entry.get("name")
                or entry.get("tool_name")
                or ""
            )
            if not name:
                continue
            out.append({"name": name, "arguments": dict(entry)})
        if out:
            return out

    if response_actions:
        return [
            {"name": str(name), "arguments": dict(response_params)}
            for name in response_actions
            if isinstance(name, str) and name.strip()
        ]
    return []


def _translate_calls(
    raw_calls: Sequence[Mapping[str, Any]],
    *,
    bench_tool_names: frozenset[str],
) -> list[dict[str, Any]]:
    """Translate eliza-emitted calls into bench-name calls.

    Calls whose ``name`` already matches one of the bench tools
    advertised in the task manifest pass through unchanged. Otherwise
    we try the canonical → bench lookup; failing that, we keep the
    original call (the scorer simply won't credit it).
    """
    translated: list[dict[str, Any]] = []
    for call in raw_calls:
        name = str(call.get("name") or "")
        args = _coerce_args(call.get("arguments"))
        if not name:
            continue
        if name in bench_tool_names:
            translated.append({"name": name, "arguments": args})
            continue
        mapped = eliza_to_voice_tool(name, args)
        if mapped is not None:
            bench_name, bench_args = mapped
            translated.append({"name": bench_name, "arguments": bench_args})
            continue
        logger.debug(
            "[voiceagentbench] no mapping for eliza action %s; passing through",
            name,
        )
        translated.append({"name": name, "arguments": args})
    return translated


class ElizaBridgeVoiceAgentBenchAgent:
    """VoiceAgentBench agent that routes through the eliza TS bridge.

    Mirrors the AgentFn contract from
    :mod:`elizaos_voiceagentbench.types`: each ``predict`` call accepts
    a transcript plus the available-tools manifest and returns a
    ``{tool_calls, text}`` payload.
    """

    def __init__(
        self,
        client: Optional[ElizaClient] = None,
        *,
        task_id: Optional[str] = None,
        benchmark_label: str = "voiceagentbench",
    ) -> None:
        self._client = client or ElizaClient()
        self._task_id = task_id
        self._benchmark_label = benchmark_label
        self._initialized = False

    async def _ensure_ready(self) -> None:
        if self._initialized:
            return
        try:
            self._client.wait_until_ready(timeout=120)
        except Exception as exc:  # pragma: no cover — surface clearly
            logger.error("[voiceagentbench] bridge not ready: %s", exc)
            raise
        self._initialized = True

    async def predict(
        self,
        transcript: str,
        available_tools: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Run a single turn and return ``{tool_calls, text}``."""
        await self._ensure_ready()

        bench_tool_names = frozenset(
            str(t.get("function", {}).get("name") or t.get("name") or "")
            for t in (available_tools or [])
            if isinstance(t, Mapping)
        )

        context: dict[str, Any] = {
            "benchmark": self._benchmark_label,
            "tools": list(available_tools or []),
        }
        if self._task_id is not None:
            context["task_id"] = self._task_id

        response = self._client.send_message(text=transcript, context=context)
        raw_calls = _extract_tool_calls_from_response(
            response.params, response.actions
        )
        translated = _translate_calls(raw_calls, bench_tool_names=bench_tool_names)
        return {"tool_calls": translated, "text": response.text or ""}


# ---------------------------------------------------------------------------
# AgentFn factory for the bench runner
# ---------------------------------------------------------------------------


def build_eliza_voiceagentbench_agent(
    *, client: Optional[ElizaClient] = None
) -> Any:
    """Construct an ``AgentFn``-shaped coroutine for the voiceagentbench
    runner.

    The bench runner expects ``(history, tool_manifest) -> MessageTurn``;
    we pull the most recent user transcript out of history, dispatch
    through :class:`ElizaBridgeVoiceAgentBenchAgent`, then build a bench
    ``MessageTurn`` (with ``tool_calls`` populated when the agent emitted
    any).
    """
    # Lazy import so the eliza_adapter package stays importable when
    # voiceagentbench is not installed.
    from elizaos_voiceagentbench.types import MessageTurn  # noqa: WPS433

    agent = ElizaBridgeVoiceAgentBenchAgent(client=client)

    async def _agent_fn(
        history: list[Any], tool_manifest: list[dict[str, Any]]
    ) -> Any:
        last_user_text = ""
        for turn in reversed(history):
            role = getattr(turn, "role", None)
            if role == "user":
                last_user_text = str(getattr(turn, "content", "") or "")
                break

        result = await agent.predict(last_user_text, tool_manifest or [])
        tool_calls = result["tool_calls"]
        if tool_calls:
            normalized = [
                {
                    "id": f"call_{idx}",
                    "type": "function",
                    "function": {
                        "name": call["name"],
                        "arguments": json.dumps(
                            call.get("arguments") or {}, ensure_ascii=False
                        ),
                    },
                }
                for idx, call in enumerate(tool_calls)
            ]
            return MessageTurn(
                role="assistant",
                content=result["text"],
                tool_calls=normalized,
            )
        return MessageTurn(
            role="assistant",
            content=result["text"],
            tool_calls=None,
        )

    return _agent_fn


__all__ = [
    "ElizaBridgeVoiceAgentBenchAgent",
    "build_eliza_voiceagentbench_agent",
    "eliza_to_voice_tool",
]
