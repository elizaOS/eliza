"""Unit + fixture-flow tests for ``drive_eliza.py``.

Covers:

- ``parse_bench_response``: strong-typing + sub-agent id scraping from the
  /api/benchmark/message JSON shape.
- ``_extract_sub_agent_ids``: dedup + insertion-order + pty-prefix filter.
- ``normalize_session_detail`` + ``CapturedSubAgentTrace.to_dict``: JSONL row
  shape with stable field set, tagged ``synth_kind='with_subagents'``.
- ``capture_sub_agents``: mocked sub-agent spawn flow — list_sessions + per-id
  get_session, including the "new session id appeared between snapshots" path.
- ``write_subagent_records``: JSONL round-trip.

No network, no aiohttp dep — the transport protocol is mocked. CPU-only;
designed to run under the pre-flight gate alongside ``test_project_simulator.py``.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any

import pytest

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from synth.drive_eliza import (  # noqa: E402
    SYNTH_KIND_WITH_SUBAGENTS,
    BenchmarkResponse,
    CapturedSubAgentTrace,
    SubAgentSession,
    SubAgentTransport,
    _extract_sub_agent_ids,
    capture_sub_agents,
    make_subagent_record,
    normalize_session_detail,
    parse_bench_response,
    snapshot_session_ids,
    write_subagent_records,
)


# ─────────────────────────── fixture transport ────────────────────────────


class FakeSubAgentTransport(SubAgentTransport):
    """Deterministic transport for tests.

    Records every list_sessions/get_session call so tests can assert call
    ordering. The list_sessions return value is a queue — successive calls
    yield successive snapshots, mirroring the runtime where new sessions
    appear between turns.
    """

    def __init__(
        self,
        *,
        session_snapshots: list[list[dict[str, Any]]],
        sessions: dict[str, dict[str, Any]],
        outputs: dict[str, str] | None = None,
    ):
        self._snapshots = list(session_snapshots)
        self._sessions = dict(sessions)
        self._outputs = dict(outputs or {})
        self.list_calls = 0
        self.get_calls: list[str] = []

    async def list_sessions(self) -> list[dict[str, Any]]:
        idx = min(self.list_calls, len(self._snapshots) - 1)
        self.list_calls += 1
        return list(self._snapshots[idx])

    async def get_session(self, session_id: str) -> tuple[dict[str, Any], str]:
        self.get_calls.append(session_id)
        detail = self._sessions.get(session_id)
        if detail is None:
            raise RuntimeError(f"unknown session {session_id}")
        return dict(detail), self._outputs.get(session_id, "")


class FailingListTransport(SubAgentTransport):
    """list_sessions raises; get_session still works for explicit ids."""

    def __init__(self, sessions: dict[str, dict[str, Any]]):
        self._sessions = dict(sessions)

    async def list_sessions(self) -> list[dict[str, Any]]:
        raise RuntimeError("simulated network failure")

    async def get_session(self, session_id: str) -> tuple[dict[str, Any], str]:
        detail = self._sessions.get(session_id)
        if detail is None:
            raise RuntimeError(f"unknown session {session_id}")
        return dict(detail), ""


# ─────────────────────────── parse_bench_response ────────────────────────────


def test_parse_bench_response_minimal():
    payload: dict[str, Any] = {
        "text": "hi",
        "thought": "thinking",
        "actions": ["REPLY"],
        "params": {},
        "benchmark": "synth-eliza",
        "task_id": "t1",
        "room_id": "r1",
        "trajectory_step": 1,
    }
    parsed = parse_bench_response(payload)
    assert isinstance(parsed, BenchmarkResponse)
    assert parsed.text == "hi"
    assert parsed.thought == "thinking"
    assert parsed.actions == ["REPLY"]
    assert parsed.benchmark == "synth-eliza"
    assert parsed.task_id == "t1"
    assert parsed.room_id == "r1"
    assert parsed.trajectory_step == 1
    assert parsed.sub_agent_session_ids == []
    # raw is the verbatim input
    assert parsed.raw is payload


def test_parse_bench_response_drops_non_string_action_entries():
    parsed = parse_bench_response(
        {"text": "x", "actions": ["REPLY", 7, None, "TASK_CALL"]}
    )
    assert parsed.actions == ["REPLY", "TASK_CALL"]


def test_parse_bench_response_handles_missing_fields():
    parsed = parse_bench_response({})
    assert parsed.text == ""
    assert parsed.thought is None
    assert parsed.actions == []
    assert parsed.params == {}
    assert parsed.sub_agent_session_ids == []
    assert parsed.trajectory_step == 0


def test_parse_bench_response_pulls_session_id_from_params():
    parsed = parse_bench_response(
        {
            "text": "spawning",
            "actions": ["CREATE_TASK"],
            "params": {"sessionId": "pty-1700000000-deadbeef"},
        }
    )
    assert parsed.sub_agent_session_ids == ["pty-1700000000-deadbeef"]


def test_parse_bench_response_pulls_multi_session_ids():
    parsed = parse_bench_response(
        {
            "actions": ["CREATE_TASK", "CREATE_TASK"],
            "params": {
                "sessionIds": ["pty-1-aaa", "pty-2-bbb"],
            },
        }
    )
    assert parsed.sub_agent_session_ids == ["pty-1-aaa", "pty-2-bbb"]


def test_parse_bench_response_accepts_explicit_block():
    parsed = parse_bench_response(
        {
            "sub_agent_session_ids": ["pty-9-xyz"],
            "params": {"sessionId": "pty-9-xyz"},  # duplicate
        }
    )
    # Dedup is exact: explicit wins, params duplicate dropped.
    assert parsed.sub_agent_session_ids == ["pty-9-xyz"]


# ─────────────────────────── _extract_sub_agent_ids ────────────────────────────


def test_extract_filters_non_pty_ids():
    payload = {"sub_agent_session_ids": ["not-a-pty", "pty-1-aa"]}
    ids = _extract_sub_agent_ids(payload, {})
    assert ids == ["pty-1-aa"]


def test_extract_pulls_from_sub_agents_aggregate():
    params = {
        "sub_agents": [
            {"sessionId": "pty-1-aa"},
            {"sessionId": "pty-2-bb"},
            {"label": "no session here"},
        ]
    }
    assert _extract_sub_agent_ids({}, params) == ["pty-1-aa", "pty-2-bb"]


def test_extract_preserves_insertion_order_and_dedup():
    payload = {"sub_agent_session_ids": ["pty-1-aa"]}
    params = {
        "sessionId": "pty-2-bb",
        "sessionIds": ["pty-1-aa", "pty-3-cc"],  # pty-1-aa already seen
        "sub_agents": [{"sessionId": "pty-4-dd"}],
    }
    assert _extract_sub_agent_ids(payload, params) == [
        "pty-1-aa",
        "pty-2-bb",
        "pty-3-cc",
        "pty-4-dd",
    ]


# ─────────────────────────── normalize_session_detail ────────────────────────────


def test_normalize_session_detail_fills_defaults_when_missing():
    s = normalize_session_detail(
        "pty-1-aa", {"agentType": "claude"}, "stdout-tail"
    )
    assert s.session_id == "pty-1-aa"
    assert s.agent_type == "claude"
    assert s.workdir is None
    assert s.status == "unknown"  # default when status missing
    assert s.output == "stdout-tail"
    # detail blob is preserved verbatim for downstream filters
    assert s.detail == {"agentType": "claude"}


def test_normalize_session_detail_uses_provided_fields():
    s = normalize_session_detail(
        "pty-1-aa",
        {
            "agentType": "codex",
            "workdir": "/tmp/wkdir",
            "status": "completed",
            "extra": "preserved",
        },
        "",
    )
    assert s.agent_type == "codex"
    assert s.workdir == "/tmp/wkdir"
    assert s.status == "completed"
    assert s.detail["extra"] == "preserved"


# ─────────────────────────── captured trace serialization ────────────────────────────


def test_captured_trace_to_dict_round_trips_as_jsonl():
    trace = CapturedSubAgentTrace(
        synth_kind=SYNTH_KIND_WITH_SUBAGENTS,
        task_id="t1",
        benchmark="synth-eliza",
        user_text="please refactor this file",
        agent_text="ok, spawning",
        actions=["CREATE_TASK"],
        sub_agents=[
            SubAgentSession(
                session_id="pty-1-aa",
                agent_type="codex",
                workdir="/tmp/wkdir",
                status="completed",
                detail={"agentType": "codex"},
                output="stdout-tail",
            ),
        ],
        captured_at_ms=1700000000000,
    )
    blob = trace.to_dict()
    # JSON-serializable
    line = json.dumps(blob)
    reparsed = json.loads(line)
    assert reparsed["synth_kind"] == SYNTH_KIND_WITH_SUBAGENTS
    assert reparsed["task_id"] == "t1"
    assert reparsed["sub_agents"][0]["session_id"] == "pty-1-aa"
    assert reparsed["sub_agents"][0]["output"] == "stdout-tail"
    assert reparsed["actions"] == ["CREATE_TASK"]


# ─────────────────────────── capture_sub_agents ────────────────────────────


def _run(coro):
    return asyncio.run(coro)


def test_snapshot_session_ids_pulls_session_ids():
    transport = FakeSubAgentTransport(
        session_snapshots=[
            [{"id": "pty-1-aa"}, {"sessionId": "pty-2-bb"}],
        ],
        sessions={},
    )
    ids = _run(snapshot_session_ids(transport))
    assert ids == {"pty-1-aa", "pty-2-bb"}


def test_snapshot_session_ids_degrades_to_empty_on_failure():
    transport = FailingListTransport(sessions={})
    ids = _run(snapshot_session_ids(transport))
    assert ids == set()


def test_capture_sub_agents_via_explicit_ids_only():
    transport = FakeSubAgentTransport(
        session_snapshots=[[]],  # no visible sessions
        sessions={
            "pty-1-aa": {
                "agentType": "claude",
                "workdir": "/w/a",
                "status": "completed",
            },
        },
        outputs={"pty-1-aa": "Claude finished."},
    )
    captured = _run(
        capture_sub_agents(
            transport,
            session_ids=["pty-1-aa"],
            sessions_before=set(),
        )
    )
    assert len(captured) == 1
    assert captured[0].session_id == "pty-1-aa"
    assert captured[0].agent_type == "claude"
    assert captured[0].output == "Claude finished."
    assert transport.get_calls == ["pty-1-aa"]


def test_capture_sub_agents_diff_detects_new_session():
    """list_sessions returns a new session that wasn't in sessions_before;
    it should be captured even though the planner didn't surface its id."""
    transport = FakeSubAgentTransport(
        session_snapshots=[
            # post-turn snapshot: includes the new session
            [
                {"id": "pty-OLD-zz"},
                {"id": "pty-NEW-aa"},
            ],
        ],
        sessions={
            "pty-NEW-aa": {
                "agentType": "codex",
                "workdir": "/w/new",
                "status": "running",
            },
        },
        outputs={"pty-NEW-aa": "codex log..."},
    )
    captured = _run(
        capture_sub_agents(
            transport,
            session_ids=[],
            sessions_before={"pty-OLD-zz"},
        )
    )
    assert [s.session_id for s in captured] == ["pty-NEW-aa"]
    assert captured[0].agent_type == "codex"


