"""Complete model context and recorded evidence survive adapter boundaries."""

import json
import sys
from pathlib import Path
from types import SimpleNamespace as NS

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "suites" / "adhdbench"))
from benchmarks.mind2web.types import (
    Mind2WebActionStep,
    Mind2WebConfig,
    Mind2WebElement,
    Mind2WebOperation,
    Mind2WebRankerMode,
    Mind2WebTask,
)
from benchmarks.mint.executor import PythonExecutor
from benchmarks.mint.types import MINTSubtask, MINTTask
from benchmarks.realm.types import RealmProblem, REALMTask
from eliza_adapter import adhdbench, mind2web, mint, realm


@pytest.mark.asyncio
async def test_full_history_is_model_visible():
    requests = []

    class Client:
        def send_message(self, text, *, context):
            requests.append(text)
            return NS(text="done", actions=["REPLY"], params={}, thought="reason")

    runner = adhdbench.ElizaADHDBenchRunner(config=NS(), client=Client())
    history = [
        {"role": "user", "text": f"original-{i}-" + str(i) * 1000} for i in range(20)
    ]
    await runner._execute_turn("next", 20, "id", ["REPLY"], "history", history)
    assert all(row["text"] in requests[0] for row in history)


def test_saved_trace_is_complete(tmp_path):
    text = "response" * 1000
    thought = "thought" * 1000
    actual = "actual" * 1000
    detail = "detail" * 1000
    turn = NS(
        turn_index=0,
        actions_selected=["REPLY"],
        response_text=text,
        thought=thought,
        latency_ms=1,
        outcome_results=[
            NS(
                outcome=NS(outcome_type=NS(value="reply"), value="expected"),
                passed=False,
                actual_value=actual,
                detail=detail,
            )
        ],
    )
    scenario = NS(
        scenario_id="id",
        scenario_name="name",
        level=NS(name="level"),
        scale_point=NS(label="scale"),
        config_name="config",
        score=0,
        total_latency_ms=1,
        model_name="fixture",
        error=None,
        turn_results=[turn],
    )
    runner = adhdbench.ElizaADHDBenchRunner(
        config=NS(output_dir=str(tmp_path)), client=NS()
    )
    runner._save_traces(
        NS(metadata={}, baselines={}, timestamp="test", results=[scenario])
    )
    saved = json.loads((tmp_path / "adhdbench_traces_test.json").read_text())[
        "results"
    ][0]["turns"][0]
    assert saved["response_text"] == text
    assert saved["thought"] == thought
    assert saved["outcomes"][0]["actual"] == actual
    assert saved["outcomes"][0]["detail"] == detail


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "code,expected",
    [
        ('print("x"*2000+"OUTPUT_END")', "x" * 2000 + "OUTPUT_END"),
        ('assert False, "x"*2000+"ERROR_END"', "x" * 2000 + "ERROR_END"),
    ],
)
async def test_real_python_feedback_is_complete(code, expected):
    requests = []

    class Client:
        def wait_until_ready(self, **kwargs):
            pass

        def reset(self, **kwargs):
            pass

        def send_message(self, text, *, context):
            requests.append(text)
            return NS(
                text=f"```python\n{code}\n```"
                if len(requests) == 1
                else "Final answer: 42",
                actions=[],
                params={},
            )

    agent = mint.ElizaMINTAgent(
        client=Client(), tool_executor=PythonExecutor(use_docker=False)
    )
    task = MINTTask(
        id="feedback",
        subtask=MINTSubtask.GSM8K,
        initial_prompt="Calculate.",
        ground_truth="42",
        max_turns=2,
        tools_allowed=["python"],
    )
    await agent.solve_task(task)
    assert expected in requests[1]


class Client:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.requests = []

    def wait_until_ready(self, **kwargs):
        pass

    def reset(self, **kwargs):
        pass

    def send_message(self, text, *, context):
        self.requests.append((text, context))
        return next(self.responses)


@pytest.mark.asyncio
async def test_realm_preserves_action_feedback():
    feedback = "x" * 5000 + "FEEDBACK_END"
    client = Client(
        [
            NS(text=feedback, actions=[], thought="", params={}),
            NS(text="", actions=["COMPLETE_TASK"], thought="", params={}),
        ]
    )
    task = REALMTask(
        id="feedback",
        name="feedback",
        description="plan",
        goal="plan",
        problem=next(iter(RealmProblem)),
    )
    await realm.ElizaREALMAgent(client=client, max_steps=2).solve_task(task)
    assert feedback in client.requests[1][0]


@pytest.mark.asyncio
async def test_mind2web_preserves_selected_element_metadata():
    attributes = {f"attribute-{i}": f"value-{i}" for i in range(12)}
    text = "buttonlabel" * 100 + "LABEL_END"
    element = Mind2WebElement(
        tag="button",
        backend_node_id="node_target",
        attributes=attributes,
        text_content=text,
        is_original_target=True,
    )
    task = Mind2WebTask(
        annotation_id="metadata",
        confirmed_task="Click the selected button",
        website="example.com",
        domain="test",
        actions=[
            Mind2WebActionStep(
                action_uid="one",
                operation=Mind2WebOperation.CLICK,
                pos_candidates=[element],
                cleaned_html='<button backend_node_id="node_target">target</button>',
            )
        ],
    )
    client = Client(
        [
            NS(
                text='{"operation":"CLICK","element_id":"node_target"}',
                params={},
                thought="",
                actions=["REPLY"],
            )
        ]
    )
    agent = mind2web.ElizaMind2WebAgent(
        Mind2WebConfig(max_steps_per_task=1, ranker_mode=Mind2WebRankerMode.NONE),
        client=client,
    )
    await agent.process_task(task)
    received = client.requests[0][1]["elements"][0]
    assert received["attributes"] == attributes
    assert received["text_content"] == text
