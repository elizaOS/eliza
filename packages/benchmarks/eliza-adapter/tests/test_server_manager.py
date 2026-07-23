from __future__ import annotations

from pathlib import Path

from eliza_adapter.server_manager import (
    ElizaServerManager,
    _normalize_model_env,
    _server_command,
)


def _stub_node_resolution(monkeypatch) -> None:
    monkeypatch.setattr("eliza_adapter.server_manager._resolve_node", lambda: "node")
    monkeypatch.setattr("eliza_adapter.server_manager._node_major", lambda _node: 24)


class _FakeProcess:
    pid = 999999

    def poll(self):
        return None


def test_server_manager_does_not_default_stub_embedding_env(
    monkeypatch,
    tmp_path: Path,
) -> None:
    server = tmp_path / "packages" / "app-core" / "src" / "benchmark" / "server.ts"
    server.parent.mkdir(parents=True)
    server.write_text("console.log('fake benchmark server')\n", encoding="utf-8")
    captured = {}

    def fake_popen(*args, **kwargs):
        captured["args"] = args
        captured["kwargs"] = kwargs
        return _FakeProcess()

    manager = ElizaServerManager(repo_root=tmp_path, port=0)
    monkeypatch.setattr(manager.client, "is_ready", lambda: True)
    monkeypatch.setattr(manager.client, "health", lambda **_kwargs: {"status": "ready"})
    monkeypatch.setattr(manager.client, "reset", lambda *args, **kwargs: None)
    monkeypatch.setattr("eliza_adapter.server_manager.subprocess.Popen", fake_popen)
    _stub_node_resolution(monkeypatch)
    monkeypatch.delenv("ELIZA_BENCH_ALLOW_STUB_EMBEDDING", raising=False)

    manager.start()
    manager._proc = None

    assert "ELIZA_BENCH_ALLOW_STUB_EMBEDDING" not in captured["kwargs"]["env"]


def test_server_manager_does_not_default_stub_embedding_for_benchmark_harness(
    monkeypatch,
    tmp_path: Path,
) -> None:
    server = tmp_path / "packages" / "app-core" / "src" / "benchmark" / "server.ts"
    server.parent.mkdir(parents=True)
    server.write_text("console.log('fake benchmark server')\n", encoding="utf-8")
    captured = {}

    def fake_popen(*args, **kwargs):
        captured["kwargs"] = kwargs
        return _FakeProcess()

    manager = ElizaServerManager(repo_root=tmp_path, port=0)
    monkeypatch.setattr(manager.client, "is_ready", lambda: True)
    monkeypatch.setattr(manager.client, "health", lambda **_kwargs: {"status": "ready"})
    monkeypatch.setattr(manager.client, "reset", lambda *args, **kwargs: None)
    monkeypatch.setattr("eliza_adapter.server_manager.subprocess.Popen", fake_popen)
    _stub_node_resolution(monkeypatch)
    monkeypatch.delenv("ELIZA_BENCH_ALLOW_STUB_EMBEDDING", raising=False)
    monkeypatch.setenv("BENCHMARK_HARNESS", "eliza")

    manager.start()
    manager._proc = None

    assert "ELIZA_BENCH_ALLOW_STUB_EMBEDDING" not in captured["kwargs"]["env"]


