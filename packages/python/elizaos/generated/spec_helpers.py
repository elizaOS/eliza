"""
Helper functions to lookup action/provider/evaluator specs by name.
These allow language-specific implementations to import their text content
(description, similes, examples) from the centralized specs.

DO NOT EDIT the spec data - update packages/prompts/specs/** and regenerate.
"""

from .action_docs import (
    ActionDoc,
    EvaluatorDoc,
    ProviderDoc,
    all_action_docs,
    all_evaluator_docs,
    all_provider_docs,
    core_action_docs,
    core_evaluator_docs,
    core_provider_docs,
)


def _get_items(doc: object, key: str) -> list[dict[str, object]]:
    if not isinstance(doc, dict):
        return []
    raw = doc.get(key)
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, dict)]


# Build lookup dicts for O(1) access
_core_action_map: dict[str, ActionDoc] = {}
for action in _get_items(core_action_docs, "actions"):
    name = action.get("name")
    if isinstance(name, str):
        _core_action_map[name] = action  # type: ignore[assignment]

_all_action_map: dict[str, ActionDoc] = {}
for action in _get_items(all_action_docs, "actions"):
    name = action.get("name")
    if isinstance(name, str):
        _all_action_map[name] = action  # type: ignore[assignment]

_core_provider_map: dict[str, ProviderDoc] = {}
for provider in _get_items(core_provider_docs, "providers"):
    name = provider.get("name")
    if isinstance(name, str):
        _core_provider_map[name] = provider  # type: ignore[assignment]

_all_provider_map: dict[str, ProviderDoc] = {}
for provider in _get_items(all_provider_docs, "providers"):
    name = provider.get("name")
    if isinstance(name, str):
        _all_provider_map[name] = provider  # type: ignore[assignment]

_core_evaluator_map: dict[str, EvaluatorDoc] = {}
for evaluator in _get_items(core_evaluator_docs, "evaluators"):
    name = evaluator.get("name")
    if isinstance(name, str):
        _core_evaluator_map[name] = evaluator  # type: ignore[assignment]

_all_evaluator_map: dict[str, EvaluatorDoc] = {}
for evaluator in _get_items(all_evaluator_docs, "evaluators"):
    name = evaluator.get("name")
    if isinstance(name, str):
        _all_evaluator_map[name] = evaluator  # type: ignore[assignment]


def get_action_spec(name: str) -> ActionDoc | None:
    """
    Get an action spec by name from the core specs.

    Args:
        name: The action name (e.g., "REPLY", "IGNORE")

    Returns:
        The action spec or None if not found
    """
    return _core_action_map.get(name) or _all_action_map.get(name)


def require_action_spec(name: str) -> ActionDoc:
    """
    Get an action spec by name, raising if not found.

    Args:
        name: The action name

    Returns:
        The action spec

    Raises:
        ValueError: If the action is not found
    """
    spec = get_action_spec(name)
    if spec is None:
        raise ValueError(f"Action spec not found: {name}")
    return spec


def get_provider_spec(name: str) -> ProviderDoc | None:
    """
    Get a provider spec by name from the core specs.

    Args:
        name: The provider name (e.g., "CHARACTER", "TIME")

    Returns:
        The provider spec or None if not found
    """
    return _core_provider_map.get(name) or _all_provider_map.get(name)


def require_provider_spec(name: str) -> ProviderDoc:
    """
    Get a provider spec by name, raising if not found.

    Args:
        name: The provider name

    Returns:
        The provider spec

    Raises:
        ValueError: If the provider is not found
    """
    spec = get_provider_spec(name)
    if spec is None:
        raise ValueError(f"Provider spec not found: {name}")
    return spec


def get_evaluator_spec(name: str) -> EvaluatorDoc | None:
    """
    Get an evaluator spec by name from the core specs.

    Args:
        name: The evaluator name (e.g., "REFLECTION")

    Returns:
        The evaluator spec or None if not found
    """
    return _core_evaluator_map.get(name) or _all_evaluator_map.get(name)


def require_evaluator_spec(name: str) -> EvaluatorDoc:
    """
    Get an evaluator spec by name, raising if not found.

    Args:
        name: The evaluator name

    Returns:
        The evaluator spec

    Raises:
        ValueError: If the evaluator is not found
    """
    spec = get_evaluator_spec(name)
    if spec is None:
        raise ValueError(f"Evaluator spec not found: {name}")
    return spec


__all__ = [
    "ActionDoc",
    "ProviderDoc",
    "EvaluatorDoc",
    "get_action_spec",
    "require_action_spec",
    "get_provider_spec",
    "require_provider_spec",
    "get_evaluator_spec",
    "require_evaluator_spec",
]
