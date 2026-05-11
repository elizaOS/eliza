from scripts.lib.toon import ToonDecoder, ToonEncoder


def test_toon_encoder_round_trips_nested_actions() -> None:
    record = {
        "thought": "check the requested action with the available tool",
        "actions": [
            {"name": "SHELL", "params": {"command": "pwd"}},
        ],
        "text": "ok",
    }

    encoded = ToonEncoder().encode(record)
    assert ToonDecoder().decode(encoded) == record


def test_toon_decoder_accepts_json() -> None:
    assert ToonDecoder().decode('{"thought":"ok","actions":[]}') == {
        "thought": "ok",
        "actions": [],
    }


def test_toon_decoder_normalizes_indexed_headers() -> None:
    decoded = ToonDecoder().decode(
        """
actions[1]:
  - name: SHELL
    params:
      command: pwd
"""
    )

    assert decoded == {"actions": [{"name": "SHELL", "params": {"command": "pwd"}}]}