def test_capture_sub_agents_unions_explicit_and_diff_sources():
    transport = FakeSubAgentTransport(
        session_snapshots=[
            [{"id": "pty-EXP-aa"}, {"id": "pty-DIFF-bb"}],
        ],
        sessions={
            "pty-EXP-aa": {"agentType": "claude"},
            "pty-DIFF-bb": {"agentType": "codex"},
        },
    )
    captured = _run(
        capture_sub_agents(
            transport,
            session_ids=["pty-EXP-aa"],
            sessions_before=set(),
        )
    )
    captured_ids = {s.session_id for s in captured}
    assert captured_ids == {"pty-EXP-aa", "pty-DIFF-bb"}


def test_capture_sub_agents_dedups_when_explicit_and_diff_overlap():
    """A session id that appears in BOTH the planner-returned list AND the
    diff should be captured exactly once."""
    transport = FakeSubAgentTransport(
        session_snapshots=[[{"id": "pty-DUP-aa"}]],
        sessions={"pty-DUP-aa": {"agentType": "claude"}},
    )
    captured = _run(
        capture_sub_agents(
            transport,
            session_ids=["pty-DUP-aa"],
            sessions_before=set(),
        )
    )
    assert [s.session_id for s in captured] == ["pty-DUP-aa"]
    # Only ONE detail fetch per session id.
    assert transport.get_calls == ["pty-DUP-aa"]


