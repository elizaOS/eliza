from __future__ import annotations

import importlib
import importlib.util
import contextlib
import json
import os
import subprocess
import sys
import types
from pathlib import Path

import pytest

from benchmarks.orchestrator import adapters as orchestrator_adapters
from benchmarks.bench_cli_types import ModelSpec
from benchmarks.orchestrator.adapters import (
    GAIA_OFFICIAL_DATASET_UNAVAILABLE_REASON,
    _score_from_app_eval,
    _score_from_compactbench,
    _score_from_eliza_1,
    _score_from_loca_bench,
    _score_from_personality_bench,
    _score_from_woobench,
    discover_adapters,
)
from benchmarks.orchestrator.runner import (
    _default_env,
    _effective_request,
    _is_harness_compatible,
    _required_env_for_request,
)
from benchmarks.orchestrator.matrix_validation import (
    build_cross_matrix_report,
    report_to_json,
)
from benchmarks.orchestrator.random_baseline_runner import (
    CALIBRATION_HARNESSES,
    run_synthetic_baseline,
    synthetic_score_for_harness,
)
from benchmarks.orchestrator.types import ExecutionContext, RunRequest
from benchmarks.registry import (
    _score_from_agentbench_json,
    _score_from_bfcl_json,
    _score_from_clawbench_json,
    _score_from_contextbench_json,
    _score_from_gauntlet_json,
    _score_from_gsm8k_json,
    _score_from_hyperliquid_bench_json,
    _score_from_mind2web_json,
    _score_from_mmau_json,
    _score_from_mint_json,
    _score_from_mt_bench_json,
    _score_from_osworld_json,
    _score_from_realm_json,
    _score_from_rlmbench_json,
    _score_from_scambench_json,
    _score_from_swebench_json,
    _score_from_taubench_json,
    _score_from_terminalbench_json,
    _score_from_trajectory_replay_json,
    _score_from_vendingbench_json,
    _score_from_vision_language_json,
    _score_from_visualwebbench_json,
    _score_from_voiceagentbench_json,
    _score_from_voicebench_json,
    _score_from_voicebench_quality_json,
    _score_from_webshop_json,
    get_benchmark_registry,
)


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
    assert adapters["mmau"].directory == "mmau-audio"
    assert adapters["voicebench_quality"].directory == "voicebench-quality"
    assert adapters["voiceagentbench"].directory == "voiceagentbench"
    assert "elizaos_mmau" not in discover_adapters(_workspace_root()).all_directories


def test_voice_audio_defaults_do_not_publish_mock_fixture_runs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.setattr(orchestrator_adapters.importlib.util, "find_spec", lambda _name: object())
    orchestrator_adapters._VOICEBENCH_QUALITY_REAL_INPUTS_AVAILABLE = None
    orchestrator_adapters._VOICEAGENTBENCH_REAL_AUDIO_AVAILABLE = None
    adapters = discover_adapters(_workspace_root()).adapters

    voicebench_quality_extra = adapters["voicebench_quality"].default_extra_config
    assert voicebench_quality_extra.get("fixtures") is not True
    assert voicebench_quality_extra.get("mock") is not True
    assert voicebench_quality_extra.get("stt_provider") == "faster-whisper"

    voiceagentbench_extra = adapters["voiceagentbench"].default_extra_config
    assert voiceagentbench_extra.get("mock") is not True
    assert voiceagentbench_extra.get("no_judge") is not True


def test_gauntlet_requires_clone_capable_surfpool_for_real_harness_rows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        orchestrator_adapters,
        "_has_gauntlet_real_surfpool_backend",
        lambda: False,
    )
    monkeypatch.setattr(
        orchestrator_adapters,
        "_has_hyperliquid_live_backend",
        lambda: True,
    )
    adapter = discover_adapters(_workspace_root()).adapters["gauntlet"]
    assert adapter.agent_compatibility == ()
    assert _is_harness_compatible(adapter, "eliza") is False
    assert _is_harness_compatible(adapter, "hermes") is False
    assert _is_harness_compatible(adapter, "openclaw") is False

    monkeypatch.setattr(
        orchestrator_adapters,
        "_has_gauntlet_real_surfpool_backend",
        lambda: True,
    )
    adapter = discover_adapters(_workspace_root()).adapters["gauntlet"]
    assert adapter.agent_compatibility == ("eliza", "openclaw", "hermes")
    assert _is_harness_compatible(adapter, "eliza") is True
    assert _is_harness_compatible(adapter, "hermes") is True
    assert _is_harness_compatible(adapter, "openclaw") is True


