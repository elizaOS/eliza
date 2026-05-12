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
    _score_from_woobench,
    discover_adapters,
)
from benchmarks.orchestrator.runner import (
    _effective_request,
    _is_harness_compatible,
    _required_env_for_request,
)
from benchmarks.orchestrator.types import ExecutionContext, RunRequest
from benchmarks.registry import _score_from_bfcl_json, get_benchmark_registry


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
    assert adapters["rlm_bench"].directory == "rlm-bench"
    assert adapters["osworld"].directory == "OSWorld"
    assert adapters["mmau"].directory == "mmau"
    assert adapters["voicebench_quality"].directory == "voicebench-quality"
    assert adapters["voiceagentbench"].directory == "voiceagentbench"
    assert "elizaos_mmau" not in discover_adapters(_workspace_root()).all_directories


def test_audio_benchmark_registry_commands_and_scores(tmp_path: Path) -> None:
    registry = {entry.id: entry for entry in get_benchmark_registry(_workspace_root())}

    mmau = registry["mmau"]
    mmau_command = mmau.build_command(
        tmp_path / "mmau",
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"agent": "hermes", "limit": 2, "no_traces": True},
    )
    assert mmau_command[:3] == [mmau_command[0], "-m", "benchmarks.mmau"]
    assert mmau_command[mmau_command.index("--agent") + 1] == "hermes"
    assert mmau_command[mmau_command.index("--limit") + 1] == "2"
    assert "--mock" not in mmau_command
    assert "--no-traces" in mmau_command
    assert mmau.extract_score(
        {"metrics": {"overall_accuracy": 0.5, "total_samples": 2}}
    ).score == 0.5

    voicebench_quality = registry["voicebench_quality"]
    vbq_command = voicebench_quality.build_command(
        tmp_path / "vbq",
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"agent": "openclaw", "suite": "openbookqa", "limit": 2, "fixtures": True},
    )
    assert vbq_command[:3] == [vbq_command[0], "-m", "elizaos_voicebench"]
    assert vbq_command[vbq_command.index("--agent") + 1] == "openclaw"
    assert vbq_command[vbq_command.index("--suite") + 1] == "openbookqa"
    assert "--fixtures" in vbq_command
    assert voicebench_quality.extract_score(
        {"score": 0.75, "n": 2, "per_suite": {"openbookqa": 0.75}}
    ).score == 0.75

    voiceagentbench = registry["voiceagentbench"]
    vab_command = voiceagentbench.build_command(
        tmp_path / "vab",
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"agent": "eliza", "suite": "single", "limit": 2, "mock": True, "no_judge": True},
    )
    assert vab_command[:3] == [vab_command[0], "-m", "elizaos_voiceagentbench"]
    assert vab_command[vab_command.index("--agent") + 1] == "eliza"
    assert "--mock" in vab_command
    assert "--no-judge" in vab_command
    assert voiceagentbench.extract_score(
        {"pass_at_1": 1.0, "tasks": [{"task_id": "t1"}]}
    ).score == 1.0


def test_hermes_native_envs_are_hermes_only() -> None:
    adapters = discover_adapters(_workspace_root()).adapters

    for benchmark_id in (
        "hermes_tblite",
        "hermes_terminalbench_2",
        "hermes_yc_bench",
        "hermes_swe_env",
    ):
        adapter = adapters[benchmark_id]
        assert adapter.directory == "hermes-adapter"
        assert adapter.agent_compatibility == ("hermes",)
        assert _is_harness_compatible(adapter, "hermes") is True
        assert _is_harness_compatible(adapter, "eliza") is False
        assert _is_harness_compatible(adapter, "openclaw") is False


def test_direct_provider_benchmarks_are_not_published_as_harness_rows() -> None:
    adapters = discover_adapters(_workspace_root()).adapters

    for benchmark_id in ("openclaw_bench", "interrupt_bench"):
        adapter = adapters[benchmark_id]
        assert adapter.agent_compatibility == ()
        assert _is_harness_compatible(adapter, "eliza") is False
        assert _is_harness_compatible(adapter, "hermes") is False
        assert _is_harness_compatible(adapter, "openclaw") is False


def test_gaia_orchestrated_registry_uses_orchestrated_entrypoint(tmp_path: Path) -> None:
    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "gaia_orchestrated"
    ]

    command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {
            "dataset": "sample",
            "max_questions": 2,
            "providers": ["claude-code", "codex"],
            "required_capabilities": ["research.web_search", "research.docs_lookup"],
            "strict_capabilities": True,
        },
    )

    assert command[command.index("-m") + 1] == "elizaos_gaia.orchestrated"
    assert command[command.index("--max-questions") + 1] == "2"
    assert command[command.index("--providers") + 1 : command.index("--providers") + 3] == [
        "claude-code",
        "codex",
    ]
    assert "--strict-capabilities" in command
    assert entry.locate_result(tmp_path) == tmp_path / "gaia-orchestrated-latest.json"


