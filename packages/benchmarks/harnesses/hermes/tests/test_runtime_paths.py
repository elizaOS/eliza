"""Runtime selection cannot silently replace an explicitly selected checkout."""
from pathlib import Path
import pytest
import hermes_adapter.client as client

@pytest.fixture
def installs(tmp_path, monkeypatch):
    monkeypatch.delenv("HERMES_REPO_PATH", raising=False)
    monkeypatch.delenv("HERMES_RUNTIME_PYTHON", raising=False)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    managed = tmp_path/"managed"
    monkeypatch.setattr(client, "DEFAULT_REPO_PATH", managed)
    standard = tmp_path/".hermes/hermes-agent"
    standard.mkdir(parents=True)
    (standard/"run_agent.py").write_text("")
    python = standard/"venv/bin/python"
    python.parent.mkdir(parents=True)
    python.write_text("")
    return managed, standard, python

def test_standard_install_is_discovered(installs):
    _, standard, python = installs
    assert client._runtime_paths(None, None) == (standard, python)

def test_managed_install_keeps_precedence(installs):
    managed, _, _ = installs
    managed.mkdir()
    (managed/"run_agent.py").write_text("")
    assert client._runtime_paths(None, None) == (managed, managed/".venv/bin/python")

def test_explicit_missing_checkout_is_not_replaced(installs, tmp_path):
    missing = tmp_path/"missing"
    assert client._runtime_paths(missing, None) == (missing, missing/".venv/bin/python")

def test_environment_and_argument_precedence(installs, tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_REPO_PATH", str(tmp_path/"environment"))
    monkeypatch.setenv("HERMES_RUNTIME_PYTHON", str(tmp_path/"environment-python"))
    assert client._runtime_paths(None,None) == (tmp_path/"environment",tmp_path/"environment-python")
    assert client._runtime_paths(tmp_path/"explicit",tmp_path/"explicit-python") == (tmp_path/"explicit",tmp_path/"explicit-python")
