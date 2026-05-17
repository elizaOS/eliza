"""Context-bench query function backed by hermes-agent.

Mirrors :func:`eliza_adapter.context_bench.make_eliza_llm_query`: returns an
``async def query(context: str, question: str) -> str`` that the
``ContextBenchRunner`` invokes for each needle-in-a-haystack task.

The adapter is intentionally thin — context-bench has no tool use, no
multi-turn state, and no scoring beyond exact-substring match. We just need
to thread the prompt through HermesClient and return the assistant text.
"""

from __future__ import annotations

import logging

from hermes_adapter.client import HermesClient

logger = logging.getLogger(__name__)


def make_hermes_llm_query(
    client: HermesClient | None = None,
):
    """Return an async LLM query function compatible with context-bench."""
    _client = client or HermesClient()
    try:
        _client.wait_until_ready(timeout=60)
    except Exception as exc:  # pragma: no cover — surface but don't block import
        logger.debug("hermes wait_until_ready failed: %s", exc)

    async def hermes_llm_query(context: str, question: str) -> str:
        prompt = (
            "Given the following context, answer the question precisely "
            "and concisely.\n\n"
            f"Context:\n{context}\n\n"
            f"Question: {question}\n\n"
            "Answer (be brief and precise):"
        )
        try:
            response = _client.send_message(
                prompt,
                context={
                    "benchmark": "context_bench",
                    "task_id": "context_query",
                    "messages": [{"role": "user", "content": prompt}],
                },
            )
        except Exception as exc:
            logger.exception("[hermes-context] send_message failed")
            raise RuntimeError("hermes context-bench send_message failed") from exc
        return (response.text or "").strip()

    return hermes_llm_query


__all__ = ["make_hermes_llm_query"]
