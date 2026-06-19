"""Unit tests for the VoiceAgentBench mapping table and reverse lookup.

Two pillars:

1. Schema-level: the mapping table behaves as the inverse-lookup spec
   requires (umbrella + subaction → bench tool name; promoted virtual
   names like ``MUSIC_PLAY``; bench-name passthrough; ``None`` for
   unmapped actions).
2. Source-of-truth: every ``(canonical_action, subaction)`` entry
   references a real Action declared somewhere under ``plugins/`` (or
   ``packages/native-plugins/`` for ALARM, ``packages/core/`` for
   MESSAGE) so the mapping cannot quietly drift out of sync with the
   real handlers.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from eliza_adapter.voiceagentbench import (
    _UNMAPPED_VOICE_TOOLS,
    _VOICE_TOOL_TO_ELIZA_ACTION,
    eliza_to_voice_tool,
)


# ---------------------------------------------------------------------------
# Reverse-lookup behaviour
# ---------------------------------------------------------------------------


def test_calendar_create_event_maps_to_schedule() -> None:
    result = eliza_to_voice_tool(
        "CALENDAR", {"action": "create_event", "title": "Lunch"}
    )
    assert result is not None
    name, args = result
    assert name == "schedule"
    # The routing discriminator keys are stripped; payload fields stay.
    assert "action" not in args
    assert "subaction" not in args
    assert args == {"title": "Lunch"}


def test_calendar_update_event_maps_to_reschedule() -> None:
    result = eliza_to_voice_tool("CALENDAR", {"subaction": "update_event"})
    assert result is not None
    assert result[0] == "reschedule"


def test_promoted_music_play_maps_to_play_music() -> None:
    result = eliza_to_voice_tool("MUSIC_PLAY", {})
    assert result is not None
    assert result[0] == "play_music"


def test_promoted_calendar_create_event_maps_to_schedule() -> None:
    result = eliza_to_voice_tool("CALENDAR_CREATE_EVENT", {"title": "Stand-up"})
    assert result is not None
    name, args = result
    assert name == "schedule"
    assert args == {"title": "Stand-up"}


def test_promoted_owner_reminders_create_does_not_split_owner() -> None:
    """``OWNER_REMINDERS_CREATE`` must split on the longest umbrella so
    we don't accidentally route to a non-existent ``OWNER`` action."""
    result = eliza_to_voice_tool("OWNER_REMINDERS_CREATE", {})
    assert result is not None
    assert result[0] == "set_reminder"


def test_owner_todos_create_maps_to_add_todo() -> None:
    result = eliza_to_voice_tool("OWNER_TODOS", {"action": "create"})
    assert result is not None
    assert result[0] == "add_todo"


def test_music_skip_maps_to_next_song() -> None:
    result = eliza_to_voice_tool("MUSIC", {"subaction": "skip"})
    assert result is not None
    assert result[0] == "next_song"


def test_alarm_set_maps_to_set_timer() -> None:
    result = eliza_to_voice_tool("ALARM", {"subaction": "set"})
    assert result is not None
    assert result[0] == "set_timer"


def test_bench_tool_name_passthrough() -> None:
    """A bench tool name emitted verbatim by eliza must round-trip."""
    result = eliza_to_voice_tool("play_music", {"track": "Jazz"})
    assert result is not None
    assert result[0] == "play_music"
    assert result[1] == {"track": "Jazz"}


def test_unmapped_bench_tool_passthrough_preserved() -> None:
    result = eliza_to_voice_tool("get_weather", {"city": "Paris"})
    assert result is not None
    assert result[0] == "get_weather"


def test_unknown_action_returns_none() -> None:
    assert eliza_to_voice_tool("DEFINITELY_NOT_A_REAL_ACTION", {}) is None


def test_empty_action_name_returns_none() -> None:
    assert eliza_to_voice_tool("", {"subaction": "create"}) is None
    assert eliza_to_voice_tool("   ", {}) is None


def test_no_subaction_with_unknown_umbrella_returns_none() -> None:
    assert eliza_to_voice_tool("CALENDAR", {"subaction": "fictional"}) is None


# ---------------------------------------------------------------------------
# Source-of-truth: every canonical action declared in the mapping table
# must exist somewhere in the monorepo.
# ---------------------------------------------------------------------------


# The eliza monorepo root resolved relative to this test file:
# tests/ → eliza-adapter/ → benchmarks/ → packages/ → eliza/
_REPO_ROOT = Path(__file__).resolve().parents[4]
_SEARCH_ROOTS = [
    _REPO_ROOT / "plugins",
    _REPO_ROOT / "packages" / "core" / "src",
    _REPO_ROOT / "packages" / "native-plugins",
]


def _action_name_declared(name: str) -> bool:
    """Return True iff some .ts file under the search roots declares
    an ``Action`` with ``name: "<name>"``.

    We use a strict ``name: "X"`` pattern so we don't accidentally
    accept similes or arbitrary string occurrences.
    """
    pattern = re.compile(rf"""name:\s*['"]{re.escape(name)}['"]""")
    for root in _SEARCH_ROOTS:
        if not root.is_dir():
            continue
        for ts_path in root.rglob("*.ts"):
            # Skip generated/dist/test files to keep this fast and
            # stable; actions are always declared in production source.
            parts = set(ts_path.parts)
            if {"dist", "node_modules"} & parts:
                continue
            try:
                text = ts_path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            if pattern.search(text):
                return True
    return False


@pytest.mark.parametrize(
    "bench_tool,target",
    sorted(_VOICE_TOOL_TO_ELIZA_ACTION.items()),
)
def test_canonical_action_exists_in_monorepo(
    bench_tool: str, target: dict[str, str]
) -> None:
    """Every mapped canonical action must be declared somewhere."""
    action = target["action"]
    assert _action_name_declared(action), (
        f"bench tool {bench_tool!r} maps to canonical action {action!r}, "
        f"which is not declared in any plugins/, packages/core/src/, or "
        f"packages/native-plugins/ source file."
    )


def test_unmapped_set_is_disjoint_from_mapping() -> None:
    """A bench tool can only be in one of the two sets, not both."""
    assert _UNMAPPED_VOICE_TOOLS.isdisjoint(set(_VOICE_TOOL_TO_ELIZA_ACTION))


def test_inverse_index_round_trip_for_every_mapping() -> None:
    """Every canonical-side entry must be reachable from the inverse
    lookup so the adapter can translate it back at scoring time."""
    for bench_tool, target in _VOICE_TOOL_TO_ELIZA_ACTION.items():
        result = eliza_to_voice_tool(target["action"], {"subaction": target["subaction"]})
        assert result is not None, (
            f"inverse lookup failed for {target['action']}/"
            f"{target['subaction']} (expected → {bench_tool})"
        )
        # The first registered bench name for a (action, subaction)
        # pair wins. We assert *some* bench tool round-trips, not
        # necessarily this one — multiple bench tools may share the
        # same canonical target (e.g. send_message / send_email both
        # map to MESSAGE/send).
        recovered = result[0]
        assert _VOICE_TOOL_TO_ELIZA_ACTION[recovered] == target
