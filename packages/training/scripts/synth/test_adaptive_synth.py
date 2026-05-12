"""Tests for failure-driven adaptive synth (M6 / W1-S2).

CPU-only. No network. Mocked author + fixture agent → deterministic
output. Covers:

  - Fixture failure set (JSON artifacts + a tiny SQLite ResultsStore
    written in-test) → loaded by both source implementations.
  - Mocked author → variations generated + tagged with
    ``derived_from`` + ``synth_kind='failure_derived'``.
  - No silent drops: author exceptions land in the report, not stdout.
  - CLI smoke (--source json end-to-end).
  - ``--since`` parsing for ISO-8601, dates, and bare unix-ms.
"""

from __future__ import annotations

import json
import random
import sqlite3
import sys
from pathlib import Path
from typing import Any

import pytest

# Make ``synth.adaptive_synth`` importable from this test file regardless
# of where pytest collects it.
HERE = Path(__file__).resolve().parent
SCRIPTS_ROOT = HERE.parent
if str(SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_ROOT))
PACKAGES_ROOT = SCRIPTS_ROOT.parent.parent
if str(PACKAGES_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGES_ROOT))

from synth.adaptive_synth import (  # noqa: E402
    SYNTH_KIND,
    AdaptiveSynth,
    AdaptiveSynthReport,
    BenchmarkFailure,
    CallableVariationAuthor,
    FixtureVariationAuthor,
    JsonArtifactFailureSource,
    ResultsStoreFailureSource,
    _extract_failed_tasks,
    _parse_since,
    main as cli_main,
)
from synth.project_simulator import (  # noqa: E402
    AgentClient,
    EchoAgentClient,
    HeuristicTurnDecider,
    Project,
    ScriptedTurnDecider,
)


# ─────────────────────────── fixture helpers ────────────────────────────


def _failure(
    *,
    run_id: str = "run-1",
    benchmark: str = "synth-fail",
    score: float = 0.2,
    failed_tasks: tuple[dict[str, Any], ...] = (),
    raw: dict[str, Any] | None = None,
) -> BenchmarkFailure:
    return BenchmarkFailure(
        run_id=run_id,
        model_id="eliza-1-2b",
        benchmark=benchmark,
        score=score,
        ts=1_700_000_000_000,
        failed_tasks=failed_tasks,
        raw=raw or {},
    )


# ─────────────────────────── BenchmarkFailure shape ────────────────────────────


def test_failure_to_context_strips_raw():
    f = _failure(
        raw={"large": "x" * 1000, "user_text": "do x"},
        failed_tasks=({"task_id": "t1", "user_text": "do x"},),
    )
    ctx = f.to_context()
    assert set(ctx.keys()) == {"run_id", "model_id", "benchmark", "score", "ts"}
    assert ctx["run_id"] == "run-1"
    assert ctx["score"] == 0.2


def test_extract_failed_tasks_failed_tasks_key():
    raw = {"failed_tasks": [{"task_id": "a"}, {"task_id": "b"}, "garbage"]}
    out = _extract_failed_tasks(raw)
    assert len(out) == 2
    assert out[0]["task_id"] == "a"


def test_extract_failed_tasks_tasks_passed_false():
    raw = {
        "tasks": [
            {"task_id": "a", "passed": True},
            {"task_id": "b", "passed": False},
            {"task_id": "c", "passed": False},
        ]
    }
    out = _extract_failed_tasks(raw)
    assert [t["task_id"] for t in out] == ["b", "c"]


def test_extract_failed_tasks_results_low_score():
    raw = {
        "results": [
            {"task_id": "a", "score": 0.9},
            {"task_id": "b", "score": 0.2},
            {"task_id": "c", "score": 0.49},
        ]
    }
    out = _extract_failed_tasks(raw)
    assert [t["task_id"] for t in out] == ["b", "c"]


def test_extract_failed_tasks_empty_when_no_signal():
    assert _extract_failed_tasks({"unrelated": 1}) == ()


# ─────────────────────────── FixtureVariationAuthor ────────────────────────────


