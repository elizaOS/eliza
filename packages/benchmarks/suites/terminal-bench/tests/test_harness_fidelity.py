"""Harness actions and full tool output survive real local shell execution."""

import copy
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

for harness in ("eliza", "hermes", "openclaw"):
    harness_path = str(Path(__file__).resolve().parents[3] / "harnesses" / harness)
    if harness_path not in sys.path:
        sys.path.insert(0, harness_path)

from eliza_adapter.terminal_bench import ElizaBridgeTerminalAgent
from elizaos_terminal_bench.environment import LocalTerminalEnvironment
from elizaos_terminal_bench.types import TaskCategory, TaskDifficulty, TerminalTask
from hermes_adapter.terminal_bench import HermesTerminalAgent
from openclaw_adapter.terminal_bench import OpenClawTerminalAgent

agents = [ElizaBridgeTerminalAgent, HermesTerminalAgent, OpenClawTerminalAgent]


class Client:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.requests = []

    def wait_until_ready(self, **kwargs):
        pass

    def reset(self, **kwargs):
        pass

    def send_message(self, text, *, context):
        self.requests.append((text, copy.deepcopy(context)))
        return SimpleNamespace(text=next(self.responses), params={})


def task(script):
    return TerminalTask(
        task_id="fidelity",
        instruction="Execute the requested commands.",
        category=TaskCategory.SCRIPTING,
        difficulty=TaskDifficulty.EASY,
        test_script=script,
        reference_solution="",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("agent_class", agents)
async def test_full_stdout_stderr_reach_next_turn(agent_class):
    command = "python3 - <<'PY'\nimport sys\nprint('a'*6000+'STDOUT_END')\nprint('b'*6000+'STDERR_END',file=sys.stderr)\nPY"
    client = Client([f"<command>{command}</command>", "TASK_COMPLETE"])
    env = LocalTerminalEnvironment()
    await env.start()
    try:
        result = await agent_class(
            environment=env, client=client, max_iterations=2
        ).solve_task(task("exit 0"))
        assert result.success
        second = json.dumps(client.requests[1])
        assert "a" * 6000 + "STDOUT_END" in second
        assert "b" * 6000 + "STDERR_END" in second
        assert result.session.commands[0].command == command
    finally:
        await env.stop()


@pytest.mark.asyncio
async def test_failed_answer_remains_agent_authored():
    command = "python3 -c \"from pathlib import Path; Path('/app/answer.txt').write_text('wrong')\""
    client = Client([f"<command>{command}</command> TASK_COMPLETE"])
    env = LocalTerminalEnvironment()
    await env.start()
    try:
        grader = "if [ \"$(cat /app/answer.txt)\" = correct ]; then exit 0; fi\necho \"Expected 'correct' but got 'wrong'\"\nexit 1"
        result = await agents[0](
            environment=env, client=client, max_iterations=1
        ).solve_task(task(grader))
        assert result.success is False
        assert [c.command for c in result.session.commands] == [command]
        assert (await env.execute("cat /app/answer.txt")).stdout == "wrong"
    finally:
        await env.stop()
