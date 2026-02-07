from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.generated.action_docs import all_action_docs, all_evaluator_docs

if TYPE_CHECKING:
    from elizaos.types import Action, Evaluator


def _action_doc_by_name() -> dict[str, dict[str, object]]:
    actions = all_action_docs.get("actions")
    if not isinstance(actions, list):
        return {}
    by_name: dict[str, dict[str, object]] = {}
    for item in actions:
        if isinstance(item, dict):
            name = item.get("name")
            if isinstance(name, str):
                by_name[name] = item
    return by_name


def _evaluator_doc_by_name() -> dict[str, dict[str, object]]:
    evaluators = all_evaluator_docs.get("evaluators")
    if not isinstance(evaluators, list):
        return {}
    by_name: dict[str, dict[str, object]] = {}
    for item in evaluators:
        if isinstance(item, dict):
            name = item.get("name")
            if isinstance(name, str):
                by_name[name] = item
    return by_name


_ACTION_DOCS = _action_doc_by_name()
_EVALUATOR_DOCS = _evaluator_doc_by_name()


def _coerce_action_parameters(values: object) -> list[object]:
    if not isinstance(values, list):
        return []

    # Local import to avoid import cycles during package init.
    from google.protobuf.json_format import ParseDict

    from elizaos.types import ActionParameter  # noqa: PLC0415

    out: list[object] = []
    for item in values:
        if not isinstance(item, dict):
            continue
        # Use protobuf ParseDict to convert dict to protobuf message
        try:
            param = ParseDict(item, ActionParameter())
            out.append(param)
        except Exception:
            # If conversion fails, skip this item
            pass
    return out


def with_canonical_action_docs(action: Action) -> Action:
    """
    Merge canonical docs (description/similes/parameters) into an Action.

    Conservative merge rules:
    - do not overwrite an existing description
    - do not overwrite existing similes
    - do not overwrite existing parameters
    """
    doc = _ACTION_DOCS.get(action.name)
    if not doc:
        return action

    update: dict[str, object] = {}

    if not action.description:
        desc = doc.get("description")
        if isinstance(desc, str):
            update["description"] = desc

    if not action.similes:
        similes = doc.get("similes")
        if isinstance(similes, list) and all(isinstance(s, str) for s in similes):
            update["similes"] = similes

    if not action.parameters:
        params = doc.get("parameters")
        converted = _coerce_action_parameters(params)
        if converted:
            update["parameters"] = converted

    if not update:
        return action

    for key, value in update.items():
        setattr(action, key, value)
    return action


def with_canonical_evaluator_docs(evaluator: Evaluator) -> Evaluator:
    doc = _EVALUATOR_DOCS.get(evaluator.name)
    if not doc:
        return evaluator

    update: dict[str, object] = {}

    if not evaluator.description:
        desc = doc.get("description")
        if isinstance(desc, str):
            update["description"] = desc

    if not evaluator.similes:
        similes = doc.get("similes")
        if isinstance(similes, list) and all(isinstance(s, str) for s in similes):
            update["similes"] = similes

    if not evaluator.examples:
        examples = doc.get("examples")
        if isinstance(examples, list):
            update["examples"] = examples

    if not update:
        return evaluator

    for key, value in update.items():
        setattr(evaluator, key, value)
    return evaluator


def get_canonical_action_example_calls(action_name: str) -> list[dict[str, object]]:
    """
    Return canonical action-call examples for an action, if present.

    These are the examples that include explicit `<actions>` and optional `<params>` payloads.
    """
    doc = _ACTION_DOCS.get(action_name)
    if not doc:
        return []
    calls = doc.get("exampleCalls")
    if not isinstance(calls, list):
        return []
    out: list[dict[str, object]] = []
    for item in calls:
        if isinstance(item, dict):
            out.append(item)
    return out
