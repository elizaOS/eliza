"""Tests for LLM-visible tool description shape hints.

These guard against regressing on W6-5: the LIFE_* and SCHEDULED_TASK_*
descriptions + JSON schemas must communicate the flat vs nested wire shape so
the planner stops shoving title into details.
"""

from __future__ import annotations

from eliza_lifeops_bench.runner import (
    _TOOL_DESCRIPTIONS,
    _tool_parameters_for_action,
    build_tool_manifest,
)


def test_life_create_description_calls_out_top_level_title() -> None:
    text = _TOOL_DESCRIPTIONS["LIFE_CREATE"]
    assert "TOP-LEVEL" in text
    assert "title" in text
    assert "details" in text
    # Concrete example must show title outside details.
    assert '"title"' in text
    assert '"Pick up dry cleaning"' in text


def test_life_create_schema_promotes_title_to_top_level() -> None:
    schema = _tool_parameters_for_action("LIFE_CREATE")
    assert schema["type"] == "object"
    props = schema["properties"]
    assert "title" in props
    assert props["title"]["type"] == "string"
    assert "TOP-LEVEL" in props["title"]["description"]
    assert "details" in props
    assert props["details"]["type"] == "object"
    # details must NOT redeclare title — title lives at the top level only.
    assert "title" not in props["details"].get("properties", {})
    # Subaction and title both required.
    required = set(schema["required"])
    assert {"subaction", "title"}.issubset(required)


def test_life_update_delete_complete_skip_have_top_level_target() -> None:
    for name in ("LIFE_UPDATE", "LIFE_DELETE", "LIFE_COMPLETE", "LIFE_SKIP"):
        text = _TOOL_DESCRIPTIONS[name]
        assert "TOP-LEVEL" in text, name
        assert "target" in text, name
        schema = _tool_parameters_for_action(name)
        props = schema["properties"]
        assert "target" in props, name
        assert "TOP-LEVEL" in props["target"]["description"], name


def test_life_snooze_requires_flat_target_and_minutes() -> None:
    text = _TOOL_DESCRIPTIONS["LIFE_SNOOZE"]
    assert "TOP-LEVEL" in text
    assert "minutes" in text
    schema = _tool_parameters_for_action("LIFE_SNOOZE")
    props = schema["properties"]
    assert props["target"]["type"] == "string"
    assert props["minutes"]["type"] == "integer"
    required = set(schema["required"])
    assert {"subaction", "target", "minutes"}.issubset(required)


def test_scheduled_task_create_trigger_is_object_shape() -> None:
    text = _TOOL_DESCRIPTIONS["SCHEDULED_TASK_CREATE"]
    assert "OBJECT" in text or "object" in text
    assert "atIso" in text
    schema = _tool_parameters_for_action("SCHEDULED_TASK_CREATE")
    props = schema["properties"]
    assert props["trigger"]["type"] == "object"
    trig_props = props["trigger"]["properties"]
    assert trig_props["kind"]["enum"] == ["once", "recurring"]
    assert trig_props["atIso"]["type"] == "string"
    assert trig_props["rrule"]["type"] == "string"
    required = set(schema["required"])
    assert {"promptInstructions", "trigger"}.issubset(required)


def test_scheduled_task_update_and_snooze_have_top_level_task_id() -> None:
    for name in ("SCHEDULED_TASK_UPDATE", "SCHEDULED_TASK_SNOOZE"):
        text = _TOOL_DESCRIPTIONS[name]
        assert "TOP-LEVEL" in text, name
        assert "taskId" in text, name
        schema = _tool_parameters_for_action(name)
        props = schema["properties"]
        assert "taskId" in props, name
        assert "TOP-LEVEL" in props["taskId"]["description"], name


def test_build_tool_manifest_exposes_shape_hints_to_planner() -> None:
    """Regression guard: the LLM-visible manifest carries the W6-5 hints.

    Before W6-5, W4-D's "TOP-LEVEL (flat) field" note only lived in
    manifests/actions.manifest.json under dead OWNER_REMINDERS_* entries the
    runner never exposed via _ACTION_HANDLERS. The planner therefore never
    saw the hint. This test asserts the runner-side manifest now carries it.
    """
    from eliza_lifeops_bench.__main__ import _build_world_factory

    world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")
    tools = build_tool_manifest(world)
    by_name = {tool["function"]["name"]: tool["function"] for tool in tools}

    assert "LIFE_CREATE" in by_name
    life_create = by_name["LIFE_CREATE"]
    assert "TOP-LEVEL" in life_create["description"]
    assert "title" in life_create["parameters"]["properties"]
    assert "details" in life_create["parameters"]["properties"]

    assert "SCHEDULED_TASK_CREATE" in by_name
    sched = by_name["SCHEDULED_TASK_CREATE"]
    assert "trigger" in sched["parameters"]["properties"]
    assert sched["parameters"]["properties"]["trigger"]["type"] == "object"
