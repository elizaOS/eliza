"""
Built-in control types for the Form Plugin.

Seven standard types: text, number, email, boolean, select, date, file.
"""

from __future__ import annotations

import re
from typing import Callable

from .types import FormControl, JsonValue, ValidationResult

# ---------------------------------------------------------------------------
# ControlType dict shape
# ---------------------------------------------------------------------------
ControlType = dict[str, object]

# ---------------------------------------------------------------------------
# Regex helpers
# ---------------------------------------------------------------------------
_EMAIL_REGEX = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
_ISO_DATE_REGEX = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# ============================================================================
# BUILT-IN TYPES
# ============================================================================

_text_type: ControlType = {
    "id": "text",
    "builtin": True,
    "validate": lambda value, control: (
        ValidationResult(valid=True) if value is None else
        _text_validate(value, control)
    ),
    "parse": lambda value: str(value).strip(),
    "format": lambda value: str(value) if value is not None else "",
    "extraction_prompt": "a text string",
}


def _text_validate(value: JsonValue, control: FormControl) -> ValidationResult:
    s = str(value)
    if control.min_length is not None and len(s) < control.min_length:
        return ValidationResult(valid=False, error=f"Must be at least {control.min_length} characters")
    if control.max_length is not None and len(s) > control.max_length:
        return ValidationResult(valid=False, error=f"Must be at most {control.max_length} characters")
    if control.pattern and not re.search(control.pattern, s):
        return ValidationResult(valid=False, error="Invalid format")
    if control.enum and s not in control.enum:
        return ValidationResult(valid=False, error=f"Must be one of: {', '.join(control.enum)}")
    return ValidationResult(valid=True)


_number_type: ControlType = {
    "id": "number",
    "builtin": True,
    "validate": lambda value, control: (
        ValidationResult(valid=True) if value is None or value == "" else
        _number_validate(value, control)
    ),
    "parse": lambda value: float(re.sub(r"[,$\s]", "", value)),
    "format": lambda value: (
        "" if value is None else
        f"{value:,}" if isinstance(value, int) else
        str(value)
    ),
    "extraction_prompt": "a number (integer or decimal)",
}


def _number_validate(value: JsonValue, control: FormControl) -> ValidationResult:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        num = float(value)
    else:
        try:
            num = float(str(value))
        except (ValueError, TypeError):
            return ValidationResult(valid=False, error="Must be a valid number")

    import math
    if math.isnan(num):
        return ValidationResult(valid=False, error="Must be a valid number")
    if control.min is not None and num < control.min:
        return ValidationResult(valid=False, error=f"Must be at least {control.min}")
    if control.max is not None and num > control.max:
        return ValidationResult(valid=False, error=f"Must be at most {control.max}")
    return ValidationResult(valid=True)


_email_type: ControlType = {
    "id": "email",
    "builtin": True,
    "validate": lambda value, control: (
        ValidationResult(valid=True) if value is None or value == "" else
        (
            ValidationResult(valid=False, error="Invalid email format")
            if not _EMAIL_REGEX.match(str(value).strip().lower())
            else ValidationResult(valid=True)
        )
    ),
    "parse": lambda value: value.strip().lower(),
    "format": lambda value: str(value or "").lower(),
    "extraction_prompt": "an email address (e.g., user@example.com)",
}


_boolean_type: ControlType = {
    "id": "boolean",
    "builtin": True,
    "validate": lambda value, control: (
        ValidationResult(valid=True) if value is None else
        (
            ValidationResult(valid=True) if isinstance(value, bool) else
            (
                ValidationResult(valid=True)
                if str(value).lower() in {"true", "false", "yes", "no", "1", "0", "on", "off"}
                else ValidationResult(valid=False, error="Must be yes/no or true/false")
            )
        )
    ),
    "parse": lambda value: str(value).lower() in {"true", "yes", "1", "on"},
    "format": lambda value: (
        "Yes" if value is True else
        "No" if value is False else
        str(value or "")
    ),
    "extraction_prompt": "a yes/no or true/false value",
}


_select_type: ControlType = {
    "id": "select",
    "builtin": True,
    "validate": lambda value, control: (
        ValidationResult(valid=True) if value is None or value == "" else
        _select_validate(value, control)
    ),
    "parse": lambda value: value.strip(),
    "format": lambda value: str(value or ""),
    "extraction_prompt": "one of the available options",
}


def _select_validate(value: JsonValue, control: FormControl) -> ValidationResult:
    s = str(value)
    if control.options:
        valid_vals = [o.value for o in control.options]
        if s not in valid_vals:
            labels = ", ".join(o.label for o in control.options)
            return ValidationResult(valid=False, error=f"Must be one of: {labels}")
    if control.enum and not control.options:
        if s not in control.enum:
            return ValidationResult(valid=False, error=f"Must be one of: {', '.join(control.enum)}")
    return ValidationResult(valid=True)


_date_type: ControlType = {
    "id": "date",
    "builtin": True,
    "validate": lambda value, control: (
        ValidationResult(valid=True) if value is None or value == "" else
        _date_validate(value, control)
    ),
    "parse": lambda value: _date_parse(value),
    "format": lambda value: str(value) if value else "",
    "extraction_prompt": "a date (preferably in YYYY-MM-DD format)",
}


def _date_validate(value: JsonValue, control: FormControl) -> ValidationResult:
    s = str(value)
    if not _ISO_DATE_REGEX.match(s):
        return ValidationResult(valid=False, error="Must be in YYYY-MM-DD format")
    from datetime import datetime
    try:
        datetime.strptime(s, "%Y-%m-%d")
    except ValueError:
        return ValidationResult(valid=False, error="Invalid date")
    return ValidationResult(valid=True)


def _date_parse(value: str) -> str:
    from datetime import datetime
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            dt = datetime.strptime(value.strip(), fmt)
            return dt.strftime("%Y-%m-%d")
        except ValueError:
            continue
    return value.strip()


_file_type: ControlType = {
    "id": "file",
    "builtin": True,
    "validate": lambda value, control: (
        ValidationResult(valid=True) if value is None else
        (
            ValidationResult(valid=True) if isinstance(value, (dict, list)) else
            ValidationResult(valid=False, error="Invalid file data")
        )
    ),
    "format": lambda value: (
        "" if not value else
        f"{len(value)} file(s)" if isinstance(value, list) else
        (value.get("name", "File attached") if isinstance(value, dict) else "File attached")
    ),
    "extraction_prompt": "a file attachment (upload required)",
}


# ============================================================================
# EXPORTS
# ============================================================================

BUILTIN_TYPES: list[ControlType] = [
    _text_type,
    _number_type,
    _email_type,
    _boolean_type,
    _select_type,
    _date_type,
    _file_type,
]

BUILTIN_TYPE_MAP: dict[str, ControlType] = {str(t["id"]): t for t in BUILTIN_TYPES}


def register_builtin_types(register_fn: Callable[[ControlType], None]) -> None:
    """Register all built-in types with the given function."""
    for t in BUILTIN_TYPES:
        register_fn(t)


def get_builtin_type(type_id: str) -> ControlType | None:
    """Get a built-in type by id."""
    return BUILTIN_TYPE_MAP.get(type_id)


def is_builtin_type(type_id: str) -> bool:
    """Check if a type id is a built-in type."""
    return type_id in BUILTIN_TYPE_MAP