def test_gauntlet_accepts_current_surfpool_remote_datasource_help(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    orchestrator_adapters._GAUNTLET_REAL_SURFPOOL_AVAILABLE = None
    monkeypatch.setattr(orchestrator_adapters.shutil, "which", lambda _name: "/bin/surfpool")
    monkeypatch.setattr(
        orchestrator_adapters,
        "_surfpool_start_help",
        lambda _binary: "Usage: surfpool start --network <NETWORK> --rpc-url <RPC_URL> --no-tui",
    )
    try:
        assert orchestrator_adapters._has_gauntlet_real_surfpool_backend() is True
    finally:
        orchestrator_adapters._GAUNTLET_REAL_SURFPOOL_AVAILABLE = None


def test_gauntlet_surfpool_manager_uses_current_mainnet_datasource_cli(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.syspath_prepend(str(_workspace_root() / "benchmarks" / "gauntlet" / "src"))
    for module_name in list(sys.modules):
        if module_name == "gauntlet" or module_name.startswith("gauntlet."):
            del sys.modules[module_name]

    from gauntlet.harness.surfpool import SurfpoolConfig, SurfpoolManager

    manager = SurfpoolManager(
        SurfpoolConfig(
            offline_mode=False,
            clone_from="https://api.mainnet-beta.solana.com",
            programs_to_clone=["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
        )
    )
    monkeypatch.setattr(manager, "_find_surfpool_binary", lambda: "/bin/surfpool")
    monkeypatch.setattr(
        manager,
        "_start_help",
        lambda: "Usage: surfpool start --network <NETWORK> --rpc-url <RPC_URL> --no-tui",
    )

    command = manager._build_command()
    assert "--offline" not in command
    assert "--clone" not in command
    assert "--network" in command
    assert command[command.index("--network") + 1] == "mainnet"


def test_gauntlet_registry_selects_distinct_harness_agents(tmp_path: Path) -> None:
    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "gauntlet"
    ]

    for harness, shim in (
        ("eliza", "eliza_bridge_agent.py"),
        ("hermes", "hermes_bridge_agent.py"),
        ("openclaw", "openclaw_bridge_agent.py"),
    ):
        command = entry.build_command(
            tmp_path / harness,
            ModelSpec(provider="cerebras", model="gpt-oss-120b"),
            {"agent": harness, "clone_mainnet": True, "max_scenarios": 1},
        )
        assert "--agent" in command
        assert command[command.index("--agent") + 1].endswith(shim)
        assert "--clone-mainnet" in command
        assert "--mock" not in command


def test_gauntlet_rejects_mock_or_offline_execution_artifacts() -> None:
    payload = {
        "metadata": {
            "execution": {
                "mock_mode": False,
                "offline_mode": True,
                "clone_mainnet": False,
            }
        },
        "results": {
            "overall_score": 75.0,
            "passed": True,
            "components": {
                "task_completion": 70.0,
                "safety": 90.0,
                "efficiency": 60.0,
                "capital": 100.0,
            },
        },
    }
    with pytest.raises(ValueError, match="mock/offline execution"):
        _score_from_gauntlet_json(payload)

    payload["metadata"]["execution"]["offline_mode"] = False  # type: ignore[index]
    assert _score_from_gauntlet_json(payload).score == 0.75


def test_hyperliquid_rejects_demo_mode_execution_artifacts() -> None:
    payload = {
        "final_score": 3.5,
        "total_score": 3.5,
        "base": 3.0,
        "bonus": 0.5,
        "penalty": 0.0,
        "total_scenarios": 1,
        "passed_scenarios": 1,
        "mode": "eliza",
        "model": "gpt-oss-120b",
        "network": "testnet",
        "demo_mode": True,
        "scenarios": [
            {
                "success": True,
                "unique_signatures": ["perp.order.GTC:false:none"],
            }
        ],
    }
    with pytest.raises(ValueError, match="demo-mode result"):
        _score_from_hyperliquid_bench_json(payload)

    payload["demo_mode"] = False
    assert _score_from_hyperliquid_bench_json(payload).score == 3.5

    payload["scenarios"] = [{"success": True, "unique_signatures": []}]
    with pytest.raises(ValueError, match="no confirmed live action signatures"):
        _score_from_hyperliquid_bench_json(payload)

    payload["scenarios"] = [
        {
            "success": False,
            "unique_signatures": ["perp.order.GTC:false:none"],
        }
    ]
    with pytest.raises(ValueError, match="failed scenarios"):
        _score_from_hyperliquid_bench_json(payload)


def test_voiceagentbench_requires_real_audio_dataset_for_harness_rows(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.delenv("VOICEAGENTBENCH_STT_PROVIDER", raising=False)
    monkeypatch.delenv("ELIZA_API_BASE", raising=False)
    monkeypatch.delenv("ELIZA_BENCH_URL", raising=False)
    monkeypatch.delenv("VOICEAGENTBENCH_DATA_PATH", raising=False)
    monkeypatch.delenv("VOICEAGENTBENCH_REAL_DATA_PATH", raising=False)
    monkeypatch.setattr(orchestrator_adapters.importlib.util, "find_spec", lambda _name: None)
    orchestrator_adapters._VOICEAGENTBENCH_REAL_AUDIO_AVAILABLE = None
    adapter = discover_adapters(_workspace_root()).adapters["voiceagentbench"]
    assert adapter.agent_compatibility == ()

    data_path = tmp_path / "voiceagentbench-real.jsonl"
    data_path.write_text(
        json.dumps(
            {
                "task_id": "real-audio-1",
                "suite": "single",
                "queries": [
                    {
                        "transcript": "Find the weather in Paris",
                        "language": "en",
                        "audio_b64": "UklGRg==",
                    }
                ],
                "expected_tool_calls": [],
                "tool_manifest": [],
            }
        )
        + "\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    monkeypatch.setenv("VOICEAGENTBENCH_DATA_PATH", str(data_path))
    orchestrator_adapters._VOICEAGENTBENCH_REAL_AUDIO_AVAILABLE = None
    adapter = discover_adapters(_workspace_root()).adapters["voiceagentbench"]
    assert adapter.agent_compatibility == ("eliza", "openclaw", "hermes")

    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "voiceagentbench"
    ]
    command = entry.build_command(
        tmp_path / "out",
        ModelSpec(provider="cerebras", model="eliza"),
        {"agent": "eliza", "suite": "single", "limit": 1, "no_judge": True},
    )
    assert "--mock" not in command
    assert "--data-path" in command
    assert command[command.index("--data-path") + 1] == str(data_path)

    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.setenv("VOICEAGENTBENCH_STT_PROVIDER", "eliza-runtime")
    monkeypatch.setenv("ELIZA_API_BASE", "http://127.0.0.1:31337")
    orchestrator_adapters._VOICEAGENTBENCH_REAL_AUDIO_AVAILABLE = None
    adapter = discover_adapters(_workspace_root()).adapters["voiceagentbench"]
    assert adapter.agent_compatibility == ("eliza", "openclaw", "hermes")

    command = entry.build_command(
        tmp_path / "out-eliza-stt",
        ModelSpec(provider="cerebras", model="hermes"),
        {"agent": "hermes", "suite": "single", "limit": 1, "no_judge": True},
    )
    assert "--stt-provider" in command
    assert command[command.index("--stt-provider") + 1] == "eliza-runtime"


def test_voicebench_requires_real_audio_assets_for_eliza_row(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.delenv("CEREBRAS_API_KEY", raising=False)
    monkeypatch.delenv("VOICEBENCH_DATASET", raising=False)
    monkeypatch.delenv("VOICEBENCH_DATASET_PATH", raising=False)
    monkeypatch.delenv("VOICEBENCH_AUDIO_PATH", raising=False)
    monkeypatch.delenv("VOICEBENCH_PROFILE", raising=False)
    orchestrator_adapters._VOICEBENCH_REAL_AUDIO_AVAILABLE = None
    adapter = discover_adapters(_workspace_root()).adapters["voicebench"]
    assert adapter.agent_compatibility == ()

    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"RIFF")
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "datasetName": "voicebench-real-smoke",
                "samples": [
                    {
                        "id": "sample",
                        "text": "hello",
                        "audioPath": str(audio_path),
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    monkeypatch.setenv("VOICEBENCH_DATASET_PATH", str(manifest_path))
    orchestrator_adapters._VOICEBENCH_REAL_AUDIO_AVAILABLE = None
    adapter = discover_adapters(_workspace_root()).adapters["voicebench"]
    assert adapter.agent_compatibility == ("eliza", "openclaw", "hermes")
    assert _is_harness_compatible(adapter, "eliza") is True
    assert _is_harness_compatible(adapter, "hermes") is True
    assert _is_harness_compatible(adapter, "openclaw") is True

    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "voicebench"
    ]
    command = entry.build_command(
        tmp_path / "out",
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"iterations": 1, "agent": "openclaw"},
    )
    assert "--profile=groq" in command
    assert f"--dataset={manifest_path}" in command
    with pytest.raises(ValueError, match="mock profile result"):
        _score_from_voicebench_json(
            {"profile": "mock", "summary": {"simple": {"avgEndToEndMs": 0.0}}}
        )
    with pytest.raises(ValueError, match="result records"):
        _score_from_voicebench_json(
            {
                "profile": "local-cerebras",
                "runtime": "typescript",
                "sampleCount": 1,
                "datasetName": "real-audio",
                "results": [],
                "summary": {
                    "simple": {
                        "runs": 1,
                        "avgEndToEndMs": 10.0,
                        "transcriptionNormalizedAccuracy": 1.0,
                    }
                },
            }
        )
    assert (
        _score_from_voicebench_json(
            {
                "profile": "groq",
                "runtime": "typescript",
                "sampleCount": 1,
                "datasetName": "real-audio",
                "results": [{"mode": "simple"}],
                "summary": {
                    "simple": {
                        "runs": 1,
                        "avgEndToEndMs": 10.0,
                        "transcriptionNormalizedAccuracy": 0.5,
                    }
                },
            }
        ).score
        == 0.5
    )


def test_voicebench_quality_supports_eliza_runtime_stt_gate(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.delenv("VOICEBENCH_QUALITY_STT_PROVIDER", raising=False)
    monkeypatch.delenv("VOICEBENCH_STT_PROVIDER", raising=False)
    monkeypatch.delenv("ELIZA_API_BASE", raising=False)
    monkeypatch.delenv("ELIZA_BENCH_URL", raising=False)
    monkeypatch.setattr(orchestrator_adapters.importlib.util, "find_spec", lambda _name: None)
    orchestrator_adapters._VOICEBENCH_QUALITY_REAL_INPUTS_AVAILABLE = None
    adapter = discover_adapters(_workspace_root()).adapters["voicebench_quality"]
    assert adapter.agent_compatibility == ()

    monkeypatch.setattr(orchestrator_adapters.importlib.util, "find_spec", lambda _name: object())
    orchestrator_adapters._VOICEBENCH_QUALITY_REAL_INPUTS_AVAILABLE = None
    adapter = discover_adapters(_workspace_root()).adapters["voicebench_quality"]
    assert adapter.agent_compatibility == ("eliza", "openclaw", "hermes")
    assert adapter.default_extra_config["stt_provider"] == "faster-whisper"

    monkeypatch.setenv("VOICEBENCH_QUALITY_STT_PROVIDER", "eliza-runtime")
    monkeypatch.setenv("ELIZA_API_BASE", "http://127.0.0.1:31337")
    orchestrator_adapters._VOICEBENCH_QUALITY_REAL_INPUTS_AVAILABLE = None
    adapter = discover_adapters(_workspace_root()).adapters["voicebench_quality"]
    assert adapter.agent_compatibility == ("eliza", "openclaw", "hermes")
    assert adapter.default_extra_config["stt_provider"] == "eliza-runtime"

    request = RunRequest(
        benchmarks=("voicebench_quality",),
        agent="hermes",
        provider="cerebras",
        model="gpt-oss-120b",
        extra_config={"stt_provider": "eliza-runtime"},
    )
    assert _required_env_for_request(adapter, request) == ("CEREBRAS_API_KEY", "ELIZA_API_BASE")

    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "voicebench_quality"
    ]
    command = entry.build_command(
        tmp_path / "out-vbq",
        ModelSpec(provider="cerebras", model="hermes"),
        {"agent": "hermes", "suite": "openbookqa", "limit": 1},
    )
    assert "--stt-provider" in command
    assert command[command.index("--stt-provider") + 1] == "eliza-runtime"


def test_synthetic_calibration_payloads_exercise_all_score_extractors(tmp_path: Path) -> None:
    adapters = discover_adapters(_workspace_root()).adapters
    expected = {"perfect_v1": 1.0, "wrong_v1": 0.0, "half_v1": 0.5}

    for benchmark_id, adapter in sorted(adapters.items()):
        for harness in CALIBRATION_HARNESSES:
            output_dir = tmp_path / benchmark_id / harness
            baseline = run_synthetic_baseline(
                benchmark_id=benchmark_id,
                output_dir=output_dir,
                harness=harness,
            )
            assert baseline.status == "succeeded"
            assert baseline.result_path is not None
            summary = adapter.score_extractor(baseline.result_path)
            assert summary.score == pytest.approx(expected[harness])


def test_random_v1_covers_code_terminal_os_and_browser_adapters(
    tmp_path: Path,
) -> None:
    adapters = discover_adapters(_workspace_root()).adapters
    assert synthetic_score_for_harness("random_v1") == pytest.approx(0.5)

    for benchmark_id in (
        "swe_bench",
        "terminal_bench",
        "osworld",
        "visualwebbench",
    ):
        output_dir = tmp_path / benchmark_id / "random_v1"
        baseline = run_synthetic_baseline(
            benchmark_id=benchmark_id,
            output_dir=output_dir,
            harness="random_v1",
        )

        assert baseline.status == "succeeded"
        assert baseline.result_path is not None
        summary = adapters[benchmark_id].score_extractor(baseline.result_path)
        assert summary.score == pytest.approx(0.5)


def test_default_env_does_not_enable_benchmark_stub_embedding_for_eliza(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("ELIZA_BENCH_ALLOW_STUB_EMBEDDING", raising=False)

    env = _default_env(
        _workspace_root(),
        RunRequest(
            benchmarks=("action-calling",),
            agent="eliza",
            provider="cerebras",
            model="gpt-oss-120b",
            extra_config={},
        ),
    )

    assert "ELIZA_BENCH_ALLOW_STUB_EMBEDDING" not in env


def test_default_env_can_explicitly_enable_benchmark_stub_embedding(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("ELIZA_BENCH_ALLOW_STUB_EMBEDDING", raising=False)

    env = _default_env(
        _workspace_root(),
        RunRequest(
            benchmarks=("action-calling",),
            agent="eliza",
            provider="cerebras",
            model="gpt-oss-120b",
            extra_config={"allow_stub_embedding": True},
        ),
    )

    assert env["ELIZA_BENCH_ALLOW_STUB_EMBEDDING"] == "1"


def test_default_env_respects_disabled_benchmark_stub_embedding(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ELIZA_BENCH_ALLOW_STUB_EMBEDDING", "0")

    env = _default_env(
        _workspace_root(),
        RunRequest(
            benchmarks=("action-calling",),
            agent="eliza",
            provider="cerebras",
            model="gpt-oss-120b",
            extra_config={},
        ),
    )

    assert env["ELIZA_BENCH_ALLOW_STUB_EMBEDDING"] == "0"


def test_default_env_maps_profile_reasoning_effort_to_provider_env() -> None:
    env = _default_env(
        _workspace_root(),
        RunRequest(
            benchmarks=("bfcl",),
            agent="eliza",
            provider="cerebras",
            model="gpt-oss-120b",
            extra_config={"reasoning_effort": " low "},
        ),
    )

    assert env["OPENAI_REASONING_EFFORT"] == "low"
    assert env["CEREBRAS_REASONING_EFFORT"] == "low"


def test_cross_matrix_validation_constructs_all_compatible_cells(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(orchestrator_adapters, "_has_gaia_official_dataset", lambda: True)
    monkeypatch.setattr(orchestrator_adapters, "_has_hyperliquid_live_backend", lambda: True)
    monkeypatch.setattr(orchestrator_adapters, "_has_terminal_bench_docker_backend", lambda: True)
    monkeypatch.setattr(orchestrator_adapters, "_has_swe_bench_docker_backend", lambda: True)
    monkeypatch.setattr(orchestrator_adapters, "_has_osworld_docker_backend", lambda: True)
    monkeypatch.setattr(orchestrator_adapters, "_has_hermes_sandbox_backend", lambda: True)
    monkeypatch.setattr(orchestrator_adapters, "_has_voicebench_real_audio_assets", lambda: True)
    monkeypatch.setattr(orchestrator_adapters, "_has_voicebench_quality_real_inputs", lambda: True)
    monkeypatch.setattr(orchestrator_adapters, "_has_voiceagentbench_real_audio_dataset", lambda: True)
    monkeypatch.setattr(orchestrator_adapters, "_vision_language_compatible_harnesses", lambda: ("eliza", "hermes", "openclaw"))
    report = build_cross_matrix_report(
        _workspace_root().parent,
        provider="cerebras",
        model="gpt-oss-120b",
    )

    assert report.adapter_count == len(discover_adapters(_workspace_root()).adapters)
    assert report.compatible_cell_count > 0
    assert report.incompatible_cell_count == 0
    assert report.error_count == 0
    incompatible = [cell for cell in report.cells if not cell.compatible]
    assert incompatible == []

    compatible = [cell for cell in report.cells if cell.compatible]
    assert compatible
    assert all(cell.command for cell in compatible)
    assert all(cell.command_display for cell in compatible)
    assert all(cell.effective_extra_config is not None for cell in compatible)
    assert all(cell.result_locator_patterns for cell in compatible)
    assert all(cell.trajectory_expectations for cell in compatible)

    sample = next(
        cell
        for cell in compatible
        if cell.benchmark_id == "bfcl" and cell.harness == "openclaw"
    )
    assert sample.propagated_env["BENCHMARK_MODEL_PROVIDER"] == "cerebras"
    assert sample.propagated_env["BENCHMARK_MODEL_NAME"] == "gpt-oss-120b"
    assert sample.propagated_env["BENCHMARK_HARNESS"] == "openclaw"
    assert sample.env_overrides["OPENCLAW_DIRECT_OPENAI_COMPAT"] == "1"

    incompatible = [cell for cell in report.cells if not cell.compatible]
    assert all(cell.reason for cell in incompatible)


def test_gaia_matrix_rows_require_official_dataset_access(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(orchestrator_adapters, "_has_gaia_official_dataset", lambda: False)

    report = build_cross_matrix_report(
        _workspace_root().parent,
        provider="cerebras",
        model="gpt-oss-120b",
    )
    gaia_cells = [
        cell
        for cell in report.cells
        if cell.benchmark_id in {"gaia", "gaia_orchestrated"}
    ]

    assert len(gaia_cells) == 6
    assert all(cell.compatible is False for cell in gaia_cells)
    assert all(
        cell.reason == GAIA_OFFICIAL_DATASET_UNAVAILABLE_REASON
        for cell in gaia_cells
    )


@pytest.mark.parametrize(
    "env_name",
    ["HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "HUGGINGFACE_TOKEN"],
)
def test_gaia_official_dataset_gate_accepts_hf_token_aliases(
    monkeypatch: pytest.MonkeyPatch,
    env_name: str,
) -> None:
    for name in orchestrator_adapters.HUGGINGFACE_TOKEN_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv(env_name, "token-value")
    orchestrator_adapters._GAIA_OFFICIAL_DATASET_AVAILABLE = None
    try:
        assert orchestrator_adapters._has_gaia_official_dataset() is True
    finally:
        orchestrator_adapters._GAIA_OFFICIAL_DATASET_AVAILABLE = None


def test_hyperliquid_matrix_rows_require_live_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(orchestrator_adapters, "_has_gaia_official_dataset", lambda: True)
    monkeypatch.setattr(orchestrator_adapters, "_has_hyperliquid_live_backend", lambda: False)

    report = build_cross_matrix_report(
        _workspace_root().parent,
        provider="cerebras",
        model="gpt-oss-120b",
    )
    cells = [
        cell
        for cell in report.cells
        if cell.benchmark_id == "hyperliquid_bench"
    ]

    assert len(cells) == 3
    assert all(cell.compatible is False for cell in cells)
    assert all(
        cell.reason == orchestrator_adapters.HYPERLIQUID_LIVE_UNAVAILABLE_REASON
        for cell in cells
    )


def test_cross_matrix_validation_redacts_secret_config_values() -> None:
    report = build_cross_matrix_report(
        _workspace_root().parent,
        provider="cerebras",
        model="gpt-oss-120b",
        extra_config={
            "api_key": "should-not-leak",
            "nested": {"token": "also-secret"},
            "safe": "visible",
        },
        harnesses=("eliza",),
    )

    payload = report_to_json(report)
    assert "should-not-leak" not in payload
    assert "also-secret" not in payload
    assert "<redacted>" in payload
    assert "visible" in payload


def test_direct_and_native_rows_keep_truthful_matrix_compatibility(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(orchestrator_adapters, "_has_gaia_official_dataset", lambda: True)
    monkeypatch.setattr(
        orchestrator_adapters,
        "_has_hermes_sandbox_backend",
        lambda: True,
    )
    monkeypatch.setattr(
        orchestrator_adapters,
        "_has_swe_bench_docker_backend",
        lambda: True,
    )
    monkeypatch.setattr(
        orchestrator_adapters,
        "_has_gauntlet_real_surfpool_backend",
        lambda: False,
    )
    monkeypatch.setattr(
        orchestrator_adapters,
        "_has_hyperliquid_live_backend",
        lambda: True,
    )
    monkeypatch.setattr(
        orchestrator_adapters,
        "_vision_language_compatible_harnesses",
        lambda: ("eliza",),
    )

    report = build_cross_matrix_report(
        _workspace_root().parent,
        provider="cerebras",
        model="gpt-oss-120b",
    )
    cells = {(cell.benchmark_id, cell.harness): cell for cell in report.cells}

    for harness in ("eliza", "hermes", "openclaw"):
        cell = cells[("openclaw_bench", harness)]
        assert cell.compatible is True
        assert cell.command is not None
        assert "openclaw-benchmark/eliza_adapter.py" in cell.command_display

    for benchmark_id in ("mmlu", "humaneval", "gsm8k", "mt_bench"):
        for harness in ("eliza", "hermes", "openclaw"):
            cell = cells[(benchmark_id, harness)]
            assert cell.compatible is True
            assert cell.command
            assert cell.propagated_env["BENCHMARK_HARNESS"] == harness
            assert cell.propagated_env["ELIZA_BENCH_HARNESS"] == harness

    for benchmark_id in (
        "gaia",
        "gaia_orchestrated",
        "swe_bench_orchestrated",
        "configbench",
        "hyperliquid_bench",
        "interrupt_bench",
        "eliza_1",
        "framework",
        "orchestrator_lifecycle",
        "scambench",
        "vending_bench",
        "webshop",
    ):
        for harness in ("eliza", "hermes", "openclaw"):
            cell = cells[(benchmark_id, harness)]
            assert cell.compatible is True
            assert cell.command
            assert cell.propagated_env["BENCHMARK_HARNESS"] == harness
            assert cell.propagated_env["ELIZA_BENCH_HARNESS"] == harness
            if benchmark_id == "gaia":
                assert "--harness" in cell.command
                assert cell.command[cell.command.index("--harness") + 1] == harness
            if benchmark_id == "gaia_orchestrated":
                assert "--providers" in cell.command
                assert cell.command[cell.command.index("--providers") + 1] == harness
            if benchmark_id == "swe_bench_orchestrated":
                assert "--providers" in cell.command
                assert cell.command[cell.command.index("--providers") + 1] == harness
            if benchmark_id == "configbench":
                assert "--harness" in cell.command
                assert cell.command[cell.command.index("--harness") + 1] == harness
            if benchmark_id == "vending_bench":
                assert "--provider" in cell.command
                assert cell.command[cell.command.index("--provider") + 1] == "eliza"
            if benchmark_id == "hyperliquid_bench":
                assert "--mode" in cell.command
                assert cell.command[cell.command.index("--mode") + 1] == "eliza"
            if benchmark_id == "interrupt_bench":
                assert "--mode=harness" in cell.command
            if benchmark_id == "eliza_1":
                assert "scripts/harness_runner.py" in cell.command_display
                assert "--harness" in cell.command
                assert cell.command[cell.command.index("--harness") + 1] == harness
            if benchmark_id == "framework":
                assert "benchmarks/framework/scripts/harness_runner.py" in cell.command_display
                assert "--harness" in cell.command
                assert cell.command[cell.command.index("--harness") + 1] == harness
            if benchmark_id == "orchestrator_lifecycle":
                assert "--mode" in cell.command
                assert cell.command[cell.command.index("--mode") + 1] == "bridge"
            if benchmark_id == "scambench":
                assert "--provider" in cell.command
                assert cell.command[cell.command.index("--provider") + 1] == "cerebras"

    for benchmark_id in (
        "hermes_tblite",
        "hermes_terminalbench_2",
        "hermes_yc_bench",
        "hermes_swe_env",
    ):
        for harness in ("eliza", "hermes", "openclaw"):
            cell = cells[(benchmark_id, harness)]
            assert cell.compatible is True
            assert cell.command
            assert "hermes-adapter/run_env_cli.py" in cell.command_display
            assert "--harness" in cell.command
            assert cell.command[cell.command.index("--harness") + 1] == harness

    for harness in ("eliza", "hermes", "openclaw"):
        cell = cells[("gauntlet", harness)]
        assert cell.compatible is False
        assert cell.command is None
        assert cell.reason == (
            f"harness '{harness}' not in adapter compatibility (none)"
        )

    for harness in ("eliza", "hermes", "openclaw"):
        cell = cells[("vision_language", harness)]
        if harness == "eliza":
            assert cell.compatible is True
            assert cell.command
            assert "src/runner.ts" in cell.command_display
        else:
            assert cell.compatible is False
            assert cell.command is None
            assert cell.reason == orchestrator_adapters.VISION_LANGUAGE_HARNESS_RUNTIME_UNAVAILABLE_REASON

    compactbench_hermes = cells[("compactbench", "hermes")]
    assert compactbench_hermes.compatible is True
    assert compactbench_hermes.command is not None
    assert (
        "hermes_compactbench/compactors.py:HermesNativeToolCompactor"
        in compactbench_hermes.command
    )

    compactbench_openclaw = cells[("compactbench", "openclaw")]
    assert compactbench_openclaw.compatible is True
    assert compactbench_openclaw.command is not None
    assert (
        "eliza_compactbench/openclaw_compactor.py:OpenClawNativeToolCompactor"
        in compactbench_openclaw.command
    )


def test_real_matrix_compatible_commands_do_not_default_to_mock_or_stub(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        orchestrator_adapters,
        "_has_gauntlet_real_surfpool_backend",
        lambda: False,
    )
    report = build_cross_matrix_report(
        _workspace_root().parent,
        provider="cerebras",
        model="gpt-oss-120b",
    )
    forbidden_terms = ("mock", "stub", "dummy", "dry-run", "dry_run", "no-judge", "no_judge")
    offenders: list[str] = []
    for cell in report.cells:
        if not cell.compatible:
            continue
        command_text = " ".join(cell.command or []).lower()
        extra_text = json.dumps(cell.effective_extra_config or {}, sort_keys=True).lower()
        hits = [
            term
            for term in forbidden_terms
            if term in command_text or term in extra_text
        ]
        if hits:
            offenders.append(f"{cell.benchmark_id}/{cell.harness}: {', '.join(hits)}")
    assert offenders == []


def test_audio_benchmark_registry_commands_and_scores(tmp_path: Path) -> None:
    registry = {entry.id: entry for entry in get_benchmark_registry(_workspace_root())}

    mmau = registry["mmau"]
    mmau_command = mmau.build_command(
        tmp_path / "mmau",
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"agent": "hermes", "limit": 2, "no_traces": True},
    )
    assert mmau_command[:3] == [mmau_command[0], "-m", "elizaos_mmau_audio"]
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
    with pytest.raises(ValueError, match="mock or fixture result"):
        _score_from_voicebench_quality_json(
            {
                "score": 1.0,
                "n": 1,
                "agent": "openclaw",
                "judge_model": "fixture",
                "stt_provider": "fixture",
                "mock": True,
                "per_suite": {"openbookqa": 1.0},
            }
        )

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
    with pytest.raises(ValueError, match="mock agent result"):
        _score_from_voiceagentbench_json(
            {"pass_at_1": 1.0, "model_name": "mock", "tasks": [{"task_id": "t1"}]}
        )
    with pytest.raises(ValueError, match="fixture STT result"):
        _score_from_voiceagentbench_json(
            {
                "pass_at_1": 1.0,
                "model_name": "eliza",
                "stt_provider": "fixture",
                "tasks": [{"task_id": "t1"}],
            }
        )


def test_vision_language_multimodal_model_detection_blocks_cerebras_public_models(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert (
        orchestrator_adapters._is_vision_language_multimodal_model(
            provider="cerebras",
            model="kimi-k2.6",
        )
        is False
    )
    assert (
        orchestrator_adapters._is_vision_language_multimodal_model(
            provider="cerebras",
            model="gpt-oss-120b",
        )
        is False
    )
    monkeypatch.setenv("VISION_LANGUAGE_MULTIMODAL", "1")
    assert (
        orchestrator_adapters._is_vision_language_multimodal_model(
            provider="cerebras",
            model="user-confirmed-dedicated-vlm",
        )
        is True
    )


def test_taubench_extracts_pass_hat_k_dict_shape() -> None:
    score = _score_from_taubench_json(
        {
            "num_tasks": 2,
            "avg_reward": 0.0,
            "pass_k": {"1": {"k": 1, "num_tasks": 2, "pass_hat_k": 0.25}},
        }
    )

    assert score.score == 0.25


def test_personality_score_uses_task_pass_rate_not_calibration_score(tmp_path: Path) -> None:
    report = tmp_path / "report.json"
    report.write_text(
        json.dumps(
            {
                "totals": {"scenarios": 87, "pass": 39, "fail": 46, "needsReview": 2},
                "calibration": {
                    "score": 1.0,
                    "agreementRate": 1.0,
                    "falsePositiveRate": 0.0,
                    "reviewRate": 2 / 87,
                    "mismatches": [],
                },
            }
        ),
        encoding="utf-8",
    )

    summary = _score_from_personality_bench(report)

    assert summary.score == pytest.approx(39 / 87)
    assert summary.metrics["calibration_score"] == 1.0


def test_live_gated_domain_benchmarks_have_no_key_smoke_routes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.delenv("CEREBRAS_API_KEY", raising=False)
    registry = {entry.id: entry for entry in get_benchmark_registry(_workspace_root())}
    mock_model = ModelSpec(provider="mock", model="mock")

    vending_command = registry["vending_bench"].build_command(
        tmp_path / "vending",
        mock_model,
        {"mock": True, "max_tasks": 1},
    )
    assert vending_command[vending_command.index("--provider") + 1] == "heuristic"
    assert vending_command[vending_command.index("--runs") + 1] == "1"

    hyperliquid_command = registry["hyperliquid_bench"].build_command(
        tmp_path / "hyperliquid",
        mock_model,
        {"max_steps": 1},
    )
    assert hyperliquid_command[hyperliquid_command.index("--mode") + 1] == "deterministic"

    lifecycle_command = registry["orchestrator_lifecycle"].build_command(
        tmp_path / "lifecycle",
        mock_model,
        {"max_scenarios": 1},
    )
    assert lifecycle_command[lifecycle_command.index("--mode") + 1] == "simulate"

    openclaw_command = registry["openclaw_bench"].build_command(
        tmp_path / "openclaw",
        mock_model,
        {"task": "setup"},
    )
    assert openclaw_command[openclaw_command.index("--mode") + 1] == "conceptual"

    voicebench_command = registry["voicebench"].build_command(
        tmp_path / "voicebench",
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"iterations": 1},
    )
    assert "--profile=groq" in voicebench_command


def test_eliza_1_score_rejects_all_adapter_errors(tmp_path: Path) -> None:
    result_path = tmp_path / "eliza-1-results.json"
    result_path.write_text(
        json.dumps(
            {
                "cases": [
                    {
                        "raw_output": "",
                        "tokens_generated": 24,
                        "error": "cerebras returned empty output",
                    },
                    {
                        "raw_output": "",
                        "tokens_generated": 24,
                        "error": "cerebras returned empty output",
                    },
                ],
                "summaries": [
                    {
                        "taskId": "should_respond",
                        "modeId": "cerebras",
                        "cases": 2,
                        "label_match_rate": 0.0,
                        "parse_success_rate": 0.0,
                        "schema_valid_rate": 0.0,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="adapter errors"):
        _score_from_eliza_1(result_path)


def test_mmau_legacy_module_shims_find_renamed_audio_package(tmp_path: Path) -> None:
    env = dict(os.environ)
    env["PYTHONPATH"] = str(_workspace_root() / "packages")

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "benchmarks.mmau",
            "--mock",
            "--limit",
            "1",
            "--output",
            str(tmp_path / "mmau-legacy"),
            "--json",
        ],
        cwd=_workspace_root(),
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert (tmp_path / "mmau-legacy" / "mmau-results.json").exists()


def test_hermes_native_envs_publish_real_harness_rows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        orchestrator_adapters,
        "_has_hermes_sandbox_backend",
        lambda: True,
    )

    adapters = discover_adapters(_workspace_root()).adapters

    for benchmark_id in (
        "hermes_tblite",
        "hermes_terminalbench_2",
        "hermes_yc_bench",
        "hermes_swe_env",
    ):
        adapter = adapters[benchmark_id]
        assert adapter.directory == "hermes-adapter"
        assert adapter.agent_compatibility == ("eliza", "openclaw", "hermes")
        assert _is_harness_compatible(adapter, "hermes") is True
        assert _is_harness_compatible(adapter, "eliza") is True
        assert _is_harness_compatible(adapter, "openclaw") is True


def test_hermes_native_envs_require_sandbox_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        orchestrator_adapters,
        "_has_hermes_sandbox_backend",
        lambda: False,
    )
    adapters = discover_adapters(_workspace_root()).adapters

    for benchmark_id in (
        "hermes_tblite",
        "hermes_terminalbench_2",
        "hermes_yc_bench",
        "hermes_swe_env",
    ):
        adapter = adapters[benchmark_id]
        assert adapter.directory == "hermes-adapter"
        assert adapter.agent_compatibility == ()
        assert _is_harness_compatible(adapter, "hermes") is False
        assert _is_harness_compatible(adapter, "eliza") is False
        assert _is_harness_compatible(adapter, "openclaw") is False


def test_osworld_requires_reachable_docker_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        orchestrator_adapters,
        "_has_osworld_docker_backend",
        lambda: False,
    )
    adapter = discover_adapters(_workspace_root()).adapters["osworld"]
    assert adapter.agent_compatibility == ()
    assert _is_harness_compatible(adapter, "eliza") is False
    assert _is_harness_compatible(adapter, "hermes") is False
    assert _is_harness_compatible(adapter, "openclaw") is False

    report = build_cross_matrix_report(
        _workspace_root().parent,
        harnesses=("eliza", "hermes", "openclaw"),
    )
    for cell in [cell for cell in report.cells if cell.benchmark_id == "osworld"]:
        assert cell.compatible is False
        assert cell.command is None
        assert cell.reason == orchestrator_adapters.OSWORLD_DOCKER_UNAVAILABLE_REASON

    monkeypatch.setattr(
        orchestrator_adapters,
        "_has_osworld_docker_backend",
        lambda: True,
    )
    adapter = discover_adapters(_workspace_root()).adapters["osworld"]
    assert adapter.agent_compatibility == ("eliza", "openclaw", "hermes")
    assert _is_harness_compatible(adapter, "eliza") is True
    assert _is_harness_compatible(adapter, "hermes") is True
    assert _is_harness_compatible(adapter, "openclaw") is True


def test_hermes_native_env_matrix_reports_sandbox_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        orchestrator_adapters,
        "_has_hermes_sandbox_backend",
        lambda: False,
    )

    report = build_cross_matrix_report(
        _workspace_root().parent,
        provider="cerebras",
        model="gpt-oss-120b",
    )
    cell = next(
        cell
        for cell in report.cells
        if cell.benchmark_id == "hermes_tblite" and cell.harness == "hermes"
    )

    assert cell.compatible is False
    assert cell.reason == orchestrator_adapters.HERMES_SANDBOX_UNAVAILABLE_REASON


def test_openclaw_bench_publishes_real_harness_rows() -> None:
    adapters = discover_adapters(_workspace_root()).adapters

    adapter = adapters["openclaw_bench"]
    assert adapter.agent_compatibility == ("eliza", "openclaw", "hermes")
    assert _is_harness_compatible(adapter, "eliza") is True
    assert _is_harness_compatible(adapter, "hermes") is True
    assert _is_harness_compatible(adapter, "openclaw") is True


def test_standard_public_benchmarks_publish_real_harness_rows() -> None:
    adapters = discover_adapters(_workspace_root()).adapters

    for benchmark_id in ("mmlu", "humaneval", "gsm8k", "mt_bench"):
        adapter = adapters[benchmark_id]
        assert adapter.agent_compatibility == ("eliza", "openclaw", "hermes")
        assert _is_harness_compatible(adapter, "eliza") is True
        assert _is_harness_compatible(adapter, "hermes") is True
        assert _is_harness_compatible(adapter, "openclaw") is True


def test_framework_publishes_real_harness_rows() -> None:
    adapter = discover_adapters(_workspace_root()).adapters["framework"]

    assert adapter.agent_compatibility == ("eliza", "openclaw", "hermes")
    assert _is_harness_compatible(adapter, "eliza") is True
    assert _is_harness_compatible(adapter, "hermes") is True
    assert _is_harness_compatible(adapter, "openclaw") is True


def test_compactbench_publishes_all_real_compactor_harnesses() -> None:
    adapter = discover_adapters(_workspace_root()).adapters["compactbench"]

    assert adapter.agent_compatibility == ("eliza", "openclaw", "hermes")
    assert _is_harness_compatible(adapter, "eliza") is True
    assert _is_harness_compatible(adapter, "hermes") is True
    assert _is_harness_compatible(adapter, "openclaw") is True


def test_agentbench_routes_cross_harness_adapter_clients(
    tmp_path: Path,
) -> None:
    adapter = discover_adapters(_workspace_root()).adapters["agentbench"]
    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "agentbench"
    ]

    assert adapter.agent_compatibility == ("eliza", "openclaw", "hermes")
    assert _is_harness_compatible(adapter, "eliza") is True
    assert _is_harness_compatible(adapter, "hermes") is True
    assert _is_harness_compatible(adapter, "openclaw") is True

    command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"agent": "hermes", "max_tasks": 1},
    )
    assert "--runtime" in command
    assert command[command.index("--runtime") + 1] == "hermes"


def test_agentbench_score_rejects_zero_task_results() -> None:
    with pytest.raises(ValueError, match="zero-task score"):
        _score_from_agentbench_json(
            {"overall_success_rate": 1.0, "total_tasks": 0, "passed_tasks": 0}
        )
    assert (
        _score_from_agentbench_json(
            {"overall_success_rate": 0.5, "total_tasks": 2, "passed_tasks": 1}
        ).score
        == 0.5
    )


def test_context_and_terminal_scores_reject_zero_task_results() -> None:
    with pytest.raises(ValueError, match="zero-task score"):
        _score_from_contextbench_json(
            {"metrics": {"overall_accuracy": 1.0, "total_tasks": 0}}
        )
    assert (
        _score_from_contextbench_json(
            {"metrics": {"overall_accuracy": 0.5, "total_tasks": 2}}
        ).score
        == 0.5
    )

    with pytest.raises(ValueError, match="zero-task score"):
        _score_from_terminalbench_json(
            {"summary": {"accuracy": 1.0, "total_tasks": 0, "passed_tasks": 0}}
        )
    assert (
        _score_from_terminalbench_json(
            {"summary": {"accuracy": 0.5, "total_tasks": 2, "passed_tasks": 1}}
        ).score
        == 0.5
    )


def test_mind2web_and_visualwebbench_scores_reject_zero_task_results() -> None:
    with pytest.raises(ValueError, match="zero-task score"):
        _score_from_mind2web_json(
            {"overall_step_accuracy": 1.0, "total_tasks": 0}
        )
    assert (
        _score_from_mind2web_json(
            {"overall_step_accuracy": 0.5, "total_tasks": 2}
        ).score
        == 0.5
    )

    with pytest.raises(ValueError, match="zero-task score"):
        _score_from_visualwebbench_json(
            {"overall_accuracy": 1.0, "total_tasks": 0}
        )
    assert (
        _score_from_visualwebbench_json(
            {"overall_accuracy": 0.5, "total_tasks": 2}
        ).score
        == 0.5
    )


def test_rlm_gsm8k_mt_and_scambench_scores_reject_empty_workloads() -> None:
    with pytest.raises(ValueError, match="zero-task score"):
        _score_from_rlmbench_json(
            {"metrics": {"overall_accuracy": 1.0, "total_tasks": 0}, "results": []}
        )
    assert (
        _score_from_rlmbench_json(
            {"metrics": {"overall_accuracy": 0.5, "total_tasks": 2}, "results": [{"id": "t"}]}
        ).score
        == 0.5
    )

    with pytest.raises(ValueError, match="gsm8k:n must be positive"):
        _score_from_gsm8k_json({"metrics": {"score": 1.0, "n": 0}})
    assert _score_from_gsm8k_json({"metrics": {"score": 0.5, "n": 2}}).score == 0.5

    with pytest.raises(ValueError, match="mt_bench:n must be positive"):
        _score_from_mt_bench_json({"metrics": {"score": 1.0, "n": 0}})
    assert _score_from_mt_bench_json({"metrics": {"score": 0.5, "n": 2}}).score == 0.5

    with pytest.raises(ValueError, match="zero-example score"):
        _score_from_scambench_json(
            {"metrics": {"score": 1.0, "n_scam": 0, "n_legit": 0}}
        )
    assert (
        _score_from_scambench_json(
            {"metrics": {"score": 0.5, "n_scam": 1, "n_legit": 1}}
        ).score
        == 0.5
    )


def test_task_sample_and_check_scores_reject_empty_workloads() -> None:
    with pytest.raises(ValueError, match="tau_bench: zero-task score"):
        _score_from_taubench_json({"overall_success_rate": 1.0, "num_tasks": 0})
    assert _score_from_taubench_json({"overall_success_rate": 0.5, "num_tasks": 2}).score == 0.5

    with pytest.raises(ValueError, match="swe_bench: zero-instance score"):
        _score_from_swebench_json(
            {"summary": {"resolve_rate": 1.0, "total_instances": 0}}
        )
    assert (
        _score_from_swebench_json(
            {"summary": {"resolve_rate": 0.5, "total_instances": 2}}
        ).score
        == 0.5
    )

    with pytest.raises(ValueError, match="osworld: zero-task score"):
        _score_from_osworld_json({"overall_success_rate": 1.0, "total_tasks": 0})
    assert (
        _score_from_osworld_json({"overall_success_rate": 0.5, "total_tasks": 2}).score
        == 0.5
    )

    with pytest.raises(ValueError, match="mmau: zero-sample score"):
        _score_from_mmau_json({"overall_accuracy": 1.0, "total_samples": 0})
    with pytest.raises(ValueError, match="all samples errored"):
        _score_from_mmau_json(
            {"overall_accuracy": 0.0, "total_samples": 2, "error_count": 2}
        )
    assert (
        _score_from_mmau_json(
            {"overall_accuracy": 0.5, "total_samples": 2, "error_count": 0}
        ).score
        == 0.5
    )

    with pytest.raises(ValueError, match="trajectory_replay:n must be positive"):
        _score_from_trajectory_replay_json({"metrics": {"score": 1.0, "n": 0}})
    assert (
        _score_from_trajectory_replay_json({"metrics": {"score": 0.5, "n": 2}}).score
        == 0.5
    )

    with pytest.raises(ValueError, match="clawbench: zero-check score"):
        _score_from_clawbench_json({"score": {"score": 1.0, "total_checks": 0}})
    assert (
        _score_from_clawbench_json(
            {"score": {"score": 0.5, "passed": 1, "total_checks": 2}}
        ).score
        == 0.5
    )


def test_mint_routes_all_three_harnesses() -> None:
    adapter = discover_adapters(_workspace_root()).adapters["mint"]

    assert adapter.agent_compatibility == ("eliza", "openclaw", "hermes")
    assert _is_harness_compatible(adapter, "eliza") is True
    assert _is_harness_compatible(adapter, "hermes") is True
    assert _is_harness_compatible(adapter, "openclaw") is True


def test_realm_routes_cross_harness_delegate_client(tmp_path: Path) -> None:
    adapter = discover_adapters(_workspace_root()).adapters["realm"]
    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}["realm"]

    assert adapter.agent_compatibility == ("eliza", "openclaw", "hermes")
    assert _is_harness_compatible(adapter, "eliza") is True
    assert _is_harness_compatible(adapter, "hermes") is True
    assert _is_harness_compatible(adapter, "openclaw") is True

    command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"agent": "openclaw", "max_tasks": 1},
    )
    assert "--provider" in command
    assert command[command.index("--provider") + 1] == "openclaw"


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

    hermes_command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"agent": "hermes"},
    )
    assert hermes_command[hermes_command.index("--providers") + 1] == "hermes"


