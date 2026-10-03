"""SWE-bench model handler backed by hermes-agent.

Drop-in equivalent of :func:`eliza_adapter.swe_bench.make_eliza_swe_bench_model_handler`
but routes the prompt through :class:`HermesClient` rather than the elizaOS
TypeScript benchmark HTTP server.

SWE-bench's canonical model contract is a single ``TEXT_LARGE`` handler::

    async def handler(runtime: object, params: dict[str, object]) -> str: ...

The handler must return the raw model text — SWE-bench performs
benchmark-specific extraction downstream. hermes-agent
normally emits structured tool calls, so we force ``tool_choice='none'``
and surface no ``tools=`` array; that keeps the response in the same shape
the eliza handler returns.
"""

from __future__ import annotations

import logging
from typing import Awaitable, Callable

from hermes_adapter.client import HermesClient

logger = logging.getLogger(__name__)


SWEBenchModelHandler = Callable[[object, dict[str, object]], Awaitable[str]]


def build_swe_bench_agent_fn(
    *,
    client: HermesClient | None = None,
) -> SWEBenchModelHandler:
    """Return a SWE-bench-compatible TEXT_LARGE handler backed by hermes-agent.

    The handler matches the shape registered by the existing Anthropic /
    OpenAI / Eliza handlers in ``swe_bench/cli.py``. It extracts the
    ``prompt`` / ``system`` fields from the runtime params, threads
    ``instance_id`` into the bridge as ``task_id`` so per-task telemetry is
    correctly tagged, and returns response text verbatim.
    """
    bridge = client or HermesClient()
    bridge.wait_until_ready(timeout=60)

    async def _swe_text_large(_runtime: object, params: dict[str, object]) -> str:
        del _runtime

        prompt_raw = params.get("prompt", "")
        prompt = str(prompt_raw) if prompt_raw is not None else ""

        system_raw = params.get("system", "")
        system = str(system_raw) if system_raw else ""

        # Per-call ``task_id`` so the hermes-adapter telemetry JSONL row is
        # correlated to the SWE-bench instance id.
        instance_id_raw = params.get("instance_id") or params.get("instanceId")
        task_id = ""
        if isinstance(instance_id_raw, str) and instance_id_raw.strip():
            task_id = instance_id_raw.strip()
            try:
                bridge.reset(task_id=task_id, benchmark="swe_bench")
            except Exception as exc:  # noqa: BLE001 — reset is best-effort
                logger.debug("hermes reset(task_id=%s) failed: %s", task_id, exc)

        # SWE-bench expects raw text patches — explicitly suppress tool
        # calling. Stateless flag tells downstream tooling this turn carries
        # no server-side session.
        context: dict[str, object] = {
            "benchmark": "swe_bench",
            "tool_choice": "none",
            "_stateless": True,
        }
        if system:
            context["system_prompt"] = system
        if task_id:
            context["task_id"] = task_id

        model_hint = params.get("model_name")
        if isinstance(model_hint, str) and model_hint.strip():
            context["model_name"] = model_hint.strip()

        try:
            response = bridge.send_message(prompt, context=context)
        except Exception:
            logger.exception("[hermes-swe-bench] send_message failed")
            raise
        return response.text or ""

    return _swe_text_large


# Legacy alias for callers that match the eliza-adapter's naming style.
make_hermes_swe_bench_model_handler = build_swe_bench_agent_fn


__all__ = [
    "build_swe_bench_agent_fn",
    "make_hermes_swe_bench_model_handler",
    "SWEBenchModelHandler",
]
