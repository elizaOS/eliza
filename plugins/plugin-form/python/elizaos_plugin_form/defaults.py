"""
Default value application for forms and controls.

Ensures minimal definitions work correctly by filling in sensible defaults.
"""

from __future__ import annotations

import re
from copy import deepcopy
from typing import cast

from .types import (
    FORM_CONTROL_DEFAULTS,
    FORM_DEFINITION_DEFAULTS,
    FormControl,
    FormDefinition,
    FormDefinitionNudge,
    FormDefinitionTTL,
    FormDefinitionUX,
    JsonValue,
)


def prettify(key: str) -> str:
    """Convert snake_case or kebab-case to Title Case.

    >>> prettify("first_name")
    'First Name'
    >>> prettify("email-address")
    'Email Address'
    """
    spaced = re.sub(r"[-_]", " ", key)
    return re.sub(r"\b\w", lambda m: m.group().upper(), spaced)


def apply_control_defaults(control: dict[str, JsonValue] | FormControl) -> dict[str, JsonValue]:
    """Apply defaults to a control dict and return a complete dict."""
    if isinstance(control, FormControl):
        src: dict[str, JsonValue] = {
            "key": control.key,
            "label": control.label,
            "type": control.type,
            "required": control.required,
        }
        if control.confirm_threshold is not None:
            src["confirm_threshold"] = control.confirm_threshold
        if control.pattern is not None:
            src["pattern"] = control.pattern
        if control.min is not None:
            src["min"] = control.min
        if control.max is not None:
            src["max"] = control.max
        if control.description is not None:
            src["description"] = control.description
    else:
        src = dict(control)

    key = str(src.get("key", ""))
    result: dict[str, JsonValue] = {
        "key": key,
        "label": src.get("label") or prettify(key),
        "type": src.get("type") or cast(str, FORM_CONTROL_DEFAULTS["type"]),
        "required": src.get("required") if src.get("required") is not None else FORM_CONTROL_DEFAULTS["required"],
        "confirm_threshold": (
            src.get("confirm_threshold")
            if src.get("confirm_threshold") is not None
            else FORM_CONTROL_DEFAULTS["confirm_threshold"]
        ),
    }

    # Merge remaining keys from source
    for k, v in src.items():
        if k not in result:
            result[k] = v

    return result


def apply_form_defaults(form: dict[str, JsonValue] | FormDefinition) -> dict[str, JsonValue]:
    """Apply defaults to a form dict and return a complete dict."""
    _def = FORM_DEFINITION_DEFAULTS
    _ux_def: dict[str, JsonValue] = _def["ux"]  # type: ignore[assignment]
    _ttl_def: dict[str, JsonValue] = _def["ttl"]  # type: ignore[assignment]
    _nudge_def: dict[str, JsonValue] = _def["nudge"]  # type: ignore[assignment]

    if isinstance(form, FormDefinition):
        src: dict[str, JsonValue] = {"id": form.id, "name": form.name}
        if form.version is not None:
            src["version"] = form.version
        if form.status is not None:
            src["status"] = form.status
        if form.controls is not None:
            src["controls"] = form.controls  # type: ignore[assignment]
        if form.debug is not None:
            src["debug"] = form.debug
        if form.description is not None:
            src["description"] = form.description
    else:
        src = dict(form)

    form_id = str(src.get("id", ""))

    # UX
    ux_src = src.get("ux") or {}
    if isinstance(ux_src, dict):
        ux = {
            "allow_undo": ux_src.get("allow_undo") if ux_src.get("allow_undo") is not None else _ux_def["allow_undo"],
            "allow_skip": ux_src.get("allow_skip") if ux_src.get("allow_skip") is not None else _ux_def["allow_skip"],
            "max_undo_steps": ux_src.get("max_undo_steps") if ux_src.get("max_undo_steps") is not None else _ux_def["max_undo_steps"],
            "show_examples": ux_src.get("show_examples") if ux_src.get("show_examples") is not None else _ux_def["show_examples"],
            "show_explanations": ux_src.get("show_explanations") if ux_src.get("show_explanations") is not None else _ux_def["show_explanations"],
            "allow_autofill": ux_src.get("allow_autofill") if ux_src.get("allow_autofill") is not None else _ux_def["allow_autofill"],
        }
    else:
        ux = dict(_ux_def)

    # TTL
    ttl_src = src.get("ttl") or {}
    if isinstance(ttl_src, dict):
        ttl = {
            "min_days": ttl_src.get("min_days") if ttl_src.get("min_days") is not None else _ttl_def["min_days"],
            "max_days": ttl_src.get("max_days") if ttl_src.get("max_days") is not None else _ttl_def["max_days"],
            "effort_multiplier": ttl_src.get("effort_multiplier") if ttl_src.get("effort_multiplier") is not None else _ttl_def["effort_multiplier"],
        }
    else:
        ttl = dict(_ttl_def)

    # Nudge
    nudge_src = src.get("nudge") or {}
    if isinstance(nudge_src, dict):
        nudge: dict[str, JsonValue] = {
            "enabled": nudge_src.get("enabled") if nudge_src.get("enabled") is not None else _nudge_def["enabled"],
            "after_inactive_hours": nudge_src.get("after_inactive_hours") if nudge_src.get("after_inactive_hours") is not None else _nudge_def["after_inactive_hours"],
            "max_nudges": nudge_src.get("max_nudges") if nudge_src.get("max_nudges") is not None else _nudge_def["max_nudges"],
        }
        if nudge_src.get("message") is not None:
            nudge["message"] = nudge_src["message"]
    else:
        nudge = dict(_nudge_def)

    # Controls
    raw_controls = src.get("controls") or []
    controls: list[dict[str, JsonValue]] = []
    if isinstance(raw_controls, list):
        for c in raw_controls:
            if isinstance(c, (dict, FormControl)):
                controls.append(apply_control_defaults(c))
            # else skip non-dict items

    result: dict[str, JsonValue] = {
        "id": form_id,
        "name": src.get("name") or prettify(form_id),
        "version": src.get("version") if src.get("version") is not None else _def["version"],
        "status": src.get("status") if src.get("status") is not None else _def["status"],
        "controls": controls,  # type: ignore[dict-item]
        "ux": ux,  # type: ignore[dict-item]
        "ttl": ttl,  # type: ignore[dict-item]
        "nudge": nudge,  # type: ignore[dict-item]
        "debug": src.get("debug") if src.get("debug") is not None else _def["debug"],
    }

    # Merge remaining keys
    for k, v in src.items():
        if k not in result:
            result[k] = v

    return result
