"""Unified benchmark comparison harness.

Runs a named *suite* of benchmarks against a **candidate** endpoint and a
**baseline** endpoint, records every result into the W0-X5 ``ResultsStore``,
and emits a comparison report (text + JSON) with per-benchmark deltas
plus a noise-threshold pass/fail check.

CLI
===

    python -m benchmarks.compare \\
        --candidate http://localhost:8000/v1 \\
        --baseline https://api.openai.com/v1 \\
        --suite candidate_gate \\
        --out report.json

The endpoint identifier is either:

* an OpenAI-compatible base URL (e.g. ``http://localhost:8000/v1``), or
* one of the named providers in
  :data:`benchmarks.standard._base.PROVIDER_BASE_URLS`
  (e.g. ``openai``, ``groq``, ``cerebras``, ``elizacloud``).

The harness derives a stable ``model_id`` for each endpoint from the
``--candidate-model`` / ``--baseline-model`` flags so the results store
can keep per-model history across runs.

Suites
======

Two default suites ship in this module (contracts §4):

* ``candidate_gate`` — fast smoke gate run on every candidate ckpt.
* ``stable_gate`` — full gate before promotion to ``stable`` channel.

Suites are keyed in :data:`DEFAULT_SUITES`; ``--suite`` accepts a key
from that mapping or a comma-separated list of benchmark IDs.

Noise threshold
===============

Each benchmark is annotated with a per-suite noise threshold. A run
**fails** the gate when ``candidate.score < baseline.score - noise``
on a benchmark that's marked ``higher_is_better`` (which is all of
them today). The threshold defaults to ``0.02`` (2 absolute percentage
points) and can be overridden per-benchmark via ``--noise <bench>=<float>``
flags.

Strong-typing
=============

This module uses dataclasses for every payload (no ``Any``, no
``dict[str, object]`` as a public surface, no implicit ``Optional``).
Tests inject a :class:`BenchmarkRunCallable` to bypass real network
calls — see :func:`build_default_runner` for the production wiring.
"""

from __future__ import annotations

import argparse
import importlib
import json
import logging
import os
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from .lib.results_store import ResultsStore, default_db_path
from .standard._base import (
    BenchmarkResult,
    MockClient,
    OpenAICompatibleClient,
    TrajectoryRecordingClient,
    make_client,
    resolve_api_key,
    resolve_endpoint,
)

log = logging.getLogger("benchmarks.compare")


# ---------------------------------------------------------------------------
# Suite configuration
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SuiteBenchmark:
    """A single benchmark slot in a suite.

    ``benchmark_id`` is the Python module key under ``benchmarks.standard.*``
    (e.g. ``"mmlu"``, ``"humaneval"``). ``noise_threshold`` is the absolute
    score delta below which we treat candidate-vs-baseline as a tie.
    """

    benchmark_id: str
    noise_threshold: float = 0.02


@dataclass(frozen=True)
class Suite:
    """A named ordered set of benchmarks plus their noise budgets."""

    name: str
    description: str
    benchmarks: tuple[SuiteBenchmark, ...]

    def benchmark_ids(self) -> tuple[str, ...]:
        return tuple(b.benchmark_id for b in self.benchmarks)


# Default suites — see contracts §4. The thresholds are conservative
# defaults; override them per-run with ``--noise <id>=<float>``.
DEFAULT_SUITES: Mapping[str, Suite] = {
    "candidate_gate": Suite(
        name="candidate_gate",
        description="Fast smoke gate run on every candidate checkpoint.",
        benchmarks=(
            SuiteBenchmark("mmlu", noise_threshold=0.02),
            SuiteBenchmark("gsm8k", noise_threshold=0.03),
        ),
    ),
    "stable_gate": Suite(
        name="stable_gate",
        description="Full gate before promotion to the stable channel.",
        benchmarks=(
            SuiteBenchmark("mmlu", noise_threshold=0.015),
            SuiteBenchmark("gsm8k", noise_threshold=0.025),
            SuiteBenchmark("humaneval", noise_threshold=0.03),
            SuiteBenchmark("mt_bench", noise_threshold=0.05),
        ),
    ),
}


