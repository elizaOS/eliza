from __future__ import annotations

from pathlib import Path

from benchmarks.bench_cli_types import ModelSpec
from benchmarks.orchestrator.adapters import _score_from_app_eval, discover_adapters
from benchmarks.orchestrator.types import ExecutionContext, RunRequest
from benchmarks.registry import get_benchmark_registry


def _workspace_root() -> Path:
    return Path(__file__).resolve().parents[3]


def test_discovery_covers_all_real_benchmark_directories() -> None:
    discovery = discover_adapters(_workspace_root())
    covered_dirs = {adapter.directory for adapter in discovery.adapters.values()}

    assert set(discovery.all_directories) - covered_dirs == set()
    assert ".pytest_cache" not in discovery.all_directories
    assert "swe-bench-workspace" not in discovery.all_directories


def test_discovery_includes_directory_name_mismatches_and_special_tracks() -> None:
    adapters = discover_adapters(_workspace_root()).adapters

    assert adapters["app-eval"].directory == "app-eval"
    assert adapters["openclaw_bench"].directory == "openclaw-benchmark"
    assert adapters["hyperliquid_bench"].directory == "HyperliquidBench"
    assert adapters["eliza_replay"].directory == "eliza-adapter"
    assert adapters["gaia_orchestrated"].directory == "gaia"


def test_openclaw_registry_command_and_result_locator(tmp_path: Path) -> None:
    registry = {entry.id: entry for entry in get_benchmark_registry(_workspace_root())}
    entry = registry["openclaw_bench"]

    command = entry.build_command(tmp_path, ModelSpec(provider="groq", model="kimi-k2"), {})
    assert "--output-dir" in command
    assert str(tmp_path) in command

    result_path = tmp_path / "openclaw_setup_concept_123.json"
    result_path.write_text('{"score":{"score":0.5}}', encoding="utf-8")
    assert entry.locate_result(tmp_path) == result_path

    score = entry.extract_score({"score": {"score": 0.5}})
    assert score.score == 0.5
    assert score.metrics["tasks_completed"] == 1


def test_configbench_registry_command_forwards_limit(tmp_path: Path) -> None:
    registry = {entry.id: entry for entry in get_benchmark_registry(_workspace_root())}
    entry = registry["configbench"]

    command = entry.build_command(
        tmp_path,
        ModelSpec(provider="groq", model="kimi-k2"),
        {"limit": 1, "verbose": True},
    )

    assert command[:3] == ["bun", "run", "src/index.ts"]
    assert command[command.index("--output") + 1] == str(tmp_path)
    assert command[command.index("--limit") + 1] == "1"
    assert "--verbose" in command
    assert "--eliza" not in command


def test_configbench_adapter_command_forwards_limit(tmp_path: Path) -> None:
    adapters = discover_adapters(_workspace_root()).adapters
    adapter = adapters["configbench"]
    ctx = ExecutionContext(
        workspace_root=_workspace_root(),
        benchmarks_root=_workspace_root() / "benchmarks",
        output_root=tmp_path / "out",
        run_root=tmp_path,
        request=RunRequest(
            benchmarks=("configbench",),
            agent="mock",
            provider="groq",
            model="kimi-k2",
            extra_config={"limit": 1, "verbose": True},
        ),
        run_group_id="test",
        env={},
        repo_meta={},
    )

    command = adapter.command_builder(ctx, adapter)

    assert command[:3] == ["bun", "run", "src/index.ts"]
    assert command[command.index("--output") + 1] == str(tmp_path / "out")
    assert command[command.index("--limit") + 1] == "1"
    assert "--verbose" in command
    assert "--eliza" not in command


def test_app_eval_score_normalizes_ten_point_summary(tmp_path: Path) -> None:
    result_path = tmp_path / "summary.json"
    result_path.write_text(
        '{"overall_score":7.5,"total_tasks":2,"completed":1,"failed":1}',
        encoding="utf-8",
    )

    score = _score_from_app_eval(result_path)
    assert score.score == 0.75
    assert score.unit == "ratio"
    assert score.metrics["overall_score"] == 7.5
