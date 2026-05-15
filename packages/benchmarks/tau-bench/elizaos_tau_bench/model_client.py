"""Provider-normalizing LiteLLM wrapper for tau-bench."""

from __future__ import annotations

from typing import Any


def completion(*args: Any, **kwargs: Any) -> Any:
    if "messages" in kwargs and isinstance(kwargs["messages"], list):
        kwargs = {
            **kwargs,
            "messages": [
                {
                    k: v
                    for k, v in message.items()
                    if k not in {"provider_specific_fields", "reasoning_content"}
                }
                if isinstance(message, dict)
                else message
                for message in kwargs["messages"]
            ],
        }
    from litellm import completion as litellm_completion

    response = litellm_completion(*args, **kwargs)
    try:
        message = response.choices[0].message
        model_dump = message.model_dump
    except Exception:
        return response

    def portable_model_dump(*dump_args: Any, **dump_kwargs: Any) -> dict[str, Any]:
        dumped = model_dump(*dump_args, **dump_kwargs)
        if isinstance(dumped, dict):
            dumped.pop("provider_specific_fields", None)
            dumped.pop("reasoning_content", None)
        return dumped

    try:
        message.model_dump = portable_model_dump
    except Exception:
        pass
    return response