def test_fixture_author_uses_failed_task_prompts():
    f = _failure(
        failed_tasks=(
            {"task_id": "t1", "user_text": "summarize the doc"},
            {"task_id": "t2", "user_text": "list the names"},
        )
    )
    rng = random.Random(0)
    projects = FixtureVariationAuthor().author_variations(
        failure=f, n=3, rng=rng
    )
    assert len(projects) == 3
    # variation 0 picks the first candidate, 1 the second, 2 wraps.
    assert "summarize the doc" in projects[0].initial_user_text
    assert "list the names" in projects[1].initial_user_text
    assert "summarize the doc" in projects[2].initial_user_text
    for i, p in enumerate(projects):
        assert p.metadata["variation_index"] == i
        assert p.metadata["failure_run_id"] == "run-1"


def test_fixture_author_falls_back_to_user_text_in_raw():
    f = _failure(raw={"user_text": "the raw prompt"})
    projects = FixtureVariationAuthor().author_variations(
        failure=f, n=1, rng=random.Random(0)
    )
    assert "the raw prompt" in projects[0].initial_user_text


def test_fixture_author_synthesizes_prompt_when_no_text_available():
    f = _failure(benchmark="numeric-bench", score=0.12, raw={})
    projects = FixtureVariationAuthor().author_variations(
        failure=f, n=2, rng=random.Random(0)
    )
    # Synthetic prompt mentions both the benchmark + the score.
    for p in projects:
        assert "numeric-bench" in p.initial_user_text
        assert "0.12" in p.initial_user_text


def test_fixture_author_rejects_n_zero():
    with pytest.raises(ValueError, match="n must be >= 1"):
        FixtureVariationAuthor().author_variations(
            failure=_failure(), n=0, rng=random.Random(0)
        )


def test_fixture_author_template_must_have_placeholders():
    with pytest.raises(ValueError, match="placeholders"):
        FixtureVariationAuthor(template="no_placeholders")


# ─────────────────────────── CallableVariationAuthor ────────────────────────────


def test_callable_author_passes_through_triples():
    def fake_llm(failure, n):
        return [
            (f"title-{i}", f"goal-{i}", f"prompt-{i} for {failure.run_id}")
            for i in range(n)
        ]

    author = CallableVariationAuthor(fake_llm)
    f = _failure(run_id="run-42")
    projects = author.author_variations(failure=f, n=3, rng=random.Random(0))
    assert len(projects) == 3
    assert projects[0].title == "title-0"
    assert projects[1].initial_user_text == "prompt-1 for run-42"
    assert projects[2].metadata["variation_index"] == 2
    assert projects[0].metadata["failure_run_id"] == "run-42"


def test_callable_author_rejects_wrong_count():
    def liar(failure, n):
        return [("t", "g", "p")]  # always 1, regardless of n

    author = CallableVariationAuthor(liar)
    with pytest.raises(ValueError, match="returned 1 variations but 3"):
        author.author_variations(
            failure=_failure(), n=3, rng=random.Random(0)
        )


def test_callable_author_rejects_empty_field():
    def bad(failure, n):
        return [("title", "", "prompt") for _ in range(n)]

    author = CallableVariationAuthor(bad)
    with pytest.raises(ValueError, match="empty fields"):
        author.author_variations(
            failure=_failure(), n=2, rng=random.Random(0)
        )


def test_callable_author_rejects_non_tuple():
    def malformed(failure, n):
        return ["just a string" for _ in range(n)]

    author = CallableVariationAuthor(malformed)
    with pytest.raises(ValueError, match="not a"):
        author.author_variations(
            failure=_failure(), n=1, rng=random.Random(0)
        )


# ─────────────────────────── JsonArtifactFailureSource ────────────────────────────


def test_json_source_rejects_missing_dir(tmp_path):
    with pytest.raises(FileNotFoundError):
        JsonArtifactFailureSource(root=tmp_path / "nope")


def test_json_source_rejects_file_as_root(tmp_path):
    f = tmp_path / "x.json"
    f.write_text("{}")
    with pytest.raises(NotADirectoryError):
        JsonArtifactFailureSource(root=f)