def test_capture_sub_agents_tolerates_list_sessions_failure():
    """list_sessions raising should not abort capture; the explicit ids
    from the planner still resolve via get_session."""
    transport = FailingListTransport(
        sessions={"pty-1-aa": {"agentType": "claude"}}
    )
    captured = _run(
        capture_sub_agents(
            transport,
            session_ids=["pty-1-aa"],
            sessions_before=set(),
        )
    )
    assert [s.session_id for s in captured] == ["pty-1-aa"]


def test_capture_sub_agents_skips_session_that_fails_to_resolve():
    """A get_session error for one session should NOT take down the whole
    capture — the remaining sessions are still recorded."""
    class PartialTransport(SubAgentTransport):
        async def list_sessions(self) -> list[dict[str, Any]]:
            return []

        async def get_session(
            self, session_id: str
        ) -> tuple[dict[str, Any], str]:
            if session_id == "pty-FAIL-xx":
                raise RuntimeError("simulated 500")
            return {"agentType": "claude"}, ""

    captured = _run(
        capture_sub_agents(
            PartialTransport(),
            session_ids=["pty-FAIL-xx", "pty-OK-aa"],
            sessions_before=set(),
        )
    )
    assert [s.session_id for s in captured] == ["pty-OK-aa"]


# ─────────────────────────── make_subagent_record ────────────────────────────


