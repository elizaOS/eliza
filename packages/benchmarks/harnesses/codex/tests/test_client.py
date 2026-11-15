"""Offline tests for the CodexClient skeleton (#10193/#10199).

No live model is invoked. These assert construction, health, command/env
building, round-robin account rotation, and that the client fails loudly (never
fabricates a response) when the binary or an account credential is absent.
"""

from __future__ import annotations

import pytest
import json
from types import SimpleNamespace

from codex_adapter.accounts import CodexAccount
from codex_adapter.client import CodexClient, MessageResponse, resolve_codex_binary


def _accounts(tmp_path, *ids, authenticated=True):
    root = tmp_path / "auth" / "_codex-home"
    out = []
    for account_id in ids:
        home = root / account_id
        home.mkdir(parents=True, exist_ok=True)
        if authenticated:
            (home / "auth.json").write_text("{}", encoding="utf-8")
        out.append(CodexAccount(account_id=account_id, codex_home=home))
    return out


def test_resolve_codex_binary_explicit(tmp_path):
    fake = tmp_path / "codex"
    fake.write_text("#!/bin/sh\n", encoding="utf-8")
    assert resolve_codex_binary(str(fake)) == str(fake)


def test_resolve_codex_binary_missing(monkeypatch):
    monkeypatch.delenv("CODEX_BIN", raising=False)
    monkeypatch.setattr("shutil.which", lambda _: None)
    with pytest.raises(FileNotFoundError, match="codex executable not found"):
        resolve_codex_binary(None)


def test_client_uses_preresolved_accounts(tmp_path):
    accounts = _accounts(tmp_path, "a", "b")
    client = CodexClient(accounts=accounts, model="gpt-5.5")
    assert [a.account_id for a in client.accounts] == ["a", "b"]
    assert client.model == "gpt-5.5"


def test_health_ready(tmp_path, monkeypatch):
    fake = tmp_path / "codex"
    fake.write_text("#!/bin/sh\n", encoding="utf-8")
    monkeypatch.setenv("CODEX_BIN", str(fake))
    client = CodexClient(accounts=_accounts(tmp_path, "a"))
    health = client.health()
    assert health["status"] == "ready"
    assert health["accounts"] == ["a"]


def test_health_reports_missing_binary(tmp_path, monkeypatch):
    monkeypatch.delenv("CODEX_BIN", raising=False)
    monkeypatch.setattr("shutil.which", lambda _: None)
    client = CodexClient(accounts=_accounts(tmp_path, "a"))
    assert client.health()["status"] == "error"


def test_health_reports_unauthenticated_account(tmp_path, monkeypatch):
    fake = tmp_path / "codex"
    fake.write_text("#!/bin/sh\n", encoding="utf-8")
    monkeypatch.setenv("CODEX_BIN", str(fake))
    client = CodexClient(accounts=_accounts(tmp_path, "a", authenticated=False))
    health = client.health()
    assert health["status"] == "error"
    assert "not authenticated" in str(health["error"])


def test_build_command_shape(tmp_path):
    fake = tmp_path / "codex"
    fake.write_text("#!/bin/sh\n", encoding="utf-8")
    client = CodexClient(accounts=_accounts(tmp_path, "a"), codex_bin=str(fake), model="gpt-5.5")
    cmd = client.build_command()
    assert cmd[0] == str(fake)
    assert cmd[1] == "exec"
    assert "--model" in cmd and "gpt-5.5" in cmd


def test_build_env_points_codex_home(tmp_path):
    accounts = _accounts(tmp_path, "a")
    client = CodexClient(accounts=accounts, codex_bin="/usr/bin/true")
    env = client.build_env(accounts[0])
    assert env["CODEX_HOME"] == str(accounts[0].codex_home)


def test_reset_rewinds_turn_index(tmp_path):
    client = CodexClient(accounts=_accounts(tmp_path, "a", "b"), codex_bin="/usr/bin/true")
    client._turn_index = 5
    client.reset("task-1", "bfcl")
    assert client._turn_index == 0
    assert client._task_id == "task-1"
    assert client._benchmark == "bfcl"


def test_account_for_current_turn_round_robins(tmp_path):
    client = CodexClient(accounts=_accounts(tmp_path, "a", "b"), codex_bin="/usr/bin/true")
    assert client.account_for_current_turn().account_id == "a"
    client._turn_index = 1
    assert client.account_for_current_turn().account_id == "b"
    client._turn_index = 2
    assert client.account_for_current_turn().account_id == "a"


def test_send_message_raises_on_unauthenticated(tmp_path):
    accounts = _accounts(tmp_path, "a", authenticated=False)
    client = CodexClient(accounts=accounts, codex_bin="/usr/bin/true")
    with pytest.raises(RuntimeError, match="not authenticated"):
        client.send_message("hello")


