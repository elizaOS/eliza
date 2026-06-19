"""Tests for the unified benchmark comparison harness (``benchmarks.compare``).

These tests inject a fake :class:`BenchmarkRunCallable` that returns
canned :class:`BenchmarkResult` scores, so no real network calls or
adapter dependencies are exercised. They cover:

* suite resolution (named + ad-hoc + bad input);
* endpoint resolution (URL + provider + missing-args errors);
* report shape (per-benchmark deltas + pass/fail flags);
* noise-threshold pass/fail boundary semantics;
* ``ResultsStore`` persistence (one row per endpoint per benchmark);
* CLI plumbing (argparse + ``main`` exit codes);
* default suite contents (contracts §4 invariants).
"""

from __future__ import annotations

import json
import sys
from collections.abc import Callable
from pathlib import Path

import pytest

# Make ``benchmarks.*`` importable when pytest is invoked directly on
# this test file. Matches the bootstrap pattern in other tests under
# ``benchmarks/tests/`` (e.g. ``test_trajectory_normalizer.py``).
_PACKAGE_PARENT = Path(__file__).resolve().parents[2]
if str(_PACKAGE_PARENT) not in sys.path:
    sys.path.insert(0, str(_PACKAGE_PARENT))

from benchmarks.compare import (  # noqa: E402
    DEFAULT_SUITES,
    BenchmarkRunCallable,
    CompareInputs,
    CompareReport,
    EndpointSpec,
    PairResult,
    RunRequest,
    Suite,
    SuiteBenchmark,
    _apply_noise_overrides,
    _parse_noise_overrides,
    build_arg_parser,
    main,
    parse_inputs,
    resolve_endpoint_spec,
    resolve_suite,
    run_compare,
)
from benchmarks.lib.results_store import ResultsStore  # noqa: E402
from benchmarks.standard._base import BenchmarkResult  # noqa: E402


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


def _make_result(
    *,
    benchmark: str,
    model: str,
    endpoint: str,
    score: float,
    n: int = 3,
) -> BenchmarkResult:
    return BenchmarkResult(
        benchmark=benchmark,
        model=model,
        endpoint=endpoint,
        dataset_version=f"{benchmark}@test",
        n=n,
        metrics={"score": score, "n": float(n)},
        raw_json={"fake": True},
    )


def make_canned_runner(
    scores: dict[tuple[str, str], float],
    *,
    record_calls: list[RunRequest] | None = None,
) -> BenchmarkRunCallable:
    """Build a fake runner that returns canned scores.

    ``scores`` is keyed by ``(benchmark_id, endpoint_label)``. Missing
    entries fall back to ``0.5`` so the tests don't get hidden ``None``
    errors.
    """

    def run(req: RunRequest) -> BenchmarkResult:
        if record_calls is not None:
            record_calls.append(req)
        key = (req.benchmark_id, req.endpoint.label)
        score = scores.get(key, 0.5)
        return _make_result(
            benchmark=req.benchmark_id,
            model=req.endpoint.model_id,
            endpoint=req.endpoint.endpoint,
            score=score,
        )

    return run


@pytest.fixture
def store(tmp_path: Path) -> ResultsStore:
    s = ResultsStore(db_path=tmp_path / "results.db")
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def small_suite() -> Suite:
    return Suite(
        name="test_suite",
        description="Tiny suite for unit tests.",
        benchmarks=(
            SuiteBenchmark("mmlu", noise_threshold=0.02),
            SuiteBenchmark("gsm8k", noise_threshold=0.03),
        ),
    )


@pytest.fixture
def default_inputs(small_suite: Suite, tmp_path: Path) -> Callable[..., CompareInputs]:
    def make(
        *,
        candidate_score_overrides: dict[str, float] | None = None,
        baseline_score_overrides: dict[str, float] | None = None,
        noise_overrides: dict[str, float] | None = None,
    ) -> CompareInputs:
        del candidate_score_overrides, baseline_score_overrides
        return CompareInputs(
            suite=small_suite,
            candidate=EndpointSpec(
                label="candidate",
                model_id="eliza-1-2b",
                endpoint="http://cand/v1",
                api_key_env="UNSET_KEY",
            ),
            baseline=EndpointSpec(
                label="baseline",
                model_id="qwen-3-9b",
                endpoint="http://base/v1",
                api_key_env="UNSET_KEY",
            ),
            output_dir=tmp_path / "out",
            limit=None,
            mock=True,
            dataset_version="fallback@v1",
            code_commit="testcommit",
            noise_overrides=noise_overrides or {},
        )

    return make