def test_gaia_registry_uses_env_dataset_path_as_local_jsonl(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "gaia"
    ]
    dataset = tmp_path / "official-gaia.jsonl"
    dataset.write_text("", encoding="utf-8")
    monkeypatch.setenv("GAIA_DATASET_PATH", str(dataset))

    command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"agent": "eliza"},
    )

    assert command[command.index("--dataset") + 1] == "jsonl"
    assert command[command.index("--dataset-path") + 1] == str(dataset)


def test_gaia_registry_env_dataset_path_overrides_default_gaia_source(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "gaia_orchestrated"
    ]
    dataset = tmp_path / "official-gaia.jsonl"
    dataset.write_text("", encoding="utf-8")
    monkeypatch.setenv("GAIA_DATASET_PATH", str(dataset))

    command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"dataset": "gaia", "providers": ["eliza"]},
    )

    assert command[command.index("--dataset") + 1] == "jsonl"
    assert command[command.index("--dataset-path") + 1] == str(dataset)


def test_gaia_orchestrated_registry_forwards_dataset_path(tmp_path: Path) -> None:
    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "gaia_orchestrated"
    ]
    dataset = tmp_path / "official-gaia.jsonl"
    dataset.write_text("", encoding="utf-8")

    command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {
            "dataset": "jsonl",
            "dataset_path": str(dataset),
            "max_questions": 2,
            "providers": ["eliza"],
        },
    )

    assert command[command.index("--dataset") + 1] == "jsonl"
    assert command[command.index("--dataset-path") + 1] == str(dataset)