def resolve_suite(name_or_csv: str) -> Suite:
    """Resolve a suite name or comma-separated benchmark IDs to a :class:`Suite`.

    Lookup order:

    1. If ``name_or_csv`` is a key in :data:`DEFAULT_SUITES`, return it.
    2. Otherwise split on ``,``; each non-empty token becomes a
       :class:`SuiteBenchmark` with the default noise threshold.

    Raises :class:`ValueError` on empty / unresolvable input.
    """

    token = (name_or_csv or "").strip()
    if not token:
        raise ValueError("suite must be a registered name or comma-separated benchmark ids")
    if token in DEFAULT_SUITES:
        return DEFAULT_SUITES[token]
    ids = [tok.strip() for tok in token.split(",") if tok.strip()]
    if not ids:
        raise ValueError(f"could not resolve suite from {name_or_csv!r}")
    return Suite(
        name=f"adhoc({','.join(ids)})",
        description="Ad-hoc suite built from a CLI --suite override.",
        benchmarks=tuple(SuiteBenchmark(b) for b in ids),
    )


# ---------------------------------------------------------------------------
# Endpoint resolution
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class EndpointSpec:
    """A resolved candidate or baseline endpoint.

    ``model_id`` is the stable identifier we record in :class:`ResultsStore`.
    When the user provides ``--candidate-model``, that wins. Otherwise we
    fall back to ``"{label}:{endpoint}"`` so the harness still produces a
    deterministic ID even when the user only gave a base URL.
    """

    label: str
    model_id: str
    endpoint: str
    api_key_env: str

    def api_key(self) -> str:
        return resolve_api_key(self.api_key_env)


def resolve_endpoint_spec(
    *,
    label: str,
    raw: str,
    model: str | None,
    api_key_env: str,
) -> EndpointSpec:
    """Normalize a ``--candidate``/``--baseline`` value into an :class:`EndpointSpec`."""

    if not raw or not raw.strip():
        raise ValueError(f"--{label} is required")
    raw = raw.strip()
    # The user can pass a URL (anything with "://") or a provider name.
    if "://" in raw:
        endpoint = raw
    else:
        endpoint = resolve_endpoint(model_endpoint=None, provider=raw)
    model_id = (model or "").strip() or f"{label}:{raw}"
    return EndpointSpec(
        label=label,
        model_id=model_id,
        endpoint=endpoint,
        api_key_env=api_key_env,
    )


# ---------------------------------------------------------------------------
# Benchmark dispatch
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RunRequest:
    """Single benchmark invocation against a single endpoint."""

    benchmark_id: str
    endpoint: EndpointSpec
    output_dir: Path
    limit: int | None
    mock: bool


BenchmarkRunCallable = Callable[[RunRequest], BenchmarkResult]
"""Callable that produces a :class:`BenchmarkResult` for a :class:`RunRequest`.

The production implementation (:func:`build_default_runner`) loads each
adapter via ``benchmarks.standard.<id>``. Tests inject a fake that
returns canned :class:`BenchmarkResult` instances.
"""


_STANDARD_RUNNER_CLASSES: Mapping[str, str] = {
    "mmlu": "MMLURunner",
    "humaneval": "HumanEvalRunner",
    "gsm8k": "GSM8KRunner",
    "mt_bench": "MTBenchRunner",
}


_MT_BENCH_MOCK_JUDGE_RESPONSES = ("Reasoning... Rating: [[8]]",)


