from pathlib import Path

import httpx
import pytest

from clawbench import SandboxClient, SandboxError, setup_workspace


@pytest.mark.parametrize("method", ["get_tool_calls", "get_all_requests", "reset_scenario", "send_message"])
@pytest.mark.parametrize("status,payload", [(503, {}), (200, [])])
def test_transport_failure_cannot_be_scored(monkeypatch, method, status, payload):
    monkeypatch.setattr(httpx, "request", lambda verb, url, **kwargs: httpx.Response(status, json=payload, request=httpx.Request(verb, url)))
    client = SandboxClient(agent_url="http://localhost", token="test", tools_url="http://localhost", model="test")
    with pytest.raises(SandboxError):
        getattr(client, method)(*([] if method.startswith("get_") else ["task"]))


def test_missing_fixture_fails_before_workspace_is_modified(tmp_path: Path):
    fixtures = tmp_path / "fixtures" / "task"
    fixtures.mkdir(parents=True)
    (fixtures / "policy").write_text("new")
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "AGENTS.md").write_text("existing")
    with pytest.raises(SandboxError, match="Missing workspace fixture"):
        setup_workspace({"name": "task", "variants": {"base": "policy"}, "workspace": {"notes": "missing"}}, "base", fixtures.parent, workspace)
    assert (workspace / "AGENTS.md").read_text() == "existing"