def test_gaia_and_webshop_registry_route_cross_harnesses(tmp_path: Path) -> None:
    entries = {item.id: item for item in get_benchmark_registry(_workspace_root())}

    gaia_command = entries["gaia"].build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"agent": "openclaw"},
    )
    assert gaia_command[gaia_command.index("--harness") + 1] == "openclaw"

    webshop_command = entries["webshop"].build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"agent": "openclaw"},
    )
    assert "--bridge" in webshop_command
    assert "--mock" not in webshop_command


def test_mint_registry_distinguishes_harness_bridge_from_direct_provider(
    tmp_path: Path,
) -> None:
    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "mint"
    ]

    harness_command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"agent": "eliza"},
    )
    direct_command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {},
    )

    assert harness_command[harness_command.index("--provider") + 1] == "eliza"
    assert direct_command[direct_command.index("--provider") + 1] == "cerebras"
    hermes_command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"agent": "hermes"},
    )
    assert hermes_command[hermes_command.index("--provider") + 1] == "hermes"


def test_realm_registry_smoke_bounds_and_routes_selected_harness(
    tmp_path: Path,
) -> None:
    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "realm"
    ]

    command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {
            "agent": "eliza",
            "categories": ["P11"],
            "max_tasks": 1,
            "max_steps": 3,
            "timeout": 60000,
        },
    )

    assert "--categories" in command
    assert command[command.index("--categories") + 1] == "P11"
    assert "--use-sample-tasks" not in command
    assert command[command.index("--max-tasks") + 1] == "1"
    assert command[command.index("--max-steps") + 1] == "3"
    assert command[command.index("--timeout") + 1] == "60000"
    assert command[command.index("--provider") + 1] == "eliza"
    openclaw_command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"agent": "openclaw", "max_tasks": 1},
    )
    assert openclaw_command[openclaw_command.index("--provider") + 1] == "openclaw"

    sample_command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"agent": "eliza", "max_tasks": 1, "use_sample_tasks": True},
    )
    assert "--use-sample-tasks" in sample_command


