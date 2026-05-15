from __future__ import annotations

from pathlib import Path

from eliza_adapter.server_manager import ElizaServerManager, _server_command


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
    monkeypatch.setattr(manager.client, "health", lambda: {"status": "ready"})
    monkeypatch.setattr(manager.client, "reset", lambda *args, **kwargs: None)
    monkeypatch.setattr("eliza_adapter.server_manager.subprocess.Popen", fake_popen)
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
    monkeypatch.setattr(manager.client, "health", lambda: {"status": "ready"})
    monkeypatch.setattr(manager.client, "reset", lambda *args, **kwargs: None)
    monkeypatch.setattr("eliza_adapter.server_manager.subprocess.Popen", fake_popen)
    monkeypatch.delenv("ELIZA_BENCH_ALLOW_STUB_EMBEDDING", raising=False)
    monkeypatch.setenv("BENCHMARK_HARNESS", "eliza")

    manager.start()
    manager._proc = None

    assert "ELIZA_BENCH_ALLOW_STUB_EMBEDDING" not in captured["kwargs"]["env"]


def test_server_manager_uses_ephemeral_port_by_default(monkeypatch, tmp_path: Path) -> None:
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
    monkeypatch.setattr(manager.client, "health", lambda: {"status": "ready"})
    monkeypatch.setattr(manager.client, "reset", lambda *args, **kwargs: None)
    monkeypatch.setattr("eliza_adapter.server_manager.subprocess.Popen", fake_popen)

    manager.start()
    manager._proc = None

    assert manager.port == 45678
    assert captured["kwargs"]["env"]["ELIZA_BENCH_PORT"] == "45678"


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
    monkeypatch.setattr(manager.client, "health", lambda: {"status": "ready"})
    monkeypatch.setattr(manager.client, "reset", lambda *args, **kwargs: None)
    monkeypatch.setattr("eliza_adapter.server_manager.subprocess.Popen", fake_popen)
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
    monkeypatch.setattr(manager.client, "health", lambda: {"status": "ready"})
    monkeypatch.setattr(manager.client, "reset", lambda *args, **kwargs: None)
    monkeypatch.setattr("eliza_adapter.server_manager.subprocess.Popen", fake_popen)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    monkeypatch.delenv("OPENAI_SMALL_MODEL", raising=False)
    monkeypatch.delenv("OPENAI_LARGE_MODEL", raising=False)
    monkeypatch.delenv("OPENAI_RESPONSE_HANDLER_MODEL", raising=False)
    monkeypatch.delenv("OPENAI_ACTION_PLANNER_MODEL", raising=False)
    monkeypatch.setenv("CEREBRAS_API_KEY", "csk-test")
    monkeypatch.setenv("BENCHMARK_MODEL_PROVIDER", "cerebras")
    monkeypatch.setenv("BENCHMARK_MODEL_NAME", "gpt-oss-120b")

    manager.start()
    manager._proc = None

    env = captured["kwargs"]["env"]
    assert env["ELIZA_PROVIDER"] == "cerebras"
    assert env["OPENAI_API_KEY"] == "csk-test"
    assert env["OPENAI_BASE_URL"] == "https://api.cerebras.ai/v1"
    assert env["OPENAI_SMALL_MODEL"] == "gpt-oss-120b"
    assert env["OPENAI_LARGE_MODEL"] == "gpt-oss-120b"
    assert env["OPENAI_RESPONSE_HANDLER_MODEL"] == "gpt-oss-120b"
    assert env["OPENAI_ACTION_PLANNER_MODEL"] == "gpt-oss-120b"


def test_server_manager_prefers_bun_for_typescript_server(monkeypatch, tmp_path: Path) -> None:
    server = tmp_path / "server.ts"
    monkeypatch.delenv("ELIZA_BENCH_SERVER_CMD", raising=False)
    monkeypatch.setattr("eliza_adapter.server_manager.shutil.which", lambda name: "/usr/bin/bun" if name == "bun" else None)

    assert _server_command(server) == ["bun", "run", str(server)]


def test_server_manager_falls_back_to_node_tzx(monkeypatch, tmp_path: Path) -> None:
    server = tmp_path / "server.ts"
    monkeypatch.delenv("ELIZA_BENCH_SERVER_CMD", raising=False)
    monkeypatch.setattr("eliza_adapter.server_manager.shutil.which", lambda _name: None)

    assert _server_command(server) == ["node", "--import", "tsx", str(server)]