def test_make_subagent_record_tags_synth_kind():
    response = parse_bench_response(
        {
            "text": "ok",
            "actions": ["CREATE_TASK"],
            "params": {"sessionId": "pty-1-aa"},
            "benchmark": "synth-eliza",
            "task_id": "t-from-response",
        }
    )
    sub_agents = [
        SubAgentSession(
            session_id="pty-1-aa",
            agent_type="claude",
            workdir=None,
            status="running",
            detail={},
            output="",
        ),
    ]
    record = make_subagent_record(
        scenario={"task_id": "t-from-scenario", "user_text": "please do thing"},
        response=response,
        sub_agents=sub_agents,
    )
    assert record.synth_kind == SYNTH_KIND_WITH_SUBAGENTS
    # scenario.task_id wins over response.task_id (driver is authoritative).
    assert record.task_id == "t-from-scenario"
    assert record.benchmark == "synth-eliza"
    assert record.user_text == "please do thing"
    assert record.agent_text == "ok"
    assert record.actions == ["CREATE_TASK"]
    assert [s.session_id for s in record.sub_agents] == ["pty-1-aa"]


def test_make_subagent_record_falls_back_to_response_task_id():
    response = parse_bench_response(
        {"text": "", "task_id": "t-from-response", "benchmark": "b"}
    )
    record = make_subagent_record(
        scenario={"user_text": "hi"},  # no task_id
        response=response,
        sub_agents=[],
    )
    assert record.task_id == "t-from-response"


# ─────────────────────────── JSONL writer ────────────────────────────


