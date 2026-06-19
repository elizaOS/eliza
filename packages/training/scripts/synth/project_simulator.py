"""Multi-turn project simulator for synth trajectory generation.

Today's synth (`drive_eliza.py`, `together_synth.py`) is one-shot: each
scenario → one model call → one record. Real users drive *projects* —
multi-step goals where each turn depends on the previous response. The
fine-tuning corpus needs trajectories that look like that.

This module simulates a project. A "project" is an LLM-authored multi-step
goal, derived from either a seed corpus (curated good projects) or recent
benchmark failures (project shapes the current model fails on). At each
turn the simulator decides whether to:

  - send the next user prompt and record (prompt, agent response),
  - or terminate (goal reached / unrecoverable / max turns).

Every turn lands as one record in the output JSONL, tagged
``synth_kind: 'multi_turn_project'``, linked into a single trajectory
chain via ``parent_step_id`` (mirroring the in-runtime parent-step
linkage at
``plugins/plugin-agent-orchestrator/src/services/spawn-trajectory.ts``).

Architecture
============

CLI is a thin argparse wrapper.  All orchestration lives in
``ProjectSimulator``.  Three pluggable interfaces (typing.Protocol) let
the same loop run against:

  - fixture models (for unit/e2e tests, no network),
  - Together / Anthropic / OpenAI-compatible HTTP endpoints,
  - the eliza benchmark server (`drive_eliza.py` semantics).

The agent transport is supplied by the caller — this file does not own
HTTP code, on purpose.  Privacy filtering is NOT this module's concern
(repo-wide CLAUDE.md / training AGENTS.md require the
``validate_corpus.py`` + privacy filter passes downstream).

Usage
=====

::

    python -m synth.project_simulator \\
        --seed-file scripts/synth/scenarios/all.jsonl \\
        --turns 10 \\
        --output-dir data/synthesized/multi_turn_project/ \\
        --num-projects 50

Records (one per turn) look like::

    {
      "synth_kind": "multi_turn_project",
      "session_id": "proj-<uuid>",
      "project": {
        "id": "proj-<uuid>",
        "title": "Plan a 3-stop weekend road trip",
        "goal": "Get a confirmed itinerary with hotels and routes."
      },
      "turn_index": 2,
      "parent_step_id": "step-<uuid-of-turn-1>",
      "step_id": "step-<uuid-of-turn-2>",
      "messages": [
        {"role": "system", "content": "..."},
        {"role": "user", "content": "..."},
        {"role": "assistant", "content": "..."}
      ],
      "user_text": "...",
      "agent_text": "...",
      "termination": null   // or {"reason": "goal_reached" | "max_turns" | "unrecoverable"}
    }
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Iterator, Protocol

# stable tag for downstream filters / corpus assemblers
SYNTH_KIND = "multi_turn_project"


# ─────────────────────────── domain types ────────────────────────────


@dataclass(frozen=True)
class Project:
    """An LLM-authored (or seed-derived) multi-step user goal."""

    id: str
    title: str
    goal: str
    initial_user_text: str
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Message:
    role: str  # "user" | "assistant" | "system"
    content: str


class TerminationReason:
    GOAL_REACHED = "goal_reached"
    MAX_TURNS = "max_turns"
    UNRECOVERABLE = "unrecoverable"


@dataclass(frozen=True)
class TurnDecision:
    """What the simulator does at a turn boundary."""

    terminate: bool
    reason: str | None = None  # one of TerminationReason.*
    next_user_text: str | None = None


# ─────────────────────────── protocols ────────────────────────────


class ProjectAuthor(Protocol):
    """Generate `Project` instances. Used for both seed-corpus and
    benchmark-failure-driven authoring. Implementations may be deterministic
    (fixture for tests) or LLM-backed (Together / Anthropic) for production.
    """

    def author(self, *, n: int, rng: random.Random) -> list[Project]: ...


class AgentClient(Protocol):
    """Send a turn to the agent under test and get back the model output."""

    def respond(self, *, project: Project, history: list[Message]) -> str: ...


class TurnDecider(Protocol):
    """Given the project + history so far, decide whether to terminate
    or what the next user prompt should be.

    A real implementation will call an LLM to play the user. A fixture
    implementation can read from a scripted plan.
    """

    def decide(
        self,
        *,
        project: Project,
        history: list[Message],
        turn_index: int,
        max_turns: int,
    ) -> TurnDecision: ...


# ─────────────────────────── seed-file authoring ────────────────────────────


def load_seed_records(seed_path: Path) -> list[dict[str, Any]]:
    """Read a JSONL seed file (scenario shape; see drive_eliza.py)."""
    out: list[dict[str, Any]] = []
    with seed_path.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            out.append(json.loads(line))
    return out


class SeedFileProjectAuthor:
    """Author projects from a seed JSONL of scenarios.

    Each scenario becomes one project: the scenario's ``user_text`` is the
    initial user message; the project goal is derived from the scenario's
    ``benchmark`` / ``task_id``. This is the deterministic path used by
    tests; the LLM-backed path lives in ``LLMProjectAuthor`` (below).
    """

    def __init__(self, seed_records: list[dict[str, Any]]):
        if not seed_records:
            raise ValueError("SeedFileProjectAuthor: seed_records is empty")
        self._records = list(seed_records)

    def author(self, *, n: int, rng: random.Random) -> list[Project]:
        sample = (
            rng.sample(self._records, n)
            if n <= len(self._records)
            else [rng.choice(self._records) for _ in range(n)]
        )
        projects: list[Project] = []
        for rec in sample:
            task_id = rec.get("task_id") or f"seed-{uuid.uuid4()}"
            text = rec.get("user_text") or ""
            if not text:
                continue
            benchmark = rec.get("benchmark", "synth")
            projects.append(
                Project(
                    id=f"proj-{uuid.uuid4().hex[:12]}",
                    title=str(task_id)[:80],
                    goal=f"Complete the multi-step request: {text[:120]}",
                    initial_user_text=text,
                    metadata={
                        "seed_task_id": task_id,
                        "seed_benchmark": benchmark,
                        "seed_context": rec.get("context", {}),
                    },
                )
            )
        return projects


# ─────────────────────────── fixture transports ────────────────────────────


class ScriptedTurnDecider:
    """Deterministic turn decider for tests.

    Configured with a per-project plan listing what happens AFTER each
    completed turn. Index ``i`` of the plan is the decision made after
    turn ``i`` (which is itself indexed from 0). The value is either:

      - a string: the next user prompt for turn ``i + 1``,
      - ``None``: terminate after turn ``i`` (reason = GOAL_REACHED).

    Examples:
      - ``[]``           → terminate immediately after turn 0 (1 total turn).
      - ``["a"]``        → after turn 0, send "a" as turn 1; the simulator
                           then runs out of plan → terminate (2 total turns).
      - ``["a", None]``  → after turn 0, send "a"; after turn 1, terminate
                           (2 total turns, explicit GOAL_REACHED).
      - ``["a", "b", None]`` → 3 total turns; explicit GOAL_REACHED.

    Plans missing for a project default to "terminate immediately after
    turn 0".
    """

    def __init__(self, plan: dict[str, list[str | None]]):
        self._plan = plan

    def decide(
        self,
        *,
        project: Project,
        history: list[Message],
        turn_index: int,
        max_turns: int,
    ) -> TurnDecision:
        # turn_index here is the *next* turn that would be executed
        # (the simulator calls this after completing turn N with
        # turn_index = N + 1).
        if turn_index >= max_turns:
            return TurnDecision(terminate=True, reason=TerminationReason.MAX_TURNS)
        steps = self._plan.get(project.id, [])
        # plan[i] describes the decision after completing turn i;
        # so for the call after turn N, we read plan[N] which is at
        # index turn_index - 1.
        plan_idx = turn_index - 1
        if plan_idx < 0 or plan_idx >= len(steps):
            return TurnDecision(terminate=True, reason=TerminationReason.GOAL_REACHED)
        nxt = steps[plan_idx]
        if nxt is None:
            return TurnDecision(terminate=True, reason=TerminationReason.GOAL_REACHED)
        return TurnDecision(terminate=False, next_user_text=nxt)


class EchoAgentClient:
    """Fixture AgentClient: deterministic, no network.

    Returns a short, traceable response based on the last user message
    plus the turn index. Good enough for asserting trajectory shape +
    parent-step linkage in unit tests.
    """

    def respond(self, *, project: Project, history: list[Message]) -> str:
        last_user = next(
            (m.content for m in reversed(history) if m.role == "user"),
            "",
        )
        n_user = sum(1 for m in history if m.role == "user")
        return f"[fixture-agent t{n_user}] acknowledged: {last_user[:120]}"


# ─────────────────────────── default open-turn decider ────────────────────────────


class HeuristicTurnDecider:
    """A simple decider used when no LLM-backed decider is wired in.

    It terminates when the most recent agent response mentions a goal-
    completion sentinel (configurable), or after ``max_turns``. Otherwise
    it advances by appending a short follow-up prompt taken from a
    rotating pool. Useful for boot-strapping multi-turn data when no
    author LLM is available; production runs replace this with an
    LLM-backed decider.
    """

    DEFAULT_FOLLOWUPS = (
        "Great. What's next?",
        "Can you walk through the next step?",
        "Sounds good — keep going.",
        "Anything else I should confirm?",
        "Let's continue.",
    )
    DEFAULT_DONE_SENTINELS = ("done", "all set", "finished", "complete")

    def __init__(
        self,
        *,
        followups: Iterable[str] = DEFAULT_FOLLOWUPS,
        done_sentinels: Iterable[str] = DEFAULT_DONE_SENTINELS,
    ):
        self._followups = list(followups)
        if not self._followups:
            raise ValueError("HeuristicTurnDecider: followups must be non-empty")
        self._done = tuple(s.lower() for s in done_sentinels)

    def decide(
        self,
        *,
        project: Project,
        history: list[Message],
        turn_index: int,
        max_turns: int,
    ) -> TurnDecision:
        if turn_index >= max_turns:
            return TurnDecision(terminate=True, reason=TerminationReason.MAX_TURNS)
        last_agent = next(
            (m.content for m in reversed(history) if m.role == "assistant"),
            "",
        )
        if any(s in last_agent.lower() for s in self._done):
            return TurnDecision(terminate=True, reason=TerminationReason.GOAL_REACHED)
        return TurnDecision(
            terminate=False,
            next_user_text=self._followups[turn_index % len(self._followups)],
        )


# ─────────────────────────── core orchestrator ────────────────────────────


@dataclass
class TurnRecord:
    """One turn = one JSONL row.  Multiple records share a session_id and
    link via parent_step_id → step_id, mirroring the runtime's spawn-
    trajectory chain (see spawn-trajectory.ts).
    """

    synth_kind: str
    session_id: str
    project: dict[str, Any]
    turn_index: int
    parent_step_id: str | None
    step_id: str
    messages: list[dict[str, str]]
    user_text: str
    agent_text: str
    termination: dict[str, str] | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "synth_kind": self.synth_kind,
            "session_id": self.session_id,
            "project": self.project,
            "turn_index": self.turn_index,
            "parent_step_id": self.parent_step_id,
            "step_id": self.step_id,
            "messages": self.messages,
            "user_text": self.user_text,
            "agent_text": self.agent_text,
            "termination": self.termination,
        }


def _new_step_id() -> str:
    return f"step-{uuid.uuid4().hex[:16]}"


def _new_session_id(project_id: str) -> str:
    # session shares the project id; useful for grouping in BI / eval views
    return project_id


class ProjectSimulator:
    """Drive a project through up to ``max_turns`` turns.

    The simulator is transport-agnostic — it does not know about HTTP,
    Together, or anthropic SDKs. The caller injects:

      - an :class:`AgentClient` that knows how to talk to the model under
        test (or a fixture for tests),
      - a :class:`TurnDecider` that plays the user (LLM-backed in prod;
        scripted / heuristic for tests),
      - a system prompt rendered once at session start.

    The result of ``run(project)`` is a list of :class:`TurnRecord`,
    chained via parent_step_id → step_id. Persist them in order; the
    full session reconstructs by sorting on ``turn_index`` within a
    ``session_id``.
    """

    def __init__(
        self,
        *,
        agent: AgentClient,
        decider: TurnDecider,
        max_turns: int = 10,
        system_prompt: str | None = None,
    ):
        if max_turns < 1:
            raise ValueError("max_turns must be >= 1")
        self._agent = agent
        self._decider = decider
        self._max_turns = max_turns
        self._system_prompt = system_prompt

    def _render_system(self, project: Project) -> str:
        if self._system_prompt is not None:
            return self._system_prompt
        return (
            "You are an autonomous elizaOS agent. The user is pursuing a "
            f"multi-step project: {project.title}. Goal: {project.goal}. "
            "Drive each turn forward; ask follow-up questions only when "
            "needed."
        )

    def run(self, project: Project) -> list[TurnRecord]:
        """Execute one project session and return its turn records.

        Always emits at least one record (the seeded turn-0). The final
        record's ``termination`` field carries the reason; intermediate
        records have ``termination=None``.
        """
        session_id = _new_session_id(project.id)
        system_msg = Message(role="system", content=self._render_system(project))
        history: list[Message] = [system_msg]
        records: list[TurnRecord] = []
        parent_step_id: str | None = None

        # turn 0 uses the project's initial user text
        next_user_text: str | None = project.initial_user_text

        for turn_index in range(self._max_turns):
            if next_user_text is None:
                # decider chose to terminate before emitting a turn
                if records:
                    final = records[-1]
                    final.termination = {"reason": TerminationReason.GOAL_REACHED}
                break

            user_msg = Message(role="user", content=next_user_text)
            history.append(user_msg)

            agent_text = self._agent.respond(project=project, history=list(history))
            agent_msg = Message(role="assistant", content=agent_text)
            history.append(agent_msg)

            step_id = _new_step_id()
            record = TurnRecord(
                synth_kind=SYNTH_KIND,
                session_id=session_id,
                project={
                    "id": project.id,
                    "title": project.title,
                    "goal": project.goal,
                    "metadata": dict(project.metadata),
                },
                turn_index=turn_index,
                parent_step_id=parent_step_id,
                step_id=step_id,
                messages=[
                    {"role": "system", "content": system_msg.content},
                    {"role": "user", "content": next_user_text},
                    {"role": "assistant", "content": agent_text},
                ],
                user_text=next_user_text,
                agent_text=agent_text,
                termination=None,
            )
            records.append(record)
            parent_step_id = step_id

            decision = self._decider.decide(
                project=project,
                history=list(history),
                turn_index=turn_index + 1,
                max_turns=self._max_turns,
            )
            if decision.terminate:
                record.termination = {
                    "reason": decision.reason or TerminationReason.MAX_TURNS,
                }
                break
            next_user_text = decision.next_user_text

        else:
            # for-else: we exhausted max_turns without a termination decision
            if records:
                records[-1].termination = {"reason": TerminationReason.MAX_TURNS}

        return records


# ─────────────────────────── JSONL writer ────────────────────────────


def write_records(records: Iterable[TurnRecord], out_path: Path) -> int:
    """Append turn records to a JSONL file. Returns count written."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with out_path.open("a", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r.to_dict(), ensure_ascii=False) + "\n")
            n += 1
    return n


