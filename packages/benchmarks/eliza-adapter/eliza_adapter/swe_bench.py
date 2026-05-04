"""SWE-bench model handler backed by the eliza benchmark server.

The SWE-bench benchmark in ``benchmarks/swe_bench`` uses ``runtime.register_model``
to install a ``TEXT_LARGE`` handler that the canonical ``message_service``
invokes for each agent step. The handler signature is::

    async def handler(runtime: object, params: dict[str, object]) -> str: ...

This module exposes :func:`make_eliza_swe_bench_model_handler`, which returns a
handler matching that signature but routes the prompt through the eliza
TypeScript benchmark HTTP server (``server.ts`` -> ``ElizaClient``).

The eliza side is expected to produce raw text (often XML formatted as the
SWE-bench character template instructs). We return that text verbatim — the
SWE-bench agent's XML parser handles the rest, identically to how it parses
output from the Anthropic / OpenAI handlers.
"""

from __future__ import annotations

import logging
from typing import Awaitable, Callable

from eliza_adapter.client import ElizaClient

logger = logging.getLogger(__name__)


SWEBenchModelHandler = Callable[[object, dict[str, object]], Awaitable[str]]


def make_eliza_swe_bench_model_handler(
    client: ElizaClient | None = None,
) -> SWEBenchModelHandler:
    """Return a SWE-bench-compatible TEXT_LARGE handler that calls eliza.

    The handler matches the shape registered by the existing Anthropic /
    OpenAI handlers in ``swe_bench/cli.py``. It extracts ``prompt`` /
    ``system`` from the runtime params, sends them to the eliza benchmark
    server via :class:`ElizaClient`, and returns the response text so that
    the SWE-bench agent's XML parser can extract ``<actions>`` / ``<params>``.

    The optional ``instance_id`` field on params (set by the swe_bench agent
    via ``MessageMetadata``) is forwarded as ``context.task_id`` so the eliza
    server can scope its session.
    """
    bench_client = client or ElizaClient()

    async def _eliza_text_large(_runtime: object, params: dict[str, object]) -> str:
        _ = _runtime

        prompt_raw = params.get("prompt", "")
        prompt = str(prompt_raw) if prompt_raw is not None else ""

        system_raw = params.get("system", "")
        system = str(system_raw) if system_raw else ""

        # Compose context for the eliza server. We surface the system prompt
        # and the SWE-bench instance id (when the runtime threads it through)
        # so the eliza side can route or log appropriately.
        context: dict[str, object] = {"benchmark": "swe_bench"}
        if system:
            context["system"] = system

        instance_id_raw = params.get("instance_id") or params.get("instanceId")
        if isinstance(instance_id_raw, str) and instance_id_raw.strip():
            context["task_id"] = instance_id_raw.strip()

        # Some SWE-bench callers also pass a model name hint — propagate it.
        model_hint = params.get("model_name")
        if isinstance(model_hint, str) and model_hint.strip():
            context["model_name"] = model_hint.strip()

        response = bench_client.send_message(text=prompt, context=context)
        return response.text or ""

    return _eliza_text_large


__all__ = ["make_eliza_swe_bench_model_handler", "SWEBenchModelHandler"]
