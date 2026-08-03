"""Checks ContextBench query metadata at the Eliza adapter boundary."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from eliza_adapter.context_bench import make_eliza_llm_query


def test_query_forwards_the_generated_context_task_id() -> None:
    contexts: list[dict[str, object]] = []

    class FakeClient:
        def send_message(self, text: str, context: dict[str, object]):
            del text
            contexts.append(context)
            return SimpleNamespace(text="needle", actions=[], params={})

    query = make_eliza_llm_query(client=FakeClient())

    answer = asyncio.run(query("context", "question", "niah_basic_17"))

    assert answer == "needle"
    assert contexts == [
        {
            "benchmark": "context_bench",
            "task_id": "niah_basic_17",
            "question": "question",
            "passages": ["context"],
        }
    ]
