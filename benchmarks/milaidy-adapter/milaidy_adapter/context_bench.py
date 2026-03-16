"""Context-bench adapter for the milaidy benchmark server."""

from __future__ import annotations

import logging

from milaidy_adapter.client import MilaidyClient

logger = logging.getLogger(__name__)


def make_milaidy_llm_query(
    client: MilaidyClient | None = None,
):
    """Return an async LLM query function compatible with context-bench.

    The returned function has the same signature as ``openai_llm_query``
    and ``anthropic_llm_query`` in context-bench's ``run_benchmark.py``::

        async def query(context: str, question: str) -> str: ...
    """
    _client = client or MilaidyClient()

    async def milaidy_llm_query(context: str, question: str) -> str:
        """Query milaidy for an answer given context and question."""
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

    return milaidy_llm_query
