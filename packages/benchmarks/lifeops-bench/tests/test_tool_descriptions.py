"""Tests that the LIFE_* tool descriptions surfaced to hermes/openclaw are
non-empty and document the wire shape the executor actually accepts.

P0-6 (LifeOps benchmark synthesis plan, 2026-05-11): the planner was guessing
at LIFE_CREATE kwargs because the description was generic, so reminders/sleep
write scenarios scored 0 on action match. These tests pin the documented
fields against the real `_u_life_*` handler shape.
"""

from __future__ import annotations

import pytest

from eliza_lifeops_bench.runner import (
    _DISCRIMINATORS,
    _TOOL_DESCRIPTIONS,
    _tool_parameters_for_action,
    build_tool_manifest,
)


LIFE_VERBS = (
    "LIFE_CREATE",
    "LIFE_COMPLETE",
    "LIFE_SNOOZE",
    "LIFE_REVIEW",
    "LIFE_DELETE",
    "LIFE_UPDATE",
    "LIFE_SKIP",
)


@pytest.mark.parametrize("verb", LIFE_VERBS)
def test_life_verb_description_is_present_and_substantive(verb: str) -> None:
    description = _TOOL_DESCRIPTIONS.get(verb)
    assert description, f"missing description for {verb}"
    # Sanity floor — generic one-liners had ~50 chars; real specs run longer.
    assert len(description) >= 80, (
        f"{verb} description too short ({len(description)} chars) — "
        "spec the wire shape, not a one-line summary"
    )


def test_life_create_documents_kind_and_due() -> None:
    description = _TOOL_DESCRIPTIONS["LIFE_CREATE"]
    assert "kind" in description, "LIFE_CREATE description must call out the kind field"
    assert "details" in description, "LIFE_CREATE description must mention the details payload"
    # The handler accepts ISO8601 due_at via details.due / details.due_at.
    assert "due" in description.lower(), "LIFE_CREATE description must document due/due_at"
    # Detail kinds the handler dispatches on.
    for detail_kind in ("reminder", "alarm", "workout", "health_metric"):
        assert detail_kind in description, (
            f"LIFE_CREATE description must mention detail kind '{detail_kind}'"
        )


def test_life_complete_and_snooze_document_target() -> None:
    for verb in ("LIFE_COMPLETE", "LIFE_SNOOZE", "LIFE_DELETE"):
        description = _TOOL_DESCRIPTIONS[verb]
        assert "target" in description, f"{verb} must document the target field"
        assert "reminder_" in description, (
            f"{verb} must document that targets are reminder_* ids"
        )
    assert "minutes" in _TOOL_DESCRIPTIONS["LIFE_SNOOZE"], (
        "LIFE_SNOOZE must document the minutes field"
    )


def test_life_update_and_skip_document_definition_payload() -> None:
    update_desc = _TOOL_DESCRIPTIONS["LIFE_UPDATE"]
    assert "definition" in update_desc.lower(), (
        "LIFE_UPDATE must call out the definition-level payload"
    )
    assert "details" in update_desc, "LIFE_UPDATE must document the details patch shape"

    skip_desc = _TOOL_DESCRIPTIONS["LIFE_SKIP"]
    assert "skipDate" in skip_desc, "LIFE_SKIP must document the skipDate field"


@pytest.mark.parametrize("verb", LIFE_VERBS)
def test_life_verb_has_discriminator_entry(verb: str) -> None:
    """Every documented verb also needs a JSON-schema discriminator so the
    planner's tool manifest enforces the subaction enum."""
    assert verb in _DISCRIMINATORS, f"{verb} missing from _DISCRIMINATORS"
    field, values = _DISCRIMINATORS[verb]
    assert field == "subaction"
    assert values, f"{verb} has empty subaction enum"
    schema = _tool_parameters_for_action(verb)
    assert schema["properties"]["subaction"]["enum"] == values


def test_tool_manifest_surfaces_life_verbs_with_real_descriptions() -> None:
    """The tool manifest the agent actually sees must carry the inlined specs,
    not the fallback string."""
    from eliza_lifeops_bench.__main__ import _build_world_factory

    world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")
    tools = build_tool_manifest(world)
    by_name = {tool["function"]["name"]: tool["function"] for tool in tools}

    fallback = "Execute this LifeOps action when the user request"
    for verb in LIFE_VERBS:
        assert verb in by_name, f"{verb} missing from manifest"
        description = by_name[verb]["description"]
        assert fallback not in description, (
            f"{verb} fell through to the fallback description"
        )
        assert description == _TOOL_DESCRIPTIONS[verb]
