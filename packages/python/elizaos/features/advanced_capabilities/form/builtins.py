"""Built-in control types for the Form capability.

Standard types available out of the box:
- text, number, email, boolean, select, date, file

Built-in types provide consistent validation, sensible defaults,
LLM extraction hints, and override protection.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

from .types import FormControl, ValidationResult

# ---------------------------------------------------------------------------
# ControlType -- lightweight registry entry
# ---------------------------------------------------------------------------


class ControlType:
    """Unified widget/type registry entry.

    Supports three patterns:
    1. Simple types (text, number, email) -- validate/parse/format
    2. Composite types -- have sub-controls via ``get_sub_controls``
    3. External types -- have ``activate`` for async processes
    """

    def __init__(
        self,
        id: str,
        *,
        builtin: bool = False,
        validate: Callable[[Any, FormControl], ValidationResult] | None = None,
        parse: Callable[[str], Any] | None = None,
        format: Callable[[Any], str] | None = None,
        extraction_prompt: str | None = None,
        get_sub_controls: Callable[..., list[FormControl]] | None = None,
        activate: Callable[..., Any] | None = None,
        deactivate: Callable[..., Any] | None = None,
    ) -> None:
        self.id = id
        self.builtin = builtin
        self.validate_fn = validate
        self.parse_fn = parse
        self.format_fn = format
        self.extraction_prompt = extraction_prompt
        self.get_sub_controls = get_sub_controls
        self.activate = activate
        self.deactivate = deactivate

    def validate(self, value: Any, control: FormControl) -> ValidationResult:
        if self.validate_fn is not None:
            return self.validate_fn(value, control)
        return ValidationResult(valid=True)

    def parse(self, value: str) -> Any:
        if self.parse_fn is not None:
            return self.parse_fn(value)
        return value

    def format_value(self, value: Any) -> str:
        if self.format_fn is not None:
            return self.format_fn(value)
        return str(value) if value is not None else ""


# ---------------------------------------------------------------------------
# Built-in type definitions
# ---------------------------------------------------------------------------

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_DATE_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}$"
    r"|^\d{1,2}/\d{1,2}/\d{2,4}$"
    r"|^\d{1,2}-\d{1,2}-\d{2,4}$"
)


def _validate_text(value: Any, control: FormControl) -> ValidationResult:
    s = str(value) if value is not None else ""
    if control.min_length is not None and len(s) < control.min_length:
        return ValidationResult(valid=False, error=f"Minimum length is {control.min_length}")
    if control.max_length is not None and len(s) > control.max_length:
        return ValidationResult(valid=False, error=f"Maximum length is {control.max_length}")
    if control.pattern and not re.search(control.pattern, s):
        return ValidationResult(valid=False, error=f"Does not match pattern {control.pattern}")
    return ValidationResult(valid=True)


def _validate_number(value: Any, control: FormControl) -> ValidationResult:
    try:
        n = float(str(value).replace(",", "").replace("$", "").strip())
    except (ValueError, TypeError):
        return ValidationResult(valid=False, error="Not a valid number")
    if control.min is not None and n < control.min:
        return ValidationResult(valid=False, error=f"Minimum value is {control.min}")
    if control.max is not None and n > control.max:
        return ValidationResult(valid=False, error=f"Maximum value is {control.max}")
    return ValidationResult(valid=True)


def _parse_number(value: str) -> float | int:
    cleaned = value.replace(",", "").replace("$", "").strip()
    n = float(cleaned)
    return int(n) if n == int(n) else n


def _validate_email(value: Any, _control: FormControl) -> ValidationResult:
    s = str(value).strip().lower()
    if not _EMAIL_RE.match(s):
        return ValidationResult(valid=False, error="Not a valid email address")
    return ValidationResult(valid=True)


def _parse_email(value: str) -> str:
    return value.strip().lower()


def _validate_boolean(value: Any, _control: FormControl) -> ValidationResult:
    s = str(value).strip().lower()
    if s in {"true", "false", "yes", "no", "1", "0", "y", "n"}:
        return ValidationResult(valid=True)
    return ValidationResult(valid=False, error="Not a valid yes/no value")


def _parse_boolean(value: str) -> bool:
    return value.strip().lower() in {"true", "yes", "1", "y"}


def _validate_select(value: Any, control: FormControl) -> ValidationResult:
    if control.options:
        valid_values = {opt.value for opt in control.options}
        valid_labels = {opt.label.lower() for opt in control.options}
        s = str(value).strip()
        if s not in valid_values and s.lower() not in valid_labels:
            return ValidationResult(
                valid=False,
                error=f"Must be one of: {', '.join(valid_values)}",
            )
    if control.enum:
        if str(value).strip() not in control.enum:
            return ValidationResult(
                valid=False,
                error=f"Must be one of: {', '.join(control.enum)}",
            )
    return ValidationResult(valid=True)


def _validate_date(value: Any, _control: FormControl) -> ValidationResult:
    s = str(value).strip()
    if not _DATE_RE.match(s):
        return ValidationResult(
            valid=False,
            error="Not a valid date format (expected YYYY-MM-DD or similar)",
        )
    return ValidationResult(valid=True)


def _validate_file(value: Any, control: FormControl) -> ValidationResult:
    if not isinstance(value, dict):
        return ValidationResult(valid=False, error="Expected file metadata object")
    if control.file:
        if control.file.max_size and isinstance(value.get("size"), (int, float)):
            if value["size"] > control.file.max_size:
                return ValidationResult(
                    valid=False,
                    error=f"File exceeds maximum size of {control.file.max_size} bytes",
                )
    return ValidationResult(valid=True)


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

BUILTIN_TYPES: list[ControlType] = [
    ControlType(
        id="text",
        builtin=True,
        validate=_validate_text,
        extraction_prompt="a plain text string",
    ),
    ControlType(
        id="number",
        builtin=True,
        validate=_validate_number,
        parse=_parse_number,
        format=lambda v: f"{v:,}" if isinstance(v, (int, float)) else str(v),
        extraction_prompt="a numeric value (integer or decimal)",
    ),
    ControlType(
        id="email",
        builtin=True,
        validate=_validate_email,
        parse=_parse_email,
        extraction_prompt="an email address",
    ),
    ControlType(
        id="boolean",
        builtin=True,
        validate=_validate_boolean,
        parse=_parse_boolean,
        format=lambda v: "Yes" if v else "No",
        extraction_prompt="a yes/no or true/false value",
    ),
    ControlType(
        id="select",
        builtin=True,
        validate=_validate_select,
        extraction_prompt="a choice from the available options",
    ),
    ControlType(
        id="date",
        builtin=True,
        validate=_validate_date,
        extraction_prompt="a date in YYYY-MM-DD format",
    ),
    ControlType(
        id="file",
        builtin=True,
        validate=_validate_file,
        extraction_prompt="a file upload",
    ),
]

BUILTIN_TYPE_MAP: dict[str, ControlType] = {ct.id: ct for ct in BUILTIN_TYPES}


def register_builtin_types(
    register_fn: Callable[[ControlType], None],
) -> None:
    """Register all built-in types with a FormService instance."""
    for ct in BUILTIN_TYPES:
        register_fn(ct)


def get_builtin_type(type_id: str) -> ControlType | None:
    return BUILTIN_TYPE_MAP.get(type_id)


def is_builtin_type(type_id: str) -> bool:
    return type_id in BUILTIN_TYPE_MAP
