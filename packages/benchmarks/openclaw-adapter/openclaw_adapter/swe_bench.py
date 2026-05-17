"""SWE-bench model handler backed by the OpenClaw CLI.

Drop-in equivalent of :func:`eliza_adapter.swe_bench.make_eliza_swe_bench_model_handler`
but spawns one OpenClaw CLI per call instead of routing through the
elizaOS TypeScript benchmark HTTP server.

SWE-bench's canonical model contract is a single ``TEXT_LARGE`` handler::

    async def handler(runtime: object, params: dict[str, object]) -> str: ...

OpenClaw CLI is stateless per spawn, so each ``send_message`` carries its
own ``instance_id`` as ``task_id`` for telemetry tagging. The CLI returns
raw text by default — no tool extraction needed.
"""

from __future__ import annotations

import logging
from typing import Awaitable, Callable

from openclaw_adapter.client import OpenClawClient

logger = logging.getLogger(__name__)


SWEBenchModelHandler = Callable[[object, dict[str, object]], Awaitable[str]]


def build_swe_bench_agent_fn(
    *,
    client: OpenClawClient | None = None,
    system_prompt: str | None = None,
) -> SWEBenchModelHandler:
    """Return a SWE-bench-compatible TEXT_LARGE handler backed by OpenClaw.

    Args:
        client: Optional preconfigured :class:`OpenClawClient`.
        system_prompt: Default system prompt prepended when the caller does
            not supply a ``system`` field in ``params``. SWE-bench's
            character template normally includes its own system prompt, so
            most callers leave this :data:`None`.
    """
    bridge = client or OpenClawClient()

    async def _swe_text_large(_runtime: object, params: dict[str, object]) -> str:
        del _runtime

        prompt_raw = params.get("prompt", "")
        prompt = str(prompt_raw) if prompt_raw is not None else ""

        system_raw = params.get("system", "")
        system = str(system_raw) if system_raw else (system_prompt or "")

        instance_id_raw = params.get("instance_id") or params.get("instanceId")
        task_id = ""
        if isinstance(instance_id_raw, str) and instance_id_raw.strip():
            task_id = instance_id_raw.strip()
            try:
                bridge.reset(task_id=task_id, benchmark="swe_bench")
            except Exception as exc:  # noqa: BLE001 — reset is best-effort
                logger.debug("openclaw reset(task_id=%s) failed: %s", task_id, exc)

        # Nudge OpenClaw to return raw XML rather than function calls. The CLI
        # in --message mode already returns raw text by default; the system
        # prompt suffix is a belt-and-braces hint for prompt-tuned models.
        context: dict[str, object] = {
            "benchmark": "swe_bench",
            "_stateless": True,
        }
        if system:
            context["system_prompt"] = (
                f"{system}\n\nRespond only with XML output. Do not emit tool calls."
            )
        else:
            context["system_prompt"] = (
                "Respond only with XML output. Do not emit tool calls."
            )
        if task_id:
            context["task_id"] = task_id

        model_hint = params.get("model_name")
        if isinstance(model_hint, str) and model_hint.strip():
            context["model_name"] = model_hint.strip()

        try:
            response = bridge.send_message(prompt, context=context)
        except Exception:
            logger.exception("[openclaw-swe-bench] send_message failed")
            raise
        return response.text or ""

    return _swe_text_large


make_openclaw_swe_bench_model_handler = build_swe_bench_agent_fn


__all__ = [
    "build_swe_bench_agent_fn",
    "make_openclaw_swe_bench_model_handler",
    "SWEBenchModelHandler",
]
