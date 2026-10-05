"""Tests for the top-level ``benchmarks.run`` dispatcher CLI."""

from __future__ import annotations

import pytest

from benchmarks.run import _DISPATCH, main


def test_run_help_lists_benchmarks(capsys: pytest.CaptureFixture[str]) -> None:
    rc = main(["--help"])
    out = capsys.readouterr().out
    assert rc == 0
    for bench_id in ("mmlu", "humaneval", "gsm8k", "mt_bench"):
        assert bench_id in out


def test_run_no_args_prints_usage(capsys: pytest.CaptureFixture[str]) -> None:
    rc = main([])
    out = capsys.readouterr().out
    assert rc == 0
    assert "usage:" in out


def test_run_rejects_unknown_benchmark(capsys: pytest.CaptureFixture[str]) -> None:
    rc = main(["not-a-real-benchmark"])
    err = capsys.readouterr().err
    assert rc == 2
    assert "unknown benchmark" in err


@pytest.mark.parametrize("benchmark_id", ["mmlu", "humaneval", "gsm8k", "mt_bench"])
def test_dispatch_table_includes_benchmark(benchmark_id: str) -> None:
    assert benchmark_id in _DISPATCH
    assert callable(_DISPATCH[benchmark_id])


def test_mt_bench_alias_is_dispatched() -> None:
    # ``mt-bench`` (hyphen) is the registry id; ``mt_bench`` (underscore)
    # is the Python module. Both should resolve to the same adapter.
    assert _DISPATCH["mt_bench"] is _DISPATCH["mt-bench"]


def test_dispatch_mmlu_through_run(tmp_path, capsys) -> None:
    """End-to-end: ``python -m benchmarks.run mmlu --mock ...`` should
    invoke the MMLU adapter and write its results file.

    The shared ``cli_dispatch`` sys.exits, so we catch SystemExit and
    verify the rc + the on-disk result.
    """

    import json

    out_dir = tmp_path / "mmlu"
    with pytest.raises(SystemExit) as excinfo:
        main(
            [
                "mmlu",
                "--mock",
                "--provider",
                "openai",
                "--model",
                "mock",
                "--output",
                str(out_dir),
                "--api-key-env",
                "DOES_NOT_EXIST",
            ]
        )
    assert excinfo.value.code == 0
    capsys.readouterr()
    results_file = out_dir / "mmlu-results.json"
    assert results_file.exists()
    data = json.loads(results_file.read_text("utf-8"))
    assert data["metrics"]["score"] == 1.0
