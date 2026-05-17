"""Failure-driven adaptive synth (closes M6).

Builds on the W1-S1 multi-turn project simulator. The one-shot synth
(``together_synth.py``, ``drive_eliza.py``) and the W1-S1 simulator both
generate trajectories from generic seeds. This module closes the loop:

  1. read recent benchmark failures (from the W0-X5 ``ResultsStore``
     SQLite DB at ``~/.eliza/benchmarks/results.db``, OR from JSON
     artifacts written by older benchmark adapters),
  2. for each failure, ask an LLM "author" to produce N variation
     prompts that exercise the same failure mode,
  3. drive each variation through ``project_simulator.ProjectSimulator``
     using the same agent transport the operator already wired up,
  4. write the resulting trajectories with two adaptive-synth tags:
     ``synth_kind: 'failure_derived'`` and
     ``derived_from: '<benchmark_run_id>'``.

The downstream filter (``judge_filter.py`` / M7) decides whether a
generated record clears the quality bar before SFT. This module's job
is to expose the failure mode in N nearby shapes; it does not pre-filter.

Architecture
============

Strict layering, no business logic in the CLI:

  - :class:`FailureSource` (Protocol) — yields :class:`BenchmarkFailure`
    rows. Two concrete implementations ship here:

    * :class:`ResultsStoreFailureSource` reads the W0-X5 SQLite DB.
    * :class:`JsonArtifactFailureSource` reads JSON / JSONL files.

  - :class:`VariationAuthor` (Protocol) — given a :class:`BenchmarkFailure`,
    returns N :class:`project_simulator.Project` instances (variations on
    the failure prompt). A :class:`FixtureVariationAuthor` ships for tests;
    an :class:`AnthropicVariationAuthor` ships for production behind an
    optional dependency (only imported when used).

  - :class:`AdaptiveSynth` drives the orchestration: pull failures →
    author N variations each → run each through ProjectSimulator → tag
    every record → stream-write JSONL.

No silent drops
===============

Per the package contract in ``packages/training/CLAUDE.md``: every dropped
or failed input is surfaced. ``AdaptiveSynth.run()`` returns
:class:`AdaptiveSynthReport` which counts failures pulled, variations
authored, sessions written, AND every error encountered (parse failure,
authoring exception, simulator exception). The CLI writes the report
beside the output JSONL.

CLI
===

::

    python -m synth.adaptive_synth \\
        --since 2025-05-01 \\
        --variations 3 \\
        --output-dir data/synthesized/adaptive/

Tagged record shape
===================

Each turn record from ProjectSimulator gets two extra top-level fields::

    {
      "synth_kind": "failure_derived",          # overwrites the inherited
                                                # 'multi_turn_project' tag
      "derived_from": "run-42",                 # benchmark run id
      "failure_context": {                      # full failure metadata
        "model_id": "...",
        "benchmark": "...",
        "score": 0.12,
        "ts": 1715000000000
      },
      "variation_index": 1,                     # 0..N-1 per failure
      ...rest of the multi-turn-project shape from project_simulator.py...
    }
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import sys
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping, Protocol, Sequence

# Allow `from synth.project_simulator import ...` when invoked as
# ``python -m synth.adaptive_synth`` from packages/training/.
HERE = Path(__file__).resolve().parent
SCRIPTS_ROOT = HERE.parent
if str(SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_ROOT))

from synth.project_simulator import (  # noqa: E402
    AgentClient,
    EchoAgentClient,
    HeuristicTurnDecider,
    Project,
    ProjectSimulator,
    TurnDecider,
    TurnRecord,
)

SYNTH_KIND = "failure_derived"

log = logging.getLogger("synth.adaptive_synth")


_RESULTS_STORE_MODULE_NAME = "_adaptive_synth_results_store"


def _load_results_store() -> tuple[type, "Callable[[], Path]"]:
    """Load the W0-X5 ``ResultsStore`` lazily from its absolute path.

    The repo layout puts the canonical ResultsStore at
    ``packages/benchmarks/lib/results_store.py``. ``packages/training``
    also has a (different) ``benchmarks/`` directory (eliza1_gates),
    so we cannot safely add the parent ``packages`` dir to ``sys.path``
    — the training-local ``benchmarks`` package would shadow the
    sibling one. We load by absolute file path via ``importlib.util``
    instead and register the loaded module in ``sys.modules`` so
    dataclasses referenced by string annotations resolve cleanly.
    Raises ImportError on failure (no silent fallback).
    """
    import importlib.util

    cached = sys.modules.get(_RESULTS_STORE_MODULE_NAME)
    if cached is not None:
        return cached.ResultsStore, cached.default_db_path

    repo_root = SCRIPTS_ROOT.parent.parent  # .../packages/
    target = repo_root / "benchmarks" / "lib" / "results_store.py"
    if not target.is_file():
        raise ImportError(
            f"ResultsStoreFailureSource: could not find {target}"
        )
    spec = importlib.util.spec_from_file_location(
        _RESULTS_STORE_MODULE_NAME, target
    )
    if spec is None or spec.loader is None:
        raise ImportError(
            f"ResultsStoreFailureSource: importlib could not build a spec "
            f"for {target}"
        )
    module = importlib.util.module_from_spec(spec)
    # Register before exec so dataclass(slots / __module__ lookups succeed.
    sys.modules[_RESULTS_STORE_MODULE_NAME] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(_RESULTS_STORE_MODULE_NAME, None)
        raise
    return module.ResultsStore, module.default_db_path


# ─────────────────────────── domain types ────────────────────────────


@dataclass(frozen=True)
class BenchmarkFailure:
    """A single failed benchmark run pulled from the W0-X5 store or JSON.

    ``run_id`` is the unique identifier used to populate
    ``derived_from`` on every generated trajectory. ``failed_tasks`` is
    optional but, when present, lets the author produce variations that
    target the *specific* failed tasks rather than the aggregate score.
    """

    run_id: str
    model_id: str
    benchmark: str
    score: float
    ts: int
    failed_tasks: tuple[Mapping[str, Any], ...] = field(default_factory=tuple)
    raw: Mapping[str, Any] = field(default_factory=dict)

    def to_context(self) -> dict[str, Any]:
        """Return the failure context attached to every derived trajectory."""
        return {
            "run_id": self.run_id,
            "model_id": self.model_id,
            "benchmark": self.benchmark,
            "score": self.score,
            "ts": self.ts,
        }


# ─────────────────────────── failure sources ────────────────────────────


class FailureSource(Protocol):
    """Yields recent benchmark failures.

    Implementations decide what counts as "recent" (epoch ms cutoff) and
    what counts as a "failure" (score threshold). Both are CLI-tunable.
    """

    def list_failures(
        self,
        *,
        since_ts_ms: int,
        threshold: float,
    ) -> list[BenchmarkFailure]: ...


def _extract_failed_tasks(raw: Mapping[str, Any]) -> tuple[Mapping[str, Any], ...]:
    """Pull per-task failure entries out of a benchmark ``raw_json`` blob.

    Accepted shapes (whichever the adapter happens to write):

    1. ``raw["failed_tasks"]: [{"task_id": "...", "user_text": "...", ...}]``
    2. ``raw["tasks"]: [{"task_id": "...", "passed": false, ...}, ...]``
    3. ``raw["results"]: [{"task_id": "...", "score": 0.1, ...}, ...]``
       (entries with ``score < 0.5`` are treated as failures).

    Anything else returns an empty tuple — the author still has the
    aggregate failure metadata to work from.
    """
    failed = raw.get("failed_tasks")
    if isinstance(failed, list):
        return tuple(t for t in failed if isinstance(t, dict))

    tasks = raw.get("tasks")
    if isinstance(tasks, list):
        out: list[Mapping[str, Any]] = []
        for t in tasks:
            if not isinstance(t, dict):
                continue
            passed = t.get("passed")
            if passed is False:
                out.append(t)
        if out:
            return tuple(out)

    results = raw.get("results")
    if isinstance(results, list):
        out2: list[Mapping[str, Any]] = []
        for t in results:
            if not isinstance(t, dict):
                continue
            sc = t.get("score")
            if isinstance(sc, (int, float)) and float(sc) < 0.5:
                out2.append(t)
        if out2:
            return tuple(out2)

    return ()


class ResultsStoreFailureSource:
    """Pull failures from the W0-X5 SQLite ResultsStore.

    Failures are runs whose aggregate score is strictly below the
    ``threshold`` passed to :meth:`list_failures`, recorded at or after
    ``since_ts_ms``. The store is opened read-side only; this module
    never writes back.
    """

    def __init__(self, db_path: str | Path | None = None):
        # Load lazily so test environments without ``benchmarks.lib``
        # on sys.path still load this module. Load directly from the
        # sibling-package path to avoid colliding with
        # ``packages/training/benchmarks/`` (eliza1_gates), which
        # shadows the top-level ``benchmarks`` package name.
        ResultsStore, default_db_path = _load_results_store()
        self._ResultsStore = ResultsStore
        self._db_path = Path(db_path) if db_path is not None else default_db_path()

    def list_failures(
        self,
        *,
        since_ts_ms: int,
        threshold: float,
    ) -> list[BenchmarkFailure]:
        if since_ts_ms < 0:
            raise ValueError("since_ts_ms must be non-negative")
        if not 0.0 <= threshold <= 1.0:
            raise ValueError("threshold must be in [0.0, 1.0]")

        store = self._ResultsStore(db_path=self._db_path)
        try:
            conn = store._connect()  # noqa: SLF001 — readonly query, store owns conn
            rows = conn.execute(
                """
                SELECT id, model_id, benchmark, score, ts,
                       dataset_version, code_commit, raw_json
                  FROM benchmark_runs
                 WHERE score < ? AND ts >= ?
                 ORDER BY ts DESC, id DESC
                """,
                (float(threshold), int(since_ts_ms)),
            ).fetchall()
        finally:
            store.close()

        out: list[BenchmarkFailure] = []
        for r in rows:
            try:
                raw = json.loads(r["raw_json"])
            except (TypeError, json.JSONDecodeError) as exc:
                log.warning(
                    "ResultsStoreFailureSource: skipping run id=%s with "
                    "malformed raw_json: %r",
                    r["id"],
                    exc,
                )
                continue
            if not isinstance(raw, dict):
                log.warning(
                    "ResultsStoreFailureSource: run id=%s raw_json is not "
                    "an object (got %s); using empty context",
                    r["id"],
                    type(raw).__name__,
                )
                raw = {}
            out.append(
                BenchmarkFailure(
                    run_id=f"run-{int(r['id'])}",
                    model_id=str(r["model_id"]),
                    benchmark=str(r["benchmark"]),
                    score=float(r["score"]),
                    ts=int(r["ts"]),
                    failed_tasks=_extract_failed_tasks(raw),
                    raw=raw,
                )
            )
        return out


class JsonArtifactFailureSource:
    """Pull failures from a directory of JSON/JSONL artifacts.

    Each artifact is one benchmark run. Accepted layouts:

    - ``*.json`` containing a single run object,
    - ``*.jsonl`` with one run per line.

    Each object MUST carry ``model_id``, ``benchmark``, ``score``, ``ts``
    (unix ms). Optional ``id`` keys provide stable run ids; otherwise a
    deterministic ``<benchmark>-<ts>`` id is synthesized so derived
    trajectories still chain back to a unique source.

    Objects whose ``score`` is at or above ``threshold`` are skipped at
    list time; objects older than ``since_ts_ms`` are also skipped.
    """

    def __init__(self, root: str | Path):
        root_path = Path(root)
        if not root_path.exists():
            raise FileNotFoundError(
                f"JsonArtifactFailureSource root does not exist: {root_path}"
            )
        if not root_path.is_dir():
            raise NotADirectoryError(
                f"JsonArtifactFailureSource root must be a directory: {root_path}"
            )
        self._root = root_path

    def _iter_raw_runs(self) -> Iterator[tuple[Path, dict[str, Any]]]:
        for path in sorted(self._root.rglob("*")):
            if not path.is_file():
                continue
            suffix = path.suffix.lower()
            if suffix == ".json":
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                except json.JSONDecodeError as exc:
                    log.warning(
                        "JsonArtifactFailureSource: skipping malformed %s: %r",
                        path,
                        exc,
                    )
                    continue
                if isinstance(data, list):
                    for entry in data:
                        if isinstance(entry, dict):
                            yield path, entry
                elif isinstance(data, dict):
                    yield path, data
                else:
                    log.warning(
                        "JsonArtifactFailureSource: %s is not an object or "
                        "list; skipping",
                        path,
                    )
            elif suffix == ".jsonl":
                try:
                    for i, raw_line in enumerate(
                        path.read_text(encoding="utf-8").splitlines()
                    ):
                        line = raw_line.strip()
                        if not line:
                            continue
                        try:
                            entry = json.loads(line)
                        except json.JSONDecodeError as exc:
                            log.warning(
                                "JsonArtifactFailureSource: skipping malformed "
                                "line %d in %s: %r",
                                i + 1,
                                path,
                                exc,
                            )
                            continue
                        if isinstance(entry, dict):
                            yield path, entry
                except OSError as exc:
                    log.warning(
                        "JsonArtifactFailureSource: could not read %s: %r",
                        path,
                        exc,
                    )

    def list_failures(
        self,
        *,
        since_ts_ms: int,
        threshold: float,
    ) -> list[BenchmarkFailure]:
        if since_ts_ms < 0:
            raise ValueError("since_ts_ms must be non-negative")
        if not 0.0 <= threshold <= 1.0:
            raise ValueError("threshold must be in [0.0, 1.0]")

        out: list[BenchmarkFailure] = []
        for path, raw in self._iter_raw_runs():
            try:
                score = float(raw["score"])
                ts = int(raw["ts"])
                model_id = str(raw["model_id"])
                benchmark = str(raw["benchmark"])
            except (KeyError, TypeError, ValueError) as exc:
                log.warning(
                    "JsonArtifactFailureSource: %s missing required fields "
                    "(model_id, benchmark, score, ts): %r",
                    path,
                    exc,
                )
                continue

            if score >= threshold or ts < since_ts_ms:
                continue

            run_id = raw.get("id") or raw.get("run_id")
            if run_id is None or not str(run_id):
                run_id = f"{benchmark}-{ts}"
            out.append(
                BenchmarkFailure(
                    run_id=str(run_id),
                    model_id=model_id,
                    benchmark=benchmark,
                    score=score,
                    ts=ts,
                    failed_tasks=_extract_failed_tasks(raw),
                    raw=raw,
                )
            )
        return out


# ─────────────────────────── variation authors ────────────────────────────


class VariationAuthor(Protocol):
    """LLM (or fixture) that turns a failure into N nearby :class:`Project`."""

    def author_variations(
        self,
        *,
        failure: BenchmarkFailure,
        n: int,
        rng: random.Random,
    ) -> list[Project]: ...


def _variation_project_id() -> str:
    return f"proj-{uuid.uuid4().hex[:12]}"


class FixtureVariationAuthor:
    """Deterministic author. Used by tests; also a sane offline default.

    For each failure, emits N projects whose initial user prompt is the
    failure's ``user_text`` (if recoverable from ``raw``) with a
    variation index appended. The goal and title surface the failure's
    benchmark + score so the simulator system prompt has something
    concrete.
    """

    def __init__(self, *, template: str = "[variation {i}] {prompt}"):
        if "{i}" not in template or "{prompt}" not in template:
            raise ValueError(
                "FixtureVariationAuthor.template must include both "
                "{i} and {prompt} placeholders"
            )
        self._template = template

    def author_variations(
        self,
        *,
        failure: BenchmarkFailure,
        n: int,
        rng: random.Random,
    ) -> list[Project]:
        if n < 1:
            raise ValueError("n must be >= 1")
        # Recover something prompt-like from the failure metadata.
        candidates: list[str] = []
        for task in failure.failed_tasks:
            text = task.get("user_text") or task.get("prompt") or task.get("input")
            if isinstance(text, str) and text.strip():
                candidates.append(text.strip())
        if not candidates:
            top_level = failure.raw.get("user_text") or failure.raw.get("prompt")
            if isinstance(top_level, str) and top_level.strip():
                candidates.append(top_level.strip())
        if not candidates:
            candidates.append(
                f"Reproduce the {failure.benchmark} failure (score={failure.score:.2f})."
            )

        projects: list[Project] = []
        for i in range(n):
            base = candidates[i % len(candidates)]
            initial = self._template.format(i=i, prompt=base)
            projects.append(
                Project(
                    id=_variation_project_id(),
                    title=f"{failure.benchmark}#{failure.run_id} var{i}"[:80],
                    goal=(
                        f"Stress-test the {failure.benchmark} failure mode "
                        f"(baseline score {failure.score:.2f})."
                    ),
                    initial_user_text=initial,
                    metadata={
                        "failure_run_id": failure.run_id,
                        "failure_benchmark": failure.benchmark,
                        "failure_model_id": failure.model_id,
                        "failure_score": failure.score,
                        "variation_index": i,
                    },
                )
            )
        return projects


class CallableVariationAuthor:
    """Adapter that wraps a plain callable as a :class:`VariationAuthor`.

    The callable is given ``(failure, n)`` and must return a sequence of
    ``(title, goal, initial_user_text)`` triples (one per variation).
    Used by ``AnthropicVariationAuthor`` and by tests that want to mock
    out the LLM without subclassing.
    """

    def __init__(
        self,
        fn: Callable[[BenchmarkFailure, int], Sequence[tuple[str, str, str]]],
    ):
        self._fn = fn

    def author_variations(
        self,
        *,
        failure: BenchmarkFailure,
        n: int,
        rng: random.Random,
    ) -> list[Project]:
        if n < 1:
            raise ValueError("n must be >= 1")
        triples = list(self._fn(failure, n))
        if len(triples) != n:
            raise ValueError(
                f"CallableVariationAuthor: callable returned {len(triples)} "
                f"variations but {n} were requested"
            )
        projects: list[Project] = []
        for i, triple in enumerate(triples):
            if not (isinstance(triple, tuple) and len(triple) == 3):
                raise ValueError(
                    f"CallableVariationAuthor: variation {i} is not a "
                    "(title, goal, initial_user_text) tuple"
                )
            title, goal, prompt = triple
            if not all(isinstance(v, str) and v.strip() for v in (title, goal, prompt)):
                raise ValueError(
                    f"CallableVariationAuthor: variation {i} has empty fields"
                )
            projects.append(
                Project(
                    id=_variation_project_id(),
                    title=title[:80],
                    goal=goal,
                    initial_user_text=prompt,
                    metadata={
                        "failure_run_id": failure.run_id,
                        "failure_benchmark": failure.benchmark,
                        "failure_model_id": failure.model_id,
                        "failure_score": failure.score,
                        "variation_index": i,
                    },
                )
            )
        return projects


# ─────────────────────────── orchestrator ────────────────────────────


@dataclass
class AdaptiveSynthReport:
    """Bookkeeping for one ``AdaptiveSynth.run()`` invocation.

    Counters and per-failure errors are all surfaced — nothing is
    silently dropped. Authoring exceptions, simulator exceptions, and
    write exceptions land in :attr:`errors` with the failure run id +
    a short description.
    """

    failures_seen: int = 0
    variations_authored: int = 0
    sessions_written: int = 0
    records_written: int = 0
    errors: list[dict[str, str]] = field(default_factory=list)

    def add_error(self, *, run_id: str, stage: str, message: str) -> None:
        self.errors.append({"run_id": run_id, "stage": stage, "message": message})

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class AdaptiveSynth:
    """Drive failures → variations → simulator → tagged trajectories.

    The orchestrator is transport-agnostic. Callers wire in:

      - a :class:`FailureSource` (SQLite or JSON),
      - a :class:`VariationAuthor` (fixture / Anthropic / callable),
      - an :class:`AgentClient` from ``project_simulator`` (echo for
        tests, HTTP for prod),
      - a :class:`TurnDecider` (heuristic / scripted / LLM-backed).

    Records are tagged with both ``synth_kind='failure_derived'`` and
    ``derived_from=<run_id>`` before being written.
    """

    def __init__(
        self,
        *,
        failures: FailureSource,
        author: VariationAuthor,
        agent: AgentClient,
        decider: TurnDecider,
        max_turns: int = 5,
        system_prompt: str | None = None,
    ):
        if max_turns < 1:
            raise ValueError("max_turns must be >= 1")
        self._failures = failures
        self._author = author
        self._agent = agent
        self._decider = decider
        self._max_turns = max_turns
        self._system_prompt = system_prompt

    def _tag_record(
        self,
        record: TurnRecord,
        *,
        failure: BenchmarkFailure,
        variation_index: int,
    ) -> dict[str, Any]:
        blob = record.to_dict()
        blob["synth_kind"] = SYNTH_KIND  # overwrite multi_turn_project tag
        blob["derived_from"] = failure.run_id
        blob["failure_context"] = failure.to_context()
        blob["variation_index"] = variation_index
        return blob

    def run(
        self,
        *,
        since_ts_ms: int,
        variations_per_failure: int,
        threshold: float,
        out_path: Path,
        rng: random.Random | None = None,
    ) -> AdaptiveSynthReport:
        """Execute one adaptive-synth pass and stream-write tagged JSONL.

        Errors at each stage land in the report; ``run()`` never raises
        on individual failure-level errors (it does raise on
        configuration errors like a missing output dir creation).
        """
        if variations_per_failure < 1:
            raise ValueError("variations_per_failure must be >= 1")

        rng = rng or random.Random()
        report = AdaptiveSynthReport()
        out_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            failures = self._failures.list_failures(
                since_ts_ms=since_ts_ms,
                threshold=threshold,
            )
        except Exception as exc:  # surfacing — caller will see in report
            report.add_error(
                run_id="<source>",
                stage="list_failures",
                message=repr(exc),
            )
            return report

        report.failures_seen = len(failures)
        log.info(
            "adaptive_synth: pulled %d failures (since_ts_ms=%d, threshold=%s)",
            len(failures),
            since_ts_ms,
            threshold,
        )

        simulator = ProjectSimulator(
            agent=self._agent,
            decider=self._decider,
            max_turns=self._max_turns,
            system_prompt=self._system_prompt,
        )

        with out_path.open("a", encoding="utf-8") as fh:
            for failure in failures:
                try:
                    projects = self._author.author_variations(
                        failure=failure,
                        n=variations_per_failure,
                        rng=rng,
                    )
                except Exception as exc:
                    report.add_error(
                        run_id=failure.run_id,
                        stage="author",
                        message=repr(exc),
                    )
                    continue

                report.variations_authored += len(projects)

                for project in projects:
                    variation_index = int(
                        project.metadata.get("variation_index", 0)
                    )
                    try:
                        records = simulator.run(project)
                    except Exception as exc:
                        report.add_error(
                            run_id=failure.run_id,
                            stage="simulate",
                            message=repr(exc),
                        )
                        continue

                    if not records:
                        report.add_error(
                            run_id=failure.run_id,
                            stage="simulate",
                            message="simulator returned 0 records "
                            f"(project_id={project.id})",
                        )
                        continue

                    try:
                        for rec in records:
                            blob = self._tag_record(
                                rec,
                                failure=failure,
                                variation_index=variation_index,
                            )
                            fh.write(json.dumps(blob, ensure_ascii=False) + "\n")
                            report.records_written += 1
                    except OSError as exc:
                        report.add_error(
                            run_id=failure.run_id,
                            stage="write",
                            message=repr(exc),
                        )
                        continue

                    report.sessions_written += 1

        return report


# ─────────────────────────── CLI ────────────────────────────


def _parse_since(value: str) -> int:
    """Parse a CLI ``--since`` value into unix ms.

    Accepts:
      - ISO-8601 date (``2025-05-01``) — interpreted as 00:00 UTC,
      - ISO-8601 datetime (``2025-05-01T12:34:56Z``),
      - bare integer unix-ms.
    """
    value = value.strip()
    if not value:
        raise ValueError("--since must be non-empty")
    # bare int → unix ms
    if value.isdigit():
        return int(value)
    # ISO-8601 — let datetime do the parsing
    try:
        if "T" in value or " " in value:
            normalized = value.replace("Z", "+00:00")
            dt = datetime.fromisoformat(normalized)
        else:
            dt = datetime.fromisoformat(value).replace(
                hour=0, minute=0, second=0, microsecond=0
            )
    except ValueError as exc:
        raise ValueError(f"could not parse --since {value!r}: {exc}") from exc
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def _build_logger() -> logging.Logger:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )
    return logging.getLogger("adaptive_synth")


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        prog="adaptive_synth",
        description=(
            "Failure-driven adaptive synth: pull recent benchmark failures, "
            "author N variations per failure, drive each through the "
            "project simulator, write tagged trajectories."
        ),
    )
    ap.add_argument(
        "--since",
        required=True,
        help=(
            "Inclusive lower bound for failure recency. Accepts ISO-8601 "
            "(2025-05-01 or 2025-05-01T12:00:00Z) or bare unix-ms."
        ),
    )
    ap.add_argument(
        "--variations",
        type=int,
        default=3,
        help="Number of variation projects to author per failure (default 3).",
    )
    ap.add_argument(
        "--threshold",
        type=float,
        default=0.5,
        help="Score strictly below this counts as a failure (default 0.5).",
    )
    ap.add_argument(
        "--turns",
        type=int,
        default=5,
        help="Max turns per simulator session (default 5).",
    )
    ap.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="Directory to write adaptive_synth.jsonl + the report.",
    )
    ap.add_argument(
        "--source",
        choices=["results-db", "json"],
        default="results-db",
        help=(
            "Failure source: 'results-db' (W0-X5 ResultsStore SQLite) or "
            "'json' (a directory of JSON/JSONL artifacts)."
        ),
    )
    ap.add_argument(
        "--db-path",
        type=Path,
        default=None,
        help=(
            "Override the ResultsStore DB path. Defaults to the path "
            "resolved by benchmarks.lib.results_store.default_db_path()."
        ),
    )
    ap.add_argument(
        "--artifacts-dir",
        type=Path,
        default=None,
        help="Root directory for --source json. Required when source=json.",
    )
    ap.add_argument(
        "--seed",
        type=int,
        default=0,
        help="Random seed for the fixture author + heuristic decider.",
    )
    return ap.parse_args(argv)


def _build_failure_source(args: argparse.Namespace) -> FailureSource:
    if args.source == "results-db":
        return ResultsStoreFailureSource(db_path=args.db_path)
    if args.source == "json":
        if args.artifacts_dir is None:
            raise SystemExit(
                "--artifacts-dir is required when --source=json"
            )
        return JsonArtifactFailureSource(root=args.artifacts_dir)
    raise SystemExit(f"unknown source: {args.source}")


def _default_author() -> VariationAuthor:
    """The CLI default is the fixture author. Production callers wiring
    in a live LLM (Anthropic / Together / OpenAI) construct the
    :class:`CallableVariationAuthor` themselves and call
    :class:`AdaptiveSynth` directly — same pattern as together_synth.py.
    """
    return FixtureVariationAuthor()


def _default_agent() -> AgentClient:
    return EchoAgentClient()


def _default_decider() -> TurnDecider:
    return HeuristicTurnDecider()


def main(argv: list[str] | None = None) -> int:
    log_ = _build_logger()
    args = _parse_args(argv)

    try:
        since_ts_ms = _parse_since(args.since)
    except ValueError as exc:
        log_.error("invalid --since: %s", exc)
        return 2

    try:
        failures = _build_failure_source(args)
    except (FileNotFoundError, NotADirectoryError, ImportError) as exc:
        log_.error("could not open failure source: %s", exc)
        return 2

    out_dir: Path = args.output_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "adaptive_synth.jsonl"
    report_path = out_dir / "adaptive_synth.report.json"

    rng = random.Random(args.seed)
    synth = AdaptiveSynth(
        failures=failures,
        author=_default_author(),
        agent=_default_agent(),
        decider=_default_decider(),
        max_turns=args.turns,
    )

    started = time.time()
    report = synth.run(
        since_ts_ms=since_ts_ms,
        variations_per_failure=args.variations,
        threshold=args.threshold,
        out_path=out_path,
        rng=rng,
    )
    elapsed_ms = int((time.time() - started) * 1000)

    report_blob = report.to_dict()
    report_blob["elapsed_ms"] = elapsed_ms
    report_blob["since_ts_ms"] = since_ts_ms
    report_blob["variations_per_failure"] = args.variations
    report_blob["threshold"] = args.threshold
    report_path.write_text(json.dumps(report_blob, indent=2, sort_keys=True))

    log_.info(
        "adaptive_synth: failures=%d variations=%d sessions=%d records=%d errors=%d → %s",
        report.failures_seen,
        report.variations_authored,
        report.sessions_written,
        report.records_written,
        len(report.errors),
        out_path,
    )
    if report.errors:
        log_.warning(
            "adaptive_synth: %d failure(s) hit errors; see %s",
            len(report.errors),
            report_path,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
