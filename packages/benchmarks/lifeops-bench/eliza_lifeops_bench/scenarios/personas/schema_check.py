"""Strict structural validator for scheduled-task ground-truth shapes.

The action manifest overlay for ``SCHEDULED_TASK_*`` declares nested objects
(``trigger`` / ``escalation`` / ``shouldFire`` / ``completionCheck`` / …) as
``additionalProperties: true``, so the manifest-based validator in
``_authoring/validate.py`` cannot catch a mis-shaped nested payload. That gap
let ground-truth encode trigger/gate/escalation shapes that DON'T match the
real plugin-scheduling zod contract, so a schema-correct agent would score
partial credit against invalid ground truth.

This module is a faithful Python replica of the authoritative zod schema at
``plugins/plugin-scheduling/src/scheduled-task/schema.ts`` (the discriminated
trigger union, ``scheduledTaskShouldFireSchema``,
``scheduledTaskCompletionCheckSchema``, ``escalationStepSchema``, …) plus the
``LIFE_CREATE`` reminder shape from the action manifest. It validates the
nested structure of every scheduled-task-bearing ground-truth action and
returns a list of human-readable issues (empty == valid).

Kept in lockstep with the TS schema — if the zod contract changes, update the
checks here and the corpus guard will flag any scenario that drifts.
"""

from __future__ import annotations

from typing import Any

from ...types import Action

# --- Enum vocabularies mirrored from schema.ts ------------------------------

_KINDS = frozenset(
    {"reminder", "checkin", "followup", "approval", "recap", "watcher", "output", "custom"}
)
_PRIORITIES = frozenset({"low", "medium", "high"})
_SOURCES = frozenset({"default_pack", "user_chat", "first_run", "plugin"})
_SUBJECT_KINDS = frozenset(
    {"entity", "relationship", "thread", "document", "calendar_event", "self"}
)
_TERMINAL_STATES = frozenset({"completed", "skipped", "expired", "failed", "dismissed"})
_INTENSITIES = frozenset({"soft", "normal", "urgent"})
_COMPOSE = frozenset({"all", "any", "first_deny"})
_OUTPUT_DESTINATIONS = frozenset(
    {"in_app_card", "channel", "apple_notes", "gmail_draft", "memory"}
)
_WINDOW_KEYS = frozenset(
    {
        "morning",
        "afternoon",
        "evening",
        "night",
        "morning_or_night",
        "morning_or_evening",
    }
)


def _is_str(v: Any) -> bool:
    return isinstance(v, str) and bool(v)


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _check_trigger(trigger: Any, out: list[str], path: str) -> None:
    if not isinstance(trigger, dict):
        out.append(f"{path}: trigger must be an object")
        return
    kind = trigger.get("kind")
    allowed_by_kind: dict[str, set[str]] = {
        "once": {"kind", "atIso"},
        "cron": {"kind", "expression", "tz"},
        "interval": {"kind", "everyMinutes", "from", "until"},
        "relative_to_anchor": {"kind", "anchorKey", "offsetMinutes"},
        "during_window": {"kind", "windowKey"},
        "event": {"kind", "eventKind", "filter"},
        "manual": {"kind"},
        "after_task": {"kind", "taskId", "outcome"},
    }
    if kind not in allowed_by_kind:
        out.append(f"{path}: trigger.kind {kind!r} not in the discriminated union")
        return
    extra = set(trigger) - allowed_by_kind[kind]
    if extra:
        out.append(f"{path}: trigger[{kind}] has undeclared keys {sorted(extra)}")
    if kind == "once" and not _is_str(trigger.get("atIso")):
        out.append(f"{path}: trigger.once requires atIso ISO string")
    elif kind == "cron":
        if not _is_str(trigger.get("expression")):
            out.append(f"{path}: trigger.cron requires expression")
        if not _is_str(trigger.get("tz")):
            out.append(f"{path}: trigger.cron requires tz")
    elif kind == "interval" and not _is_int(trigger.get("everyMinutes")):
        out.append(f"{path}: trigger.interval requires integer everyMinutes")
    elif kind == "relative_to_anchor":
        if not _is_str(trigger.get("anchorKey")):
            out.append(f"{path}: trigger.relative_to_anchor requires anchorKey")
        if not _is_int(trigger.get("offsetMinutes")):
            out.append(f"{path}: trigger.relative_to_anchor requires integer offsetMinutes")
    elif kind == "during_window":
        wk = trigger.get("windowKey")
        if not _is_str(wk):
            out.append(f"{path}: trigger.during_window requires windowKey")
        elif wk not in _WINDOW_KEYS:
            out.append(
                f"{path}: trigger.during_window windowKey {wk!r} not a known window key"
            )
    elif kind == "event" and not _is_str(trigger.get("eventKind")):
        out.append(f"{path}: trigger.event requires eventKind")
    elif kind == "after_task":
        if not _is_str(trigger.get("taskId")):
            out.append(f"{path}: trigger.after_task requires taskId")
        if trigger.get("outcome") not in _TERMINAL_STATES:
            out.append(f"{path}: trigger.after_task requires a terminal-state outcome")