def test_registry_adapter_forwards_selected_harness_to_build_command(tmp_path: Path) -> None:
    adapter = discover_adapters(_workspace_root()).adapters["bfcl"]
    effective = _effective_request(
        adapter,
        RunRequest(
            benchmarks=("bfcl",),
            agent="openclaw",
            provider="cerebras",
            model="gpt-oss-120b",
            extra_config={"sample": 1},
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

    assert command[command.index("--provider") + 1] == "openclaw"


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


def test_standard_academic_adapters_default_to_bounded_smoke(tmp_path: Path) -> None:
    adapters = discover_adapters(_workspace_root()).adapters
    expected_limits = {
        "gsm8k": "2",
        "humaneval": "2",
        "mmlu": "2",
        "mt_bench": "1",
    }
    for benchmark_id, expected_limit in expected_limits.items():
        adapter = adapters[benchmark_id]
        effective = _effective_request(
            adapter,
            RunRequest(
                benchmarks=(benchmark_id,),
                agent="eliza",
                provider="cerebras",
                model="gpt-oss-120b",
                extra_config={},
            ),
        )
        ctx = ExecutionContext(
            workspace_root=_workspace_root(),
            benchmarks_root=_workspace_root() / "packages" / "benchmarks",
            output_root=tmp_path / benchmark_id,
            run_root=tmp_path,
            request=effective,
            run_group_id="test",
            env={},
            repo_meta={},
        )

        command = adapter.command_builder(ctx, adapter)

        assert command[command.index("--limit") + 1] == expected_limit
        assert "--max-tokens" in command

    mt_command = adapters["mt_bench"].command_builder(
        ExecutionContext(
            workspace_root=_workspace_root(),
            benchmarks_root=_workspace_root() / "packages" / "benchmarks",
            output_root=tmp_path / "mt",
            run_root=tmp_path,
            request=_effective_request(
                adapters["mt_bench"],
                RunRequest(
                    benchmarks=("mt_bench",),
                    agent="eliza",
                    provider="cerebras",
                    model="gpt-oss-120b",
                    extra_config={},
                ),
            ),
            run_group_id="test",
            env={},
            repo_meta={},
        ),
        adapters["mt_bench"],
    )
    assert mt_command[mt_command.index("--judge-provider") + 1] == "cerebras"
    assert mt_command[mt_command.index("--judge-model") + 1] == "gpt-oss-120b"
    assert mt_command[mt_command.index("--judge-api-key-env") + 1] == "CEREBRAS_API_KEY"
    assert mt_command[mt_command.index("--judge-max-tokens") + 1] == "512"


def test_taubench_adapter_defaults_to_single_real_task(tmp_path: Path) -> None:
    adapter = discover_adapters(_workspace_root()).adapters["tau_bench"]
    effective = _effective_request(
        adapter,
        RunRequest(
            benchmarks=("tau_bench",),
            agent="eliza",
            provider="cerebras",
            model="gpt-oss-120b",
            extra_config={"task_ids": [0], "start_index": 0, "agent_max_turns": 30},
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

    assert command[command.index("--max-tasks-per-domain") + 1] == "1"
    assert "--use-sample-tasks" not in command
    assert command[command.index("--agent-harness") + 1] == "eliza"
    assert command[command.index("--agent-provider") + 1] == "cerebras"
    assert command[command.index("--agent-model") + 1] == "gpt-oss-120b"
    assert command[command.index("--user-provider") + 1] == "cerebras"
    assert command[command.index("--user-model") + 1] == "gpt-oss-120b"
    assert command[command.index("--judge-provider") + 1] == "cerebras"
    assert command[command.index("--judge-model") + 1] == "gpt-oss-120b"
    assert command[command.index("--task-ids") + 1] == "0"
    assert command[command.index("--start-index") + 1] == "0"
    assert command.count("--agent-max-turns") == 1


def test_remaining_smoke_defaults_bound_expensive_adapters(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(orchestrator_adapters, "_has_hyperliquid_live_backend", lambda: True)
    adapters = discover_adapters(_workspace_root()).adapters
    expected_flags = {
        "configbench": ("--limit", "1"),
        "lifeops_bench": ("--limit", "2"),
        "mint": ("--max-tasks", "1"),
        "realm": ("--max-tasks", "1"),
        "bfcl": ("--max-per-category", "1"),
        "hyperliquid_bench": ("--max-steps", "1"),
        "experience": ("--queries", "2"),
        "loca_bench": ("--max-tool-uses", "40"),
    }
    for benchmark_id, (flag, value) in expected_flags.items():
        adapter = adapters[benchmark_id]
        effective = _effective_request(
            adapter,
            RunRequest(
                benchmarks=(benchmark_id,),
                agent=adapter.agent_compatibility[0],
                provider="cerebras",
                model="gpt-oss-120b",
                extra_config={},
            ),
        )
        ctx = ExecutionContext(
            workspace_root=_workspace_root(),
            benchmarks_root=_workspace_root() / "packages" / "benchmarks",
            output_root=tmp_path / benchmark_id,
            run_root=tmp_path,
            request=effective,
            run_group_id="test",
            env={},
            repo_meta={},
        )

        command = adapter.command_builder(ctx, adapter)

        assert command[command.index(flag) + 1] == value

    mint = adapters["mint"]
    effective_mint = _effective_request(
        mint,
        RunRequest(
            benchmarks=("mint",),
            agent="eliza",
            provider="cerebras",
            model="gpt-oss-120b",
            extra_config={},
        ),
    )
    ctx = ExecutionContext(
        workspace_root=_workspace_root(),
        benchmarks_root=_workspace_root() / "packages" / "benchmarks",
        output_root=tmp_path / "mint",
        run_root=tmp_path,
        request=effective_mint,
        run_group_id="test",
        env={},
        repo_meta={},
    )
    mint_command = mint.command_builder(ctx, mint)
    assert "--categories" not in mint_command
    assert mint_command[mint_command.index("--subtasks") + 1] == "gsm8k"
    assert mint_command[mint_command.index("--max-turns") + 1] == "3"
    assert mint_command[mint_command.index("--timeout") + 1] == "60"
    assert "--no-ablation" in mint_command

    woobench = adapters["woobench"]
    effective_woo = _effective_request(
        woobench,
        RunRequest(
            benchmarks=("woobench",),
            agent="openclaw",
            provider="cerebras",
            model="gpt-oss-120b",
            extra_config={},
        ),
    )
    woo_ctx = ExecutionContext(
        workspace_root=_workspace_root(),
        benchmarks_root=_workspace_root() / "packages" / "benchmarks",
        output_root=tmp_path / "woobench",
        run_root=tmp_path,
        request=effective_woo,
        run_group_id="test",
        env={},
        repo_meta={},
    )
    woo_command = woobench.command_builder(woo_ctx, woobench)
    woo_env = woobench.env_builder(woo_ctx, woobench) if woobench.env_builder else {}
    assert woo_command[woo_command.index("--agent") + 1] == "openclaw"
    assert "openclaw-adapter" in woo_env["PYTHONPATH"]
    assert "hermes-adapter" in woo_env["PYTHONPATH"]
    assert "eliza-adapter" in woo_env["PYTHONPATH"]

    benchmark_id = "hyperliquid_bench"
    adapter = adapters[benchmark_id]
    effective_hyperliquid = _effective_request(
        adapter,
        RunRequest(
            benchmarks=(benchmark_id,),
            agent="eliza",
            provider="cerebras",
            model="gpt-oss-120b",
            extra_config={},
        ),
    )
    ctx = ExecutionContext(
        workspace_root=_workspace_root(),
        benchmarks_root=_workspace_root() / "packages" / "benchmarks",
        output_root=tmp_path / benchmark_id,
        run_root=tmp_path,
        request=effective_hyperliquid,
        run_group_id="test",
        env={},
        repo_meta={},
    )
    command = adapter.command_builder(ctx, adapter)
    env = adapter.env_builder(ctx, adapter) if adapter.env_builder else {}
    assert "--no-demo" in command
    assert command[command.index("--max-steps") + 1] == "1"
    assert command[command.index("--max-iterations") + 1] == "2"
    assert env["ELIZA_BENCH_HTTP_TIMEOUT"] == "90.0"
    assert env["HL_BENCH_COMMAND_TIMEOUT_S"] == "60.0"
    assert env["ELIZA_BENCH_FORCE_TOOL_CALL"] == "0"
    assert env["BENCHMARK_MODEL_PROVIDER"] == "cerebras"
    assert env["BENCHMARK_MODEL_NAME"] == "gpt-oss-120b"

    evm = adapters["evm"]
    effective_evm = _effective_request(
        evm,
        RunRequest(
            benchmarks=("evm",),
            agent="openclaw",
            provider="cerebras",
            model="gpt-oss-120b",
            extra_config={},
        ),
    )
    ctx = ExecutionContext(
        workspace_root=_workspace_root(),
        benchmarks_root=_workspace_root() / "packages" / "benchmarks",
        output_root=tmp_path / "evm",
        run_root=tmp_path,
        request=effective_evm,
        run_group_id="test",
        env={},
        repo_meta={},
    )
    env = evm.env_builder(ctx, evm) if evm.env_builder else {}
    assert env["BENCHMARK_HARNESS"] == "openclaw"
    assert env["ELIZA_BENCH_HARNESS"] == "openclaw"
    assert env["BENCHMARK_MODEL_PROVIDER"] == "cerebras"
    assert env["BENCHMARK_MODEL_NAME"] == "gpt-oss-120b"
    assert env["MODEL_NAME"] == "cerebras/gpt-oss-120b"
    assert env["MAX_MESSAGES"] == "2"

    solana = adapters["solana"]
    effective_solana = _effective_request(
        solana,
        RunRequest(
            benchmarks=("solana",),
            agent="eliza",
            provider="cerebras",
            model="gpt-oss-120b",
            extra_config={"max_tasks": 0},
        ),
    )
    ctx = ExecutionContext(
        workspace_root=_workspace_root(),
        benchmarks_root=_workspace_root() / "packages" / "benchmarks",
        output_root=tmp_path / "solana",
        run_root=tmp_path,
        request=effective_solana,
        run_group_id="test",
        env={},
        repo_meta={},
    )
    env = solana.env_builder(ctx, solana) if solana.env_builder else {}
    assert env["MAX_MESSAGES"] == "2"


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


def test_webshop_score_rejects_zero_task_results() -> None:
    with pytest.raises(ValueError, match="zero-task score"):
        _score_from_webshop_json(
            {
                "average_reward": 0.0,
                "success_rate": 0.0,
                "total_tasks": 0,
                "total_trials": 0,
            }
        )


def test_webshop_score_preserves_sample_metadata() -> None:
    score = _score_from_webshop_json(
        {
            "average_reward": 1.0,
            "success_rate": 1.0,
            "total_tasks": 1,
            "total_trials": 1,
            "sample": True,
            "split": "test",
            "profile": "small",
            "use_hf": False,
        }
    )

    assert score.score == 1.0
    assert score.metrics["sample"] is True
    assert score.metrics["split"] == "test"
    assert score.metrics["profile"] == "small"
    assert score.metrics["use_hf"] is False


def test_realm_and_mint_scores_reject_zero_task_results() -> None:
    with pytest.raises(ValueError, match="zero-task score"):
        _score_from_realm_json(
            {
                "metrics": {
                    "overall_success_rate": 0.0,
                    "total_tasks": 0,
                    "passed_tasks": 0,
                }
            }
        )

    with pytest.raises(ValueError, match="zero-task score"):
        _score_from_mint_json(
            {
                "baseline_results": {
                    "metrics": {
                        "overall_success_rate": 0.0,
                        "total_tasks": 0,
                        "passed_tasks": 0,
                    }
                }
            }
        )


def test_realm_score_rejects_sample_task_runs() -> None:
    with pytest.raises(ValueError, match="sample-task run"):
        _score_from_realm_json(
            {
                "metrics": {"overall_success_rate": 1.0, "total_tasks": 2},
                "metadata": {"config": {"use_sample_tasks": True}},
            }
        )

    assert _score_from_realm_json(
        {
            "metrics": {"overall_success_rate": 0.5, "total_tasks": 2},
            "metadata": {"config": {"use_sample_tasks": False}},
        }
    ).score == 0.5


def test_mint_score_uses_best_non_empty_configuration() -> None:
    score = _score_from_mint_json(
        {
            "baseline_results": {
                "metrics": {
                    "overall_success_rate": 0.25,
                    "total_tasks": 4,
                    "passed_tasks": 1,
                }
            },
            "feedback_only_results": {
                "metrics": {
                    "overall_success_rate": 0.75,
                    "total_tasks": 4,
                    "passed_tasks": 3,
                }
            },
            "full_results": {
                "metrics": {
                    "overall_success_rate": 0.5,
                    "total_tasks": 4,
                    "passed_tasks": 2,
                }
            },
        }
    )

    assert score.score == 0.75
    assert score.metrics["best_configuration"] == "feedback"
    assert score.metrics["passed_tasks"] == 3


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


def test_terminal_and_tau_openclaw_env_use_direct_openai_compatible_transport(tmp_path: Path) -> None:
    adapters = discover_adapters(_workspace_root()).adapters
    for benchmark_id in ("terminal_bench", "tau_bench"):
        adapter = adapters[benchmark_id]
        ctx = ExecutionContext(
            workspace_root=_workspace_root(),
            benchmarks_root=_workspace_root() / "packages" / "benchmarks",
            output_root=tmp_path / benchmark_id,
            run_root=tmp_path,
            request=RunRequest(
                benchmarks=(benchmark_id,),
                agent="openclaw",
                provider="cerebras",
                model="gpt-oss-120b",
                extra_config={"agent": "openclaw"},
            ),
            run_group_id="test",
            env={},
            repo_meta={},
        )

        env = adapter.env_builder(ctx, adapter) if adapter.env_builder else {}

        assert env["OPENCLAW_DIRECT_OPENAI_COMPAT"] == "1"
        assert env["OPENCLAW_USE_CLI"] == "0"


def test_registry_adapter_env_uses_normalized_cerebras_model_alias(tmp_path: Path) -> None:
    adapter = discover_adapters(_workspace_root()).adapters["bfcl"]
    ctx = ExecutionContext(
        workspace_root=_workspace_root(),
        benchmarks_root=_workspace_root() / "packages" / "benchmarks",
        output_root=tmp_path / "out",
        run_root=tmp_path,
        request=RunRequest(
            benchmarks=("bfcl",),
            agent="hermes",
            provider="cerebras",
            model="openai/gpt-oss-120b",
            extra_config={"agent": "hermes", "sample": 1},
        ),
        run_group_id="test",
        env={},
        repo_meta={},
    )

    env = adapter.env_builder(ctx, adapter) if adapter.env_builder else {}

    assert env["BENCHMARK_MODEL_NAME"] == "gpt-oss-120b"
    assert env["MODEL_NAME"] == "gpt-oss-120b"


def test_openclaw_registry_command_and_result_locator(tmp_path: Path) -> None:
    registry = {entry.id: entry for entry in get_benchmark_registry(_workspace_root())}
    entry = registry["openclaw_bench"]

    command = entry.build_command(tmp_path, ModelSpec(provider="groq", model="kimi-k2"), {})
    assert "--output-dir" in command
    assert str(tmp_path) in command
    assert command[command.index("--mode") + 1] == "execution"
    assert command[command.index("--model") + 1] == "kimi-k2"

    result_path = tmp_path / "openclaw_setup_exec_123.json"
    result_path.write_text(
        json.dumps(
            {
                "score": {"score": 0.5},
                "harness": "openclaw",
                "real_validation": {
                    "mode": "execution",
                    "scoring": "file_command_and_test_execution",
                    "conceptual_scoring": False,
                },
            }
        ),
        encoding="utf-8",
    )
    assert entry.locate_result(tmp_path) == result_path

    score = entry.extract_score(
        {
            "score": {"score": 0.5},
            "harness": "openclaw",
            "real_validation": {
                "mode": "execution",
                "scoring": "file_command_and_test_execution",
                "conceptual_scoring": False,
            },
        }
    )
    assert score.score == 0.5
    assert score.metrics["tasks_completed"] == 1
    assert score.metrics["harness"] == "openclaw"

    conceptual_path = tmp_path / "openclaw_setup_concept_124.json"
    conceptual_path.write_text(
        '{"mode":"conceptual","score":{"score":1.0}}',
        encoding="utf-8",
    )
    assert entry.locate_result(tmp_path) == result_path
    with pytest.raises(ValueError, match="conceptual result"):
        entry.extract_score({"mode": "conceptual", "score": {"score": 1.0}})


def test_clawbench_registry_routes_selected_harness_to_multi_harness_runner(
    tmp_path: Path,
) -> None:
    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "clawbench"
    ]

    command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"agent": "openclaw", "scenario": "inbox_triage"},
    )

    assert command[command.index("-m") + 1] == "clawbench.multi_harness_runner"
    assert command[command.index("--harness") + 1] == "openclaw"
    assert command[command.index("--model") + 1] == "gpt-oss-120b"
    assert command[command.index("--output") + 1] == str(
        tmp_path / "trajectory_inbox_triage.json"
    )


def test_clawbench_runner_prefers_shared_eliza_adapter_package(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.syspath_prepend(str(_workspace_root() / "benchmarks" / "clawbench"))
    import clawbench.multi_harness_runner as runner

    legacy = types.ModuleType("eliza_adapter")
    legacy.__file__ = str(_workspace_root() / "benchmarks" / "clawbench" / "eliza_adapter.py")
    monkeypatch.setitem(sys.modules, "eliza_adapter", legacy)

    runner._prepend_adapter_package("eliza-adapter")
    imported = importlib.import_module("eliza_adapter")

    assert "benchmarks/eliza-adapter/eliza_adapter" in str(imported.__file__)


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
    assert command[command.index("--method") + 1] == (
        "eliza_compactbench/compactors/__init__.py:HybridLedgerCompactor"
    )
    assert adapter.agent_compatibility == ("eliza", "openclaw", "hermes")


def test_compactbench_python_falls_back_when_local_python_lacks_dependencies(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    compactbench_root = tmp_path / "compactbench"
    venv_bin = compactbench_root / ".venv" / "bin"
    venv_bin.mkdir(parents=True)
    local_python = venv_bin / "python"
    local_python.write_text("#!/bin/sh\n", encoding="utf-8")

    good_python = tmp_path / "conda-python"
    good_python.write_text("#!/bin/sh\n", encoding="utf-8")
    monkeypatch.setattr(orchestrator_adapters.sys, "executable", "/broken/sys-python")
    monkeypatch.setattr(
        orchestrator_adapters.shutil,
        "which",
        lambda name: str(good_python) if name == "python" else None,
    )
    monkeypatch.setattr(
        orchestrator_adapters,
        "_python_can_import",
        lambda candidate, module: candidate == str(good_python)
        and module == "ruamel.yaml",
    )

    assert orchestrator_adapters._compactbench_python_executable(
        compactbench_root
    ) == str(good_python)


def test_compactbench_hermes_adapter_uses_native_tool_compactor(
    tmp_path: Path,
) -> None:
    adapters = discover_adapters(_workspace_root()).adapters
    adapter = adapters["compactbench"]
    ctx = ExecutionContext(
        workspace_root=_workspace_root(),
        benchmarks_root=_workspace_root() / "packages" / "benchmarks",
        output_root=tmp_path / "out",
        run_root=tmp_path,
        request=RunRequest(
            benchmarks=("compactbench",),
            agent="hermes",
            provider="cerebras",
            model="gpt-oss-120b",
            extra_config={"case_count": 1, "drift_cycles": 1},
        ),
        run_group_id="test",
        env={},
        repo_meta={},
    )

    command = adapter.command_builder(ctx, adapter)
    env = adapter.env_builder(ctx, adapter) if adapter.env_builder else {}

    assert command[command.index("--method") + 1] == (
        "hermes_compactbench/compactors.py:HermesNativeToolCompactor"
    )
    assert "--analyze-valid-hits" in command
    assert env["HERMES_BENCH_PROVIDER"] == "cerebras"


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


def test_woobench_orchestrator_explicit_scenario_overrides_default_list(tmp_path: Path) -> None:
    adapters = discover_adapters(_workspace_root()).adapters
    adapter = adapters["woobench"]
    extra = dict(adapter.default_extra_config)
    extra.update({"scenario": "friend_supporter_tarot_01", "evaluator": "llm"})
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
            extra_config=extra,
        ),
        run_group_id="test",
        env={},
        repo_meta={},
    )

    command = adapter.command_builder(ctx, adapter)

    assert "--scenarios" not in command
    assert command[command.index("--scenario") + 1] == "friend_supporter_tarot_01"
    assert command[command.index("--evaluator") + 1] == "llm"


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


def test_vending_score_rejects_zero_successful_runs() -> None:
    with pytest.raises(ValueError, match="zero successful runs"):
        _score_from_vendingbench_json(
            {
                "metadata": {"total_runs": 1, "successful_runs": 0},
                "metrics": {"avg_net_worth": "0"},
                "results": [
                    {
                        "run_id": "run_001",
                        "simulation_days": 0,
                        "final_net_worth": "0",
                        "error": "Remote end closed connection without response",
                    }
                ],
            }
        )


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


def test_compare_label_runs_multi_harness_compactbench() -> None:
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

    assert adapter.agent_compatibility == ("eliza", "openclaw", "hermes")
    assert effective.agent == "compare"
    assert _is_harness_compatible(adapter, "compare") is True


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


def test_adhdbench_adapter_defaults_to_bounded_quick_smoke(tmp_path: Path) -> None:
    adapter = discover_adapters(_workspace_root()).adapters["adhdbench"]
    effective = _effective_request(
        adapter,
        RunRequest(
            benchmarks=("adhdbench",),
            agent="eliza",
            provider="cerebras",
            model="gpt-oss-120b",
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
    assert command[command.index("--ids") + 1] == "L0-002"


def test_loca_adapter_enables_openclaw_direct_openai_tool_path(tmp_path: Path) -> None:
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

    assert adapter.agent_compatibility == ("eliza", "openclaw", "hermes")
    assert _is_harness_compatible(adapter, "eliza") is True
    assert _is_harness_compatible(adapter, "hermes") is True
    assert _is_harness_compatible(adapter, "openclaw") is True
    assert "--allow-empty" not in command
    assert command[command.index("--max-context-size") + 1] == "1000000"
    assert command[command.index("--reset-size") + 1] == "500000"
    assert command[command.index("--reasoning-effort") + 1] == "low"
    assert env["MAX_CONVERSATION_TOKENS"] == "1000000"
    assert env["LOCA_HARNESS_TIMEOUT_S"] == "115"
    assert env["LOCA_OPENCLAW_THINKING"] == "low"
    assert env["LOCA_OPENCLAW_MODE"] == "direct-openai-compatible"
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


def test_public_score_extractors_reject_zero_sample_artifacts() -> None:
    entries = {item.id: item for item in get_benchmark_registry(_workspace_root())}

    zero_sample_payloads = {
        "abliteration-robustness": {
            "metrics": {"score": 0.0, "refusal_rate": 0.0, "n": 0, "n_refused": 0}
        },
        "gaia_orchestrated": {
            "metrics": {
                "overall_accuracy": 0.0,
                "total_questions": 0,
                "correct_answers": 0,
            }
        },
        "humaneval": {"metrics": {"score": 0.0, "pass@1": 0.0, "passed": 0, "n": 0}},
        "lifeops_bench": {
            "pass_at_1": 0.0,
            "pass_at_k": 0.0,
            "seeds": 1,
            "scenarios": [],
        },
        "mmlu": {"metrics": {"score": 0.0, "accuracy": 0.0, "correct": 0, "n": 0}},
    }

    for benchmark_id, payload in zero_sample_payloads.items():
        with pytest.raises(ValueError):
            entries[benchmark_id].extract_score(payload)


def test_public_score_extractors_allow_true_zero_scores_with_samples() -> None:
    entries = {item.id: item for item in get_benchmark_registry(_workspace_root())}

    scored_payloads = {
        "abliteration-robustness": {
            "metrics": {"score": 0.0, "refusal_rate": 1.0, "n": 2, "n_refused": 2}
        },
        "gaia_orchestrated": {
            "metrics": {
                "overall_accuracy": 0.0,
                "total_questions": 2,
                "correct_answers": 0,
            }
        },
        "humaneval": {"metrics": {"score": 0.0, "pass@1": 0.0, "passed": 0, "n": 2}},
        "lifeops_bench": {
            "pass_at_1": 0.0,
            "pass_at_k": 0.0,
            "seeds": 1,
            "scenarios": [{"scenario_id": "smoke_static_calendar_01"}],
        },
        "mmlu": {"metrics": {"score": 0.0, "accuracy": 0.0, "correct": 0, "n": 2}},
    }

    for benchmark_id, payload in scored_payloads.items():
        score = entries[benchmark_id].extract_score(payload)
        assert score.score == 0.0


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


def test_action_calling_cli_accepts_tool_choice_none() -> None:
    module = importlib.import_module("benchmarks.action-calling.cli")
    parser = module._build_argparser()

    args = parser.parse_args(
        [
            "--model",
            "gpt-oss-120b",
            "--out",
            "/tmp/action-calling",
            "--tool-choice",
            "none",
        ]
    )

    assert args.tool_choice == "none"


def test_clawbench_runner_extracts_native_tool_call_args() -> None:
    clawbench_root = _workspace_root() / "benchmarks" / "clawbench"
    sys.path.insert(0, str(clawbench_root))
    module_path = _workspace_root() / "benchmarks" / "clawbench" / "eliza_adapter.py"
    spec = importlib.util.spec_from_file_location("clawbench_eliza_adapter_test", module_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    finally:
        with contextlib.suppress(ValueError):
            sys.path.remove(str(clawbench_root))

    response = type(
        "Response",
        (),
        {
            "actions": ["MAIL.send"],
            "params": {
                "MAIL.send": {},
                "tool_calls": [
                    {
                        "name": "MAIL.send",
                        "arguments": {"to_emails": ["x@example.com"]},
                    }
                ],
            },
        },
    )()

    assert module._extract_response_tool_calls(response) == [
        {"tool": "MAIL.send", "args": {"to_emails": ["x@example.com"]}}
    ]


def test_action_calling_registry_command_uses_requested_harness_provider(tmp_path: Path) -> None:
    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "action-calling"
    ]

    hermes_command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"agent": "hermes", "max_examples": 1},
    )
    openclaw_command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"agent": "openclaw", "max_examples": 1},
    )

    assert hermes_command[hermes_command.index("--provider") + 1] == "hermes"
    assert openclaw_command[openclaw_command.index("--provider") + 1] == "openclaw"