def _build_standard_runner(benchmark_id: str, *, mock: bool) -> object:
    """Build the production runner for ``benchmark_id``.

    Imports the adapter module on demand so this module's import graph
    stays small.
    """

    mod_name = benchmark_id.replace("-", "_")
    cls_name = _STANDARD_RUNNER_CLASSES.get(mod_name)
    if cls_name is None:
        raise ValueError(
            f"unknown standard benchmark {benchmark_id!r} — supported: "
            + ", ".join(sorted(_STANDARD_RUNNER_CLASSES))
        )
    module = importlib.import_module(f"benchmarks.standard.{mod_name}")
    cls = getattr(module, cls_name)
    if benchmark_id == "mt_bench":
        smoke = getattr(module, "SMOKE_QUESTIONS")
        judge_responses = list(_MT_BENCH_MOCK_JUDGE_RESPONSES) * (len(smoke) * 2)
        judge = MockClient(judge_responses) if mock else _build_real_judge_for_mt_bench()
        return cls(judge=judge, judge_model="gpt-4o-mock" if mock else "gpt-4o")
    return cls()


def _build_real_judge_for_mt_bench() -> OpenAICompatibleClient:
    """Build the production MT-Bench judge from env.

    Falls back to the candidate endpoint when ``MTBENCH_JUDGE_ENDPOINT`` is
    unset; the standalone adapter does the same. The judge key defaults to
    ``OPENAI_API_KEY`` so it matches the standalone adapter's CLI default.
    """

    judge_endpoint = os.environ.get("MTBENCH_JUDGE_ENDPOINT", "").strip()
    judge_key_env = os.environ.get("MTBENCH_JUDGE_API_KEY_ENV", "OPENAI_API_KEY").strip()
    if not judge_endpoint:
        raise RuntimeError(
            "MT-Bench needs MTBENCH_JUDGE_ENDPOINT set when running through "
            "`benchmarks.compare` — pass a strong-model OpenAI-compatible URL."
        )
    from .standard._base import HTTPOpenAICompatibleClient

    return HTTPOpenAICompatibleClient(
        endpoint=judge_endpoint,
        api_key=resolve_api_key(judge_key_env),
    )


def _mock_responses_for(benchmark_id: str) -> tuple[str, ...]:
    """Deterministic mock-client responses for the standard benchmarks.

    These mirror the per-adapter ``mock_responses`` derived inside the
    standalone CLI factories.
    """

    if benchmark_id == "mmlu":
        from .standard.mmlu import SMOKE_FIXTURES, _LETTER_OPTIONS

        return tuple(
            _LETTER_OPTIONS[int(item["answer_index"])]  # type: ignore[arg-type]
            for item in SMOKE_FIXTURES
        )
    if benchmark_id == "gsm8k":
        from .standard.gsm8k import SMOKE_FIXTURES

        return tuple(str(item["answer"]) for item in SMOKE_FIXTURES)
    if benchmark_id == "humaneval":
        from .standard.humaneval import SMOKE_FIXTURES

        return tuple(str(item["canonical_solution"]) for item in SMOKE_FIXTURES)
    if benchmark_id == "mt_bench":
        from .standard.mt_bench import SMOKE_QUESTIONS

        return tuple("Mock answer." for _ in range(len(SMOKE_QUESTIONS) * 2))
    raise ValueError(f"no mock responses configured for {benchmark_id!r}")


def build_default_runner() -> BenchmarkRunCallable:
    """Return the production :class:`BenchmarkRunCallable`.

    The returned callable instantiates the standard adapter for the
    request's ``benchmark_id`` (via :func:`_build_standard_runner`), wraps
    it in a :class:`TrajectoryRecordingClient`, and invokes ``runner.run``.
    """

    def run(req: RunRequest) -> BenchmarkResult:
        runner = _build_standard_runner(req.benchmark_id, mock=req.mock)
        mock_responses = _mock_responses_for(req.benchmark_id) if req.mock else None
        client = make_client(
            endpoint=req.endpoint.endpoint,
            api_key=req.endpoint.api_key(),
            mock_responses=mock_responses,
        )
        out_dir = req.output_dir / req.endpoint.label / req.benchmark_id
        out_dir.mkdir(parents=True, exist_ok=True)
        recording_client = TrajectoryRecordingClient(
            client,
            output_path=out_dir / "trajectories.jsonl",
            benchmark_id=req.benchmark_id,
            model=req.endpoint.model_id,
        )
        result = runner.run(  # type: ignore[attr-defined]
            client=recording_client,
            model=req.endpoint.model_id,
            endpoint=req.endpoint.endpoint,
            output_dir=out_dir,
            limit=req.limit,
        )
        result.write(out_dir / f"{req.benchmark_id}-results.json")
        return result

    return run


