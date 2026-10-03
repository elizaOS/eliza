from __future__ import annotations

import asyncio

from eliza_adapter.client import MessageResponse
from eliza_adapter.mind2web import ElizaMind2WebAgent

from benchmarks.mind2web.types import (
    Mind2WebActionStep,
    Mind2WebConfig,
    Mind2WebElement,
    Mind2WebOperation,
    Mind2WebRankerMode,
    Mind2WebTask,
)


class _Client:
    def __init__(self, responses: list[MessageResponse]) -> None:
        self.responses = responses
        self.requests: list[tuple[str, dict[str, object]]] = []

    def wait_until_ready(self, timeout: int = 120) -> None:
        pass

    def reset(self, *, task_id: str, benchmark: str) -> None:
        pass

    def send_message(self, *, text: str, context: dict[str, object]) -> MessageResponse:
        self.requests.append((text, context))
        return self.responses.pop(0)


def test_process_task_parses_mind2web_json_aliases_from_response_text() -> None:
    task = Mind2WebTask(
        annotation_id="sample_001",
        confirmed_task="Search for wireless headphones",
        website="amazon.com",
        domain="shopping",
        action_reprs=[
            "Type 'wireless headphones'",
            "Click search button",
        ],
        actions=[
            Mind2WebActionStep(
                action_uid="a1",
                operation=Mind2WebOperation.TYPE,
                value="wireless headphones",
                cleaned_html=(
                    '<html backend_node_id="root"><input backend_node_id="node_search" '
                    'type="text"/><button backend_node_id="node_submit" type="submit"/></html>'
                ),
                pos_candidates=[
                    Mind2WebElement(
                        tag="input",
                        backend_node_id="node_search",
                        attributes={"type": "text"},
                        is_original_target=True,
                    )
                ],
            ),
            Mind2WebActionStep(
                action_uid="a2",
                operation=Mind2WebOperation.CLICK,
                cleaned_html=(
                    '<html backend_node_id="root"><input backend_node_id="node_search" '
                    'type="text"/><button backend_node_id="node_submit" type="submit"/></html>'
                ),
                pos_candidates=[
                    Mind2WebElement(
                        tag="button",
                        backend_node_id="node_submit",
                        attributes={"type": "submit"},
                        is_original_target=True,
                    )
                ],
            ),
        ],
    )
    client = _Client(
        [
            MessageResponse(
                text='{"action": "type", "backend_node_id": "node_search", "text": "wireless headphones"}',
                thought=None,
                actions=["REPLY"],
                params={},
            ),
            MessageResponse(
                text='```json\n{"action": "click", "backend_node_id": "node_submit"}\n```',
                thought=None,
                actions=["REPLY"],
                params={},
            ),
        ]
    )
    agent = ElizaMind2WebAgent(
        Mind2WebConfig(
            max_steps_per_task=2,
            ranker_mode=Mind2WebRankerMode.NONE,
        ),
        client=client,  # type: ignore[arg-type]
    )

    actions = asyncio.run(agent.process_task(task))

    assert [(a.operation, a.element_id, a.value) for a in actions] == [
        (Mind2WebOperation.TYPE, "node_search", "wireless headphones"),
        (Mind2WebOperation.CLICK, "node_submit", ""),
    ]
    first_prompt, first_context = client.requests[0]
    second_prompt, _second_context = client.requests[1]
    assert "Click search button" not in first_prompt
    assert "Target micro-action" not in first_prompt
    assert "Full plan" not in first_prompt
    assert "Click search button" not in second_prompt
    assert "Type 'wireless headphones'" in second_prompt
    assert first_context["tool_choice"] == "required"
    assert first_context["tools"]