def test_server_manager_uses_ephemeral_port_by_default(
    monkeypatch, tmp_path: Path
) -> None:
    server = tmp_path / "packages" / "app-core" / "src" / "benchmark" / "server.ts"
    server.parent.mkdir(parents=True)
    server.write_text("console.log('fake benchmark server')\n", encoding="utf-8")
    captured = {}

    def fake_popen(*args, **kwargs):
        captured["kwargs"] = kwargs
        return _FakeProcess()

    monkeypatch.setattr("eliza_adapter.server_manager._find_free_port", lambda: 45678)
    monkeypatch.delenv("ELIZA_BENCH_PORT", raising=False)
    manager = ElizaServerManager(repo_root=tmp_path)
    monkeypatch.setattr(manager.client, "is_ready", lambda: True)
    monkeypatch.setattr(manager.client, "health", lambda **_kwargs: {"status": "ready"})
    monkeypatch.setattr(manager.client, "reset", lambda *args, **kwargs: None)
    monkeypatch.setattr("eliza_adapter.server_manager.subprocess.Popen", fake_popen)
    _stub_node_resolution(monkeypatch)

    manager.start()
    manager._proc = None

    assert manager.port == 45678
    assert captured["kwargs"]["env"]["ELIZA_BENCH_PORT"] == "45678"


def test_server_manager_pins_tsx_to_executable_workspace_sources(
    monkeypatch, tmp_path: Path
) -> None:
    server = tmp_path / "packages" / "lifeops-bench" / "src" / "server.ts"
    server.parent.mkdir(parents=True)
    server.write_text("console.log('fake benchmark server')\n", encoding="utf-8")
    (tmp_path / "tsconfig.json").write_text("{}\n", encoding="utf-8")
    captured = {}

    def fake_popen(*args, **kwargs):
        captured["kwargs"] = kwargs
        return _FakeProcess()

    manager = ElizaServerManager(repo_root=tmp_path, port=0)
    monkeypatch.setattr(manager.client, "is_ready", lambda: True)
    monkeypatch.setattr(manager.client, "health", lambda **_kwargs: {"status": "ready"})
    monkeypatch.setattr(manager.client, "reset", lambda *args, **kwargs: None)
    monkeypatch.setattr("eliza_adapter.server_manager.subprocess.Popen", fake_popen)
    _stub_node_resolution(monkeypatch)
    monkeypatch.setenv("TSX_TSCONFIG_PATH", "/tmp/declaration-only-tsconfig.json")

    manager.start()
    manager._proc = None

    assert captured["kwargs"]["env"]["TSX_TSCONFIG_PATH"] == str(
        tmp_path / "tsconfig.json"
    )


def test_server_manager_respects_explicit_stub_embedding_override(
    monkeypatch,
    tmp_path: Path,
) -> None:
    server = tmp_path / "packages" / "app-core" / "src" / "benchmark" / "server.ts"
    server.parent.mkdir(parents=True)
    server.write_text("console.log('fake benchmark server')\n", encoding="utf-8")
    captured = {}

    def fake_popen(*args, **kwargs):
        captured["kwargs"] = kwargs
        return _FakeProcess()

    manager = ElizaServerManager(repo_root=tmp_path, port=0)
    monkeypatch.setattr(manager.client, "is_ready", lambda: True)
    monkeypatch.setattr(manager.client, "health", lambda **_kwargs: {"status": "ready"})
    monkeypatch.setattr(manager.client, "reset", lambda *args, **kwargs: None)
    monkeypatch.setattr("eliza_adapter.server_manager.subprocess.Popen", fake_popen)
    _stub_node_resolution(monkeypatch)
    monkeypatch.setenv("ELIZA_BENCH_ALLOW_STUB_EMBEDDING", "0")

    manager.start()
    manager._proc = None

    assert captured["kwargs"]["env"]["ELIZA_BENCH_ALLOW_STUB_EMBEDDING"] == "0"


