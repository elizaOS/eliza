"""Context-bench query function backed by the Smithers harness.

Mirrors ``hermes_adapter.context_bench`` / ``openclaw_adapter.context_bench``:
returns an ``async def query(context, question) -> str`` the ContextBenchRunner
invokes per needle-in-a-haystack task. No tools, no multi-turn state.
"""

from __future__ import annotations

import logging

from smithers_adapter.client import SmithersClient

logger = logging.getLogger(__name__)


def make_smithers_llm_query(client: SmithersClient | None = None):
    """Return an async LLM query function compatible with context-bench."""
    _client = client or SmithersClient()
    try:
        _client.wait_until_ready(timeout=120)
    except Exception as exc:  # pragma: no cover — surface but don't block import
        logger.debug("smithers wait_until_ready failed: %s", exc)

    async def smithers_llm_query(context: str, question: str) -> str:
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
            logger.exception("[smithers-context] send_message failed")
            raise RuntimeError("smithers context-bench send_message failed") from exc
        return (response.text or "").strip()

    return smithers_llm_query


__all__ = ["make_smithers_llm_query"]