def _write_json(path: Path, blob: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(blob))


def test_json_source_loads_single_json_object(tmp_path):
    _write_json(
        tmp_path / "run.json",
        {
            "id": "run-7",
            "model_id": "m1",
            "benchmark": "b1",
            "score": 0.2,
            "ts": 1_700_000_000_000,
            "failed_tasks": [{"task_id": "t1", "user_text": "do x"}],
        },
    )
    src = JsonArtifactFailureSource(root=tmp_path)
    out = src.list_failures(since_ts_ms=0, threshold=0.5)
    assert len(out) == 1
    f = out[0]
    assert f.run_id == "run-7"
    assert f.score == 0.2
    assert f.failed_tasks[0]["user_text"] == "do x"


def test_json_source_loads_jsonl_lines(tmp_path):
    lines = [
        {
            "id": "run-a",
            "model_id": "m1",
            "benchmark": "b1",
            "score": 0.1,
            "ts": 1_700_000_000_000,
        },
        {
            "id": "run-b",
            "model_id": "m1",
            "benchmark": "b1",
            "score": 0.9,  # filtered out
            "ts": 1_700_000_000_000,
        },
        {
            "id": "run-c",
            "model_id": "m1",
            "benchmark": "b1",
            "score": 0.3,
            "ts": 1_600_000_000_000,  # too old
        },
    ]
    f = tmp_path / "runs.jsonl"
    f.write_text("\n".join(json.dumps(line) for line in lines) + "\n")
    src = JsonArtifactFailureSource(root=tmp_path)
    out = src.list_failures(
        since_ts_ms=1_700_000_000_000, threshold=0.5
    )
    assert [x.run_id for x in out] == ["run-a"]


def test_json_source_synthesizes_run_id_when_missing(tmp_path):
    _write_json(
        tmp_path / "r.json",
        {
            "model_id": "m1",
            "benchmark": "b1",
            "score": 0.1,
            "ts": 1_700_000_000_000,
        },
    )
    src = JsonArtifactFailureSource(root=tmp_path)
    out = src.list_failures(since_ts_ms=0, threshold=0.5)
    assert len(out) == 1
    assert out[0].run_id == "b1-1700000000000"


def test_json_source_skips_records_missing_required_fields(tmp_path):
    _write_json(tmp_path / "bad.json", {"score": 0.2})  # missing rest
    _write_json(
        tmp_path / "good.json",
        {"model_id": "m", "benchmark": "b", "score": 0.2, "ts": 1_700_000_000_000},
    )
    src = JsonArtifactFailureSource(root=tmp_path)
    out = src.list_failures(since_ts_ms=0, threshold=0.5)
    assert len(out) == 1
    assert out[0].benchmark == "b"


def test_json_source_handles_list_of_runs_in_one_file(tmp_path):
    blob = [
        {"id": "x", "model_id": "m", "benchmark": "b",
         "score": 0.1, "ts": 1_700_000_000_000},
        {"id": "y", "model_id": "m", "benchmark": "b",
         "score": 0.4, "ts": 1_700_000_000_001},
    ]
    _write_json(tmp_path / "multi.json", blob)
    src = JsonArtifactFailureSource(root=tmp_path)
    out = src.list_failures(since_ts_ms=0, threshold=0.5)
    assert {f.run_id for f in out} == {"x", "y"}


def test_json_source_rejects_bad_threshold(tmp_path):
    src = JsonArtifactFailureSource(root=tmp_path)
    with pytest.raises(ValueError):
        src.list_failures(since_ts_ms=0, threshold=1.5)
    with pytest.raises(ValueError):
        src.list_failures(since_ts_ms=0, threshold=-0.1)


def test_json_source_rejects_negative_since(tmp_path):
    src = JsonArtifactFailureSource(root=tmp_path)
    with pytest.raises(ValueError):
        src.list_failures(since_ts_ms=-1, threshold=0.5)


