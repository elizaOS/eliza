from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest

from benchmarks.bench_cli_types import ModelSpec
from benchmarks.orchestrator.adapters import (
    _score_from_app_eval,
    _score_from_compactbench,
    _score_from_loca_bench,
    discover_adapters,
)
from benchmarks.orchestrator.runner import (
    _effective_request,
    _is_harness_compatible,
    _required_env_for_request,
)
from benchmarks.orchestrator.types import ExecutionContext, RunRequest
from benchmarks.registry import get_benchmark_registry


def _workspace_root() -> Path:
    return Path(__file__).resolve().parents[3]


def test_discovery_covers_all_real_benchmark_directories() -> None:
    discovery = discover_adapters(_workspace_root())
    covered_dirs = {adapter.directory for adapter in discovery.adapters.values()}

    assert set(discovery.all_directories) - covered_dirs == set()
    assert ".pytest_cache" not in discovery.all_directories
    assert "swe-bench-pro" not in discovery.all_directories
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
    assert command[command.index("--mode") + 1] == "execution"
    assert command[command.index("--model") + 1] == "kimi-k2"

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


def test_compactbench_adapter_uses_repaired_scorer_by_default(tmp_path: Path) -> None:
    adapters = discover_adapters(_workspace_root()).adapters
    adapter = adapters["compactbench"]
    ctx = ExecutionContext(
        workspace_root=_workspace_root(),
        benchmarks_root=_workspace_root() / "packages" / "benchmarks",
        output_root=tmp_path / "out",
        run_root=tmp_path,
        request=RunRequest(
            benchmarks=("compactbench",),
            agent="eliza",
            provider="cerebras",
            model="gpt-oss-120b",
            extra_config={"case_count": 1, "drift_cycles": 1, "score": True},
        ),
        run_group_id="test",
        env={},
        repo_meta={},
    )

    command = adapter.command_builder(ctx, adapter)

    assert "--analyze-valid-hits" in command
    assert "--valid-hit-output" in command
    assert command[command.index("--valid-hit-output") + 1] == str(
        tmp_path / "out" / "compactbench-results.valid-hits.jsonl"
    )
    assert adapter.agent_compatibility == ("eliza",)


def test_compactbench_score_prefers_repaired_valid_hit_analysis(tmp_path: Path) -> None:
    raw = tmp_path / "compactbench-results.jsonl"
    raw.write_text(
        '{"event":"run_end","overall_score":0.25,"compression_ratio":2.0}\n',
        encoding="utf-8",
    )
    valid = tmp_path / "compactbench-results.valid-hits.jsonl"
    valid.write_text(
        "\n".join(
            [
                '{"event":"analysis_start"}',
                (
                    '{"event":"analysis_end","overall_score":0.95,'
                    '"benchmark_quality_score":0.95,'
                    '"raw_lexical_overall_score":0.25,'
                    '"valid_false_negatives":3,'
                    '"semantic_false_positives":0,'
                    '"failures_remaining":1,'
                    '"repaired_expected_conflicts":0,'
                    '"removed_invalid_items":0,'
                    '"judge_refusals":0}'
                ),
            ]
        ),
        encoding="utf-8",
    )

    score = _score_from_compactbench(raw)

    assert score.score == 0.95
    assert score.metrics["raw_lexical_overall_score"] == 0.25
    assert score.metrics["valid_false_negatives"] == 3
    assert score.metrics["scorer_name"] == "repaired_valid_hits"


def test_compactbench_score_requires_repaired_valid_hit_analysis(tmp_path: Path) -> None:
    raw = tmp_path / "compactbench-results.jsonl"
    raw.write_text(
        '{"event":"run_end","overall_score":0.25,"compression_ratio":2.0}\n',
        encoding="utf-8",
    )

    try:
        _score_from_compactbench(raw)
    except ValueError as exc:
        assert "valid-hit analysis is required" in str(exc)
    else:
        raise AssertionError("expected missing repaired analysis to fail scoring")


def test_compare_label_remains_incompatible_with_eliza_only_compactbench() -> None:
    adapter = discover_adapters(_workspace_root()).adapters["compactbench"]
    request = RunRequest(
        benchmarks=("compactbench",),
        agent="compare",
        provider="cerebras",
        model="gpt-oss-120b",
        extra_config={},
        force=True,
    )

    effective = _effective_request(adapter, request)

    assert adapter.agent_compatibility == ("eliza",)
    assert effective.agent == "compare"
    assert _is_harness_compatible(adapter, "compare") is False


