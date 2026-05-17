"""Context-bench query function backed by OpenClaw.

Mirrors :func:`eliza_adapter.context_bench.make_eliza_llm_query` and
:func:`hermes_adapter.context_bench.make_hermes_llm_query`: returns an
``async def query(context: str, question: str) -> str``.

The adapter is intentionally thin — context-bench has no tool use, no
multi-turn state. We thread the prompt through OpenClawClient and return
the assistant text. With ``OPENCLAW_DIRECT_OPENAI_COMPAT=1`` the client
hits Cerebras directly, which is the supported smoke path.
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
    try:
        _client.wait_until_ready(timeout=120)
    except Exception as exc:  # pragma: no cover — surface but don't block import
        logger.debug("openclaw wait_until_ready failed: %s", exc)

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