def test_json_source_skips_malformed_jsonl_lines(tmp_path):
    f = tmp_path / "broken.jsonl"
    f.write_text(
        '{"id":"ok","model_id":"m","benchmark":"b","score":0.2,"ts":1700000000000}\n'
        "{this is not json\n"
        '{"id":"ok2","model_id":"m","benchmark":"b","score":0.3,"ts":1700000000000}\n'
    )
    src = JsonArtifactFailureSource(root=tmp_path)
    out = src.list_failures(since_ts_ms=0, threshold=0.5)
    assert {f.run_id for f in out} == {"ok", "ok2"}


# ─────────────────────────── ResultsStoreFailureSource ────────────────────────────


def _make_results_db(tmp_path: Path, rows: list[dict[str, Any]]) -> Path:
    db_path = tmp_path / "results.db"
    conn = sqlite3.connect(str(db_path))
    conn.executescript(
        """
        CREATE TABLE benchmark_runs (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            model_id        TEXT    NOT NULL,
            benchmark       TEXT    NOT NULL,
            score           REAL    NOT NULL,
            ts              INTEGER NOT NULL,
            dataset_version TEXT    NOT NULL,
            code_commit     TEXT    NOT NULL,
            raw_json        TEXT    NOT NULL
        );
        """
    )
    for r in rows:
        conn.execute(
            "INSERT INTO benchmark_runs(model_id, benchmark, score, ts, "
            "dataset_version, code_commit, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                r["model_id"],
                r["benchmark"],
                float(r["score"]),
                int(r["ts"]),
                r.get("dataset_version", "v1"),
                r.get("code_commit", "abc"),
                json.dumps(r.get("raw", {}), sort_keys=True),
            ),
        )
    conn.commit()
    conn.close()
    return db_path


def test_results_store_source_reads_failures(tmp_path):
    db = _make_results_db(
        tmp_path,
        [
            # passes threshold — excluded
            {"model_id": "m", "benchmark": "b1", "score": 0.9, "ts": 2_000},
            # below threshold — included
            {
                "model_id": "m",
                "benchmark": "b1",
                "score": 0.2,
                "ts": 3_000,
                "raw": {
                    "failed_tasks": [
                        {"task_id": "t1", "user_text": "please do x"}
                    ]
                },
            },
            # too old — excluded
            {"model_id": "m", "benchmark": "b1", "score": 0.1, "ts": 500},
        ],
    )
    src = ResultsStoreFailureSource(db_path=db)
    out = src.list_failures(since_ts_ms=1_000, threshold=0.5)
    assert len(out) == 1
    f = out[0]
    assert f.run_id.startswith("run-")
    assert f.score == 0.2
    assert f.failed_tasks[0]["user_text"] == "please do x"


def test_results_store_source_orders_newest_first(tmp_path):
    db = _make_results_db(
        tmp_path,
        [
            {"model_id": "m", "benchmark": "b", "score": 0.1, "ts": 1_000},
            {"model_id": "m", "benchmark": "b", "score": 0.2, "ts": 3_000},
            {"model_id": "m", "benchmark": "b", "score": 0.3, "ts": 2_000},
        ],
    )
    src = ResultsStoreFailureSource(db_path=db)
    out = src.list_failures(since_ts_ms=0, threshold=0.5)
    assert [f.ts for f in out] == [3_000, 2_000, 1_000]


def test_results_store_source_skips_malformed_raw_json(tmp_path):
    db_path = tmp_path / "results.db"
    conn = sqlite3.connect(str(db_path))
    conn.executescript(
        """
        CREATE TABLE benchmark_runs (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            model_id        TEXT    NOT NULL,
            benchmark       TEXT    NOT NULL,
            score           REAL    NOT NULL,
            ts              INTEGER NOT NULL,
            dataset_version TEXT    NOT NULL,
            code_commit     TEXT    NOT NULL,
            raw_json        TEXT    NOT NULL
        );
        """
    )
    # Bypass record_run's validation to inject a broken row.
    conn.execute(
        "INSERT INTO benchmark_runs(model_id, benchmark, score, ts, "
        "dataset_version, code_commit, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("m", "b", 0.2, 1_000, "v", "c", "not-json"),
    )
    conn.execute(
        "INSERT INTO benchmark_runs(model_id, benchmark, score, ts, "
        "dataset_version, code_commit, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("m", "b", 0.3, 2_000, "v", "c", "{}"),
    )
    conn.commit()
    conn.close()

    src = ResultsStoreFailureSource(db_path=db_path)
    out = src.list_failures(since_ts_ms=0, threshold=0.5)
    # Malformed row is skipped (logged), but the good row is returned.
    assert len(out) == 1
    assert out[0].score == 0.3


