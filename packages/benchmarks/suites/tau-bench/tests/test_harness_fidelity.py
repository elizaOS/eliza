"""Tau adapters preserve policy, observations, and actual agent actions."""

import json
from types import SimpleNamespace

import pytest
from eliza_adapter.tau_bench import ElizaTauAgent
from elizaos_tau_bench import eliza_agent as base
from hermes_adapter.tau_bench import HermesTauAgent
from openclaw_adapter.tau_bench import OpenClawTauAgent

agents = [ElizaTauAgent, HermesTauAgent, OpenClawTauAgent]


class Client:
    def __init__(self):
        self.requests = []

    def wait_until_ready(self, **kwargs):
        pass

    def reset(self, **kwargs):
        pass

    def send_message(self, text, *, context):
        self.requests.append(json.loads(json.dumps(context)))
        return SimpleNamespace(
            text="Please confirm the exchange; go ahead?",
            params={
                "tool_calls": [
                    {
                        "id": "call-1",
                        "name": "exchange_delivered_order_items",
                        "arguments": {"item_id": "123"},
                    }
                ]
            },
        )


@pytest.mark.parametrize("agent_class", agents)
def test_complete_history_schema_and_actions(agent_class):
    client = Client()
    agent = agent_class(client=client)
    rules = "policy" * 4000
    request = "customer" * 500
    observation = "observation" * 500
    schema = {
        "type": "function",
        "function": {
            "name": "lookup",
            "description": "description" * 500,
            "parameters": {"type": "object"},
        },
    }
    messages = [
        {"role": "system", "content": rules},
        {"role": "user", "content": request},
    ]
    for i in range(12):
        messages.extend(
            [
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": f"call-{i}",
                            "type": "function",
                            "function": {
                                "name": "lookup",
                                "arguments": json.dumps(
                                    {"long": "value" * 500, "index": i}
                                ),
                            },
                        }
                    ],
                },
                {
                    "role": "tool",
                    "name": "lookup",
                    "tool_call_id": f"call-{i}",
                    "content": observation,
                },
            ]
        )
    messages.append(
        {
            "role": "tool",
            "name": "exchange_delivered_order_items",
            "tool_call_id": "last",
            "content": '{"status": "exchange requested"}',
        }
    )
    agent._one_turn(messages, [schema])
    assert client.requests[-1]["messages"] == messages
    assert client.requests[-1]["tools"] == [schema]
    stepped = []
    info = SimpleNamespace(model_dump=dict)

    class Env:
        wiki = rules

        def __init__(self):
            self.tools_info = [schema]

        def reset(self, **kwargs):
            return SimpleNamespace(observation=request, info=info)

        def step(self, action):
            stepped.append(action)
            return SimpleNamespace(
                reward=0, info=info, observation="observed", done=True
            )

    result = agent.solve(Env(), 0, 1)
    assert result.error is None
    assert client.requests[-1]["messages"][0] == {"role": "system", "content": rules}
    assert stepped[0].name == "exchange_delivered_order_items"
    assert stepped[0].kwargs == {"item_id": "123"}


@pytest.mark.parametrize("arguments", ["{broken", "[]", "null", "", None, []])
def test_invalid_arguments_are_never_repaired(arguments):
    with pytest.raises((ValueError, TypeError)):
        base._message_to_action(
            {"tool_calls": [{"function": {"name": "mutate", "arguments": arguments}}]}
        )


def test_tool_arguments_roundtrip():
    arguments = {
        "empty": {},
        "false": False,
        "zero": 0,
        "unicode": "☃",
        "long": "z" * 5000,
    }
    calls = base._normalize_tool_calls_for_history(
        [{"id": "x", "name": "mutate", "arguments": arguments}]
    )
    assert base._message_to_action({"tool_calls": calls}).kwargs == arguments
