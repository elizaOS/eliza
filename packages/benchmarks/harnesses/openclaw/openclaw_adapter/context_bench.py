"""Context-bench query function backed by OpenClaw.

Mirrors :func:`eliza_adapter.context_bench.make_eliza_llm_query` and
:func:`hermes_adapter.context_bench.make_hermes_llm_query`: returns an
``async def query(context: str, question: str) -> str``.

The adapter is intentionally thin because context-bench has no tool use or
multi-turn state. The prompt still crosses OpenClaw's embedded runtime and the
shared model gateway, so its score has the same provenance as tool benchmarks.
"""

from __future__ import annotations

import logging

from openclaw_adapter.client import OpenClawClient

logger = logging.getLogger(__name__)


def make_openclaw_llm_query(
    client: OpenClawClient | None = None,
):
    """Return an async LLM query function compatible with context-bench."""
    _client = client or OpenClawClient()
    _client.wait_until_ready(timeout=120)

    async def openclaw_llm_query(context: str, question: str) -> str:
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
            logger.exception("[openclaw-context] send_message failed")
            raise RuntimeError("openclaw context-bench send_message failed") from exc
        return (response.text or "").strip()
    return openclaw_llm_query


__all__ = ["make_openclaw_llm_query"]
