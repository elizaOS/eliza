"""Sanity tests for the benchmark TOON parser.

Run with: uv run --extra train python3 scripts/benchmark/test_toon_parser.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from benchmark.toon_parser import parse


def assert_eq(label: str, got, want) -> None:
    if got != want:
        raise AssertionError(f"{label}: got {got!r}\nwant {want!r}")
    print(f"OK  {label}")


def test_should_respond() -> None:
    src = """name: agent
reasoning: Direct mention triggered a response.
action: RESPOND
primaryContext: general
secondaryContexts: greeting,smalltalk
evidenceTurnIds: t-1,t-3"""
    r = parse(src)
    assert r.ok, r.errors
    assert_eq("sr action", r.document["action"], "RESPOND")
    assert_eq("sr name", r.document["name"], "agent")
    assert_eq("sr primaryContext", r.document["primaryContext"], "general")


def test_message_handler_single_action() -> None:
    src = """thought: User wants weather. Use the weather lookup action.
actions[1]:
  - name: GET_WEATHER
    params:
      location: San Francisco
      units: imperial
providers: time,weather
text: Looking that up now.
simple: false"""
    r = parse(src)
    assert r.ok, r.errors
    assert_eq("mh thought", r.document["thought"],
              "User wants weather. Use the weather lookup action.")
    assert_eq("mh action count", len(r.document["actions"]), 1)
    assert_eq("mh first action name", r.document["actions"][0]["name"], "GET_WEATHER")
    assert_eq("mh simple", r.document["simple"], False)


def test_message_handler_multi_action() -> None:
    src = """thought: do two things
actions[2]:
  - name: REPLY
    params:
      text: ok
  - name: NOTIFY
providers:
text:
simple: true"""
    r = parse(src)
    assert r.ok, r.errors
    assert_eq("multi count", len(r.document["actions"]), 2)
    assert_eq("multi names", [a["name"] for a in r.document["actions"]],
              ["REPLY", "NOTIFY"])
    assert_eq("multi simple", r.document["simple"], True)


def test_reply() -> None:
    src = """thought: Friendly greeting.
text: Hi! How can I help?"""
    r = parse(src)
    assert r.ok, r.errors
    assert_eq("reply text", r.document["text"], "Hi! How can I help?")


def test_fenced() -> None:
    src = """```toon
thought: foo
text: hi
```"""
    r = parse(src)
    assert r.ok, r.errors
    assert_eq("fence text", r.document["text"], "hi")


def test_no_fields_partial() -> None:
    src = "thought:\nactions:\n"
    r = parse(src)
    assert_eq("no-fields thought", r.document.get("thought"), None)
    assert "actions" in r.document


def test_empty() -> None:
    r = parse("")
    assert "empty document" in r.errors[0]


def main() -> int:
    test_should_respond()
    test_message_handler_single_action()
    test_message_handler_multi_action()
    test_reply()
    test_fenced()
    test_no_fields_partial()
    test_empty()
    print("\nall TOON parser tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