def test_action_calling_registry_mock_mode_wins_over_harness(tmp_path: Path) -> None:
    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "action-calling"
    ]

    command = entry.build_command(
        tmp_path,
        ModelSpec(provider="mock", model="mock"),
        {"agent": "openclaw", "mock": True, "max_examples": 1},
    )

    assert command[command.index("--provider") + 1] == "mock"


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


def test_terminalbench_no_docker_uses_local_sandbox_not_dry_run(tmp_path: Path) -> None:
    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "terminal_bench"
    ]

    command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"agent": "eliza", "no_docker": True, "max_tasks": 1},
    )

    assert "--local-sandbox" in command
    assert "--dry-run" not in command
    assert "--model-provider" not in command
    assert command[command.index("--model") + 1] == "gpt-oss-120b"


def test_terminalbench_default_allows_real_corpus_test_bootstrap(tmp_path: Path) -> None:
    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "terminal_bench"
    ]
    adapter = discover_adapters(_workspace_root()).adapters["terminal_bench"]

    request = _effective_request(
        adapter,
        RunRequest(
            benchmarks=["terminal_bench"],
            agent="eliza",
            provider="cerebras",
            model="gpt-oss-120b",
            extra_config={},
        ),
    )
    command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        request.extra_config,
    )

    assert request.extra_config["network_mode"] == "bridge"
    assert request.extra_config["max_tasks"] == 2
    assert request.extra_config["task_ids"] == ["hello-world", "classifier-debug"]
    assert command[command.index("--network-mode") + 1] == "bridge"
    assert command[command.index("--task-ids") + 1] == "hello-world"
    assert command[command.index("--task-ids") + 2] == "classifier-debug"