def test_server_manager_maps_cerebras_env_to_openai_compatible_settings(
    monkeypatch,
    tmp_path: Path,
) -> None:
    server = tmp_path / "packages" / "app-core" / "src" / "benchmark" / "server.ts"
    server.parent.mkdir(parents=True)
    server.write_text("console.log('fake benchmark server')\n", encoding="utf-8")
    captured = {}

    def fake_popen(*args, **kwargs):
        captured["kwargs"] = kwargs
        return _FakeProcess()

    manager = ElizaServerManager(repo_root=tmp_path, port=0)
    monkeypatch.setattr(manager.client, "is_ready", lambda: True)
    monkeypatch.setattr(manager.client, "health", lambda **_kwargs: {"status": "ready"})
    monkeypatch.setattr(manager.client, "reset", lambda *args, **kwargs: None)
    monkeypatch.setattr("eliza_adapter.server_manager.subprocess.Popen", fake_popen)
    _stub_node_resolution(monkeypatch)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    monkeypatch.delenv("OPENAI_SMALL_MODEL", raising=False)
    monkeypatch.delenv("OPENAI_LARGE_MODEL", raising=False)
    monkeypatch.delenv("OPENAI_RESPONSE_HANDLER_MODEL", raising=False)
    monkeypatch.delenv("OPENAI_ACTION_PLANNER_MODEL", raising=False)
    monkeypatch.delenv("CEREBRAS_BASE_URL", raising=False)
    monkeypatch.delenv("BENCHMARK_BASE_URL", raising=False)
    monkeypatch.setenv("CEREBRAS_API_KEY", "csk-test")
    monkeypatch.setenv("BENCHMARK_MODEL_PROVIDER", "cerebras")
    monkeypatch.setenv("BENCHMARK_MODEL_NAME", "gpt-oss-120b")

    manager.start()
    manager._proc = None

    env = captured["kwargs"]["env"]
    assert env["ELIZA_PROVIDER"] == "cerebras"
    assert env["OPENAI_API_KEY"] == "csk-test"
    assert env["OPENAI_BASE_URL"] == "https://api.cerebras.ai/v1"
    assert env["CEREBRAS_MODEL"] == "gpt-oss-120b"
    assert env["OPENAI_SMALL_MODEL"] == "gpt-oss-120b"
    assert env["OPENAI_LARGE_MODEL"] == "gpt-oss-120b"
    assert env["OPENAI_RESPONSE_HANDLER_MODEL"] == "gpt-oss-120b"
    assert env["OPENAI_ACTION_PLANNER_MODEL"] == "gpt-oss-120b"


def test_server_manager_autowires_current_cerebras_model_without_provider(
    monkeypatch,
    tmp_path: Path,
) -> None:
    server = tmp_path / "packages" / "app-core" / "src" / "benchmark" / "server.ts"
    server.parent.mkdir(parents=True)
    server.write_text("console.log('fake benchmark server')\n", encoding="utf-8")
    captured = {}

    def fake_popen(*args, **kwargs):
        captured["kwargs"] = kwargs
        return _FakeProcess()

    manager = ElizaServerManager(repo_root=tmp_path, port=0)
    monkeypatch.setattr(manager.client, "is_ready", lambda: True)
    monkeypatch.setattr(manager.client, "health", lambda **_kwargs: {"status": "ready"})
    monkeypatch.setattr(manager.client, "reset", lambda *args, **kwargs: None)
    monkeypatch.setattr("eliza_adapter.server_manager.subprocess.Popen", fake_popen)
    _stub_node_resolution(monkeypatch)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    monkeypatch.delenv("BENCHMARK_MODEL_PROVIDER", raising=False)
    monkeypatch.delenv("CEREBRAS_BASE_URL", raising=False)
    monkeypatch.delenv("BENCHMARK_BASE_URL", raising=False)
    monkeypatch.setenv("CEREBRAS_API_KEY", "csk-test")
    monkeypatch.setenv("BENCHMARK_MODEL_NAME", "zai-glm-4.7")

    manager.start()
    manager._proc = None

    env = captured["kwargs"]["env"]
    assert env["ELIZA_PROVIDER"] == "cerebras"
    assert env["OPENAI_API_KEY"] == "csk-test"
    assert env["OPENAI_BASE_URL"] == "https://api.cerebras.ai/v1"
    assert env["CEREBRAS_MODEL"] == "zai-glm-4.7"
    assert env["OPENAI_SMALL_MODEL"] == "zai-glm-4.7"
    assert env["OPENAI_LARGE_MODEL"] == "zai-glm-4.7"
    assert env["OPENAI_RESPONSE_HANDLER_MODEL"] == "zai-glm-4.7"
    assert env["OPENAI_ACTION_PLANNER_MODEL"] == "zai-glm-4.7"