def test_compare_label_still_runs_multi_harness_adapters() -> None:
    adapter = discover_adapters(_workspace_root()).adapters["context_bench"]

    assert len(adapter.agent_compatibility) > 1
    assert _is_harness_compatible(adapter, "compare") is True


def test_loca_adapter_excludes_openclaw_until_full_transcript_adapter_exists(tmp_path: Path) -> None:
    adapter = discover_adapters(_workspace_root()).adapters["loca_bench"]
    ctx = ExecutionContext(
        workspace_root=_workspace_root(),
        benchmarks_root=_workspace_root() / "packages" / "benchmarks",
        output_root=tmp_path / "out",
        run_root=tmp_path,
        request=RunRequest(
            benchmarks=("loca_bench",),
            agent="eliza",
            provider="cerebras",
            model="gpt-oss-120b",
            extra_config={
                "max_context_size": 1_000_000,
                "reset_size": 500_000,
                "reasoning_effort": "low",
                "allow_empty": True,
            },
        ),
        run_group_id="test",
        env={},
        repo_meta={},
    )

    command = adapter.command_builder(ctx, adapter)
    env = adapter.env_builder(ctx, adapter) if adapter.env_builder else {}

    assert adapter.agent_compatibility == ("eliza", "hermes")
    assert _is_harness_compatible(adapter, "openclaw") is False
    assert "--allow-empty" not in command
    assert command[command.index("--max-context-size") + 1] == "1000000"
    assert command[command.index("--reset-size") + 1] == "500000"
    assert command[command.index("--reasoning-effort") + 1] == "low"
    assert env["MAX_CONVERSATION_TOKENS"] == "1000000"


def test_lifeops_required_env_tracks_static_vs_live_modes() -> None:
    adapter = discover_adapters(_workspace_root()).adapters["lifeops_bench"]

    static_perfect = _effective_request(
        adapter,
        RunRequest(
            benchmarks=("lifeops_bench",),
            agent="perfect",
            provider="cerebras",
            model="perfect",
            extra_config={"mode": "static"},
        ),
    )
    assert _required_env_for_request(adapter, static_perfect) == ()

    static_hermes = _effective_request(
        adapter,
        RunRequest(
            benchmarks=("lifeops_bench",),
            agent="hermes",
            provider="cerebras",
            model="gpt-oss-120b",
            extra_config={"mode": "static"},
        ),
    )
    assert _required_env_for_request(adapter, static_hermes) == ("CEREBRAS_API_KEY",)

    live_hermes = _effective_request(
        adapter,
        RunRequest(
            benchmarks=("lifeops_bench",),
            agent="hermes",
            provider="cerebras",
            model="gpt-oss-120b",
            extra_config={"mode": "live"},
        ),
    )
    assert _required_env_for_request(adapter, live_hermes) == (
        "CEREBRAS_API_KEY",
        "ANTHROPIC_API_KEY",
    )


def test_action_calling_eliza_generation_uses_captured_runtime_calls() -> None:
    module = importlib.import_module("benchmarks.action-calling.cli")

    class Response:
        text = ""
        params = {
            "BENCHMARK_ACTION": {
                "tool_name": "mail_search",
                "arguments": {"query": "ACME invoice"},
            }
        }

    class Client:
        def send_message(self, **_kwargs):
            return Response()

    case = module.ExpectedCase(
        record={},
        messages=[{"role": "system", "content": "Use tools."}, {"role": "user", "content": "call the tool"}],
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "mail_search",
                    "description": "Search mail",
                    "parameters": {
                        "type": "object",
                        "properties": {"query": {"type": "string"}},
                        "required": ["query"],
                    },
                },
            }
        ],
        expected_calls=[{"name": "mail_search", "arguments": {"query": "ACME invoice"}}],
    )

    generated, text, source, content_calls = module._generate(
        Client(),
        "eliza",
        "gpt-oss-120b",
        case,
        128,
        0.0,
        "auto",
    )

    assert generated == [{"name": "mail_search", "arguments": {"query": "ACME invoice"}}]
    assert text == ""
    assert source == "captured_action"
    assert content_calls == []


def test_action_calling_score_accepts_native_metrics() -> None:
    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "action-calling"
    ]

    score = entry.extract_score(
        {
            "provider": "eliza",
            "generation_source": "captured_action",
            "n": 1,
            "metrics": {
                "score": 1.0,
                "native_tool_calls_ok": 1.0,
                "tool_name_match": 1.0,
                "args_parse_ok": 1.0,
                "required_keys_ok": 1.0,
                "arguments_match": 1.0,
            },
        }
    )

    assert score.score == 1.0
    assert score.metrics["native_tool_calls_ok"] == 1.0
    assert score.metrics["generation_source"] == "captured_action"