def test_write_subagent_records_appends_jsonl(tmp_path):
    trace = CapturedSubAgentTrace(
        synth_kind=SYNTH_KIND_WITH_SUBAGENTS,
        task_id="t1",
        benchmark="b",
        user_text="u",
        agent_text="a",
        actions=["CREATE_TASK"],
        sub_agents=[
            SubAgentSession(
                session_id="pty-1-aa",
                agent_type="claude",
                workdir=None,
                status="completed",
                detail={},
                output="ran ok",
            ),
        ],
        captured_at_ms=1700000000000,
    )
    out = tmp_path / "with_subagents.jsonl"
    n = write_subagent_records([trace], out)
    assert n == 1
    lines = [ln for ln in out.read_text().splitlines() if ln.strip()]
    assert len(lines) == 1
    parsed = json.loads(lines[0])
    assert parsed["synth_kind"] == SYNTH_KIND_WITH_SUBAGENTS
    assert parsed["sub_agents"][0]["session_id"] == "pty-1-aa"
    assert parsed["sub_agents"][0]["output"] == "ran ok"

    # Appends, doesn't overwrite
    n2 = write_subagent_records([trace], out)
    assert n2 == 1
    lines2 = [ln for ln in out.read_text().splitlines() if ln.strip()]
    assert len(lines2) == 2


def test_write_subagent_records_noop_on_empty(tmp_path):
    out = tmp_path / "nope" / "with_subagents.jsonl"
    n = write_subagent_records([], out)
    assert n == 0
    # didn't create parent dir for an empty write
    assert not out.exists()


# ─────────────────────────── end-to-end fixture flow ────────────────────────────


def test_sample_run_writes_with_subagents_jsonl(tmp_path):
    """End-to-end fixture flow: simulate a synth turn that spawns a sub-agent.

    Drives the capture path the same way the worker loop would — snapshot,
    parse the bench response, capture, build record, write JSONL — but
    without aiohttp / a real server. Closes the M8 "sample run" checkpoint
    for unit tests.
    """
    bench_payload: dict[str, Any] = {
        "text": "spawning a sub-agent to handle this",
        "thought": "delegating",
        "actions": ["CREATE_TASK"],
        "params": {"sessionId": "pty-1700-deadbeef"},
        "benchmark": "synth-eliza",
        "task_id": "task-subagent-1",
        "room_id": "room-1",
        "trajectory_step": 1,
    }
    transport = FakeSubAgentTransport(
        # baseline (before turn) — no sessions
        # post-turn — the spawned session is now visible
        session_snapshots=[
            [],  # snapshot_session_ids
            [{"id": "pty-1700-deadbeef"}],  # capture_sub_agents
        ],
        sessions={
            "pty-1700-deadbeef": {
                "agentType": "codex",
                "workdir": "/tmp/codex-wk",
                "status": "completed",
            },
        },
        outputs={"pty-1700-deadbeef": "[codex] Task complete."},
    )

    async def fixture_turn() -> CapturedSubAgentTrace:
        sessions_before = await snapshot_session_ids(transport)
        parsed = parse_bench_response(bench_payload)
        sub_agents = await capture_sub_agents(
            transport,
            session_ids=parsed.sub_agent_session_ids,
            sessions_before=sessions_before,
        )
        return make_subagent_record(
            scenario={
                "task_id": "task-subagent-1",
                "user_text": "please refactor the auth module",
                "benchmark": "synth-eliza",
            },
            response=parsed,
            sub_agents=sub_agents,
        )

    record = _run(fixture_turn())
    out = tmp_path / "with_subagents.jsonl"
    n = write_subagent_records([record], out)
    assert n == 1

    parsed = json.loads(out.read_text().strip())
    assert parsed["synth_kind"] == SYNTH_KIND_WITH_SUBAGENTS
    assert parsed["task_id"] == "task-subagent-1"
    assert parsed["actions"] == ["CREATE_TASK"]
    assert len(parsed["sub_agents"]) == 1
    captured = parsed["sub_agents"][0]
    assert captured["session_id"] == "pty-1700-deadbeef"
    assert captured["agent_type"] == "codex"
    assert captured["status"] == "completed"
    assert captured["output"] == "[codex] Task complete."

    # Transport touched exactly the calls we expect
    assert transport.list_calls == 2  # baseline + capture
    assert transport.get_calls == ["pty-1700-deadbeef"]