def test_send_message_surfaces_subprocess_failure(tmp_path):
    # /usr/bin/false exits nonzero: the client must raise, never fabricate output.
    accounts = _accounts(tmp_path, "a")
    client = CodexClient(accounts=accounts, codex_bin="/usr/bin/false")
    with pytest.raises(RuntimeError, match="codex exec failed"):
        client.send_message("hello")


def test_message_response_defaults():
    resp = MessageResponse(text="hi")
    assert resp.actions == []
    assert resp.params == {}


def test_turns_preserve_context_and_capture_usage(tmp_path, monkeypatch):
    inputs = []
    def run(_cmd, **kwargs):
        inputs.append(json.loads(kwargs["input"]))
        return SimpleNamespace(returncode=0, stderr="", stdout="\n".join([
            json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "recorded"}}),
            json.dumps({"type": "turn.completed", "usage": {"input_tokens": 100, "output_tokens": 5}}),
        ]))
    monkeypatch.setattr("codex_adapter.client._run_codex_process", run)
    client = CodexClient(accounts=_accounts(tmp_path, "a"), codex_bin="/usr/bin/true")
    client.reset("task", "memory")
    first = client.send_message("remember", {"observation": "complete context"})
    client.send_message("recall")
    assert inputs[1]["messages"] == [
        {"role": "user", "text": "remember", "context": {"observation": "complete context"}},
        {"role": "assistant", "text": "recorded", "events": first.params["events"]},
        {"role": "user", "text": "recall"},
    ]
    assert first.params["usage"]["input_tokens"] == 100
    assert len(first.params["events"]) == 2
    client.reset("next", "memory")
    client.send_message("fresh")
    assert inputs[2]["messages"] == [{"role": "user", "text": "fresh"}]


@pytest.mark.parametrize("event", [
    {"type": "turn.failed", "error": {"message": "provider unavailable"}},
    {"type": "item.completed", "item": {"type": "agent_message", "text": "incomplete"}},
])
def test_zero_exit_without_successful_terminal_event_is_failure(tmp_path, monkeypatch, event):
    monkeypatch.setattr("codex_adapter.client._run_codex_process", lambda *_a, **_kw:
        SimpleNamespace(returncode=0, stderr="", stdout=json.dumps(event)))
    client = CodexClient(accounts=_accounts(tmp_path, "a"), codex_bin="/usr/bin/true")
    with pytest.raises(RuntimeError):
        client.send_message("task")
    assert client._history == []


def test_coding_workspace_and_reasoning_are_explicit(tmp_path):
    client = CodexClient(accounts=_accounts(tmp_path, "a"), codex_bin="/usr/bin/true",
                         cwd=tmp_path, reasoning_effort="high")
    command = client.build_command()
    assert "--json" in command
    assert "workspace-write" in command
    assert 'model_reasoning_effort="high"' in command
    assert client.cwd == tmp_path.resolve()


@pytest.mark.skipif(__import__("os").name != "posix", reason="POSIX process-group cleanup")
@pytest.mark.parametrize("leader_exits", [False, True])
def test_timeout_stops_pipe_holding_process_group_and_preserves_output(tmp_path, monkeypatch, leader_exits):
    import os
    import signal
    import subprocess
    import sys
    import time
    from codex_adapter import client

    # Start both real interpreters before measuring timeout cleanup. Otherwise
    # a busy host can expire the deadline before there is output to preserve.
    parent_ready = tmp_path / "parent.ready"
    child_ready = tmp_path / "child.ready"
    child_script = (
        "import time; from pathlib import Path; "
        "print('descendant-ready', flush=True); "
        f"Path({str(child_ready)!r}).write_text('ready'); time.sleep(30)"
    )
    script = (
        "import subprocess,sys,time; from pathlib import Path; "
        f"subprocess.Popen([sys.executable,'-c',{child_script!r}]); "
        "print('parent-ready', flush=True); print('diagnostic',file=sys.stderr,flush=True); "
        f"Path({str(parent_ready)!r}).write_text('ready'); "
        + ("sys.exit(0)" if leader_exits else "time.sleep(30)")
    )
    command = [sys.executable, "-c", script]
    original_popen = subprocess.Popen
    started = None

    def spawn_ready(*args, **kwargs):
        nonlocal started
        process = original_popen(*args, **kwargs)
        if args[0] != command:
            return process
        try:
            deadline = time.monotonic() + 30
            while not (parent_ready.exists() and child_ready.exists()):
                if time.monotonic() >= deadline:
                    raise AssertionError("process fixture did not become ready")
                time.sleep(0.01)
        except BaseException:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.communicate()
            raise
        started = time.monotonic()
        return process

    monkeypatch.setattr(client.subprocess, "Popen", spawn_ready)
    with pytest.raises(subprocess.TimeoutExpired) as exc:
        client._run_codex_process(command, input="", env=dict(os.environ),
                                  cwd=tmp_path, timeout=1)
    assert started is not None and time.monotonic() - started < 10
    assert "parent-ready" in exc.value.output
    assert "descendant-ready" in exc.value.output
    assert "diagnostic" in exc.value.stderr