def test_mint_registry_distinguishes_harness_bridge_from_direct_provider(
    tmp_path: Path,
) -> None:
    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "mint"
    ]

    harness_command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"agent": "hermes"},
    )
    direct_command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {},
    )

    assert harness_command[harness_command.index("--provider") + 1] == "eliza"
    assert direct_command[direct_command.index("--provider") + 1] == "cerebras"


def test_lifeops_registry_forwards_suite_and_limit(tmp_path: Path) -> None:
    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "lifeops_bench"
    ]

    command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"suite": "smoke", "limit": 1, "agent": "eliza"},
    )

    assert command[command.index("--suite") + 1] == "smoke"
    assert command[command.index("--limit") + 1] == "1"


def test_bfcl_registry_always_writes_scoreable_json(tmp_path: Path) -> None:
    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "bfcl"
    ]

    command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"agent": "hermes", "sample": 1, "no_report": True, "no_exec": True},
    )

    assert "--no-report" not in command
    assert "--no-exec" in command
    assert command[command.index("--provider") + 1] == "hermes"
    assert command[command.index("--sample") + 1] == "1"

    openclaw_command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"agent": "openclaw", "sample": 1},
    )
    assert openclaw_command[openclaw_command.index("--provider") + 1] == "openclaw"


def test_bfcl_score_rejects_zero_task_results() -> None:
    with pytest.raises(ValueError, match="zero-task score"):
        _score_from_bfcl_json(
            {
                "metrics": {
                    "overall_score": 0.0,
                    "total_tests": 0,
                    "error_analysis": {},
                }
            }
        )


def test_bfcl_openclaw_env_uses_direct_openai_compatible_transport(tmp_path: Path) -> None:
    adapter = discover_adapters(_workspace_root()).adapters["bfcl"]
    ctx = ExecutionContext(
        workspace_root=_workspace_root(),
        benchmarks_root=_workspace_root() / "packages" / "benchmarks",
        output_root=tmp_path / "out",
        run_root=tmp_path,
        request=RunRequest(
            benchmarks=("bfcl",),
            agent="openclaw",
            provider="cerebras",
            model="gpt-oss-120b",
            extra_config={"agent": "openclaw", "sample": 1},
        ),
        run_group_id="test",
        env={},
        repo_meta={},
    )

    env = adapter.env_builder(ctx, adapter) if adapter.env_builder else {}

    assert env["OPENCLAW_DIRECT_OPENAI_COMPAT"] == "1"
    assert env["OPENCLAW_USE_CLI"] == "0"


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


def test_scambench_orchestrator_default_is_tiny_bridge_smoke(tmp_path: Path) -> None:
    adapters = discover_adapters(_workspace_root()).adapters
    adapter = adapters["scambench"]
    ctx = ExecutionContext(
        workspace_root=_workspace_root(),
        benchmarks_root=_workspace_root() / "benchmarks",
        output_root=tmp_path / "out",
        run_root=tmp_path,
        request=RunRequest(
            benchmarks=("scambench",),
            agent="eliza",
            provider="cerebras",
            model="gpt-oss-120b",
            extra_config=dict(adapter.default_extra_config),
        ),
        run_group_id="test",
        env={},
        repo_meta={},
    )

    command = adapter.command_builder(ctx, adapter)

    assert command[command.index("--max-examples") + 1] == "2"
    assert command[command.index("--max-new-tokens") + 1] == "128"
    assert command[command.index("--out") + 1] == str(tmp_path / "out")


def test_woobench_orchestrator_default_is_bounded_multi_scenario_persona(tmp_path: Path) -> None:
    adapters = discover_adapters(_workspace_root()).adapters
    adapter = adapters["woobench"]
    ctx = ExecutionContext(
        workspace_root=_workspace_root(),
        benchmarks_root=_workspace_root() / "benchmarks",
        output_root=tmp_path / "out",
        run_root=tmp_path,
        request=RunRequest(
            benchmarks=("woobench",),
            agent="eliza",
            provider="cerebras",
            model="gpt-oss-120b",
            extra_config=dict(adapter.default_extra_config),
        ),
        run_group_id="test",
        env={},
        repo_meta={},
    )

    command = adapter.command_builder(ctx, adapter)

    assert "--scenario" not in command
    assert command[command.index("--scenarios") + 1] == (
        "friend_supporter_tarot_01,repeat_customer_tarot_01"
    )
    assert command[command.index("--evaluator") + 1] == "heuristic"
    assert command[command.index("--concurrency") + 1] == "1"
    assert command[command.index("--random-seed") + 1] == "1"