# ---------------------------------------------------------------------------
# Comparison report
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PairResult:
    """One row of the comparison report: candidate vs baseline for one bench."""

    benchmark_id: str
    candidate_score: float
    baseline_score: float
    delta: float
    noise_threshold: float
    passed: bool
    candidate_result: BenchmarkResult
    baseline_result: BenchmarkResult

    @classmethod
    def from_results(
        cls,
        *,
        benchmark: SuiteBenchmark,
        candidate: BenchmarkResult,
        baseline: BenchmarkResult,
    ) -> "PairResult":
        cand_score = float(candidate.metrics.get("score", 0.0))
        base_score = float(baseline.metrics.get("score", 0.0))
        delta = cand_score - base_score
        # Higher-is-better gate: candidate must not be more than ``noise`` worse.
        passed = delta >= -benchmark.noise_threshold
        return cls(
            benchmark_id=benchmark.benchmark_id,
            candidate_score=cand_score,
            baseline_score=base_score,
            delta=delta,
            noise_threshold=benchmark.noise_threshold,
            passed=passed,
            candidate_result=candidate,
            baseline_result=baseline,
        )

    def to_json(self) -> dict[str, object]:
        return {
            "benchmark": self.benchmark_id,
            "candidate_score": round(self.candidate_score, 6),
            "baseline_score": round(self.baseline_score, 6),
            "delta": round(self.delta, 6),
            "noise_threshold": self.noise_threshold,
            "passed": self.passed,
            "candidate": {
                "model": self.candidate_result.model,
                "endpoint": self.candidate_result.endpoint,
                "n": self.candidate_result.n,
                "metrics": dict(self.candidate_result.metrics),
            },
            "baseline": {
                "model": self.baseline_result.model,
                "endpoint": self.baseline_result.endpoint,
                "n": self.baseline_result.n,
                "metrics": dict(self.baseline_result.metrics),
            },
        }


@dataclass(frozen=True)
class CompareReport:
    """Aggregate report for one ``compare`` invocation."""

    suite: Suite
    candidate: EndpointSpec
    baseline: EndpointSpec
    pairs: tuple[PairResult, ...]

    @property
    def passed(self) -> bool:
        return all(p.passed for p in self.pairs)

    def to_json(self) -> dict[str, object]:
        return {
            "suite": {
                "name": self.suite.name,
                "description": self.suite.description,
                "benchmarks": [
                    {"id": b.benchmark_id, "noise_threshold": b.noise_threshold}
                    for b in self.suite.benchmarks
                ],
            },
            "candidate": {
                "label": self.candidate.label,
                "model_id": self.candidate.model_id,
                "endpoint": self.candidate.endpoint,
            },
            "baseline": {
                "label": self.baseline.label,
                "model_id": self.baseline.model_id,
                "endpoint": self.baseline.endpoint,
            },
            "passed": self.passed,
            "pairs": [p.to_json() for p in self.pairs],
        }

    def to_text(self) -> str:
        lines: list[str] = []
        lines.append(f"Suite        : {self.suite.name}")
        lines.append(f"Description  : {self.suite.description}")
        lines.append(
            f"Candidate    : {self.candidate.model_id} ({self.candidate.endpoint})"
        )
        lines.append(
            f"Baseline     : {self.baseline.model_id} ({self.baseline.endpoint})"
        )
        lines.append("")
        header = f"{'benchmark':<18} {'cand':>8} {'base':>8} {'delta':>9} {'noise':>8}  result"
        lines.append(header)
        lines.append("-" * len(header))
        for pair in self.pairs:
            verdict = "PASS" if pair.passed else "FAIL"
            lines.append(
                f"{pair.benchmark_id:<18} "
                f"{pair.candidate_score:>8.4f} "
                f"{pair.baseline_score:>8.4f} "
                f"{pair.delta:>+9.4f} "
                f"{pair.noise_threshold:>8.4f}  "
                f"{verdict}"
            )
        lines.append("")
        lines.append(f"Overall: {'PASS' if self.passed else 'FAIL'}")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CompareInputs:
    """Parsed CLI inputs threaded into :func:`run_compare`."""

    suite: Suite
    candidate: EndpointSpec
    baseline: EndpointSpec
    output_dir: Path
    limit: int | None
    mock: bool
    dataset_version: str
    code_commit: str
    noise_overrides: Mapping[str, float] = field(default_factory=dict)


