from __future__ import annotations

import os
from collections.abc import Mapping
from typing import TYPE_CHECKING

from elizaos.generated.spec_helpers import get_action_spec, get_provider_spec

if TYPE_CHECKING:
    from elizaos.types import Action, ActionParameter, IAgentRuntime, Provider


_PROMPT_COMPRESSION_KEYS = (
    "PROMPT_COMPRESSION",
    "prompt_compression",
    "promptCompression",
    "USE_PROMPT_COMPRESSION",
)

_TRUTHY_VALUES = {"1", "true", "yes", "on"}


def _read_value(container: object, key: str) -> object | None:
    if container is None:
        return None
    if isinstance(container, Mapping):
        return container.get(key)
    return getattr(container, key, None)


def _read_str_value(container: object, key: str) -> str | None:
    value = _read_value(container, key)
    return value if isinstance(value, str) and value else None


def _get_spec_value(spec: Mapping[str, object] | None, key: str) -> str | None:
    if not spec:
        return None
    value = spec.get(key)
    return value if isinstance(value, str) and value else None


def _get_action_parameter_spec(
    action_name: str,
    parameter_name: str,
) -> Mapping[str, object] | None:
    spec = get_action_spec(action_name)
    if not spec:
        return None

    parameters = spec.get("parameters")
    if not isinstance(parameters, list):
        return None

    for parameter in parameters:
        if not isinstance(parameter, Mapping):
            continue
        if parameter.get("name") == parameter_name:
            return parameter

    return None


def _is_truthy(value: object | None) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in _TRUTHY_VALUES
    if isinstance(value, (int, float)):
        return value != 0
    return False


def compress_prompt_description(description: str | None) -> str:
    if not description:
        return ""

    compact = " ".join(segment.strip() for segment in description.split())
    if len(compact) <= 160:
        return compact

    return f"{compact[:157].rstrip()}..."


def is_prompt_compression_enabled(runtime: IAgentRuntime | None = None) -> bool:
    for key in _PROMPT_COMPRESSION_KEYS:
        if runtime is not None:
            runtime_get_setting = getattr(runtime, "get_setting", None)
            if callable(runtime_get_setting):
                value = runtime_get_setting(key)
                if value is not None:
                    return _is_truthy(value)

            runtime_settings = getattr(runtime, "settings", None)
            value = _read_value(runtime_settings, key)
            if value is not None:
                return _is_truthy(value)

        env_value = os.getenv(key)
        if env_value is not None:
            return _is_truthy(env_value)

    return False


def get_prompt_action_description(
    action: Action,
    runtime: IAgentRuntime | None = None,
) -> str:
    spec = get_action_spec(action.name)
    if not is_prompt_compression_enabled(runtime):
        return _read_str_value(action, "description") or _get_spec_value(spec, "description") or ""

    return (
        _read_str_value(action, "description_compressed")
        or _read_str_value(action, "descriptionCompressed")
        or _get_spec_value(spec, "descriptionCompressed")
        or compress_prompt_description(
            _read_str_value(action, "description") or _get_spec_value(spec, "description")
        )
    )


def get_prompt_parameter_description(
    action_name: str,
    parameter: ActionParameter,
    runtime: IAgentRuntime | None = None,
) -> str:
    spec = _get_action_parameter_spec(action_name, parameter.name)
    if not is_prompt_compression_enabled(runtime):
        return (
            _read_str_value(parameter, "description") or _get_spec_value(spec, "description") or ""
        )

    return (
        _read_str_value(parameter, "description_compressed")
        or _read_str_value(parameter, "descriptionCompressed")
        or _get_spec_value(spec, "descriptionCompressed")
        or compress_prompt_description(
            _read_str_value(parameter, "description") or _get_spec_value(spec, "description")
        )
    )


def get_prompt_provider_description(
    provider: Provider,
    runtime: IAgentRuntime | None = None,
) -> str:
    spec = get_provider_spec(provider.name)
    if not is_prompt_compression_enabled(runtime):
        return (
            _read_str_value(provider, "description") or _get_spec_value(spec, "description") or ""
        )

    return (
        _read_str_value(provider, "description_compressed")
        or _read_str_value(provider, "descriptionCompressed")
        or _get_spec_value(spec, "descriptionCompressed")
        or compress_prompt_description(
            _read_str_value(provider, "description") or _get_spec_value(spec, "description")
        )
    )


__all__ = [
    "compress_prompt_description",
    "get_prompt_action_description",
    "get_prompt_parameter_description",
    "get_prompt_provider_description",
    "is_prompt_compression_enabled",
]