def test_terminalbench_forwards_task_ids_and_single(tmp_path: Path) -> None:
    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "terminal_bench"
    ]

    command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {
            "agent": "hermes",
            "task_ids": ["png-generation", "jsonl-aggregator"],
            "single": "assign-seats",
        },
    )

    assert command[command.index("--task-ids") + 1 : command.index("--task-ids") + 3] == [
        "png-generation",
        "jsonl-aggregator",
    ]
    assert command[command.index("--single") + 1] == "assign-seats"


def test_terminalbench_requires_reachable_docker_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        orchestrator_adapters,
        "_has_terminal_bench_docker_backend",
        lambda: False,
    )

    adapter = discover_adapters(_workspace_root()).adapters["terminal_bench"]

    assert adapter.agent_compatibility == ()
    for harness in ("eliza", "hermes", "openclaw"):
        assert _is_harness_compatible(adapter, harness) is False


def test_terminalbench_score_rejects_docker_unavailable_results() -> None:
    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "terminal_bench"
    ]

    with pytest.raises(ValueError, match="Docker-unavailable"):
        entry.extract_score(
            {
                "summary": {
                    "accuracy": 0.0,
                    "total_tasks": 2,
                    "passed_tasks": 0,
                    "failed_tasks": 2,
                },
                "results": [
                    {
                        "task_id": "hello-world",
                        "success": False,
                        "error_message": "Docker daemon is not reachable.",
                    },
                    {
                        "task_id": "classifier-debug",
                        "success": False,
                        "error_message": "Docker daemon is not reachable.",
                    },
                ],
            }
        )


