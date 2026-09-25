"""Named tasks must execute agent decisions, never harness-authored answers."""

import json
from types import SimpleNamespace as NS

import lib_run_single
from eliza_adapter.osworld import ElizaBridgeOSWorldAgent


INSTRUCTION = "Set Bing as the main search engine."


def test_bing_task_consults_agent_instead_of_injecting_answer():
    requests = []

    class Client:
        def send_message(self, *, text, context):
            requests.append((text, context))
            return NS(text="FAIL", params={})

    agent = ElizaBridgeOSWorldAgent(client=Client(), observation_type="a11y_tree")
    agent._initialized = True
    response, actions = agent.predict(INSTRUCTION, {"accessibility_tree": "desktop"})
    assert len(requests) == 1
    assert INSTRUCTION in requests[0][0]
    assert response == "FAIL"
    assert actions == ["FAIL"]


def test_runner_grades_only_the_agent_action(tmp_path, monkeypatch):
    calls = []
    actions = []

    class Controller:
        def execute_python_command(self, command):
            raise AssertionError("Runner must not inject a task-specific command")

        def start_recording(self):
            pass

        def end_recording(self, path):
            pass

    class Environment:
        vm_ip = "fixture"
        controller = Controller()

        def reset(self, *, task_config):
            pass

        def _get_obs(self):
            return {"accessibility_tree": "desktop"}

        def step(self, action, sleep_after_execution):
            actions.append(action)
            return self._get_obs(), 0, True, {}

        def evaluate(self):
            assert actions == ["FAIL"]
            return 0

    class Agent:
        def reset(self, *args, **kwargs):
            pass

        def predict(self, instruction, obs):
            calls.append(instruction)
            return "Unable to complete", ["FAIL"]

    monkeypatch.setattr(lib_run_single.time, "sleep", lambda _: None)
    scores = []
    lib_run_single.run_single_example(
        Agent(), Environment(), {"id": "no-oracle"}, 1, INSTRUCTION,
        NS(sleep_after_execution=0, result_dir=str(tmp_path)), str(tmp_path), scores,
    )
    assert calls == [INSTRUCTION]
    assert scores == [0]
    recorded = [json.loads(line) for line in (tmp_path / "traj.jsonl").read_text().splitlines()]
    assert [row["action"] for row in recorded] == ["FAIL"]
    assert (tmp_path / "result.txt").read_text().strip() == "0"