# ---------------------------------------------------------------------------
# Default suites (contracts §4)
# ---------------------------------------------------------------------------


def test_default_suites_include_candidate_and_stable_gate() -> None:
    assert "candidate_gate" in DEFAULT_SUITES
    assert "stable_gate" in DEFAULT_SUITES


def test_candidate_gate_is_fast_subset_of_stable_gate() -> None:
    cand = DEFAULT_SUITES["candidate_gate"].benchmark_ids()
    stable = DEFAULT_SUITES["stable_gate"].benchmark_ids()
    assert set(cand).issubset(set(stable))
    # candidate_gate is meant to be cheaper — strict subset.
    assert len(cand) < len(stable)


def test_default_suites_only_reference_known_benchmarks() -> None:
    known = {"mmlu", "humaneval", "gsm8k", "mt_bench"}
    for suite in DEFAULT_SUITES.values():
        for slot in suite.benchmarks:
            assert slot.benchmark_id in known, f"suite {suite.name} has unknown id {slot.benchmark_id}"


def test_default_suite_noise_thresholds_are_positive() -> None:
    for suite in DEFAULT_SUITES.values():
        for slot in suite.benchmarks:
            assert slot.noise_threshold > 0


# ---------------------------------------------------------------------------
# resolve_suite
# ---------------------------------------------------------------------------


def test_resolve_suite_returns_registered_suite() -> None:
    suite = resolve_suite("candidate_gate")
    assert suite is DEFAULT_SUITES["candidate_gate"]


def test_resolve_suite_parses_csv() -> None:
    suite = resolve_suite("mmlu,gsm8k")
    assert suite.benchmark_ids() == ("mmlu", "gsm8k")
    assert suite.name.startswith("adhoc(")


def test_resolve_suite_strips_whitespace() -> None:
    suite = resolve_suite(" mmlu , humaneval ")
    assert suite.benchmark_ids() == ("mmlu", "humaneval")


def test_resolve_suite_rejects_empty() -> None:
    with pytest.raises(ValueError):
        resolve_suite("")
    with pytest.raises(ValueError):
        resolve_suite("   ")
    with pytest.raises(ValueError):
        resolve_suite(",,,")


# ---------------------------------------------------------------------------
# resolve_endpoint_spec
# ---------------------------------------------------------------------------


def test_resolve_endpoint_spec_accepts_url() -> None:
    spec = resolve_endpoint_spec(
        label="candidate",
        raw="http://cand/v1",
        model="eliza-1",
        api_key_env="OPENAI_API_KEY",
    )
    assert spec.endpoint == "http://cand/v1"
    assert spec.model_id == "eliza-1"
    assert spec.label == "candidate"


def test_resolve_endpoint_spec_accepts_provider_name() -> None:
    spec = resolve_endpoint_spec(
        label="baseline",
        raw="openai",
        model=None,
        api_key_env="OPENAI_API_KEY",
    )
    assert "openai.com" in spec.endpoint
    # Without --baseline-model, the harness still produces a deterministic id.
    assert spec.model_id == "baseline:openai"


def test_resolve_endpoint_spec_rejects_empty() -> None:
    with pytest.raises(ValueError):
        resolve_endpoint_spec(
            label="candidate",
            raw="",
            model=None,
            api_key_env="OPENAI_API_KEY",
        )


def test_resolve_endpoint_spec_rejects_unknown_provider() -> None:
    with pytest.raises(ValueError):
        resolve_endpoint_spec(
            label="baseline",
            raw="not-a-real-provider",
            model=None,
            api_key_env="OPENAI_API_KEY",
        )


# ---------------------------------------------------------------------------
# Noise overrides
# ---------------------------------------------------------------------------


def test_parse_noise_overrides_parses_floats() -> None:
    assert _parse_noise_overrides(["mmlu=0.01", "gsm8k=0.05"]) == {
        "mmlu": 0.01,
        "gsm8k": 0.05,
    }


def test_parse_noise_overrides_rejects_missing_equals() -> None:
    with pytest.raises(ValueError):
        _parse_noise_overrides(["mmlu0.01"])