def _apply_noise_overrides(
    suite: Suite,
    overrides: Mapping[str, float],
) -> Suite:
    if not overrides:
        return suite
    new_benchmarks = tuple(
        SuiteBenchmark(
            benchmark_id=b.benchmark_id,
            noise_threshold=overrides.get(b.benchmark_id, b.noise_threshold),
        )
        for b in suite.benchmarks
    )
    return Suite(
        name=suite.name,
        description=suite.description,
        benchmarks=new_benchmarks,
    )


def run_compare(
    inputs: CompareInputs,
    *,
    run_benchmark: BenchmarkRunCallable,
    store: ResultsStore,
) -> CompareReport:
    """Run every benchmark in the suite against candidate + baseline.

    The caller owns ``store`` (so tests can hand in a tmp-dir store and
    inspect it after). ``run_benchmark`` is the injectable dispatch
    callable; production code uses :func:`build_default_runner`.
    """

    suite = _apply_noise_overrides(inputs.suite, inputs.noise_overrides)
    pairs: list[PairResult] = []
    for slot in suite.benchmarks:
        candidate_result = _run_one(
            benchmark=slot,
            endpoint=inputs.candidate,
            inputs=inputs,
            run_benchmark=run_benchmark,
            store=store,
        )
        baseline_result = _run_one(
            benchmark=slot,
            endpoint=inputs.baseline,
            inputs=inputs,
            run_benchmark=run_benchmark,
            store=store,
        )
        pairs.append(
            PairResult.from_results(
                benchmark=slot,
                candidate=candidate_result,
                baseline=baseline_result,
            )
        )
    return CompareReport(
        suite=suite,
        candidate=inputs.candidate,
        baseline=inputs.baseline,
        pairs=tuple(pairs),
    )


