from __future__ import annotations

from pathlib import Path

from eliza_adapter.server_manager import ElizaServerManager


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