# ─────────────────────────── AdaptiveSynth orchestration ────────────────────────────


class _StaticFailureSource:
    """In-memory source for orchestrator tests."""

    def __init__(self, failures: list[BenchmarkFailure]):
        self._failures = failures

    def list_failures(
        self, *, since_ts_ms: int, threshold: float
    ) -> list[BenchmarkFailure]:
        return list(self._failures)


def test_adaptive_synth_tags_records(tmp_path):
    failures = [
        _failure(
            run_id="run-aaa",
            benchmark="bench-x",
            failed_tasks=({"task_id": "t1", "user_text": "do alpha"},),
        )
    ]
    out_path = tmp_path / "out.jsonl"
    synth = AdaptiveSynth(
        failures=_StaticFailureSource(failures),
        author=FixtureVariationAuthor(),
        agent=EchoAgentClient(),
        decider=HeuristicTurnDecider(),
        max_turns=1,  # one turn per variation
    )
    report = synth.run(
        since_ts_ms=0,
        variations_per_failure=3,
        threshold=0.5,
        out_path=out_path,
        rng=random.Random(0),
    )
    assert report.failures_seen == 1
    assert report.variations_authored == 3
    assert report.sessions_written == 3
    assert report.records_written == 3
    assert report.errors == []

    lines = [json.loads(line) for line in out_path.read_text().splitlines() if line]
    assert len(lines) == 3
    for i, rec in enumerate(lines):
        assert rec["synth_kind"] == SYNTH_KIND
        assert rec["derived_from"] == "run-aaa"
        assert rec["failure_context"]["benchmark"] == "bench-x"
        assert rec["failure_context"]["model_id"] == "eliza-1-2b"
        assert rec["variation_index"] == i
        # The simulator-level fields survive.
        assert rec["turn_index"] == 0
        assert "step_id" in rec
        assert "messages" in rec


def test_adaptive_synth_runs_multi_turn_when_simulator_extends(tmp_path):
    """With a ScriptedTurnDecider that drives 2 turns, each variation
    should land 2 records, all tagged with the same derived_from."""
    failures = [_failure(run_id="run-multi")]

    author = FixtureVariationAuthor()
    # We need to know the project ids the author will pick so the
    # scripted decider can address them. Author returns one project per
    # variation; we configure the decider in two passes by using a
    # passthrough author wrapper.
    captured: list[Project] = []

    class CapturingAuthor:
        def __init__(self, inner):
            self._inner = inner

        def author_variations(self, *, failure, n, rng):
            projects = self._inner.author_variations(failure=failure, n=n, rng=rng)
            captured.extend(projects)
            return projects

    out_path = tmp_path / "out.jsonl"
    # Build the simulator out-of-band so we can pre-author and then plan
    # against the project ids.
    rng = random.Random(0)
    initial_projects = CapturingAuthor(author).author_variations(
        failure=failures[0], n=2, rng=rng
    )
    plan = {p.id: ["follow up"] for p in initial_projects}
    decider = ScriptedTurnDecider(plan)

    # Now run the orchestrator with a fresh author returning the SAME projects.
    class FixedAuthor:
        def author_variations(self, *, failure, n, rng):
            assert n == len(initial_projects)
            return list(initial_projects)

    synth = AdaptiveSynth(
        failures=_StaticFailureSource(failures),
        author=FixedAuthor(),
        agent=EchoAgentClient(),
        decider=decider,
        max_turns=3,
    )
    report = synth.run(
        since_ts_ms=0,
        variations_per_failure=len(initial_projects),
        threshold=0.5,
        out_path=out_path,
        rng=random.Random(0),
    )
    assert report.records_written == 4  # 2 projects × 2 turns each
    assert report.sessions_written == 2

    lines = [json.loads(line) for line in out_path.read_text().splitlines() if line]
    for rec in lines:
        assert rec["derived_from"] == "run-multi"
        assert rec["synth_kind"] == SYNTH_KIND