def test_woobench_score_extractor_marks_interrupted_for_quarantine(tmp_path: Path) -> None:
    result_path = tmp_path / "woobench_smoke.json"
    result_path.write_text(
        json.dumps(
            {
                "overall_score": 12.5,
                "revenue_efficiency": 0.0,
                "resilience_score": 0.0,
                "failed_scenarios": 1,
                "total_revenue": 9.0,
                "interrupted": True,
                "scenarios": [
                    {
                        "scenario_id": "skeptic_tarot_01",
                        "payment_converted": True,
                        "agent_responsive": True,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    score = _score_from_woobench(result_path)

    assert score.score == 0.125
    assert score.metrics["interrupted"] is True
    assert score.metrics["total_instances"] == 1
    assert score.metrics["total_revenue"] == 9.0
    assert score.metrics["avg_revenue_per_scenario"] == 9.0
    assert score.metrics["payment_converted_count"] == 1


def test_compactbench_score_accepts_valid_hit_file_from_locator(tmp_path: Path) -> None:
    valid = tmp_path / "compactbench-results.valid-hits.jsonl"
    valid.write_text(
        "\n".join(
            [
                '{"event":"analysis_start"}',
                '{"event":"analysis_end","overall_score":0.8}',
            ]
        ),
        encoding="utf-8",
    )

    score = _score_from_compactbench(valid)

    assert score.score == 0.8
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


def test_context_bench_adapter_defaults_to_smoke_command(tmp_path: Path) -> None:
    adapter = discover_adapters(_workspace_root()).adapters["context_bench"]
    effective = _effective_request(
        adapter,
        RunRequest(
            benchmarks=("context_bench",),
            agent="eliza",
            provider="groq",
            model="kimi-k2",
            extra_config={},
        ),
    )
    ctx = ExecutionContext(
        workspace_root=_workspace_root(),
        benchmarks_root=_workspace_root() / "packages" / "benchmarks",
        output_root=tmp_path / "out",
        run_root=tmp_path,
        request=effective,
        run_group_id="test",
        env={},
        repo_meta={},
    )

    command = adapter.command_builder(ctx, adapter)

    assert "--quick" in command
    assert command[command.index("--context-lengths") + 1] == "1024"
    assert command[command.index("--positions") + 1] == "middle"
    assert command[command.index("--tasks-per-position") + 1] == "1"


def test_loca_adapter_gates_openclaw_until_native_loca_adapter_exists(tmp_path: Path) -> None:
    adapter = discover_adapters(_workspace_root()).adapters["loca_bench"]
    ctx = ExecutionContext(
        workspace_root=_workspace_root(),
        benchmarks_root=_workspace_root() / "packages" / "benchmarks",
        output_root=tmp_path / "out",
        run_root=tmp_path,
        request=RunRequest(
            benchmarks=("loca_bench",),
            agent="openclaw",
            provider="cerebras",
            model="gpt-oss-120b",
            extra_config={
                "max_context_size": 1_000_000,
                "reset_size": 500_000,
                "reasoning_effort": "low",
                "timeout": 120,
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
    assert _is_harness_compatible(adapter, "eliza") is True
    assert _is_harness_compatible(adapter, "hermes") is True
    assert _is_harness_compatible(adapter, "openclaw") is False
    assert "--allow-empty" not in command
    assert command[command.index("--max-context-size") + 1] == "1000000"
    assert command[command.index("--reset-size") + 1] == "500000"
    assert command[command.index("--reasoning-effort") + 1] == "low"
    assert env["MAX_CONVERSATION_TOKENS"] == "1000000"
    assert env["LOCA_HARNESS_TIMEOUT_S"] == "115"
    # If a developer force-runs the unsupported OpenClaw smoke path, the env
    # must make the direct OpenAI-compatible transport explicit. Compatibility
    # gating above keeps this out of normal cross-agent matrices.
    assert env["LOCA_OPENCLAW_THINKING"] == "low"
    assert env["OPENCLAW_DIRECT_OPENAI_COMPAT"] == "1"
    assert env["OPENCLAW_USE_CLI"] == "0"


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


def test_action_calling_registry_command_forwards_tool_choice(tmp_path: Path) -> None:
    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "action-calling"
    ]

    command = entry.build_command(
        tmp_path,
        ModelSpec(provider="vllm", model="local-tools"),
        {"tool_choice": "required", "max_examples": 1},
    )

    assert command[command.index("--tool-choice") + 1] == "required"


def test_vending_registry_clamps_smoke_to_revenue_observable_days(tmp_path: Path) -> None:
    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "vending_bench"
    ]

    command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"agent": "eliza", "runs": 1, "days": 1},
    )

    assert command[command.index("--runs") + 1] == "1"
    assert command[command.index("--days") + 1] == "3"
    assert "--starter-inventory" in command
    assert command[command.index("--max-actions-per-day") + 1] == "6"


def test_abliteration_registry_command_defaults_to_no_tool_choice(tmp_path: Path) -> None:
    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "abliteration-robustness"
    ]

    default_command = entry.build_command(
        tmp_path,
        ModelSpec(provider="vllm", model="local-abliterated"),
        {},
    )
    explicit_command = entry.build_command(
        tmp_path,
        ModelSpec(provider="vllm", model="local-abliterated"),
        {"tool_choice": "auto"},
    )

    assert default_command[default_command.index("--tool-choice") + 1] == "none"
    assert explicit_command[explicit_command.index("--tool-choice") + 1] == "auto"


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