def test_server_manager_maps_elizaos_task_agent_to_native_adapter(
    monkeypatch,
    tmp_path: Path,
) -> None:
    server = tmp_path / "packages" / "app-core" / "src" / "benchmark" / "server.ts"
    server.parent.mkdir(parents=True)
    server.write_text("console.log('fake benchmark server')\n", encoding="utf-8")
    captured = {}

    def fake_popen(*args, **kwargs):
        captured["kwargs"] = kwargs
        return _FakeProcess()

    manager = ElizaServerManager(repo_root=tmp_path, port=0)
    monkeypatch.setattr(manager.client, "is_ready", lambda: True)
    monkeypatch.setattr(manager.client, "health", lambda **_kwargs: {"status": "ready"})
    monkeypatch.setattr(manager.client, "reset", lambda *args, **kwargs: None)
    monkeypatch.setattr("eliza_adapter.server_manager.subprocess.Popen", fake_popen)
    _stub_node_resolution(monkeypatch)
    monkeypatch.delenv("ELIZA_ACP_DEFAULT_AGENT", raising=False)
    monkeypatch.delenv("ELIZA_DEFAULT_AGENT_TYPE", raising=False)
    monkeypatch.delenv("ELIZA_AGENT_ORCHESTRATOR", raising=False)
    monkeypatch.delenv("ELIZA_AGENT_SELECTION_STRATEGY", raising=False)
    monkeypatch.setenv("BENCHMARK_TASK_AGENT", "elizaos")

    manager.start()
    manager._proc = None

    env = captured["kwargs"]["env"]
    assert env["BENCHMARK_TASK_AGENT"] == "elizaos"
    assert env["ELIZA_AGENT_ORCHESTRATOR"] == "1"
    assert env["ELIZA_AGENT_SELECTION_STRATEGY"] == "fixed"
    assert env["ELIZA_ACP_DEFAULT_AGENT"] == "elizaos"
    assert env["ELIZA_DEFAULT_AGENT_TYPE"] == "elizaos"


def test_server_manager_prefers_bun_for_typescript_server(
    monkeypatch, tmp_path: Path
) -> None:
    server = tmp_path / "server.ts"
    monkeypatch.delenv("ELIZA_BENCH_SERVER_CMD", raising=False)
    monkeypatch.setattr("eliza_adapter.server_manager._resolve_node", lambda: None)
    monkeypatch.setattr(
        "eliza_adapter.server_manager.shutil.which",
        lambda name: "/usr/bin/bun" if name == "bun" else None,
    )

    assert _server_command(server) == ["bun", "--no-env-file", "run", str(server)]


def test_server_manager_falls_back_to_node_tzx(monkeypatch, tmp_path: Path) -> None:
    server = tmp_path / "server.ts"
    monkeypatch.delenv("ELIZA_BENCH_SERVER_CMD", raising=False)
    monkeypatch.setattr("eliza_adapter.server_manager._resolve_node", lambda: None)
    monkeypatch.setattr("eliza_adapter.server_manager.shutil.which", lambda _name: None)

    assert _server_command(server) == [
        "node",
        "--conditions=eliza-source",
        "--import",
        "tsx",
        str(server),
    ]


# ---------------------------------------------------------------------------
# _normalize_model_env base-URL resolution: operator env wins over the
# hardcoded provider endpoint (CEREBRAS_BASE_URL > BENCHMARK_BASE_URL >
# OPENAI_BASE_URL > https://api.cerebras.ai/v1).
# ---------------------------------------------------------------------------