def iter_sessions(
    projects: list[Project],
    *,
    simulator: ProjectSimulator,
) -> Iterator[list[TurnRecord]]:
    """Yield one list-of-records per project. Generator so callers can stream-write."""
    for project in projects:
        yield simulator.run(project)


# ─────────────────────────── CLI (thin wrapper) ────────────────────────────


def _build_logger() -> logging.Logger:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )
    return logging.getLogger("project_simulator")


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        prog="project_simulator",
        description="Generate multi-turn project trajectories for synth.",
    )
    ap.add_argument(
        "--seed-file",
        type=Path,
        required=True,
        help="JSONL of seed scenarios (one project per line; "
        "see drive_eliza.py for the scenario shape).",
    )
    ap.add_argument(
        "--turns",
        type=int,
        default=10,
        help="Max turns per project session.",
    )
    ap.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="Directory where multi_turn_project.jsonl is written.",
    )
    ap.add_argument(
        "--num-projects",
        type=int,
        default=0,
        help="How many projects to author from the seed (0 = all).",
    )
    ap.add_argument(
        "--seed",
        type=int,
        default=0,
        help="Random seed for project sampling.",
    )
    ap.add_argument(
        "--decider",
        choices=["heuristic"],
        default="heuristic",
        help="Turn-decider implementation. Only 'heuristic' is wired into "
        "the CLI today; LLM-backed deciders are invoked programmatically.",
    )
    return ap.parse_args(argv)