def test_parse_noise_overrides_rejects_empty_id() -> None:
    with pytest.raises(ValueError):
        _parse_noise_overrides(["=0.01"])


def test_parse_noise_overrides_rejects_non_float() -> None:
    with pytest.raises(ValueError):
        _parse_noise_overrides(["mmlu=tight"])


def test_parse_noise_overrides_empty_returns_empty() -> None:
    assert _parse_noise_overrides(None) == {}
    assert _parse_noise_overrides([]) == {}


def test_apply_noise_overrides_overrides_only_listed_benchmarks(small_suite: Suite) -> None:
    overridden = _apply_noise_overrides(small_suite, {"mmlu": 0.1})
    by_id = {b.benchmark_id: b.noise_threshold for b in overridden.benchmarks}
    assert by_id["mmlu"] == pytest.approx(0.1)
    # gsm8k untouched.
    assert by_id["gsm8k"] == pytest.approx(0.03)


def test_apply_noise_overrides_with_empty_returns_input(small_suite: Suite) -> None:
    assert _apply_noise_overrides(small_suite, {}) is small_suite


# ---------------------------------------------------------------------------
# PairResult
# ---------------------------------------------------------------------------


def test_pair_result_passes_when_candidate_better() -> None:
    cand = _make_result(benchmark="mmlu", model="c", endpoint="x", score=0.8)
    base = _make_result(benchmark="mmlu", model="b", endpoint="y", score=0.7)
    pair = PairResult.from_results(
        benchmark=SuiteBenchmark("mmlu", noise_threshold=0.02),
        candidate=cand,
        baseline=base,
    )
    assert pair.delta == pytest.approx(0.1)
    assert pair.passed is True


def test_pair_result_passes_within_noise_threshold() -> None:
    cand = _make_result(benchmark="mmlu", model="c", endpoint="x", score=0.69)
    base = _make_result(benchmark="mmlu", model="b", endpoint="y", score=0.70)
    pair = PairResult.from_results(
        benchmark=SuiteBenchmark("mmlu", noise_threshold=0.02),
        candidate=cand,
        baseline=base,
    )
    assert pair.delta == pytest.approx(-0.01)
    # Within noise budget — still passes.
    assert pair.passed is True


def test_pair_result_fails_outside_noise_threshold() -> None:
    cand = _make_result(benchmark="mmlu", model="c", endpoint="x", score=0.60)
    base = _make_result(benchmark="mmlu", model="b", endpoint="y", score=0.70)
    pair = PairResult.from_results(
        benchmark=SuiteBenchmark("mmlu", noise_threshold=0.02),
        candidate=cand,
        baseline=base,
    )
    assert pair.delta == pytest.approx(-0.1)
    assert pair.passed is False


def test_pair_result_boundary_at_noise_threshold_passes() -> None:
    cand = _make_result(benchmark="mmlu", model="c", endpoint="x", score=0.68)
    base = _make_result(benchmark="mmlu", model="b", endpoint="y", score=0.70)
    pair = PairResult.from_results(
        benchmark=SuiteBenchmark("mmlu", noise_threshold=0.02),
        candidate=cand,
        baseline=base,
    )
    assert pair.delta == pytest.approx(-0.02)
    # Exactly at the noise boundary: candidate >= baseline - noise so PASS.
    assert pair.passed is True


def test_pair_result_to_json_is_serializable() -> None:
    cand = _make_result(benchmark="mmlu", model="c", endpoint="x", score=0.6)
    base = _make_result(benchmark="mmlu", model="b", endpoint="y", score=0.4)
    pair = PairResult.from_results(
        benchmark=SuiteBenchmark("mmlu", noise_threshold=0.02),
        candidate=cand,
        baseline=base,
    )
    payload = pair.to_json()
    assert payload["benchmark"] == "mmlu"
    assert payload["candidate_score"] == pytest.approx(0.6)
    assert payload["baseline_score"] == pytest.approx(0.4)
    assert payload["delta"] == pytest.approx(0.2)
    assert payload["noise_threshold"] == 0.02
    assert payload["passed"] is True
    # Must be JSON-serializable end-to-end.
    json.dumps(payload)


# ---------------------------------------------------------------------------
# run_compare end-to-end
# ---------------------------------------------------------------------------


