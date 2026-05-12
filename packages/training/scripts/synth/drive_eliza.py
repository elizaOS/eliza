"""Drive a running eliza/eliza agent through scenarios to capture trajectories.

Architecture:
    drive_eliza.py
        ↓ HTTP POST /api/benchmark/message
    eliza benchmark server (started by `startBenchmarkServer()` in
        eliza/packages/app-core/src/benchmark/server.ts)
        ↓ runs the FULL agent pipeline:
            shouldRespond → context_routing → action_planner → response
        ↓ each model call writes to the trajectory_collector service
        ↓ trajectory-export-cron flushes to JSONL per-task
    ~/.eliza/training-datasets/<date>/{
        should_respond_trajectories.jsonl,
        context_routing_trajectories.jsonl,
        action_planner_trajectories.jsonl,
        response_trajectories.jsonl,
        media_description_trajectories.jsonl,
    }

The output JSONL has the canonical nubilio `{messages: [system, user, model]}`
shape — the same format the gold-standard nubilio-trajectories use.

Sub-agent capture (closes M8 / W1-T1 + W1-T2 + W1-T3):
    With ``--allow-subagents`` the driver flags each request with
    ``allow_subagents: true`` in the context block, then watches for sub-agent
    sessions that the agent spawns via the orchestrator (Claude/Codex/OpenCode).
    After the benchmark turn, the driver queries the orchestrator bridge
    (``/api/coding-agents/<sessionId>/...``) for each new session, normalizes
    the captured rollout, and writes a ``synth_kind: 'with_subagents'`` row to
    ``<output_dir>/with_subagents.jsonl``. The bridge endpoints are the same
    surface W1-T1/T2/T3 readers consume, so the trace shape stays consistent
    with the existing trajectory mergers.

Usage:
    # 1. Start the eliza benchmark server (separate process):
    cd /home/shaw/eliza && bun run --cwd packages/app-core src/benchmark/server.ts

    # 2. Run this driver:
    .venv/bin/python scripts/synth/drive_eliza.py \\
        --scenarios scripts/synth/scenarios/all.jsonl \\
        --base-url http://localhost:7777 \\
        --token "$ELIZA_BENCH_TOKEN" \\
        --concurrency 4 \\
        --max-scenarios 200000

    # With sub-agent capture (writes <output-dir>/with_subagents.jsonl):
    .venv/bin/python scripts/synth/drive_eliza.py \\
        --scenarios scripts/synth/scenarios/all.jsonl \\
        --base-url http://localhost:7777 \\
        --token "$ELIZA_BENCH_TOKEN" \\
        --allow-subagents \\
        --orchestrator-url http://localhost:31337 \\
        --output-dir data/synthesized/with_subagents/

    # 3. After the run, the trajectory-export-cron will flush JSONL.
    #    Or trigger immediately:
    curl -X POST localhost:7777/api/benchmark/diagnostics \\
        -H "Authorization: Bearer $ELIZA_BENCH_TOKEN"
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import random
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Protocol

ROOT = Path(__file__).resolve().parents[2]

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("drive_eliza")

# Tag for sub-agent-driven rows. Matches the convention set by
# scripts/synth/project_simulator.py (synth_kind: 'multi_turn_project'),
# and the M8 closeout brief.
SYNTH_KIND_WITH_SUBAGENTS = "with_subagents"


# ─────────────────────────── domain types ────────────────────────────


@dataclass(frozen=True)
class BenchmarkResponse:
    """Parsed shape of the bench server's /api/benchmark/message response.

    Only the fields the driver reasons about are typed. ``raw`` carries the
    full JSON payload for downstream callers that need the unparsed view
    (test fixtures, debug logs).
    """

    text: str
    thought: str | None
    actions: list[str]
    params: dict[str, Any]
    benchmark: str
    task_id: str
    room_id: str
    trajectory_step: int
    sub_agent_session_ids: list[str]
    raw: dict[str, Any]


@dataclass(frozen=True)
class SubAgentSession:
    """Read-only view of a spawned sub-agent session as returned by the
    orchestrator at ``GET /api/coding-agents/<sessionId>``.

    Mirrors the fields the orchestrator's agent-routes handler emits. We do
    not validate every nested field — the orchestrator is the source of
    truth for the schema, and the driver only stamps the captured payload
    into the JSONL row.
    """

    session_id: str
    agent_type: str
    workdir: str | None
    status: str
    detail: dict[str, Any]
    output: str


@dataclass(frozen=True)
class CapturedSubAgentTrace:
    """A sub-agent rollout captured for one scenario turn.

    Persisted as one JSONL row tagged ``synth_kind='with_subagents'``.
    """

    synth_kind: str
    task_id: str
    benchmark: str
    user_text: str
    agent_text: str
    actions: list[str]
    sub_agents: list[SubAgentSession]
    captured_at_ms: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "synth_kind": self.synth_kind,
            "task_id": self.task_id,
            "benchmark": self.benchmark,
            "user_text": self.user_text,
            "agent_text": self.agent_text,
            "actions": list(self.actions),
            "sub_agents": [
                {
                    "session_id": s.session_id,
                    "agent_type": s.agent_type,
                    "workdir": s.workdir,
                    "status": s.status,
                    "detail": dict(s.detail),
                    "output": s.output,
                }
                for s in self.sub_agents
            ],
            "captured_at_ms": self.captured_at_ms,
        }


# ─────────────────────────── HTTP transport (pluggable) ──────────────


class SubAgentTransport(Protocol):
    """Read-only HTTP surface the sub-agent capture path depends on.

    Two methods so we can mock the orchestrator in tests without standing
    up a real PTY service. The default production transport is
    :class:`AiohttpSubAgentTransport`.
    """

    async def list_sessions(self) -> list[dict[str, Any]]: ...

    async def get_session(
        self, session_id: str
    ) -> tuple[dict[str, Any], str]: ...


class AiohttpSubAgentTransport:
    """Production transport: hits the orchestrator HTTP API directly.

    The orchestrator and the bench server are different processes — the
    orchestrator runs inside the main eliza runtime on ``ELIZA_API_PORT``
    (31337 in dev) and the bench server runs on ``ELIZA_BENCH_URL`` (7777
    in the README example). Both URLs must be passed in by the caller.
    """

    def __init__(
        self,
        session: Any,  # aiohttp.ClientSession; left as Any to keep import lazy
        *,
        orchestrator_url: str,
        token: str,
        timeout_s: float = 30.0,
    ):
        self._session = session
        self._base = orchestrator_url.rstrip("/")
        self._token = token
        self._timeout_s = timeout_s

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self._token:
            h["Authorization"] = f"Bearer {self._token}"
        return h

    async def list_sessions(self) -> list[dict[str, Any]]:
        url = f"{self._base}/api/coding-agents"
        async with self._session.get(
            url, headers=self._headers(), timeout=self._timeout_s
        ) as resp:
            if resp.status >= 400:
                body = await resp.text()
                raise RuntimeError(
                    f"list_sessions HTTP {resp.status}: {body[:300]}"
                )
            payload = await resp.json()
            # The orchestrator returns either a bare list or {agents: [...]};
            # accept both so we don't break on a minor wire-shape revision.
            if isinstance(payload, list):
                return [s for s in payload if isinstance(s, dict)]
            if isinstance(payload, dict):
                agents = payload.get("agents") or payload.get("sessions") or []
                return [s for s in agents if isinstance(s, dict)]
            return []

    async def get_session(
        self, session_id: str
    ) -> tuple[dict[str, Any], str]:
        detail_url = f"{self._base}/api/coding-agents/{session_id}"
        output_url = f"{self._base}/api/coding-agents/{session_id}/output"
        async with self._session.get(
            detail_url, headers=self._headers(), timeout=self._timeout_s
        ) as resp:
            if resp.status >= 400:
                body = await resp.text()
                raise RuntimeError(
                    f"get_session({session_id}) HTTP {resp.status}: {body[:300]}"
                )
            detail = await resp.json()
            if not isinstance(detail, dict):
                detail = {}
        async with self._session.get(
            output_url, headers=self._headers(), timeout=self._timeout_s
        ) as resp:
            output_text = ""
            if resp.status < 400:
                payload = await resp.json()
                if isinstance(payload, dict):
                    raw = payload.get("output")
                    if isinstance(raw, str):
                        output_text = raw
                    elif isinstance(raw, list):
                        output_text = "\n".join(
                            str(line) for line in raw if line is not None
                        )
        return detail, output_text


# ─────────────────────────── scenario IO ────────────────────────────


def load_scenarios(path: Path) -> list[dict[str, Any]]:
    """Read JSONL of scenarios. Each line:
        {
          "task_id": "lifeops.brush-teeth-basic.direct",  // unique id
          "benchmark": "synth-eliza",                     // groups sessions
          "user_text": "did you brush your teeth this morning?",
          "context": {                                    // optional
            "channel": "dm" | "group",
            "available_actions": ["REPLY", "IGNORE", "TASK_CALL"],
            "memory": [{"role":"user","content":"..."}, ...],
          }
        }
    """
    out = []
    with path.open() as f:
        for i, line in enumerate(f):
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError as e:
                log.warning("scenario %d: %s", i, e)
    log.info("loaded %d scenarios from %s", len(out), path)
    return out


# ─────────────────────────── parsing helpers ────────────────────────────


def parse_bench_response(payload: dict[str, Any]) -> BenchmarkResponse:
    """Coerce the /api/benchmark/message JSON into a strongly-typed view.

    Sub-agent session ids are scraped from the captured action params:
    when the planner picks ``CREATE_TASK`` (or any of the spawn-shaped
    actions), the response's ``params`` block carries the spawned
    sessionId — that's the same path the orchestrator's W1-T1/T2/T3
    trajectory readers anchor on. We also accept an explicit
    ``sub_agent_session_ids`` array so the bench server can elect to
    pre-stamp the list directly (forward-compatible with a future
    server-side enrichment).
    """
    text = _str_or_empty(payload.get("text"))
    thought_raw = payload.get("thought")
    thought = thought_raw if isinstance(thought_raw, str) else None
    actions = _coerce_str_list(payload.get("actions"))
    params_raw = payload.get("params")
    params: dict[str, Any] = (
        params_raw if isinstance(params_raw, dict) else {}
    )
    benchmark = _str_or_empty(payload.get("benchmark"))
    task_id = _str_or_empty(payload.get("task_id"))
    room_id = _str_or_empty(payload.get("room_id"))
    trajectory_step_raw = payload.get("trajectory_step")
    trajectory_step = (
        int(trajectory_step_raw)
        if isinstance(trajectory_step_raw, int)
        else 0
    )
    session_ids = _extract_sub_agent_ids(payload, params)
    return BenchmarkResponse(
        text=text,
        thought=thought,
        actions=actions,
        params=params,
        benchmark=benchmark,
        task_id=task_id,
        room_id=room_id,
        trajectory_step=trajectory_step,
        sub_agent_session_ids=session_ids,
        raw=payload,
    )


def _str_or_empty(v: Any) -> str:
    return v if isinstance(v, str) else ""


def _coerce_str_list(v: Any) -> list[str]:
    if not isinstance(v, list):
        return []
    return [item for item in v if isinstance(item, str)]


def _extract_sub_agent_ids(
    payload: dict[str, Any], params: dict[str, Any]
) -> list[str]:
    """Scrape spawned coding-agent session ids from the response.

    Recognized shapes:
      - ``payload.sub_agent_session_ids`` (explicit, future-compat)
      - ``params.sessionId`` (CREATE_TASK / SPAWN_AGENT happy path)
      - ``params.sessionIds`` (multi-spawn)
      - ``params.sub_agents[*].sessionId`` (planner-emitted aggregate)

    Returns a de-duplicated list in insertion order.
    """
    seen: dict[str, None] = {}

    def _add(v: Any) -> None:
        if isinstance(v, str) and v.startswith("pty-"):
            seen.setdefault(v, None)

    explicit = payload.get("sub_agent_session_ids")
    if isinstance(explicit, list):
        for v in explicit:
            _add(v)

    _add(params.get("sessionId"))
    raw_ids = params.get("sessionIds")
    if isinstance(raw_ids, list):
        for v in raw_ids:
            _add(v)
    raw_sub_agents = params.get("sub_agents")
    if isinstance(raw_sub_agents, list):
        for entry in raw_sub_agents:
            if isinstance(entry, dict):
                _add(entry.get("sessionId"))

    return list(seen.keys())


# ─────────────────────────── sub-agent capture ────────────────────────────


def normalize_session_detail(
    session_id: str, detail: dict[str, Any], output: str
) -> SubAgentSession:
    """Build a :class:`SubAgentSession` from the orchestrator's response.

    The orchestrator returns at minimum ``{sessionId, agentType, workdir,
    status}``; we keep the full ``detail`` blob for downstream filters
    rather than dropping fields we don't yet care about.
    """
    agent_type = detail.get("agentType")
    workdir = detail.get("workdir")
    status = detail.get("status")
    return SubAgentSession(
        session_id=session_id,
        agent_type=agent_type if isinstance(agent_type, str) else "unknown",
        workdir=workdir if isinstance(workdir, str) else None,
        status=status if isinstance(status, str) else "unknown",
        detail=detail,
        output=output,
    )


async def capture_sub_agents(
    transport: SubAgentTransport,
    *,
    session_ids: list[str],
    sessions_before: set[str],
) -> list[SubAgentSession]:
    """Capture sub-agent rollouts for the just-completed turn.

    Strategy:
      1. Start from the explicit ``session_ids`` the planner returned.
      2. List active sessions and treat any session_id NOT in
         ``sessions_before`` as "newly spawned this turn".
      3. Union the two sets, query the bridge for each session's detail +
         output, and return the normalized list.

    Session ids absent from both sources are not captured. We do NOT raise
    on individual session-fetch failures — a partial capture is the
    correct behavior for synth (one bad session shouldn't void the turn).
    Per-session failures are logged at warn level.
    """
    seen: dict[str, None] = {sid: None for sid in session_ids}
    try:
        current = await transport.list_sessions()
    except Exception as e:  # noqa: BLE001
        # Treat list_sessions failure as "no new sessions visible" — we
        # still capture the explicit ids the planner returned. This is
        # the only place we swallow an HTTP error; everywhere else we
        # surface failures up.
        log.warning("list_sessions failed: %s", e)
        current = []
    for entry in current:
        sid = entry.get("id") or entry.get("sessionId")
        if isinstance(sid, str) and sid not in sessions_before:
            seen.setdefault(sid, None)

    captured: list[SubAgentSession] = []
    for sid in seen:
        try:
            detail, output = await transport.get_session(sid)
        except Exception as e:  # noqa: BLE001
            log.warning("get_session(%s) failed: %s", sid, e)
            continue
        captured.append(normalize_session_detail(sid, detail, output))
    return captured


async def snapshot_session_ids(transport: SubAgentTransport) -> set[str]:
    """List active sub-agent session ids. Used as the "before" baseline
    so :func:`capture_sub_agents` can compute newly spawned sessions.

    Failures degrade to an empty baseline (the diff math then captures
    every visible session, which is the safer side for synth).
    """
    try:
        rows = await transport.list_sessions()
    except Exception as e:  # noqa: BLE001
        log.warning("snapshot_session_ids: list_sessions failed: %s", e)
        return set()
    ids: set[str] = set()
    for entry in rows:
        sid = entry.get("id") or entry.get("sessionId")
        if isinstance(sid, str):
            ids.add(sid)
    return ids


def make_subagent_record(
    *,
    scenario: dict[str, Any],
    response: BenchmarkResponse,
    sub_agents: list[SubAgentSession],
) -> CapturedSubAgentTrace:
    """Build the JSONL row for a turn that spawned at least one sub-agent."""
    return CapturedSubAgentTrace(
        synth_kind=SYNTH_KIND_WITH_SUBAGENTS,
        task_id=scenario.get("task_id") or response.task_id or "",
        benchmark=scenario.get("benchmark") or response.benchmark or "synth-eliza",
        user_text=str(scenario.get("user_text") or ""),
        agent_text=response.text,
        actions=list(response.actions),
        sub_agents=list(sub_agents),
        captured_at_ms=int(time.time() * 1000),
    )


def write_subagent_records(
    records: list[CapturedSubAgentTrace], out_path: Path
) -> int:
    """Append captured sub-agent records to a JSONL file.

    Returns the number of rows written. The output directory is created if
    missing — matches the convention in ``project_simulator.write_records``.
    """
    if not records:
        return 0
    out_path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with out_path.open("a", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r.to_dict(), ensure_ascii=False) + "\n")
            n += 1
    return n


# ─────────────────────────── core HTTP loop ────────────────────────────


async def post_message(
    session, base_url: str, token: str, scenario: dict[str, Any],
    timeout_s: float = 60.0, allow_subagents: bool = False,
) -> dict[str, Any]:
    """POST one scenario. Returns the eliza response payload (or raises).

    When ``allow_subagents`` is true the request's ``context.allow_subagents``
    flag tells the bench server (and downstream planner / orchestrator) that
    spawning coding sub-agents is permitted for this turn. The server is
    free to ignore the hint — the driver still captures whatever sub-agent
    sessions appear via the orchestrator bridge.
    """
    context: dict[str, Any] = {
        "benchmark": scenario.get("benchmark", "synth-eliza"),
        "taskId": scenario.get("task_id", str(uuid.uuid4())),
        **(scenario.get("context") or {}),
    }
    if allow_subagents:
        context["allow_subagents"] = True
    payload = {
        "text": scenario["user_text"],
        "context": context,
    }
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    async with session.post(
        f"{base_url.rstrip('/')}/api/benchmark/message",
        json=payload, headers=headers, timeout=timeout_s,
    ) as resp:
        if resp.status >= 400:
            body = await resp.text()
            raise RuntimeError(f"HTTP {resp.status}: {body[:300]}")
        return await resp.json()


@dataclass
class WorkerConfig:
    """Per-worker config bundle so we don't pass 8 positional args."""

    base_url: str
    token: str
    allow_subagents: bool
    transport: SubAgentTransport | None
    capture_records: list[CapturedSubAgentTrace] = field(default_factory=list)
    capture_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


async def worker(
    worker_id: int, queue: asyncio.Queue, config: WorkerConfig,
    stats: dict[str, int],
):
    import aiohttp
    timeout = aiohttp.ClientTimeout(total=60)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        while True:
            scenario = await queue.get()
            if scenario is None:
                break
            t0 = time.time()
            try:
                # Snapshot active sessions BEFORE the turn so we can
                # diff "newly spawned" after the planner runs.
                sessions_before: set[str] = (
                    await snapshot_session_ids(config.transport)
                    if (config.allow_subagents and config.transport)
                    else set()
                )

                raw = await post_message(
                    session, config.base_url, config.token, scenario,
                    allow_subagents=config.allow_subagents,
                )
                stats["ok"] += 1

                if config.allow_subagents and config.transport:
                    parsed = parse_bench_response(raw)
                    sub_agents = await capture_sub_agents(
                        config.transport,
                        session_ids=parsed.sub_agent_session_ids,
                        sessions_before=sessions_before,
                    )
                    if sub_agents:
                        record = make_subagent_record(
                            scenario=scenario,
                            response=parsed,
                            sub_agents=sub_agents,
                        )
                        async with config.capture_lock:
                            config.capture_records.append(record)
                        stats["sub_agent_turns"] = (
                            stats.get("sub_agent_turns", 0) + 1
                        )

                if stats["ok"] % 50 == 0:
                    log.info(
                        "[w%d] %d ok, %d fail, last=%.1fs",
                        worker_id, stats["ok"], stats["fail"], time.time() - t0,
                    )
            except Exception as e:
                stats["fail"] += 1
                if stats["fail"] <= 5 or stats["fail"] % 50 == 0:
                    log.warning("[w%d] %s", worker_id, str(e)[:200])
            finally:
                queue.task_done()


# Type alias for the transport factory: a callable that takes an aiohttp
# ClientSession and returns a SubAgentTransport. The default constructs
# the production AiohttpSubAgentTransport; tests inject a fake.
TransportFactory = Callable[[Any], SubAgentTransport]


async def run(
    scenarios: list[dict[str, Any]],
    *, base_url: str, token: str, concurrency: int,
    allow_subagents: bool = False,
    orchestrator_url: str | None = None,
    output_dir: Path | None = None,
    transport_factory: TransportFactory | None = None,
) -> dict[str, int]:
    """Drive scenarios. When ``allow_subagents`` is set, capture sub-agent
    rollouts via the orchestrator bridge and persist them to
    ``<output_dir>/with_subagents.jsonl``.

    Returns the run stats dict, including ``sub_agent_turns`` when capture
    is enabled.
    """
    queue: asyncio.Queue = asyncio.Queue(maxsize=concurrency * 8)
    stats: dict[str, int] = {"ok": 0, "fail": 0}
    if allow_subagents:
        stats["sub_agent_turns"] = 0

    if allow_subagents and not transport_factory and not orchestrator_url:
        raise ValueError(
            "--allow-subagents requires --orchestrator-url (or a "
            "transport_factory in tests)"
        )

    # Reset the bench server state once at start so we get a clean session.
    import aiohttp
    async with aiohttp.ClientSession() as session:
        try:
            headers = {"Authorization": f"Bearer {token}"} if token else {}
            async with session.post(
                f"{base_url.rstrip('/')}/api/benchmark/reset", headers=headers,
            ) as r:
                log.info("reset bench server: %s", r.status)
        except Exception as e:
            log.warning("reset failed (continuing): %s", e)

    # Build the transport once; share it across workers since the
    # aiohttp.ClientSession is itself safe for concurrent calls.
    transport_session: Any = None
    transport: SubAgentTransport | None = None
    if allow_subagents:
        if transport_factory is not None:
            # Test path: the factory may not even use the session arg.
            transport = transport_factory(None)
        else:
            transport_session = aiohttp.ClientSession()
            assert orchestrator_url is not None  # checked above
            transport = AiohttpSubAgentTransport(
                transport_session,
                orchestrator_url=orchestrator_url,
                token=token,
            )

    config = WorkerConfig(
        base_url=base_url,
        token=token,
        allow_subagents=allow_subagents,
        transport=transport,
    )

    workers = [
        asyncio.create_task(worker(i, queue, config, stats))
        for i in range(concurrency)
    ]

    t0 = time.time()
    try:
        for sc in scenarios:
            await queue.put(sc)
        for _ in range(concurrency):
            await queue.put(None)
        await queue.join()
        for w in workers:
            await w
    finally:
        if transport_session is not None:
            await transport_session.close()
    elapsed = time.time() - t0

    log.info(
        "done in %.1fs — %d ok, %d fail, %.2f scenarios/s",
        elapsed, stats["ok"], stats["fail"],
        stats["ok"] / max(1.0, elapsed),
    )

    if allow_subagents and config.capture_records and output_dir is not None:
        out_path = output_dir / "with_subagents.jsonl"
        written = write_subagent_records(config.capture_records, out_path)
        log.info(
            "captured %d sub-agent turns → %s",
            written, out_path,
        )
        stats["sub_agent_records_written"] = written

    return stats


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenarios", type=Path, required=True,
                    help="JSONL of scenarios to drive through the agent")
    ap.add_argument("--base-url", type=str,
                    default=os.environ.get("ELIZA_BENCH_URL", "http://localhost:7777"))
    ap.add_argument("--token", type=str,
                    default=os.environ.get("ELIZA_BENCH_TOKEN", ""))
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--max-scenarios", type=int, default=0,
                    help="cap input scenarios (0 = all)")
    ap.add_argument("--shuffle", action="store_true",
                    help="shuffle scenarios before dispatch")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument(
        "--allow-subagents",
        action="store_true",
        help="permit sub-agent (Codex/Claude/OpenCode) spawns and capture "
        "the resulting sessions via the orchestrator bridge. Writes "
        "<output-dir>/with_subagents.jsonl tagged synth_kind='with_subagents'.",
    )
    ap.add_argument(
        "--orchestrator-url",
        type=str,
        default=os.environ.get(
            "ELIZA_ORCHESTRATOR_URL", "http://localhost:31337"
        ),
        help="base URL of the orchestrator that owns /api/coding-agents/*. "
        "Only used when --allow-subagents is set.",
    )
    ap.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="output directory for sub-agent capture JSONL. Required when "
        "--allow-subagents is set.",
    )
    args = ap.parse_args()

    if args.allow_subagents and args.output_dir is None:
        log.error("--allow-subagents requires --output-dir")
        return 2

    scenarios = load_scenarios(args.scenarios)
    if args.shuffle:
        rng = random.Random(args.seed)
        rng.shuffle(scenarios)
    if args.max_scenarios:
        scenarios = scenarios[:args.max_scenarios]

    if not scenarios:
        log.error("no scenarios loaded — check %s", args.scenarios)
        return 1

    log.info(
        "driving %d scenarios @ concurrency=%d → %s (sub-agents=%s)",
        len(scenarios), args.concurrency, args.base_url,
        "on" if args.allow_subagents else "off",
    )

    try:
        stats = asyncio.run(run(
            scenarios,
            base_url=args.base_url, token=args.token,
            concurrency=args.concurrency,
            allow_subagents=args.allow_subagents,
            orchestrator_url=args.orchestrator_url
            if args.allow_subagents
            else None,
            output_dir=args.output_dir if args.allow_subagents else None,
        ))
    except KeyboardInterrupt:
        log.warning("interrupted")
        return 130
    return 0 if stats["fail"] < len(scenarios) // 10 else 1


if __name__ == "__main__":
    sys.exit(main())
