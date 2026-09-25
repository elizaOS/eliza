import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPT = Path(__file__).resolve().parents[3] / "scripts/eliza-1/harness_runner.py"
spec = importlib.util.spec_from_file_location("native_decision_runner", SCRIPT)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


@pytest.mark.parametrize(
    "health",
    [
        {"status": "error", "publishable_native": False},
        {"status": "ready", "publishable_native": False},
        {"status": "ready"},
    ],
)
def test_native_preflight_rejects_unverified_runtime(health):
    client = SimpleNamespace(health=lambda: health)
    with pytest.raises(RuntimeError, match="Native decision harness unavailable"):
        runner._ready_native_client(client)


def test_native_preflight_retains_the_attested_client():
    client = SimpleNamespace(
        health=lambda: {"status": "ready", "publishable_native": True}
    )
    assert runner._ready_native_client(client) == (client, None)


@pytest.mark.parametrize("fail", [False, True])
def test_cli_report_preserves_native_attempts(tmp_path, monkeypatch, fail):
    def send(*args, **kwargs):
        if fail:
            raise RuntimeError("native process failed")
        return SimpleNamespace(
            text='{"shouldRespond":"RESPOND"}',
            actions=[],
            params={
                "_meta": {"agent_runtime": "hermes", "publishable_native": True},
                "usage": {"output_tokens": 0},
            },
        )

    client = SimpleNamespace(send_message=send)
    monkeypatch.setattr(runner, "_build_client", lambda *_: (client, None))
    output = tmp_path / "report.json"
    assert runner.main(
        ["--harness", "hermes", "--out", str(output), "--limit", "1"]
    ) == int(fail)
    data = json.loads(output.read_text())
    case = data["cases"][0]
    (attempt,) = case["native_attempts"]
    assert attempt["task_id"] == "eliza-1-should-respond-" + case["caseId"].replace(
        "#", "-"
    )
    assert attempt["context"]["messages"][0]["content"] == runner.SYSTEM_PROMPT
    assert "expected_label" not in attempt["context"]
    if fail:
        assert attempt["error"] == case["error"]
    else:
        assert attempt["response"]["text"] == case["raw_output"]
        assert attempt["response"]["params"]["usage"]["output_tokens"] == 0