def _run_one(
    *,
    benchmark: SuiteBenchmark,
    endpoint: EndpointSpec,
    inputs: CompareInputs,
    run_benchmark: BenchmarkRunCallable,
    store: ResultsStore,
) -> BenchmarkResult:
    request = RunRequest(
        benchmark_id=benchmark.benchmark_id,
        endpoint=endpoint,
        output_dir=inputs.output_dir,
        limit=inputs.limit,
        mock=inputs.mock,
    )
    log.info(
        "compare: running %s for %s (%s)",
        benchmark.benchmark_id,
        endpoint.label,
        endpoint.model_id,
    )
    result = run_benchmark(request)
    store.record_run(
        model_id=endpoint.model_id,
        benchmark=result.benchmark,
        score=float(result.metrics.get("score", 0.0)),
        dataset_version=result.dataset_version or inputs.dataset_version,
        code_commit=inputs.code_commit,
        raw_json=result.to_json(),
    )
    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _parse_noise_overrides(values: Sequence[str] | None) -> dict[str, float]:
    out: dict[str, float] = {}
    for raw in values or ():
        token = raw.strip()
        if "=" not in token:
            raise ValueError(
                f"--noise must be of the form <benchmark_id>=<float>, got {raw!r}"
            )
        bench, threshold = token.split("=", 1)
        bench = bench.strip()
        if not bench:
            raise ValueError(f"--noise benchmark id is empty in {raw!r}")
        try:
            out[bench] = float(threshold.strip())
        except ValueError as exc:
            raise ValueError(
                f"--noise threshold for {bench!r} must be a float, got {threshold!r}"
            ) from exc
    return out


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="benchmarks.compare",
        description=(
            "Run a suite of standard LLM benchmarks against a candidate and a "
            "baseline endpoint, record every result, emit a comparison report."
        ),
    )
    parser.add_argument(
        "--candidate",
        required=True,
        help="Candidate endpoint URL or provider name (openai, groq, ...)",
    )
    parser.add_argument(
        "--baseline",
        required=True,
        help="Baseline endpoint URL or provider name",
    )
    parser.add_argument(
        "--candidate-model",
        default=None,
        help="Model id sent to the candidate endpoint (also used as the results-store id)",
    )
    parser.add_argument(
        "--baseline-model",
        default=None,
        help="Model id sent to the baseline endpoint (also used as the results-store id)",
    )
    parser.add_argument(
        "--candidate-api-key-env",
        default="OPENAI_API_KEY",
        help="Env var that holds the candidate endpoint's API key",
    )
    parser.add_argument(
        "--baseline-api-key-env",
        default="OPENAI_API_KEY",
        help="Env var that holds the baseline endpoint's API key",
    )
    parser.add_argument(
        "--suite",
        required=True,
        help=(
            "Suite name (one of: "
            + ", ".join(sorted(DEFAULT_SUITES))
            + ") or a comma-separated list of benchmark ids"
        ),
    )
    parser.add_argument(
        "--out",
        default=None,
        help="Path to write the JSON report (text report always goes to stdout)",
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Directory for per-benchmark outputs (default: a tmpdir under ./reports/compare)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Optional cap on evaluated examples per benchmark",
    )
    parser.add_argument(
        "--mock",
        action="store_true",
        help="Use deterministic mock clients (no network)",
    )
    parser.add_argument(
        "--dataset-version",
        default="suite-default",
        help="Fallback dataset_version recorded in ResultsStore when adapters omit it",
    )
    parser.add_argument(
        "--code-commit",
        default=None,
        help="git commit recorded with every run (default: env GIT_COMMIT or 'unknown')",
    )
    parser.add_argument(
        "--db-path",
        default=None,
        help="Override ResultsStore SQLite path (default: ELIZA_BENCHMARK_RESULTS_DB or ~/.eliza/...)",
    )
    parser.add_argument(
        "--noise",
        action="append",
        default=None,
        help="Override a benchmark's noise threshold (e.g. --noise mmlu=0.01)",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        help="Logging level (DEBUG, INFO, WARNING, ERROR)",
    )
    return parser


def parse_inputs(args: argparse.Namespace) -> CompareInputs:
    suite = resolve_suite(args.suite)
    candidate = resolve_endpoint_spec(
        label="candidate",
        raw=args.candidate,
        model=args.candidate_model,
        api_key_env=args.candidate_api_key_env,
    )
    baseline = resolve_endpoint_spec(
        label="baseline",
        raw=args.baseline,
        model=args.baseline_model,
        api_key_env=args.baseline_api_key_env,
    )
    output_dir = (
        Path(args.output_dir).expanduser().resolve()
        if args.output_dir
        else Path("reports") / "compare" / suite.name
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    code_commit = args.code_commit or os.environ.get("GIT_COMMIT") or "unknown"
    return CompareInputs(
        suite=suite,
        candidate=candidate,
        baseline=baseline,
        output_dir=output_dir,
        limit=args.limit,
        mock=bool(args.mock),
        dataset_version=args.dataset_version,
        code_commit=code_commit,
        noise_overrides=_parse_noise_overrides(args.noise),
    )


def main(argv: Sequence[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, str(args.log_level).upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    inputs = parse_inputs(args)
    db_path = (
        Path(args.db_path).expanduser().resolve()
        if args.db_path
        else default_db_path()
    )
    runner = build_default_runner()
    with ResultsStore(db_path=db_path) as store:
        report = run_compare(inputs, run_benchmark=runner, store=store)
    text = report.to_text()
    sys.stdout.write(text + "\n")
    if args.out:
        out_path = Path(args.out).expanduser().resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report.to_json(), indent=2), encoding="utf-8")
        log.info("compare: wrote JSON report to %s", out_path)
    return 0 if report.passed else 1


if __name__ == "__main__":
    sys.exit(main())
