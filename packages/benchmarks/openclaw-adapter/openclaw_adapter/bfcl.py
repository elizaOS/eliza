"""BFCL-style agent function backed by the OpenClaw harness."""

from __future__ import annotations

import logging
from typing import Any, Callable

from openclaw_adapter.client import OpenClawClient

logger = logging.getLogger(__name__)


def build_bfcl_agent_fn(
    *,
    client: OpenClawClient | None = None,
    model_name: str | None = None,
) -> Callable[[str, dict[str, Any] | None], dict[str, Any]]:
    bridge = client or OpenClawClient(model=model_name)

    def _agent_fn(prompt: str, context: dict[str, Any] | None = None) -> dict[str, Any]:
        try:
            resp = bridge.send_message(prompt, context=context)
        except Exception as exc:  # noqa: BLE001
            logger.exception("[openclaw-bfcl] send_message failed")
            raise RuntimeError("OpenClaw BFCL send_message failed") from exc
        return {
            "content": resp.text,
            "tool_calls": resp.params.get("tool_calls", []),
            "model_name": model_name,
        }

    return _agent_fn
