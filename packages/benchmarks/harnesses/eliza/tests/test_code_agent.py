import os

import pytest

from eliza_adapter import code_agent


@pytest.mark.parametrize("failure", ["start", "turn", None])
def test_code_agent_closes_runtime_and_restores_environment(monkeypatch, failure):
    events = []
    expected = object()

    class Manager:
        def __init__(self, **kwargs):
            self.client = self

        def start(self):
            events.append("start")
            assert os.environ["BENCHMARK_MODEL_NAME"] == "requested"
            if failure == "start":
                raise RuntimeError("start")

        def reset(self, **kwargs):
            events.append("reset")

        def send_message(self, prompt, context):
            assert prompt.endswith("complete requirements")
            if failure == "turn":
                raise RuntimeError("turn")
            return expected

        def stop(self):
            events.append("stop")

    monkeypatch.setattr(code_agent, "ElizaServerManager", Manager)
    monkeypatch.setenv("BENCHMARK_MODEL_NAME", "previous")
    kwargs = dict(adapter="elizaos", provider="local", model="requested", timeout_seconds=30,
                  prompt="complete requirements", context={"benchmark": "test", "task_id": "one"})
    if failure:
        with pytest.raises(RuntimeError, match=failure):
            code_agent.run_code_agent_task(**kwargs)
    else:
        assert code_agent.run_code_agent_task(**kwargs) is expected
    assert events[-1] == "stop"
    assert os.environ["BENCHMARK_MODEL_NAME"] == "previous"