def test_run_compare_returns_pairs_in_suite_order(
    default_inputs: Callable[..., CompareInputs],
    store: ResultsStore,
) -> None:
    inputs = default_inputs()
    runner = make_canned_runner(
        {
            ("mmlu", "candidate"): 0.7,
            ("mmlu", "baseline"): 0.6,
            ("gsm8k", "candidate"): 0.4,
            ("gsm8k", "baseline"): 0.5,
        }
    )
    report = run_compare(inputs, run_benchmark=runner, store=store)
    assert [p.benchmark_id for p in report.pairs] == ["mmlu", "gsm8k"]


def test_run_compare_records_one_row_per_endpoint_per_benchmark(
    default_inputs: Callable[..., CompareInputs],
    store: ResultsStore,
) -> None:
    inputs = default_inputs()
    runner = make_canned_runner({})
    run_compare(inputs, run_benchmark=runner, store=store)
    for endpoint in (inputs.candidate, inputs.baseline):
        latest = store.get_latest_for_model(model_id=endpoint.model_id)
        assert set(latest.keys()) == {"mmlu", "gsm8k"}


def test_run_compare_overall_passes_when_every_pair_passes(
    default_inputs: Callable[..., CompareInputs],
    store: ResultsStore,
) -> None:
    inputs = default_inputs()
    runner = make_canned_runner(
        {
            ("mmlu", "candidate"): 0.8,
            ("mmlu", "baseline"): 0.6,
            ("gsm8k", "candidate"): 0.5,
            ("gsm8k", "baseline"): 0.4,
        }
    )
    report = run_compare(inputs, run_benchmark=runner, store=store)
    assert report.passed is True
    assert all(p.passed for p in report.pairs)


def test_run_compare_overall_fails_when_one_pair_fails(
    default_inputs: Callable[..., CompareInputs],
    store: ResultsStore,
) -> None:
    inputs = default_inputs()
    runner = make_canned_runner(
        {
            ("mmlu", "candidate"): 0.5,  # baseline=0.5, delta=0 → PASS
            ("mmlu", "baseline"): 0.5,
            ("gsm8k", "candidate"): 0.30,  # baseline=0.7 → delta=-0.4 → FAIL
            ("gsm8k", "baseline"): 0.70,
        }
    )
    report = run_compare(inputs, run_benchmark=runner, store=store)
    assert report.passed is False
    [mmlu_pair, gsm8k_pair] = list(report.pairs)
    assert mmlu_pair.passed is True
    assert gsm8k_pair.passed is False
    assert gsm8k_pair.delta == pytest.approx(-0.4)


def test_run_compare_threads_noise_overrides_into_pairs(
    default_inputs: Callable[..., CompareInputs],
    store: ResultsStore,
) -> None:
    # Candidate 0.5 vs baseline 0.6 → delta=-0.1. With noise=0.2 it passes.
    inputs = default_inputs(noise_overrides={"mmlu": 0.2, "gsm8k": 0.2})
    runner = make_canned_runner(
        {
            ("mmlu", "candidate"): 0.5,
            ("mmlu", "baseline"): 0.6,
            ("gsm8k", "candidate"): 0.5,
            ("gsm8k", "baseline"): 0.6,
        }
    )
    report = run_compare(inputs, run_benchmark=runner, store=store)
    assert report.passed is True
    for pair in report.pairs:
        assert pair.noise_threshold == pytest.approx(0.2)


def test_run_compare_records_dataset_version_from_result(
    default_inputs: Callable[..., CompareInputs],
    store: ResultsStore,
) -> None:
    inputs = default_inputs()
    runner = make_canned_runner({})
    run_compare(inputs, run_benchmark=runner, store=store)
    [run] = store.get_history(model_id="eliza-1-2b", benchmark="mmlu", limit=1)
    # Adapter's dataset_version wins over inputs.dataset_version fallback.
    assert run.dataset_version == "mmlu@test"
    assert run.code_commit == "testcommit"


def test_run_compare_records_code_commit(
    default_inputs: Callable[..., CompareInputs],
    store: ResultsStore,
) -> None:
    inputs = default_inputs()
    runner = make_canned_runner({})
    run_compare(inputs, run_benchmark=runner, store=store)
    for endpoint_id in ("eliza-1-2b", "qwen-3-9b"):
        for bench in ("mmlu", "gsm8k"):
            [run] = store.get_history(model_id=endpoint_id, benchmark=bench, limit=1)
            assert run.code_commit == "testcommit"


