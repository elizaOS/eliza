"""Context-bench adapter for the milady benchmark server."""

from __future__ import annotations

import logging

from milady_adapter.client import MiladyClient

logger = logging.getLogger(__name__)


def make_milady_llm_query(
    client: MiladyClient | None = None,
):
    """Return an async LLM query function compatible with context-bench.

    The returned function has the same signature as ``openai_llm_query``
    and ``anthropic_llm_query`` in context-bench's ``run_benchmark.py``::

        async def query(context: str, question: str) -> str: ...
    """
    _client = client or MiladyClient()

    async def milady_llm_query(context: str, question: str) -> str:
        """Query milady for an answer given context and question."""
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
        return response.text.strip()

    return milady_llm_query