def _default_agent_client() -> AgentClient:
    """The CLI default uses a fixture echo client. Production callers
    construct their own AgentClient (HTTP / Together / Anthropic) and
    drive ``ProjectSimulator`` directly — see ``together_synth.py`` for
    the pattern. The CLI keeps no business logic."""
    return EchoAgentClient()


def _default_decider(kind: str) -> TurnDecider:
    if kind == "heuristic":
        return HeuristicTurnDecider()
    raise ValueError(f"unknown decider kind: {kind}")


def main(argv: list[str] | None = None) -> int:
    log = _build_logger()
    args = _parse_args(argv)

    if not args.seed_file.exists():
        log.error("seed file not found: %s", args.seed_file)
        return 2

    seed_records = load_seed_records(args.seed_file)
    if not seed_records:
        log.error("seed file is empty: %s", args.seed_file)
        return 2

    rng = random.Random(args.seed)
    author = SeedFileProjectAuthor(seed_records)
    n = args.num_projects or len(seed_records)
    projects = author.author(n=n, rng=rng)
    log.info("authored %d projects from %s", len(projects), args.seed_file)

    simulator = ProjectSimulator(
        agent=_default_agent_client(),
        decider=_default_decider(args.decider),
        max_turns=args.turns,
    )

    out_path = args.output_dir / "multi_turn_project.jsonl"
    total = 0
    for records in iter_sessions(projects, simulator=simulator):
        total += write_records(records, out_path)

    log.info("wrote %d turn records → %s", total, out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