def test_evm_primary_score_is_normalized_ratio(tmp_path: Path) -> None:
    result_path = tmp_path / "evm_metrics.json"
    result_path.write_text(
        json.dumps(
            {
                "final_reward": 8,
                "max_reward": 16,
                "final_contracts": 4,
                "model": "test",
                "run_id": "r1",
                "chain": "general",
            }
        ),
        encoding="utf-8",
    )

    score = orchestrator_adapters._score_from_evm(result_path)

    assert score.score == 0.5
    assert score.unit == "ratio"
    assert score.metrics["final_reward"] == 8
    assert score.metrics["max_reward"] == 16
    assert score.metrics["raw_unit"] == "unique_selectors"


def test_swe_registry_forwards_harness_and_bare_cerebras_model(
    tmp_path: Path,
) -> None:
    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "swe_bench"
    ]

    command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"agent": "openclaw", "no_docker": True, "max_instances": 1},
    )

    assert command[command.index("--harness") + 1] == "openclaw"
    assert command[command.index("--provider") + 1] == "cerebras"
    assert command[command.index("--model") + 1] == "gpt-oss-120b"


def test_swe_orchestrated_registry_forwards_harness_and_bare_cerebras_model(
    tmp_path: Path,
) -> None:
    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "swe_bench_orchestrated"
    ]

    command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"agent": "hermes", "no_docker": True, "max_instances": 1},
    )

    assert command[command.index("--harness") + 1] == "hermes"
    assert command[command.index("--provider") + 1] == "cerebras"
    assert command[command.index("--model") + 1] == "gpt-oss-120b"
    assert command[command.index("--providers") + 1] == "hermes"


def test_visualwebbench_registry_forwards_mock_mode(tmp_path: Path) -> None:
    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "visualwebbench"
    ]

    command = entry.build_command(
        tmp_path,
        ModelSpec(provider="mock", model="gpt-oss-120b"),
        {"agent": "eliza", "mock": True, "max_tasks": 1},
    )

    assert "--mock" in command
    assert "--provider" not in command
    assert "--use-sample-tasks" in command
    assert "--fixture" not in command
    assert command[command.index("--model") + 1] == "gpt-oss-120b"


def test_vision_language_registry_uses_real_runtime_unless_smoke_stub_is_explicit(
    tmp_path: Path,
) -> None:
    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "vision_language"
    ]

    command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"sub_benchmark": "screenspot", "samples": 3},
    )

    assert command[:3] == ["bun", "run", "src/runner.ts"]
    assert "--smoke" not in command
    assert "--stub" not in command
    assert command[command.index("--tier") + 1] == "eliza-1-9b"
    assert command[command.index("--benchmark") + 1] == "screenspot"
    assert command[command.index("--samples") + 1] == "3"
    assert command[command.index("--harness") + 1] == "eliza"
    assert command[command.index("--model-provider") + 1] == "cerebras"
    assert command[command.index("--model") + 1] == "gpt-oss-120b"
    assert command[command.index("--output") + 1] == str(
        tmp_path / "vision-language-results.json"
    )

    smoke_command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"sub_benchmark": "screenspot", "samples": 3, "smoke": True, "stub": True},
    )
    assert "--smoke" in smoke_command
    assert "--stub" in smoke_command


def test_vision_language_score_rejects_smoke_and_stub_reports() -> None:
    real_payload = {
        "schemaVersion": "vision-language-bench-v1",
        "tier": "eliza-1-9b",
        "runtime_id": "eliza-1-9b",
        "smoke": False,
        "benchmark": "screenspot",
        "sample_count": 2,
        "score": 0.5,
        "baseline_score": 0.876,
        "delta": -0.376,
        "runtime_seconds": 1.0,
        "error_count": 0,
        "samples": [],
    }
    assert _score_from_vision_language_json(real_payload).score == 0.5

    smoke_payload = dict(real_payload)
    smoke_payload["smoke"] = True
    with pytest.raises(ValueError, match="smoke report"):
        _score_from_vision_language_json(smoke_payload)

    stub_payload = dict(real_payload)
    stub_payload["runtime_id"] = "eliza-1-9b-stub"
    with pytest.raises(ValueError, match="stub runtime"):
        _score_from_vision_language_json(stub_payload)


def test_vision_language_harness_runtime_requires_multimodal_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VISION_LANGUAGE_PROVIDER", "cerebras")
    monkeypatch.setenv("VISION_LANGUAGE_MODEL", "gpt-oss-120b")
    monkeypatch.setenv("CEREBRAS_API_KEY", "test-key")
    monkeypatch.delenv("VISION_LANGUAGE_MULTIMODAL", raising=False)

    assert orchestrator_adapters._has_vision_language_harness_runtime() is False

    monkeypatch.setenv("VISION_LANGUAGE_PROVIDER", "openai")
    monkeypatch.setenv("VISION_LANGUAGE_MODEL", "gpt-4o-mini")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")

    assert orchestrator_adapters._has_vision_language_harness_runtime() is True

    monkeypatch.setenv("VISION_LANGUAGE_PROVIDER", "local-eliza")
    monkeypatch.setenv("VISION_LANGUAGE_MODEL", "eliza-1-9b")
    monkeypatch.setattr(
        orchestrator_adapters, "_has_vision_language_real_inputs", lambda: True
    )

    assert orchestrator_adapters._has_vision_language_harness_runtime() is True


def test_vision_language_local_eliza_runtime_must_be_explicit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("VISION_LANGUAGE_PROVIDER", raising=False)
    monkeypatch.delenv("VISION_LANGUAGE_USE_LOCAL_ELIZA", raising=False)
    monkeypatch.setattr(orchestrator_adapters, "_has_vision_language_bundle", lambda _tier: True)
    monkeypatch.setattr(orchestrator_adapters, "_has_textvqa_real_inputs", lambda: True)

    assert orchestrator_adapters._has_vision_language_real_inputs() is False

    monkeypatch.setenv("VISION_LANGUAGE_PROVIDER", "local-eliza")

    assert orchestrator_adapters._has_vision_language_real_inputs() is True


def test_vision_language_bundle_accepts_current_manifest_schema(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bundle = (
        tmp_path
        / ".eliza"
        / "local-inference"
        / "models"
        / "eliza-1-9b.bundle"
    )
    (bundle / "text").mkdir(parents=True)
    (bundle / "vision").mkdir()
    (bundle / "dflash").mkdir()
    (bundle / "text" / "eliza-1-9b-128k.gguf").write_text("text", encoding="utf-8")
    (bundle / "vision" / "mmproj-9b.gguf").write_text("vision", encoding="utf-8")
    (bundle / "dflash" / "drafter-9b.gguf").write_text("dflash", encoding="utf-8")
    (bundle / "eliza-1.manifest.json").write_text(
        json.dumps(
            {
                "id": "eliza-1-9b",
                "runtime": {"dflash": {"enabled": True}},
                "kernels": {"required": ["dflash"]},
                "files": {
                    "dflash": [{"path": "dflash/drafter-9b.gguf"}],
                    "text": [{"path": "text/eliza-1-9b-128k.gguf"}],
                    "vision": [{"path": "vision/mmproj-9b.gguf"}],
                },
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("ELIZA_STATE_DIR", str(tmp_path / ".eliza"))

    assert orchestrator_adapters._has_vision_language_bundle("eliza-1-9b") is True


def test_vision_language_bundle_rejects_manifest_without_dflash(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bundle = (
        tmp_path
        / ".eliza"
        / "local-inference"
        / "models"
        / "eliza-1-9b.bundle"
    )
    (bundle / "text").mkdir(parents=True)
    (bundle / "vision").mkdir()
    (bundle / "text" / "eliza-1-9b-128k.gguf").write_text("text", encoding="utf-8")
    (bundle / "vision" / "mmproj-9b.gguf").write_text("vision", encoding="utf-8")
    (bundle / "eliza-1.manifest.json").write_text(
        json.dumps(
            {
                "id": "eliza-1-9b",
                "kernels": {"required": ["metal"]},
                "files": {},
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("ELIZA_STATE_DIR", str(tmp_path / ".eliza"))

    assert orchestrator_adapters._has_vision_language_bundle("eliza-1-9b") is False


def test_rlm_registry_forwards_model_to_root_and_subcall(tmp_path: Path) -> None:
    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "rlm_bench"
    ]

    command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"mode": "eliza", "no_oolong": True},
    )

    assert command[command.index("--root-model") + 1] == "gpt-oss-120b"
    assert command[command.index("--subcall-model") + 1] == "gpt-oss-120b"


def test_rlm_score_rejects_all_runtime_errors() -> None:
    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "rlm_bench"
    ]

    with pytest.raises(ValueError, match="all tasks failed with runtime errors"):
        entry.extract_score(
            {
                "metrics": {
                    "overall_accuracy": 0.0,
                    "total_tasks": 2,
                    "passed_tasks": 0,
                },
                "results": [
                    {"task_id": "a", "error": "provider failed"},
                    {"task_id": "b", "error": "provider failed"},
                ],
            }
        )


def test_woobench_registry_forwards_scenario_list(tmp_path: Path) -> None:
    entry = {item.id: item for item in get_benchmark_registry(_workspace_root())}[
        "woobench"
    ]

    command = entry.build_command(
        tmp_path,
        ModelSpec(provider="cerebras", model="gpt-oss-120b"),
        {"scenarios": ["friend_supporter_tarot_01", "repeat_customer_tarot_01"]},
    )

    assert command[command.index("--scenarios") + 1] == (
        "friend_supporter_tarot_01,repeat_customer_tarot_01"
    )


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


def test_abliteration_orchestrator_default_is_bounded_smoke(tmp_path: Path) -> None:
    adapter = discover_adapters(_workspace_root()).adapters["abliteration-robustness"]
    effective = _effective_request(
        adapter,
        RunRequest(
            benchmarks=("abliteration-robustness",),
            agent="eliza",
            provider="cerebras",
            model="gpt-oss-120b",
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

    assert command[command.index("--max-examples") + 1] == "2"
    assert command[command.index("--max-new-tokens") + 1] == "128"
    assert command[command.index("--tool-choice") + 1] == "none"


def test_action_calling_orchestrator_default_is_bounded_smoke(tmp_path: Path) -> None:
    adapter = discover_adapters(_workspace_root()).adapters["action-calling"]
    effective = _effective_request(
        adapter,
        RunRequest(
            benchmarks=("action-calling",),
            agent="eliza",
            provider="cerebras",
            model="gpt-oss-120b",
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

    assert command[command.index("--max-examples") + 1] == "2"
    assert command[command.index("--max-new-tokens") + 1] == "512"


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


def test_loca_score_treats_all_error_tasks_as_zero(tmp_path: Path) -> None:
    audit = tmp_path / "eliza_loca_audit.json"
    audit.write_text(
        json.dumps(
            {
                "summary": {
                    "avg_accuracy": None,
                    "issue_count": 0,
                    "trajectory_count": 1,
                    "aggregate_trajectory_count": 1,
                    "metadata_total_tasks": 1,
                    "failed_trajectory_count": 1,
                    "total_api_tokens": 120,
                }
            }
        ),
        encoding="utf-8",
    )

    summary = _score_from_loca_bench(audit)

    assert summary.score == 0.0
    assert summary.metrics["failed_trajectory_count"] == 1


def test_loca_score_accepts_external_telemetry_for_error_tasks(tmp_path: Path) -> None:
    output_root = tmp_path / "output"
    loca_output = output_root / "loca-output"
    loca_output.mkdir(parents=True)
    (output_root / "telemetry.jsonl").write_text(
        json.dumps({"total_tokens": 42}) + "\n",
        encoding="utf-8",
    )
    audit = loca_output / "eliza_loca_audit.json"
    audit.write_text(
        json.dumps(
            {
                "summary": {
                    "avg_accuracy": None,
                    "issue_count": 0,
                    "trajectory_count": 1,
                    "aggregate_trajectory_count": 1,
                    "metadata_total_tasks": 1,
                    "failed_trajectory_count": 1,
                    "total_api_tokens": 0,
                }
            }
        ),
        encoding="utf-8",
    )

    summary = _score_from_loca_bench(audit)

    assert summary.score == 0.0
    assert summary.metrics["total_api_tokens"] == 42
    assert summary.metrics["external_telemetry_tokens"] == 42


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