def test_loca_score_rejects_task_runs_without_token_usage(tmp_path: Path) -> None:
    audit = tmp_path / "eliza_loca_audit.json"
    audit.write_text(
        json.dumps(
            {
                "summary": {
                    "avg_accuracy": 0.0,
                    "issue_count": 0,
                    "trajectory_count": 1,
                    "metadata_total_tasks": 1,
                    "total_api_tokens": 0,
                }
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="no API token usage"):
        _score_from_loca_bench(audit)


def test_loca_score_rejects_empty_runs(tmp_path: Path) -> None:
    audit = tmp_path / "eliza_loca_audit.json"
    audit.write_text(
        json.dumps(
            {
                "summary": {
                    "avg_accuracy": 1.0,
                    "issue_count": 0,
                    "trajectory_count": 0,
                    "aggregate_trajectory_count": 0,
                    "metadata_total_tasks": 0,
                    "total_api_tokens": 0,
                }
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="no captured trajectories"):
        _score_from_loca_bench(audit)


def test_scambench_registry_command_and_score_contract(tmp_path: Path) -> None:
    registry = {entry.id: entry for entry in get_benchmark_registry(_workspace_root())}
    entry = registry["scambench"]
    dataset = tmp_path / "scambench.jsonl"
    dataset.write_text("{}", encoding="utf-8")

    command = entry.build_command(
        tmp_path,
        ModelSpec(provider="vllm", model="local-scam-model"),
        {
            "dataset": str(dataset),
            "max_examples": 2,
            "max_new_tokens": 32,
            "temperature": 0.25,
            "vllm_base_url": "http://127.0.0.1:9999/v1",
        },
    )

    assert command[:3] == [command[0], "-m", "benchmarks.scambench.cli"]
    assert command[command.index("--provider") + 1] == "vllm"
    assert command[command.index("--model") + 1] == "local-scam-model"
    assert command[command.index("--out") + 1] == str(tmp_path)
    assert command[command.index("--dataset") + 1] == str(dataset)
    assert command[command.index("--base-url") + 1] == "http://127.0.0.1:9999/v1"
    assert command[command.index("--max-examples") + 1] == "2"
    assert command[command.index("--max-new-tokens") + 1] == "32"
    assert command[command.index("--temperature") + 1] == "0.25"

    result_path = tmp_path / "scambench-results.json"
    result_path.write_text(
        '{"metrics":{"score":0.75,"scam_refuse_rate":1.0,"legit_help_rate":0.5,"n_scam":1,"n_legit":2}}',
        encoding="utf-8",
    )
    assert entry.locate_result(tmp_path) == result_path

    score = entry.extract_score(
        {
            "metrics": {
                "score": 0.75,
                "scam_refuse_rate": 1.0,
                "legit_help_rate": 0.5,
                "n_scam": 1,
                "n_legit": 2,
            }
        }
    )
    assert score.score == 0.75
    assert score.unit == "ratio"
    assert score.higher_is_better is True
    assert score.metrics["n_scam"] == 1


def test_scambench_adapter_command_uses_vllm_base_url(tmp_path: Path) -> None:
    adapters = discover_adapters(_workspace_root()).adapters
    adapter = adapters["scambench"]
    dataset = tmp_path / "scambench.jsonl"
    dataset.write_text("{}", encoding="utf-8")
    ctx = ExecutionContext(
        workspace_root=_workspace_root(),
        benchmarks_root=_workspace_root() / "benchmarks",
        output_root=tmp_path / "out",
        run_root=tmp_path,
        request=RunRequest(
            benchmarks=("scambench",),
            agent="mock",
            provider="vllm",
            model="local-scam-model",
            extra_config={
                "dataset": str(dataset),
                "max_examples": 2,
                "vllm_base_url": "http://127.0.0.1:9999/v1",
            },
        ),
        run_group_id="test",
        env={},
        repo_meta={},
    )

    command = adapter.command_builder(ctx, adapter)

    assert command[:3] == [command[0], "-m", "benchmarks.scambench.cli"]
    assert command[command.index("--out") + 1] == str(tmp_path / "out")
    assert command[command.index("--dataset") + 1] == str(dataset)
    assert command[command.index("--base-url") + 1] == "http://127.0.0.1:9999/v1"


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
