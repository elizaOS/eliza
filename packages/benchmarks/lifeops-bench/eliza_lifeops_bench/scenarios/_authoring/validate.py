"""Programmatic validator for candidate scenarios.

A "candidate" is a plain JSON dict shaped like the output the LLM
returns from ``generate_candidates.py``. This module's job is to reject
every candidate the runner could not run, with a precise, human-readable
error string that the operator can paste back into the LLM for a retry.

The validator is intentionally strict and non-mutating. It does not
auto-repair; it returns the issues so the operator chooses what to do.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ...types import Domain
from .._personas import ALL_PERSONAS
from .taxonomy import (
    META_DOMAIN_TAG,
    expected_domain_tag_for_scenario,
)

VALID_DOMAIN_VALUES: frozenset[str] = frozenset(d.value for d in Domain)
VALID_MODE_VALUES: frozenset[str] = frozenset({"static", "live"})
VALID_PERSONA_IDS: frozenset[str] = frozenset(p.id for p in ALL_PERSONAS)


@dataclass(frozen=True)
class ValidationIssue:
    """A single problem with a candidate. ``path`` is dotted JSON-ish."""

    path: str
    message: str


@dataclass(frozen=True)
class ValidationResult:
    """Outcome of validating a single candidate.

    ``warnings`` carries soft taxonomy mismatches (scenario domain vs.
    ground-truth action ``domain:*`` tag) that should not fail the candidate.
    """

    candidate_id: str
    is_valid: bool
    issues: list[ValidationIssue]
    warnings: list[ValidationIssue] = field(default_factory=list)


def _get(obj: dict[str, Any], key: str) -> Any:
    return obj.get(key)


def _is_str(v: Any) -> bool:
    return isinstance(v, str) and bool(v.strip())


def _load_action_manifest(manifest_path: Path) -> dict[str, dict[str, Any]]:
    """Return ``{action_name: parameters_schema}`` from the JSON manifest."""
    raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    out: dict[str, dict[str, Any]] = {}
    for entry in raw.get("actions", []):
        function = entry.get("function") or {}
        name = function.get("name")
        params = function.get("parameters") or {}
        if isinstance(name, str) and name:
            out[name] = params
    return out


def _load_action_tags(manifest_path: Path) -> dict[str, list[str]]:
    """Return ``{action_name: [_tags...]}`` from the JSON manifest.

    Loaded separately from the parameters schema so the existing typed
    validation path stays unchanged. Used by :func:`_check_taxonomy_alignment`.
    """
    raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    out: dict[str, list[str]] = {}
    for entry in raw.get("actions", []):
        function = entry.get("function") or {}
        name = function.get("name")
        tags = entry.get("_tags") or []
        if isinstance(name, str) and name and isinstance(tags, list):
            out[name] = [t for t in tags if isinstance(t, str)]
    return out


def _load_world_ids(snapshot_path: Path) -> dict[str, set[str]]:
    """Return ``{store_kind: set(of valid ids)}`` from a snapshot file."""
    raw = json.loads(snapshot_path.read_text(encoding="utf-8"))
    stores = raw.get("stores", {})
    return {kind: set(items.keys()) for kind, items in stores.items()}


def _check_top_level(c: dict[str, Any], issues: list[ValidationIssue]) -> None:
    required = (
        "id",
        "name",
        "domain",
        "mode",
        "persona_id",
        "instruction",
        "ground_truth_actions",
        "required_outputs",
        "world_seed",
        "max_turns",
        "description",
    )
    for key in required:
        if key not in c:
            issues.append(ValidationIssue(path=key, message="missing required key"))

    if "first_question_fallback" not in c:
        issues.append(
            ValidationIssue(
                path="first_question_fallback",
                message="must be present (use null if not provided)",
            )
        )

    if not _is_str(_get(c, "id")):
        issues.append(ValidationIssue(path="id", message="must be a non-empty string"))
    if not _is_str(_get(c, "name")):
        issues.append(ValidationIssue(path="name", message="must be a non-empty string"))
    if not _is_str(_get(c, "instruction")):
        issues.append(
            ValidationIssue(path="instruction", message="must be a non-empty string")
        )
    if not _is_str(_get(c, "description")):
        issues.append(
            ValidationIssue(path="description", message="must be a non-empty string")
        )

    domain = _get(c, "domain")
    if domain not in VALID_DOMAIN_VALUES:
        issues.append(
            ValidationIssue(
                path="domain",
                message=f"must be one of {sorted(VALID_DOMAIN_VALUES)}, got {domain!r}",
            )
        )

    mode = _get(c, "mode")
    if mode not in VALID_MODE_VALUES:
        issues.append(
            ValidationIssue(
                path="mode",
                message=f"must be one of {sorted(VALID_MODE_VALUES)}, got {mode!r}",
            )
        )

    persona_id = _get(c, "persona_id")
    if persona_id not in VALID_PERSONA_IDS:
        issues.append(
            ValidationIssue(
                path="persona_id",
                message=(
                    f"must be one of {sorted(VALID_PERSONA_IDS)}, got {persona_id!r}"
                ),
            )
        )

    if not isinstance(_get(c, "world_seed"), int):
        issues.append(
            ValidationIssue(path="world_seed", message="must be an integer")
        )

    if not isinstance(_get(c, "max_turns"), int):
        issues.append(ValidationIssue(path="max_turns", message="must be an integer"))

    required_outputs = _get(c, "required_outputs")
    if not isinstance(required_outputs, list) or not all(
        isinstance(x, str) for x in required_outputs
    ):
        issues.append(
            ValidationIssue(
                path="required_outputs", message="must be a list of strings"
            )
        )

    fallback = _get(c, "first_question_fallback")
    if fallback is not None:
        if not isinstance(fallback, dict):
            issues.append(
                ValidationIssue(
                    path="first_question_fallback", message="must be object or null"
                )
            )
        else:
            if not _is_str(fallback.get("canned_answer")):
                issues.append(
                    ValidationIssue(
                        path="first_question_fallback.canned_answer",
                        message="must be a non-empty string",
                    )
                )
            if not _is_str(fallback.get("applies_when")):
                issues.append(
                    ValidationIssue(
                        path="first_question_fallback.applies_when",
                        message="must be a non-empty string",
                    )
                )


def _check_actions(
    c: dict[str, Any],
    valid_actions: dict[str, dict[str, Any]],
    valid_world_ids: dict[str, set[str]],
    issues: list[ValidationIssue],
) -> None:
    actions = _get(c, "ground_truth_actions")
    if not isinstance(actions, list) or not actions:
        issues.append(
            ValidationIssue(
                path="ground_truth_actions",
                message="must be a non-empty list of action objects",
            )
        )
        return

    for i, action in enumerate(actions):
        prefix = f"ground_truth_actions[{i}]"
        if not isinstance(action, dict):
            issues.append(
                ValidationIssue(path=prefix, message="each action must be an object")
            )
            continue

        name = action.get("name")
        if not isinstance(name, str) or name not in valid_actions:
            issues.append(
                ValidationIssue(
                    path=f"{prefix}.name",
                    message=(
                        f"action name {name!r} not present in actions.manifest.json"
                    ),
                )
            )
            continue

        kwargs = action.get("kwargs", {})
        if not isinstance(kwargs, dict):
            issues.append(
                ValidationIssue(path=f"{prefix}.kwargs", message="must be an object")
            )
            continue

        schema = valid_actions[name]
        properties = schema.get("properties") or {}
        required = schema.get("required") or []
        for required_field in required:
            if required_field not in kwargs:
                issues.append(
                    ValidationIssue(
                        path=f"{prefix}.kwargs.{required_field}",
                        message=(
                            f"required parameter for action {name!r} is missing"
                        ),
                    )
                )

        for kw_name, kw_value in kwargs.items():
            if kw_name not in properties:
                issues.append(
                    ValidationIssue(
                        path=f"{prefix}.kwargs.{kw_name}",
                        message=(
                            f"parameter {kw_name!r} is not declared on action {name!r}"
                        ),
                    )
                )
            else:
                expected_type = properties[kw_name].get("type")
                if expected_type and not _matches_type(kw_value, expected_type):
                    issues.append(
                        ValidationIssue(
                            path=f"{prefix}.kwargs.{kw_name}",
                            message=(
                                f"value type does not match declared {expected_type!r}"
                            ),
                        )
                    )
            _check_id_references(
                f"{prefix}.kwargs.{kw_name}",
                kw_value,
                valid_world_ids,
                issues,
            )


def _matches_type(value: Any, declared: str) -> bool:
    if declared == "string":
        return isinstance(value, str)
    if declared == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if declared == "boolean":
        return isinstance(value, bool)
    if declared == "array":
        return isinstance(value, list)
    if declared == "object":
        return isinstance(value, dict)
    # Unknown / multi-type: accept.
    return True


_ID_PREFIX_TO_KIND: dict[str, str] = {
    "contact_": "contact",
    "event_": "calendar_event",
    "cal_": "calendar",
    "list_": "reminder_list",
    "reminder_": "reminder",
    "email_": "email",
    "thread_": "email_thread",
    "conv_": "conversation",
    "chat_": "chat_message",
    "sub_": "subscription",
    "account_": "account",
    "txn_": "transaction",
    "note_": "note",
}


def _check_id_references(
    path: str,
    value: Any,
    valid_world_ids: dict[str, set[str]],
    issues: list[ValidationIssue],
) -> None:
    """Walk a kwargs value and reject any *_id-shaped string not in the world."""
    if isinstance(value, str):
        for prefix, kind in _ID_PREFIX_TO_KIND.items():
            if value.startswith(prefix):
                ids = valid_world_ids.get(kind, set())
                if value not in ids:
                    issues.append(
                        ValidationIssue(
                            path=path,
                            message=(
                                f"id {value!r} not present in snapshot store {kind!r}"
                            ),
                        )
                    )
                return
    elif isinstance(value, list):
        for j, item in enumerate(value):
            _check_id_references(f"{path}[{j}]", item, valid_world_ids, issues)
    elif isinstance(value, dict):
        for k, v in value.items():
            _check_id_references(f"{path}.{k}", v, valid_world_ids, issues)


def _check_taxonomy_alignment(
    c: dict[str, Any],
    valid_action_tags: dict[str, list[str]],
    warnings: list[ValidationIssue],
) -> None:
    """Soft cross-check: ground-truth action's domain tag should match the
    scenario's domain (or be ``domain:meta``).

    Mismatches go into ``warnings`` (never ``issues``) so authoring stays
    fast even when the planner picks an adjacent domain umbrella.
    """
    domain_value = _get(c, "domain")
    if not isinstance(domain_value, str):
        return
    try:
        scenario_domain = Domain(domain_value)
    except ValueError:
        return

    expected = expected_domain_tag_for_scenario(scenario_domain)
    if expected is None:
        return

    actions = _get(c, "ground_truth_actions")
    if not isinstance(actions, list):
        return

    for i, action in enumerate(actions):
        if not isinstance(action, dict):
            continue
        name = action.get("name")
        if not isinstance(name, str):
            continue
        tags = valid_action_tags.get(name, [])
        if not tags:
            # Not in manifest, or manifest has no tags — separate issue surface.
            continue
        domain_tags = [t for t in tags if t.startswith("domain:")]
        if not domain_tags:
            continue
        actual = domain_tags[0]
        # Allow exact match or `domain:meta` (universally compatible).
        if actual == expected.value or actual == META_DOMAIN_TAG.value:
            continue
        warnings.append(
            ValidationIssue(
                path=f"ground_truth_actions[{i}].name",
                message=(
                    f"action {name!r} carries {actual!r} but scenario domain "
                    f"is {scenario_domain.value!r} (expected {expected.value!r}); "
                    "soft warning — is the scenario domain or the action's "
                    "domain tag wrong?"
                ),
            )
        )


def _check_live_extras(
    c: dict[str, Any], issues: list[ValidationIssue]
) -> None:
    """For LIVE mode: enforce success_criteria, world_assertions, and that
    static-only fields are empty/null."""
    actions = c.get("ground_truth_actions")
    if actions != []:
        issues.append(
            ValidationIssue(
                path="ground_truth_actions",
                message="LIVE scenarios must have an empty list",
            )
        )
    required_outputs = c.get("required_outputs")
    if required_outputs != []:
        issues.append(
            ValidationIssue(
                path="required_outputs",
                message="LIVE scenarios must have an empty list",
            )
        )
    fallback = c.get("first_question_fallback")
    if fallback is not None:
        issues.append(
            ValidationIssue(
                path="first_question_fallback",
                message="LIVE scenarios must use null",
            )
        )
    success = c.get("success_criteria")
    if not isinstance(success, list) or not all(_is_str(x) for x in success):
        issues.append(
            ValidationIssue(
                path="success_criteria",
                message="must be a non-empty list of strings",
            )
        )
    elif not (2 <= len(success) <= 6):
        issues.append(
            ValidationIssue(
                path="success_criteria",
                message=f"must have 2-6 entries, got {len(success)}",
            )
        )
    assertions = c.get("world_assertions")
    if not isinstance(assertions, list) or not all(_is_str(x) for x in assertions):
        issues.append(
            ValidationIssue(
                path="world_assertions",
                message="must be a non-empty list of strings",
            )
        )
    elif not (1 <= len(assertions) <= 4):
        issues.append(
            ValidationIssue(
                path="world_assertions",
                message=f"must have 1-4 entries, got {len(assertions)}",
            )
        )
    cid = c.get("id")
    if isinstance(cid, str) and not cid.startswith("live."):
        issues.append(
            ValidationIssue(
                path="id",
                message="LIVE scenario id must start with 'live.'",
            )
        )


def validate_candidate(
    candidate: dict[str, Any],
    *,
    valid_actions: dict[str, dict[str, Any]],
    valid_world_ids: dict[str, set[str]],
    valid_action_tags: dict[str, list[str]] | None = None,
) -> ValidationResult:
    """Validate one candidate. Returns the full set of issues, never raises.

    When ``valid_action_tags`` is provided, also produces soft taxonomy
    warnings for ground-truth actions whose ``domain:*`` tag does not match
    the scenario's ``Domain`` field.

    LIVE-mode candidates take a separate path: their ``ground_truth_actions``
    must be empty, ``success_criteria`` and ``world_assertions`` must be
    populated, and the static-action checks are skipped.
    """
    issues: list[ValidationIssue] = []
    warnings: list[ValidationIssue] = []
    _check_top_level(candidate, issues)
    mode = candidate.get("mode")
    if mode == "live":
        _check_live_extras(candidate, issues)
    else:
        if not issues or all(i.path != "ground_truth_actions" for i in issues):
            _check_actions(candidate, valid_actions, valid_world_ids, issues)
        if valid_action_tags is not None:
            _check_taxonomy_alignment(candidate, valid_action_tags, warnings)
    candidate_id = candidate.get("id") if isinstance(candidate.get("id"), str) else "<unknown>"
    return ValidationResult(
        candidate_id=str(candidate_id),
        is_valid=not issues,
        issues=issues,
        warnings=warnings,
    )


def validate_batch(
    candidates: list[dict[str, Any]],
    *,
    manifest_path: Path,
    snapshot_path: Path,
) -> list[ValidationResult]:
    """Convenience: validate every candidate in a batch against disk artifacts."""
    valid_actions = _load_action_manifest(manifest_path)
    valid_action_tags = _load_action_tags(manifest_path)
    valid_world_ids = _load_world_ids(snapshot_path)
    return [
        validate_candidate(
            c,
            valid_actions=valid_actions,
            valid_world_ids=valid_world_ids,
            valid_action_tags=valid_action_tags,
        )
        for c in candidates
    ]
