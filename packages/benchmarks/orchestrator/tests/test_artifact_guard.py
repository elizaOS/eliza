from __future__ import annotations

from pathlib import Path

from benchmarks.orchestrator.artifact_guard import (
    build_artifact_guard_report,
    find_committed_generated_artifacts,
    is_generated_artifact,
)


def _workspace_root() -> Path:
    # ``.../packages/benchmarks/orchestrator/tests`` -> ``.../packages``
    return Path(__file__).resolve().parents[3]


GENERATED = [
    "benchmark_results/mmlu/run.json",
    "packages/benchmarks/benchmark_results/orchestrator.sqlite",
    "packages/benchmarks/benchmark_results/comparisons/x.json",
    "packages/benchmarks/some-bench/benchmark_results_v2/out.jsonl",
    "packages/benchmarks/some-bench/test_output/result.json",
    "packages/benchmarks/some-bench/trajectories/turn-1.jsonl",
    "packages/benchmarks/some-bench/trajectories.art.jsonl",
    "packages/benchmarks/some-bench/trajectories.grpo.groups.json",
]

# Source files whose names merely resemble generated output — must NOT be flagged.
SOURCE_LOOKALIKES = [
    "packages/benchmarks/HyperliquidBench/frontend/assets/trajectories.js",
    "packages/benchmarks/lifeops-bench/eliza_lifeops_bench/ingest/trajectories.py",
    "packages/benchmarks/tau-bench/tests/test_output_contract.py",
    "packages/benchmarks/terminal-bench/tasks/foo/tests/test_outputs.py",
    "packages/benchmarks/orchestrator/artifact_guard.py",
    "packages/benchmarks/registry/commands.py",
]

# The three intentionally-committed reviewed artifacts (.gitignore ``!`` negations).
ALLOWLISTED = [
    "benchmark_results/bfcl/bfcl_best_results.json",
    "benchmark_results/mint/MINT-BENCHMARK-REPORT.md",
    "benchmark_results/mint/mint-benchmark-results.json",
]


def test_flags_generated_output() -> None:
    for path in GENERATED:
        assert is_generated_artifact(path) is True, path


def test_does_not_flag_source_lookalikes() -> None:
    for path in SOURCE_LOOKALIKES:
        assert is_generated_artifact(path) is False, path


def test_allowlisted_reviewed_artifacts_are_not_flagged() -> None:
    for path in ALLOWLISTED:
        assert is_generated_artifact(path) is False, path
    # Also robust to a repo-prefixed form.
    assert (
        is_generated_artifact("packages/benchmarks/benchmark_results/mint/mint-benchmark-results.json")
        is False
    )


def test_find_committed_generated_artifacts_dedupes_and_sorts() -> None:
    mixed = [*SOURCE_LOOKALIKES, *GENERATED, GENERATED[0]]
    offending = find_committed_generated_artifacts(mixed)
    assert offending == tuple(sorted({p.strip().lstrip("./") for p in GENERATED}))
    for path in SOURCE_LOOKALIKES:
        assert path not in offending


def test_report_ok_on_clean_index() -> None:
    report = build_artifact_guard_report(
        _workspace_root(),
        run_git=lambda _args: "\n".join(SOURCE_LOOKALIKES),
    )
    assert report.ok is True
    assert report.offending == ()
    assert report.checked_count == len(SOURCE_LOOKALIKES)
    assert "OK" in report.to_markdown()


def test_report_fails_and_lists_offenders() -> None:
    report = build_artifact_guard_report(
        _workspace_root(),
        run_git=lambda _args: "\n".join([*SOURCE_LOOKALIKES, *GENERATED]),
    )
    assert report.ok is False
    assert set(report.offending) == {p.strip().lstrip("./") for p in GENERATED}
    md = report.to_markdown()
    assert "FAILED" in md
    assert "benchmark_results/mmlu/run.json" in md


def test_current_repo_index_is_clean() -> None:
    # The guard's real job: the actual tracked tree must carry no committed
    # generated benchmark output. This drives the real ``git ls-files`` path.
    report = build_artifact_guard_report(_workspace_root())
    assert report.ok is True, f"committed generated artifacts: {report.offending}"
    assert report.checked_count > 0