def _check_should_fire(should_fire: Any, out: list[str], path: str) -> None:
    if not isinstance(should_fire, dict):
        out.append(f"{path}: shouldFire must be an object")
        return
    extra = set(should_fire) - {"compose", "gates"}
    if extra:
        out.append(f"{path}: shouldFire has undeclared keys {sorted(extra)}")
    compose = should_fire.get("compose")
    if compose is not None and compose not in _COMPOSE:
        out.append(f"{path}: shouldFire.compose {compose!r} invalid")
    gates = should_fire.get("gates")
    if not isinstance(gates, list):
        out.append(f"{path}: shouldFire.gates must be an array")
        return
    for i, gate in enumerate(gates):
        if not isinstance(gate, dict):
            out.append(f"{path}: shouldFire.gates[{i}] must be an object")
            continue
        gate_extra = set(gate) - {"kind", "params"}
        if gate_extra:
            out.append(
                f"{path}: shouldFire.gates[{i}] has undeclared keys "
                f"{sorted(gate_extra)} — gate params belong under 'params'"
            )
        if not _is_str(gate.get("kind")):
            out.append(f"{path}: shouldFire.gates[{i}] requires a non-empty kind")
        if "params" in gate and not isinstance(gate["params"], dict):
            out.append(f"{path}: shouldFire.gates[{i}].params must be an object")


def _check_completion_check(cc: Any, out: list[str], path: str) -> None:
    if not isinstance(cc, dict):
        out.append(f"{path}: completionCheck must be an object")
        return
    extra = set(cc) - {"kind", "params", "followupAfterMinutes"}
    if extra:
        out.append(
            f"{path}: completionCheck has undeclared keys {sorted(extra)} — "
            "check-specific params (e.g. lookbackMinutes) belong under 'params'"
        )
    if not _is_str(cc.get("kind")):
        out.append(f"{path}: completionCheck requires a non-empty kind")
    if "params" in cc and not isinstance(cc["params"], dict):
        out.append(f"{path}: completionCheck.params must be an object")
    if "followupAfterMinutes" in cc and not _is_int(cc["followupAfterMinutes"]):
        out.append(f"{path}: completionCheck.followupAfterMinutes must be an integer")


def _check_escalation(esc: Any, out: list[str], path: str) -> None:
    if not isinstance(esc, dict):
        out.append(f"{path}: escalation must be an object")
        return
    extra = set(esc) - {"ladderKey", "steps"}
    if extra:
        out.append(f"{path}: escalation has undeclared keys {sorted(extra)}")
    steps = esc.get("steps")
    if steps is None:
        return
    if not isinstance(steps, list):
        out.append(f"{path}: escalation.steps must be an array")
        return
    for i, step in enumerate(steps):
        if not isinstance(step, dict):
            out.append(f"{path}: escalation.steps[{i}] must be an object")
            continue
        step_extra = set(step) - {"delayMinutes", "channelKey", "intensity"}
        if step_extra:
            out.append(
                f"{path}: escalation.steps[{i}] has undeclared keys {sorted(step_extra)} "
                "(the real escalationStepSchema uses delayMinutes, not afterMinutes)"
            )
        if not _is_int(step.get("delayMinutes")) or step.get("delayMinutes", -1) < 0:
            out.append(
                f"{path}: escalation.steps[{i}] requires delayMinutes >= 0"
            )
        if not _is_str(step.get("channelKey")):
            out.append(f"{path}: escalation.steps[{i}] requires channelKey")
        intensity = step.get("intensity")
        if intensity is not None and intensity not in _INTENSITIES:
            out.append(f"{path}: escalation.steps[{i}].intensity {intensity!r} invalid")


def _check_subject(subject: Any, out: list[str], path: str) -> None:
    if not isinstance(subject, dict):
        out.append(f"{path}: subject must be an object")
        return
    if set(subject) != {"kind", "id"}:
        out.append(f"{path}: subject must be exactly {{kind, id}}")
    if subject.get("kind") not in _SUBJECT_KINDS:
        out.append(f"{path}: subject.kind {subject.get('kind')!r} invalid")
    if not _is_str(subject.get("id")):
        out.append(f"{path}: subject.id must be a non-empty string")


