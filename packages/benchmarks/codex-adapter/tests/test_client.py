"""Offline tests for the CodexClient skeleton (#10193/#10199).

No live model is invoked. These assert construction, health, command/env
building, round-robin account rotation, and that the client fails loudly (never
fabricates a response) when the binary or an account credential is absent.
"""

from __future__ import annotations

import pytest

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
