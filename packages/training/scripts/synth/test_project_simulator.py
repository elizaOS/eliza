"""Unit + E2E tests for the multi-turn project simulator.

CPU-only. No network. Tiny fixture model + scripted plan → deterministic
3-turn trajectory. Designed to run under the pre-flight gate without
requiring the training extras.

Covers:

- ``ProjectSimulator.run`` turn loop (advances + terminates correctly).
- Parent-step linkage: turn N's ``step_id`` == turn N+1's
  ``parent_step_id``, mirroring spawn-trajectory.ts.
- ``TerminationReason.MAX_TURNS`` vs ``GOAL_REACHED`` paths.
- JSONL writer round-trip (E2E: 3-turn trajectory written + reread).
- CLI smoke test (heuristic decider + echo agent).
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

import pytest

# allow `from synth.project_simulator import ...` when pytest discovers
# this test from the package root.
HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from synth.project_simulator import (  # noqa: E402
    SYNTH_KIND,
    AgentClient,
    EchoAgentClient,
    HeuristicTurnDecider,
    Message,
    Project,
    ProjectSimulator,
    ScriptedTurnDecider,
    SeedFileProjectAuthor,
    TerminationReason,
    TurnDecision,
    TurnRecord,
    iter_sessions,
    load_seed_records,
    main as cli_main,
    write_records,
)


# ─────────────────────────── helpers ────────────────────────────


def _project(pid: str = "proj-test-1") -> Project:
    return Project(
        id=pid,
        title="Tiny weekend trip",
        goal="Confirm a 2-stop road-trip itinerary.",
        initial_user_text="Help me plan a weekend trip with two stops.",
        metadata={"seed_task_id": "test-task", "seed_benchmark": "unit-test"},
    )


class FixtureAgent(AgentClient):
    """Deterministic agent: responses chosen by turn index from a script."""

    def __init__(self, scripted_outputs: list[str]):
        self._outputs = scripted_outputs
        self._idx = 0

    def respond(self, *, project: Project, history: list[Message]) -> str:
        if self._idx >= len(self._outputs):
            return "(no further script)"
        out = self._outputs[self._idx]
        self._idx += 1
        return out


# ─────────────────────────── unit tests ────────────────────────────


def test_runs_one_turn_when_decider_terminates_immediately():
    sim = ProjectSimulator(
        agent=EchoAgentClient(),
        decider=ScriptedTurnDecider({"proj-1": []}),
        max_turns=5,
    )
    project = _project("proj-1")
    records = sim.run(project)
    assert len(records) == 1
    assert records[0].turn_index == 0
    assert records[0].parent_step_id is None
    assert records[0].step_id.startswith("step-")
    assert records[0].termination == {"reason": TerminationReason.GOAL_REACHED}
    assert records[0].user_text == project.initial_user_text


def test_parent_step_chain_is_intact_across_turns():
    plan = {"proj-2": ["follow up 1", "follow up 2", None]}
    sim = ProjectSimulator(
        agent=FixtureAgent(["resp 0", "resp 1", "resp 2"]),
        decider=ScriptedTurnDecider(plan),
        max_turns=10,
    )
    records = sim.run(_project("proj-2"))

    # 3 turns: initial + 2 follow-ups; then None → terminate
    assert [r.turn_index for r in records] == [0, 1, 2]
    # First record has no parent
    assert records[0].parent_step_id is None
    # Each subsequent record's parent_step_id is the previous step_id
    for prev, cur in zip(records, records[1:]):
        assert cur.parent_step_id == prev.step_id
    # All records share session_id (== project.id)
    assert {r.session_id for r in records} == {"proj-2"}
    # Final record carries termination; earlier ones do not
    assert records[-1].termination == {"reason": TerminationReason.GOAL_REACHED}
    assert records[0].termination is None
    assert records[1].termination is None


def test_max_turns_terminates_with_correct_reason():
    # plan never terminates; only max_turns can stop us
    long_plan = {"proj-3": ["continue"] * 100}
    sim = ProjectSimulator(
        agent=FixtureAgent(["a", "b", "c"]),
        decider=ScriptedTurnDecider(long_plan),
        max_turns=3,
    )
    records = sim.run(_project("proj-3"))
    assert len(records) == 3
    assert records[-1].termination == {"reason": TerminationReason.MAX_TURNS}


def test_heuristic_decider_recognizes_done_sentinel():
    # Agent says "all set" → decider should terminate
    sim = ProjectSimulator(
        agent=FixtureAgent(["I have answered everything. all set."]),
        decider=HeuristicTurnDecider(),
        max_turns=5,
    )
    records = sim.run(_project("proj-4"))
    assert len(records) == 1
    assert records[0].termination == {"reason": TerminationReason.GOAL_REACHED}


def test_turn_records_tag_synth_kind():
    sim = ProjectSimulator(
        agent=EchoAgentClient(),
        decider=ScriptedTurnDecider({"proj-5": ["next"]}),
        max_turns=5,
    )
    records = sim.run(_project("proj-5"))
    assert len(records) == 2
    assert all(r.synth_kind == SYNTH_KIND for r in records)


def test_messages_contain_system_user_assistant_in_order():
    sim = ProjectSimulator(
        agent=FixtureAgent(["agent-says-hi"]),
        decider=ScriptedTurnDecider({"proj-6": []}),
        max_turns=5,
        system_prompt="you are a tester",
    )
    records = sim.run(_project("proj-6"))
    msgs = records[0].messages
    assert [m["role"] for m in msgs] == ["system", "user", "assistant"]
    assert msgs[0]["content"] == "you are a tester"
    assert msgs[1]["content"] == _project("proj-6").initial_user_text
    assert msgs[2]["content"] == "agent-says-hi"


def test_seed_file_author_handles_missing_user_text():
    records = [
        {"task_id": "ok", "user_text": "do the thing", "benchmark": "b"},
        {"task_id": "bad", "user_text": "", "benchmark": "b"},  # skipped
    ]
    author = SeedFileProjectAuthor(records)
    projects = author.author(n=2, rng=random.Random(0))
    # Empty-text record is dropped; we only get 1 project even when n=2
    assert len(projects) == 1
    assert projects[0].initial_user_text == "do the thing"


def test_max_turns_zero_is_invalid():
    with pytest.raises(ValueError, match="max_turns"):
        ProjectSimulator(
            agent=EchoAgentClient(),
            decider=ScriptedTurnDecider({}),
            max_turns=0,
        )


def test_empty_seed_corpus_rejected():
    with pytest.raises(ValueError, match="empty"):
        SeedFileProjectAuthor([])


# ─────────────────────────── E2E test: 3-turn JSONL roundtrip ────────────────────────────


def test_e2e_three_turn_trajectory_produced(tmp_path):
    """End-to-end: simulator + JSONL writer produce a 3-turn chain that
    reads back with intact parent-step linkage and the
    ``synth_kind='multi_turn_project'`` tag.
    """
    plan = {"proj-e2e": ["second user turn", "third user turn", None]}
    sim = ProjectSimulator(
        agent=FixtureAgent(["agent reply 0", "agent reply 1", "agent reply 2"]),
        decider=ScriptedTurnDecider(plan),
        max_turns=10,
    )
    project = _project("proj-e2e")
    records = sim.run(project)
    assert len(records) == 3

    # Write via the public writer
    out = tmp_path / "multi_turn_project.jsonl"
    n_written = write_records(records, out)
    assert n_written == 3

    # Read back and assert chain integrity
    parsed = [json.loads(line) for line in out.read_text().splitlines()]
    assert len(parsed) == 3
    for r in parsed:
        assert r["synth_kind"] == SYNTH_KIND
        assert r["session_id"] == "proj-e2e"
        assert r["project"]["id"] == "proj-e2e"

    # parent_step_id chain
    assert parsed[0]["parent_step_id"] is None
    assert parsed[1]["parent_step_id"] == parsed[0]["step_id"]
    assert parsed[2]["parent_step_id"] == parsed[1]["step_id"]

    # turn_index monotonic, starting at 0
    assert [r["turn_index"] for r in parsed] == [0, 1, 2]

    # user_text matches the script
    assert parsed[0]["user_text"] == project.initial_user_text
    assert parsed[1]["user_text"] == "second user turn"
    assert parsed[2]["user_text"] == "third user turn"

    # only the final record carries termination
    assert parsed[0]["termination"] is None
    assert parsed[1]["termination"] is None
    assert parsed[2]["termination"] == {"reason": TerminationReason.GOAL_REACHED}


def test_iter_sessions_yields_one_list_per_project(tmp_path):
    projects = [_project(f"p-{i}") for i in range(3)]
    sim = ProjectSimulator(
        agent=EchoAgentClient(),
        decider=ScriptedTurnDecider({p.id: [] for p in projects}),
        max_turns=2,
    )
    sessions = list(iter_sessions(projects, simulator=sim))
    assert len(sessions) == 3
    assert all(len(s) == 1 for s in sessions)
    assert {s[0].session_id for s in sessions} == {p.id for p in projects}


# ─────────────────────────── CLI smoke test ────────────────────────────


def test_cli_smoke_run(tmp_path):
    """Run the CLI as if invoked from the shell, with a tiny seed file.

    Heuristic decider + echo agent → 1-turn-per-project output (echo
    response doesn't trigger any done-sentinel; max_turns=1 forces stop).
    """
    seed_path = tmp_path / "seed.jsonl"
    seed_path.write_text(
        json.dumps({"task_id": "t1", "user_text": "do thing one", "benchmark": "b"})
        + "\n"
        + json.dumps({"task_id": "t2", "user_text": "do thing two", "benchmark": "b"})
        + "\n",
    )
    out_dir = tmp_path / "out"

    exit_code = cli_main(
        [
            "--seed-file", str(seed_path),
            "--turns", "1",
            "--output-dir", str(out_dir),
            "--num-projects", "2",
            "--seed", "42",
        ]
    )
    assert exit_code == 0
    out_file = out_dir / "multi_turn_project.jsonl"
    assert out_file.exists()
    lines = [line for line in out_file.read_text().splitlines() if line.strip()]
    assert len(lines) == 2  # one turn per project
    for raw in lines:
        rec = json.loads(raw)
        assert rec["synth_kind"] == SYNTH_KIND
        assert rec["turn_index"] == 0
        assert rec["parent_step_id"] is None
        assert rec["termination"]["reason"] == TerminationReason.MAX_TURNS


def test_cli_missing_seed_file_exits_nonzero(tmp_path):
    out_dir = tmp_path / "out"
    exit_code = cli_main(
        [
            "--seed-file", str(tmp_path / "nope.jsonl"),
            "--turns", "3",
            "--output-dir", str(out_dir),
        ]
    )
    assert exit_code == 2


def test_load_seed_records_skips_blank_lines(tmp_path):
    f = tmp_path / "seed.jsonl"
    f.write_text(
        '{"task_id":"a","user_text":"x"}\n\n   \n'
        '{"task_id":"b","user_text":"y"}\n'
    )
    records = load_seed_records(f)
    assert len(records) == 2
    assert records[0]["task_id"] == "a"
    assert records[1]["task_id"] == "b"


# ─────────────────────────── TurnDecision wiring ────────────────────────────


def test_turn_decision_terminate_carries_reason():
    d = TurnDecision(terminate=True, reason=TerminationReason.UNRECOVERABLE)
    assert d.terminate is True
    assert d.reason == TerminationReason.UNRECOVERABLE
    assert d.next_user_text is None


def test_turn_decision_continue_carries_next_text():
    d = TurnDecision(terminate=False, next_user_text="next!")
    assert d.terminate is False
    assert d.next_user_text == "next!"
    assert d.reason is None


def test_turn_record_to_dict_round_trip():
    r = TurnRecord(
        synth_kind=SYNTH_KIND,
        session_id="s",
        project={"id": "p", "title": "t", "goal": "g", "metadata": {}},
        turn_index=0,
        parent_step_id=None,
        step_id="step-x",
        messages=[{"role": "system", "content": "sys"}],
        user_text="u",
        agent_text="a",
        termination=None,
    )
    blob = r.to_dict()
    assert blob["synth_kind"] == SYNTH_KIND
    assert blob["session_id"] == "s"
    assert blob["step_id"] == "step-x"
    # JSON-serializable
    json.dumps(blob)
