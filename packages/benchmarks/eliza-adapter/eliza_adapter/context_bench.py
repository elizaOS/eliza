"""Context-bench adapter for the eliza benchmark server."""

from __future__ import annotations

import logging
import os
import re

from eliza_adapter.client import ElizaClient

logger = logging.getLogger(__name__)


def _mock_answer_from_context(context: str, question: str) -> str:
    """Deterministic fallback used only when the TS mock emits a generic action."""
    patterns = [
        (r"The password to access the system is ([^.]+)\.", "What is the password to access the system?"),
        (r"The secret code for the vault is ([^.]+)\.", "What is the secret code for the vault?"),
        (r"The headquarters is located at ([^.]+)\.", "Where is the headquarters located?"),
        (r"The project's codename is ([^.]+)\.", "What is the project's codename?"),
        (r"The meeting point has been set to ([^.]+)\.", "What is the meeting point?"),
    ]
    for pattern, expected_question in patterns:
        if question == expected_question:
            match = re.search(pattern, context)
            if match:
                return match.group(1).strip()
    return ""


def make_eliza_llm_query(
    client: ElizaClient | None = None,
):
    """Return an async LLM query function compatible with context-bench.

    The returned function has the same signature as ``openai_llm_query``
    and ``anthropic_llm_query`` in context-bench's ``run_benchmark.py``::

        async def query(context: str, question: str) -> str: ...
    """
    _client = client or ElizaClient()

    async def eliza_llm_query(context: str, question: str) -> str:
        """Query eliza for an answer given context and question."""
        response = _client.send_message(
            text=(
                "Given the following context, answer the question precisely "
                "and concisely.\n\n"
                f"Context:\n{context}\n\n"
                f"Question: {question}\n\n"
                "Answer (be brief and precise):"
            ),
            context={
                "benchmark": "context_bench",
                "task_id": "context_query",
                "question": question,
                "passages": [context],
            },
        )
        if (
            os.environ.get("ELIZA_BENCH_MOCK") == "true"
            and response.actions == ["BENCHMARK_ACTION"]
            and response.text.startswith("Executed ")
        ):
            fallback = _mock_answer_from_context(context, question)
            if fallback:
                return fallback
        return response.text.strip()

    return eliza_llm_query
