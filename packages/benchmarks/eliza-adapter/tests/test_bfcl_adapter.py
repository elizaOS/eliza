from __future__ import annotations

import asyncio
from types import SimpleNamespace

import eliza_adapter.bfcl as bfcl
from eliza_adapter.bfcl import ElizaBFCLAgent, _extract_calls_from_response


def test_bfcl_unwraps_benchmark_action_text_calls() -> None:
    text = (
        '{"name":"BENCHMARK_ACTION","arguments":{"calls":['
        '{"name":"spotify.play","arguments":{"artist":"Taylor Swift","duration":20}},'
        '{"name":"spotify.play","arguments":{"artist":"Maroon 5","duration":15}}'
        "]}}"
    )

    calls = _extract_calls_from_response(text, {})

    assert [call.name for call in calls] == ["spotify.play", "spotify.play"]
    assert calls[0].arguments == {"artist": "Taylor Swift", "duration": 20}
    assert calls[1].arguments == {"artist": "Maroon 5", "duration": 15}


def test_bfcl_unwraps_benchmark_action_params_calls() -> None:
    params = {
        "BENCHMARK_ACTION": {
            "arguments": {
                "calls": [
                    {
                        "name": "GeometryPresentation.createPresentation",
                        "arguments": {"controller": "mapController", "parent": "mapArea"},
                    }
                ]
            }
        }
    }

    calls = _extract_calls_from_response("", params)

    assert len(calls) == 1
    assert calls[0].name == "GeometryPresentation.createPresentation"
    assert calls[0].arguments == {"controller": "mapController", "parent": "mapArea"}


def test_bfcl_query_passes_structured_tools_in_context(monkeypatch) -> None:
    tools = [
        {
            "type": "function",
            "function": {
                "name": "recipe_info.get_calories",
                "description": "Get calories",
                "parameters": {"type": "object", "properties": {}},
            },
        }
    ]
    captured: dict[str, object] = {}

    class Client:
        def reset(self, **_kwargs):
            return {"status": "ok"}

        def send_message(self, text, context):
            captured["text"] = text
            captured["context"] = context
            return SimpleNamespace(
                text="",
                params={
                    "BENCHMARK_ACTION": {
                        "arguments": {
                            "calls": [
                                {
                                    "name": "recipe_info.get_calories",
                                    "arguments": {"recipe": "Lasagna"},
                                }
                            ]
                        }
                    }
                },
                actions=[],
            )

    monkeypatch.setattr(bfcl, "_bfcl_tools_formatter", lambda: lambda _functions: tools)
    agent = ElizaBFCLAgent(client=Client())
    agent._initialized = True
    case = SimpleNamespace(
        id="simple_1",
        category=SimpleNamespace(value="simple"),
        question="How many calories?",
        functions=[],
        is_relevant=True,
        expected_calls=[],
    )

    calls, _, _ = asyncio.run(agent.query(case))

    assert captured["context"]["tools"] == tools
    assert isinstance(captured["context"]["tools"], list)
    assert "recipe_info.get_calories" in captured["text"]
    assert calls[0].name == "recipe_info.get_calories"