def test_run_compare_calls_runner_once_per_benchmark_per_endpoint(
    default_inputs: Callable[..., CompareInputs],
    store: ResultsStore,
) -> None:
    inputs = default_inputs()
    calls: list[RunRequest] = []
    runner = make_canned_runner({}, record_calls=calls)
    run_compare(inputs, run_benchmark=runner, store=store)
    assert len(calls) == 4  # 2 benchmarks * 2 endpoints
    seen = {(c.benchmark_id, c.endpoint.label) for c in calls}
    assert seen == {
        ("mmlu", "candidate"),
        ("mmlu", "baseline"),
        ("gsm8k", "candidate"),
        ("gsm8k", "baseline"),
    }


# ---------------------------------------------------------------------------
# Report shape
# ---------------------------------------------------------------------------


def _build_report(
    default_inputs: Callable[..., CompareInputs],
    store: ResultsStore,
    scores: dict[tuple[str, str], float],
) -> CompareReport:
    inputs = default_inputs()
    runner = make_canned_runner(scores)
    return run_compare(inputs, run_benchmark=runner, store=store)


def test_report_to_json_round_trips_via_json_dumps(
    default_inputs: Callable[..., CompareInputs],
    store: ResultsStore,
) -> None:
    report = _build_report(
        default_inputs,
        store,
        {
            ("mmlu", "candidate"): 0.7,
            ("mmlu", "baseline"): 0.6,
            ("gsm8k", "candidate"): 0.4,
            ("gsm8k", "baseline"): 0.5,
        },
    )
    payload = report.to_json()
    # Round-trip JSON to confirm the structure is plain dict/list/scalar.
    encoded = json.dumps(payload)
    decoded = json.loads(encoded)
    assert decoded["suite"]["name"] == "test_suite"
    assert decoded["candidate"]["model_id"] == "eliza-1-2b"
    assert decoded["baseline"]["model_id"] == "qwen-3-9b"
    assert [p["benchmark"] for p in decoded["pairs"]] == ["mmlu", "gsm8k"]
    assert decoded["passed"] is False  # gsm8k -0.1 fails the 0.03 threshold
    mmlu_pair = decoded["pairs"][0]
    assert mmlu_pair["candidate_score"] == pytest.approx(0.7)
    assert mmlu_pair["baseline_score"] == pytest.approx(0.6)
    assert mmlu_pair["delta"] == pytest.approx(0.1)
    assert mmlu_pair["passed"] is True
    gsm8k_pair = decoded["pairs"][1]
    assert gsm8k_pair["passed"] is False
    assert gsm8k_pair["delta"] == pytest.approx(-0.1)


def test_report_text_renders_pass_and_fail_lines(
    default_inputs: Callable[..., CompareInputs],
    store: ResultsStore,
) -> None:
    report = _build_report(
        default_inputs,
        store,
        {
            ("mmlu", "candidate"): 0.7,
            ("mmlu", "baseline"): 0.5,
            ("gsm8k", "candidate"): 0.3,
            ("gsm8k", "baseline"): 0.5,
        },
    )
    text = report.to_text()
    assert "Suite        : test_suite" in text
    assert "mmlu" in text and "gsm8k" in text
    assert "PASS" in text
    assert "FAIL" in text
    # Final summary at the bottom.
    assert text.strip().splitlines()[-1] == "Overall: FAIL"


def test_report_to_json_includes_metric_payload(
    default_inputs: Callable[..., CompareInputs],
    store: ResultsStore,
) -> None:
    report = _build_report(
        default_inputs,
        store,
        {("mmlu", "candidate"): 0.7, ("mmlu", "baseline"): 0.6},
    )
    payload = report.to_json()
    mmlu_pair = payload["pairs"][0]
    # The full metrics object from the adapter must survive into the report.
    assert mmlu_pair["candidate"]["metrics"]["score"] == pytest.approx(0.7)
    assert mmlu_pair["baseline"]["metrics"]["n"] == pytest.approx(3.0)


# ---------------------------------------------------------------------------
# CLI / argparse plumbing
# ---------------------------------------------------------------------------


def test_build_arg_parser_requires_candidate_baseline_suite() -> None:
    parser = build_arg_parser()
    with pytest.raises(SystemExit):
        parser.parse_args([])
    with pytest.raises(SystemExit):
        parser.parse_args(["--candidate", "x"])
    with pytest.raises(SystemExit):
        parser.parse_args(["--candidate", "x", "--baseline", "y"])


