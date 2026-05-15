"""Provider-normalizing LiteLLM wrapper for tau-bench.

Some providers return assistant-only metadata such as ``reasoning_content``.
Those fields are useful in the raw response but are not portable chat history:
passing them back to Cerebras on the next turn makes the request fail. This
module keeps the vendored TAU code on one completion boundary and scrubs those
fields from both outbound messages and response ``model_dump()`` history.
"""

from __future__ import annotations

from typing import Any

_PROVIDER_ONLY_MESSAGE_FIELDS = {
    "provider_specific_fields",
    "reasoning_content",
}


def _portable_message(message: Any) -> Any:
    if not isinstance(message, dict):
        return message
    portable = dict(message)
    for field in _PROVIDER_ONLY_MESSAGE_FIELDS:
        portable.pop(field, None)
    return portable


def _portable_messages(messages: Any) -> Any:
    if not isinstance(messages, list):
        return messages
    return [_portable_message(message) for message in messages]


def _patch_response_message_dump(response: Any) -> Any:
    try:
        message = response.choices[0].message
    except Exception:
        return response

    model_dump = getattr(message, "model_dump", None)
    if not callable(model_dump):
        return response

    def portable_model_dump(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return _portable_message(model_dump(*args, **kwargs))

    try:
        setattr(message, "model_dump", portable_model_dump)
    except Exception:
        pass
    return response


def completion(*args: Any, **kwargs: Any) -> Any:
    if "messages" in kwargs:
        kwargs = {**kwargs, "messages": _portable_messages(kwargs["messages"])}
    from litellm import completion as litellm_completion

    response = litellm_completion(*args, **kwargs)
    return _patch_response_message_dump(response)


__all__ = ["completion"]