def test_adaptive_synth_surfaces_author_exceptions(tmp_path):
    """Author exceptions land in the report, not stdout. No silent drops."""

    class ExplodingAuthor:
        def author_variations(self, *, failure, n, rng):
            raise RuntimeError(f"boom for {failure.run_id}")

    failures = [_failure(run_id=f"run-{i}") for i in range(3)]
    out_path = tmp_path / "out.jsonl"
    synth = AdaptiveSynth(
        failures=_StaticFailureSource(failures),
        author=ExplodingAuthor(),
        agent=EchoAgentClient(),
        decider=HeuristicTurnDecider(),
        max_turns=1,
    )
    report = synth.run(
        since_ts_ms=0,
        variations_per_failure=2,
        threshold=0.5,
        out_path=out_path,
        rng=random.Random(0),
    )
    assert report.failures_seen == 3
    assert report.variations_authored == 0
    assert report.records_written == 0
    assert len(report.errors) == 3
    stages = {e["stage"] for e in report.errors}
    assert stages == {"author"}
    assert all("boom for run-" in e["message"] for e in report.errors)


def test_adaptive_synth_surfaces_simulator_exceptions(tmp_path):
    """Simulator exceptions also land in the report."""

    class ExplodingAgent(AgentClient):
        def respond(self, *, project, history):
            raise RuntimeError("agent down")

    failures = [_failure(run_id="run-1")]
    out_path = tmp_path / "out.jsonl"
    synth = AdaptiveSynth(
        failures=_StaticFailureSource(failures),
        author=FixtureVariationAuthor(),
        agent=ExplodingAgent(),
        decider=HeuristicTurnDecider(),
        max_turns=1,
    )
    report = synth.run(
        since_ts_ms=0,
        variations_per_failure=2,
        threshold=0.5,
        out_path=out_path,
        rng=random.Random(0),
    )
    assert report.variations_authored == 2
    assert report.records_written == 0
    assert len(report.errors) == 2
    assert all(e["stage"] == "simulate" for e in report.errors)


def test_adaptive_synth_surfaces_source_exception(tmp_path):
    """A source that errors at list time records a top-level error."""

    class ExplodingSource:
        def list_failures(self, *, since_ts_ms, threshold):
            raise RuntimeError("db unreachable")

    out_path = tmp_path / "out.jsonl"
    synth = AdaptiveSynth(
        failures=ExplodingSource(),
        author=FixtureVariationAuthor(),
        agent=EchoAgentClient(),
        decider=HeuristicTurnDecider(),
        max_turns=1,
    )
    report = synth.run(
        since_ts_ms=0,
        variations_per_failure=1,
        threshold=0.5,
        out_path=out_path,
        rng=random.Random(0),
    )
    assert report.failures_seen == 0
    assert len(report.errors) == 1
    assert report.errors[0]["stage"] == "list_failures"


def test_adaptive_synth_rejects_n_zero(tmp_path):
    synth = AdaptiveSynth(
        failures=_StaticFailureSource([]),
        author=FixtureVariationAuthor(),
        agent=EchoAgentClient(),
        decider=HeuristicTurnDecider(),
        max_turns=1,
    )
    with pytest.raises(ValueError, match="variations_per_failure"):
        synth.run(
            since_ts_ms=0,
            variations_per_failure=0,
            threshold=0.5,
            out_path=tmp_path / "out.jsonl",
        )


def test_adaptive_synth_max_turns_zero_is_invalid():
    with pytest.raises(ValueError, match="max_turns"):
        AdaptiveSynth(
            failures=_StaticFailureSource([]),
            author=FixtureVariationAuthor(),
            agent=EchoAgentClient(),
            decider=HeuristicTurnDecider(),
            max_turns=0,
        )


