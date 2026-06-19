"""SWE-bench model handler backed by the smithers harness.

Mirror of :mod:`hermes_adapter.swe_bench`, swapping :class:`HermesClient`
for the API-compatible :class:`SmithersClient`. SWE-bench's canonical model
contract is a single ``TEXT_LARGE`` handler::

    async def handler(runtime: object, params: dict[str, object]) -> str: ...

The handler returns the raw model text — SWE-bench performs benchmark-specific
extraction downstream. We force ``tool_choice='none'`` and surface no tools so
the response stays in the same plain-text shape SWE-bench expects.
"""

from __future__ import annotations

import logging
from typing import Awaitable, Callable

from smithers_adapter.client import SmithersClient

logger = logging.getLogger(__name__)


SWEBenchModelHandler = Callable[[object, dict[str, object]], Awaitable[str]]


def build_swe_bench_agent_fn(
    *,
    client: SmithersClient | None = None,
) -> SWEBenchModelHandler:
    """Return a SWE-bench-compatible TEXT_LARGE handler backed by smithers."""
    bridge = client or SmithersClient()
    bridge.wait_until_ready(timeout=60)

    async def _swe_text_large(_runtime: object, params: dict[str, object]) -> str:
        del _runtime

        prompt_raw = params.get("prompt", "")
        prompt = str(prompt_raw) if prompt_raw is not None else ""

        system_raw = params.get("system", "")
        system = str(system_raw) if system_raw else ""

        instance_id_raw = params.get("instance_id") or params.get("instanceId")
        task_id = ""
        if isinstance(instance_id_raw, str) and instance_id_raw.strip():
            task_id = instance_id_raw.strip()
            try:
                bridge.reset(task_id=task_id, benchmark="swe_bench")
            except Exception as exc:  # noqa: BLE001 — reset is best-effort
                logger.debug("smithers reset(task_id=%s) failed: %s", task_id, exc)

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
            logger.exception("[smithers-swe-bench] send_message failed")
            raise
        return response.text or ""

    return _swe_text_large


make_smithers_swe_bench_model_handler = build_swe_bench_agent_fn


__all__ = [
    "build_swe_bench_agent_fn",
    "make_smithers_swe_bench_model_handler",
    "SWEBenchModelHandler",
]