def _check_output(output: Any, out: list[str], path: str) -> None:
    if not isinstance(output, dict):
        out.append(f"{path}: output must be an object")
        return
    extra = set(output) - {"destination", "target", "persistAs"}
    if extra:
        out.append(f"{path}: output has undeclared keys {sorted(extra)}")
    if output.get("destination") not in _OUTPUT_DESTINATIONS:
        out.append(f"{path}: output.destination {output.get('destination')!r} invalid")


def _check_scheduled_task_create(kwargs: dict[str, Any], out: list[str], path: str) -> None:
    """Validate SCHEDULED_TASK_CREATE against the scheduledTaskInput zod shape.

    ``subaction`` is the bench umbrella discriminator (not part of the zod
    shape) and is accepted. All other keys must be declared input fields, and
    the nested objects are validated structurally.
    """
    declared = {
        "subaction",
        "kind",
        "promptInstructions",
        "contextRequest",
        "trigger",
        "priority",
        "shouldFire",
        "completionCheck",
        "escalation",
        "output",
        "pipeline",
        "subject",
        "idempotencyKey",
        "respectsGlobalPause",
        "source",
        "createdBy",
        "ownerVisible",
        "metadata",
    }
    extra = set(kwargs) - declared
    if extra:
        out.append(f"{path}: SCHEDULED_TASK_CREATE has undeclared kwargs {sorted(extra)}")

    if kwargs.get("kind") not in _KINDS:
        out.append(f"{path}: kind {kwargs.get('kind')!r} not a scheduled-task kind")
    if not _is_str(kwargs.get("promptInstructions")):
        out.append(f"{path}: promptInstructions required")
    if "trigger" not in kwargs:
        out.append(f"{path}: trigger required")
    else:
        _check_trigger(kwargs["trigger"], out, path)
    if kwargs.get("priority") not in _PRIORITIES:
        out.append(f"{path}: priority {kwargs.get('priority')!r} invalid")
    if kwargs.get("source") not in _SOURCES:
        out.append(f"{path}: source {kwargs.get('source')!r} invalid")
    if not isinstance(kwargs.get("respectsGlobalPause"), bool):
        out.append(f"{path}: respectsGlobalPause must be boolean")
    if not isinstance(kwargs.get("ownerVisible"), bool):
        out.append(f"{path}: ownerVisible must be boolean")
    if "shouldFire" in kwargs:
        _check_should_fire(kwargs["shouldFire"], out, path)
    if "completionCheck" in kwargs:
        _check_completion_check(kwargs["completionCheck"], out, path)
    if "escalation" in kwargs:
        _check_escalation(kwargs["escalation"], out, path)
    if "subject" in kwargs:
        _check_subject(kwargs["subject"], out, path)
    if "output" in kwargs:
        _check_output(kwargs["output"], out, path)


def _check_life_create(kwargs: dict[str, Any], out: list[str], path: str) -> None:
    """LIFE_CREATE reminders carry `details.due`/`details.listId` only — no
    trigger field (the trigger union belongs to ScheduledTask)."""
    details = kwargs.get("details")
    if not isinstance(details, dict):
        return
    if "trigger" in details:
        out.append(
            f"{path}: LIFE_CREATE details.trigger is not a valid field — the "
            "trigger union belongs to ScheduledTask, not a LIFE reminder"
        )


def check_action_shape(action: Action, path: str) -> list[str]:
    """Return structural issues for one action (empty == valid).

    Only scheduled-task and LIFE_CREATE shapes are deeply validated; other
    actions pass through (the manifest validator already covers their flat
    kwargs, and their nested shapes are not the source of the drift here).
    """
    out: list[str] = []
    if action.name in {
        "SCHEDULED_TASK_CREATE",
        "SCHEDULED_TASKS_CREATE",
    }:
        _check_scheduled_task_create(action.kwargs, out, path)
    elif action.name == "LIFE_CREATE":
        _check_life_create(action.kwargs, out, path)
    return out


def check_scenario_actions(scenario_id: str, actions: list[Action]) -> list[str]:
    """Validate every ground-truth action in a scenario. Empty == valid."""
    issues: list[str] = []
    for i, action in enumerate(actions):
        issues.extend(
            check_action_shape(action, f"{scenario_id}.ground_truth_actions[{i}]({action.name})")
        )
    return issues