# ─────────────────────────── --since parsing ────────────────────────────


def test_parse_since_date():
    # 2025-01-01 00:00 UTC == 1_735_689_600 sec
    assert _parse_since("2025-01-01") == 1_735_689_600 * 1000


def test_parse_since_iso_datetime():
    # 2025-01-01T00:00:00Z
    assert _parse_since("2025-01-01T00:00:00Z") == 1_735_689_600 * 1000


def test_parse_since_unix_ms_passthrough():
    assert _parse_since("1700000000000") == 1_700_000_000_000


def test_parse_since_empty_raises():
    with pytest.raises(ValueError):
        _parse_since("")


def test_parse_since_garbage_raises():
    with pytest.raises(ValueError):
        _parse_since("not a date")


# ─────────────────────────── CLI smoke ────────────────────────────


def test_cli_smoke_with_json_source(tmp_path):
    """End-to-end: --source json + fixture author + echo agent → JSONL out."""
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    _write_json(
        artifacts / "run.json",
        {
            "id": "run-cli",
            "model_id": "m",
            "benchmark": "synth-bench",
            "score": 0.1,
            "ts": 1_700_000_000_000,
            "failed_tasks": [{"task_id": "t1", "user_text": "do cli thing"}],
        },
    )
    out_dir = tmp_path / "out"
    rc = cli_main(
        [
            "--since", "2020-01-01",
            "--variations", "2",
            "--threshold", "0.5",
            "--turns", "1",
            "--output-dir", str(out_dir),
            "--source", "json",
            "--artifacts-dir", str(artifacts),
            "--seed", "1",
        ]
    )
    assert rc == 0
    out = out_dir / "adaptive_synth.jsonl"
    report = out_dir / "adaptive_synth.report.json"
    assert out.exists()
    assert report.exists()

    lines = [json.loads(line) for line in out.read_text().splitlines() if line]
    assert len(lines) == 2  # one record per variation @ max_turns=1
    for rec in lines:
        assert rec["synth_kind"] == SYNTH_KIND
        assert rec["derived_from"] == "run-cli"
        assert "do cli thing" in rec["user_text"]
        assert rec["failure_context"]["benchmark"] == "synth-bench"

    rep_blob = json.loads(report.read_text())
    assert rep_blob["failures_seen"] == 1
    assert rep_blob["variations_authored"] == 2
    assert rep_blob["records_written"] == 2
    assert rep_blob["errors"] == []
    assert rep_blob["variations_per_failure"] == 2
    assert "elapsed_ms" in rep_blob


def test_cli_requires_artifacts_dir_with_json_source(tmp_path):
    with pytest.raises(SystemExit, match="--artifacts-dir"):
        cli_main(
            [
                "--since", "2020-01-01",
                "--variations", "1",
                "--output-dir", str(tmp_path / "out"),
                "--source", "json",
            ]
        )


def test_cli_rejects_bad_since(tmp_path):
    rc = cli_main(
        [
            "--since", "garbage",
            "--variations", "1",
            "--output-dir", str(tmp_path / "out"),
            "--source", "json",
            "--artifacts-dir", str(tmp_path),
        ]
    )
    assert rc == 2


def test_cli_rejects_missing_artifacts(tmp_path):
    rc = cli_main(
        [
            "--since", "2020-01-01",
            "--variations", "1",
            "--output-dir", str(tmp_path / "out"),
            "--source", "json",
            "--artifacts-dir", str(tmp_path / "does-not-exist"),
        ]
    )
    assert rc == 2


# ─────────────────────────── AdaptiveSynthReport bookkeeping ────────────────────────────


def test_report_to_dict_round_trips():
    r = AdaptiveSynthReport()
    r.failures_seen = 2
    r.add_error(run_id="run-1", stage="author", message="boom")
    d = r.to_dict()
    assert d["failures_seen"] == 2
    assert d["errors"] == [
        {"run_id": "run-1", "stage": "author", "message": "boom"}
    ]
    # JSON-serializable
    json.dumps(d)