def _cerebras_env(**overrides: str) -> dict[str, str]:
    env = {
        "CEREBRAS_API_KEY": "csk-test",
        "BENCHMARK_MODEL_PROVIDER": "cerebras",
        "BENCHMARK_MODEL_NAME": "gemma-4-31b",
    }
    env.update(overrides)
    return env


def test_normalize_model_env_respects_preset_openai_base_url() -> None:
    env = _cerebras_env(OPENAI_BASE_URL="https://elizacloud.ai/api/v1")
    _normalize_model_env(env)
    assert env["OPENAI_BASE_URL"] == "https://elizacloud.ai/api/v1"
    assert env["ELIZA_PROVIDER"] == "cerebras"
    assert env["OPENAI_API_KEY"] == "csk-test"


def test_normalize_model_env_honors_benchmark_base_url_over_default() -> None:
    env = _cerebras_env(BENCHMARK_BASE_URL="https://elizacloud.ai/api/v1")
    _normalize_model_env(env)
    assert env["OPENAI_BASE_URL"] == "https://elizacloud.ai/api/v1"


def test_normalize_model_env_cerebras_base_url_wins_over_all() -> None:
    env = _cerebras_env(
        CEREBRAS_BASE_URL="https://proxy-a.example/v1",
        BENCHMARK_BASE_URL="https://proxy-b.example/v1",
        OPENAI_BASE_URL="https://proxy-c.example/v1",
    )
    _normalize_model_env(env)
    assert env["OPENAI_BASE_URL"] == "https://proxy-a.example/v1"


def test_normalize_model_env_benchmark_base_url_wins_over_openai() -> None:
    env = _cerebras_env(
        BENCHMARK_BASE_URL="https://proxy-b.example/v1",
        OPENAI_BASE_URL="https://proxy-c.example/v1",
    )
    _normalize_model_env(env)
    assert env["OPENAI_BASE_URL"] == "https://proxy-b.example/v1"


def test_normalize_model_env_falls_back_to_hardcoded_default() -> None:
    env = _cerebras_env()
    _normalize_model_env(env)
    assert env["OPENAI_BASE_URL"] == "https://api.cerebras.ai/v1"


def test_normalize_model_env_blank_overrides_do_not_mask_default() -> None:
    """Whitespace-only operator values are treated as unset, not honored."""
    env = _cerebras_env(
        CEREBRAS_BASE_URL="  ",
        BENCHMARK_BASE_URL="",
        OPENAI_BASE_URL=" ",
    )
    _normalize_model_env(env)
    assert env["OPENAI_BASE_URL"] == "https://api.cerebras.ai/v1"


def test_normalize_model_env_known_model_without_provider_uses_overrides() -> None:
    """The known-Cerebras-model autowire path resolves the same override
    chain instead of force-writing the hardcoded endpoint."""
    env = {
        "CEREBRAS_API_KEY": "csk-test",
        "BENCHMARK_MODEL_NAME": "zai-glm-4.7",
        "BENCHMARK_BASE_URL": "https://elizacloud.ai/api/v1",
    }
    _normalize_model_env(env)
    assert env["ELIZA_PROVIDER"] == "cerebras"
    assert env["OPENAI_BASE_URL"] == "https://elizacloud.ai/api/v1"


def test_normalize_model_env_non_cerebras_setdefault_path_keeps_preset() -> None:
    """When only CEREBRAS_API_KEY hints at cerebras (unknown model, no
    provider), normalization is setdefault-only and never downgrades a
    pre-set OPENAI_BASE_URL."""
    env = {
        "CEREBRAS_API_KEY": "csk-test",
        "BENCHMARK_MODEL_NAME": "some-custom-model",
        "OPENAI_BASE_URL": "https://elizacloud.ai/api/v1",
    }
    _normalize_model_env(env)
    assert env["OPENAI_BASE_URL"] == "https://elizacloud.ai/api/v1"