def test_parse_inputs_builds_compare_inputs(tmp_path: Path) -> None:
    parser = build_arg_parser()
    args = parser.parse_args(
        [
            "--candidate",
            "http://cand/v1",
            "--baseline",
            "http://base/v1",
            "--candidate-model",
            "eliza-1",
            "--baseline-model",
            "qwen-3-9b",
            "--suite",
            "candidate_gate",
            "--output-dir",
            str(tmp_path / "out"),
            "--mock",
            "--code-commit",
            "deadbeef",
            "--noise",
            "mmlu=0.001",
        ]
    )
    inputs = parse_inputs(args)
    assert inputs.suite is DEFAULT_SUITES["candidate_gate"]
    assert inputs.candidate.endpoint == "http://cand/v1"
    assert inputs.candidate.model_id == "eliza-1"
    assert inputs.baseline.model_id == "qwen-3-9b"
    assert inputs.output_dir == (tmp_path / "out").resolve()
    assert inputs.mock is True
    assert inputs.code_commit == "deadbeef"
    assert inputs.noise_overrides == {"mmlu": 0.001}


def test_main_returns_zero_when_overall_passes(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    # Stub the production runner with a canned one before main() reaches it.
    runner = make_canned_runner(
        {
            ("mmlu", "candidate"): 0.8,
            ("mmlu", "baseline"): 0.6,
            ("gsm8k", "candidate"): 0.5,
            ("gsm8k", "baseline"): 0.4,
        }
    )
    monkeypatch.setattr("benchmarks.compare.build_default_runner", lambda: runner)
    out_path = tmp_path / "report.json"
    rc = main(
        [
            "--candidate",
            "http://cand/v1",
            "--baseline",
            "http://base/v1",
            "--candidate-model",
            "c",
            "--baseline-model",
            "b",
            "--suite",
            "mmlu,gsm8k",
            "--output-dir",
            str(tmp_path / "out"),
            "--db-path",
            str(tmp_path / "results.db"),
            "--out",
            str(out_path),
            "--mock",
            "--code-commit",
            "testcommit",
        ]
    )
    assert rc == 0
    text = capsys.readouterr().out
    assert "Overall: PASS" in text
    payload = json.loads(out_path.read_text("utf-8"))
    assert payload["passed"] is True
    # Persisted into the SQLite store.
    db = tmp_path / "results.db"
    assert db.exists()


def test_main_returns_one_when_any_pair_fails(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    runner = make_canned_runner(
        {
            ("mmlu", "candidate"): 0.4,
            ("mmlu", "baseline"): 0.6,
            ("gsm8k", "candidate"): 0.5,
            ("gsm8k", "baseline"): 0.5,
        }
    )
    monkeypatch.setattr("benchmarks.compare.build_default_runner", lambda: runner)
    rc = main(
        [
            "--candidate",
            "http://cand/v1",
            "--baseline",
            "http://base/v1",
            "--candidate-model",
            "c",
            "--baseline-model",
            "b",
            "--suite",
            "mmlu,gsm8k",
            "--output-dir",
            str(tmp_path / "out"),
            "--db-path",
            str(tmp_path / "results.db"),
            "--mock",
            "--code-commit",
            "testcommit",
        ]
    )
    assert rc == 1
    out = capsys.readouterr().out
    assert "Overall: FAIL" in out


def test_main_writes_text_report_to_stdout_even_without_out(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    runner = make_canned_runner({("mmlu", "candidate"): 0.7, ("mmlu", "baseline"): 0.6})
    monkeypatch.setattr("benchmarks.compare.build_default_runner", lambda: runner)
    rc = main(
        [
            "--candidate",
            "http://cand/v1",
            "--baseline",
            "http://base/v1",
            "--candidate-model",
            "c",
            "--baseline-model",
            "b",
            "--suite",
            "mmlu",
            "--output-dir",
            str(tmp_path / "out"),
            "--db-path",
            str(tmp_path / "results.db"),
            "--mock",
            "--code-commit",
            "testcommit",
        ]
    )
    assert rc == 0
    text = capsys.readouterr().out
    assert "mmlu" in text
    assert "Overall: PASS" in text
