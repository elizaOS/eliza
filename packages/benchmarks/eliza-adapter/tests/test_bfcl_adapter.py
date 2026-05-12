from __future__ import annotations

from eliza_adapter.bfcl import _extract_calls_from_response


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
