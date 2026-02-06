"""
Field validation utilities for the Form Plugin.

Validation happens at two points:
1. At Extraction – immediate feedback on extracted values
2. At Submission – safety net before final submission

Custom type handlers are checked FIRST, before built-in type validation.
"""

from __future__ import annotations

import math
import re
from datetime import datetime
from typing import Callable, Protocol

from .types import (
    FormControl,
    FormControlFileOptions,
    JsonValue,
    ValidationResult,
)


# ============================================================================
# TYPE HANDLER PROTOCOL
# ============================================================================


class TypeHandlerProtocol(Protocol):
    """Protocol for custom type handlers."""

    def validate(self, value: JsonValue, control: FormControl) -> ValidationResult: ...
    def parse(self, value: str) -> JsonValue: ...
    def format(self, value: JsonValue) -> str: ...


class TypeHandler:
    """Custom type handler with optional validate/parse/format/extraction_prompt."""

    def __init__(
        self,
        validate: Callable[[JsonValue, FormControl], ValidationResult] | None = None,
        parse: Callable[[str], JsonValue] | None = None,
        format: Callable[[JsonValue], str] | None = None,
        extraction_prompt: str | None = None,
    ) -> None:
        self._validate = validate
        self._parse = parse
        self._format = format
        self.extraction_prompt = extraction_prompt

    def validate(self, value: JsonValue, control: FormControl) -> ValidationResult:
        if self._validate is not None:
            return self._validate(value, control)
        return ValidationResult(valid=True)

    def parse(self, value: str) -> JsonValue:
        if self._parse is not None:
            return self._parse(value)
        return value

    def format(self, value: JsonValue) -> str:
        if self._format is not None:
            return self._format(value)
        return str(value)


# ============================================================================
# TYPE HANDLER REGISTRY
# ============================================================================

_type_handlers: dict[str, TypeHandler] = {}


def register_type_handler(type_name: str, handler: TypeHandler) -> None:
    """Register a custom type handler."""
    _type_handlers[type_name] = handler


def get_type_handler(type_name: str) -> TypeHandler | None:
    """Get a type handler or ``None`` if not registered."""
    return _type_handlers.get(type_name)


def clear_type_handlers() -> None:
    """Clear all type handlers (for tests)."""
    _type_handlers.clear()


# ============================================================================
# FIELD VALIDATION
# ============================================================================


def validate_field(value: JsonValue, control: FormControl) -> ValidationResult:
    """Validate a value against a control's validation rules.

    Order: required → custom handler → type-specific → pattern/limits.
    """
    # Required check
    if control.required:
        if value is None or value == "":
            label = control.label or control.key
            return ValidationResult(valid=False, error=f"{label} is required")

    # Empty optional fields are valid
    if value is None or value == "":
        return ValidationResult(valid=True)

    # Custom type handler first
    handler = _type_handlers.get(control.type)
    if handler is not None and handler._validate is not None:
        result = handler.validate(value, control)
        if not result.valid:
            return result

    # Type-specific validation
    type_map: dict[str, Callable[[JsonValue, FormControl], ValidationResult]] = {
        "email": _validate_email,
        "number": _validate_number,
        "boolean": _validate_boolean,
        "date": _validate_date,
        "select": _validate_select,
        "file": _validate_file,
    }

    validator = type_map.get(control.type, _validate_text)
    return validator(value, control)


# ============================================================================
# TYPE-SPECIFIC VALIDATORS
# ============================================================================

_EMAIL_REGEX = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def _validate_email(value: JsonValue, control: FormControl) -> ValidationResult:
    str_value = str(value)
    if not _EMAIL_REGEX.match(str_value):
        label = control.label or control.key
        return ValidationResult(valid=False, error=f"{label} must be a valid email address")
    return _validate_text(value, control)


def _validate_number(value: JsonValue, control: FormControl) -> ValidationResult:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        num_value = float(value)
    else:
        cleaned = re.sub(r"[,$]", "", str(value))
        try:
            num_value = float(cleaned)
        except (ValueError, TypeError):
            label = control.label or control.key
            return ValidationResult(valid=False, error=f"{label} must be a number")

    if math.isnan(num_value):
        label = control.label or control.key
        return ValidationResult(valid=False, error=f"{label} must be a number")

    if control.min is not None and num_value < control.min:
        label = control.label or control.key
        return ValidationResult(valid=False, error=f"{label} must be at least {control.min}")

    if control.max is not None and num_value > control.max:
        label = control.label or control.key
        return ValidationResult(valid=False, error=f"{label} must be at most {control.max}")

    return ValidationResult(valid=True)


def _validate_boolean(value: JsonValue, control: FormControl) -> ValidationResult:
    if isinstance(value, bool):
        return ValidationResult(valid=True)

    str_value = str(value).lower()
    truthy = {"true", "yes", "1", "on"}
    falsy = {"false", "no", "0", "off"}

    if str_value in truthy or str_value in falsy:
        return ValidationResult(valid=True)

    return ValidationResult(valid=False, error="Must be true or false")


def _validate_date(value: JsonValue, control: FormControl) -> ValidationResult:
    date_value: datetime | None = None
    timestamp: float | None = None

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            date_value = datetime.fromtimestamp(value / 1000)
            timestamp = float(value)
        except (OSError, ValueError, OverflowError):
            label = control.label or control.key
            return ValidationResult(valid=False, error=f"{label} must be a valid date")
    elif isinstance(value, str):
        # Try ISO parse
        for fmt in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
            try:
                date_value = datetime.strptime(value, fmt)
                timestamp = date_value.timestamp() * 1000
                break
            except ValueError:
                continue
        if date_value is None:
            label = control.label or control.key
            return ValidationResult(valid=False, error=f"{label} must be a valid date")
    else:
        label = control.label or control.key
        return ValidationResult(valid=False, error=f"{label} must be a valid date")

    if timestamp is not None:
        if control.min is not None and timestamp < control.min:
            label = control.label or control.key
            return ValidationResult(valid=False, error=f"{label} is too early")
        if control.max is not None and timestamp > control.max:
            label = control.label or control.key
            return ValidationResult(valid=False, error=f"{label} is too late")

    return ValidationResult(valid=True)


def _validate_select(value: JsonValue, control: FormControl) -> ValidationResult:
    if not control.options or len(control.options) == 0:
        return ValidationResult(valid=True)

    str_value = str(value)
    valid_values = [opt.value for opt in control.options]

    if str_value not in valid_values:
        label = control.label or control.key
        return ValidationResult(
            valid=False,
            error=f"{label} must be one of the available options",
        )

    return ValidationResult(valid=True)


def _validate_text(value: JsonValue, control: FormControl) -> ValidationResult:
    str_value = str(value)
    label = control.label or control.key

    # Pattern
    if control.pattern:
        if not re.search(control.pattern, str_value):
            return ValidationResult(valid=False, error=f"{label} has invalid format")

    # Length
    if control.min_length is not None and len(str_value) < control.min_length:
        return ValidationResult(
            valid=False,
            error=f"{label} must be at least {control.min_length} characters",
        )

    if control.max_length is not None and len(str_value) > control.max_length:
        return ValidationResult(
            valid=False,
            error=f"{label} must be at most {control.max_length} characters",
        )

    # Enum
    if control.enum and len(control.enum) > 0:
        if str_value not in control.enum:
            return ValidationResult(
                valid=False,
                error=f"{label} must be one of: {', '.join(control.enum)}",
            )

    return ValidationResult(valid=True)


def _validate_file(value: JsonValue, control: FormControl) -> ValidationResult:
    if control.file is None:
        return ValidationResult(valid=True)

    files = value if isinstance(value, list) else [value]

    # Max files
    if control.file.max_files is not None and len(files) > control.file.max_files:
        return ValidationResult(
            valid=False,
            error=f"Maximum {control.file.max_files} files allowed",
        )

    for f in files:
        if not f or not isinstance(f, dict):
            continue

        # Max size
        if control.file.max_size is not None:
            size = f.get("size")
            if isinstance(size, (int, float)) and size > control.file.max_size:
                return ValidationResult(
                    valid=False,
                    error=f"File size exceeds maximum of {_format_bytes(control.file.max_size)}",
                )

        # MIME types
        if control.file.accept:
            mime_type = f.get("mimeType") or f.get("mime_type")
            if mime_type:
                accepted = any(matches_mime_type(mime_type, p) for p in control.file.accept)
                if not accepted:
                    return ValidationResult(
                        valid=False,
                        error=f"File type {mime_type} is not accepted",
                    )

    return ValidationResult(valid=True)


# ============================================================================
# HELPERS
# ============================================================================


def matches_mime_type(mime_type: str, pattern: str) -> bool:
    """Check if a MIME type matches a pattern.

    Supports exact match (``image/png``), wildcard (``image/*``),
    and universal (``*/*``).
    """
    if pattern == "*/*":
        return True
    if pattern.endswith("/*"):
        prefix = pattern[:-1]  # "image/" from "image/*"
        return mime_type.startswith(prefix)
    return mime_type == pattern


def _format_bytes(num_bytes: int) -> str:
    if num_bytes < 1024:
        return f"{num_bytes} B"
    if num_bytes < 1024 * 1024:
        return f"{num_bytes / 1024:.1f} KB"
    if num_bytes < 1024 * 1024 * 1024:
        return f"{num_bytes / (1024 * 1024):.1f} MB"
    return f"{num_bytes / (1024 * 1024 * 1024):.1f} GB"


# ============================================================================
# VALUE PARSING
# ============================================================================


def parse_value(value: str, control: FormControl) -> JsonValue:
    """Parse a string value to the appropriate type based on control type."""
    handler = _type_handlers.get(control.type)
    if handler is not None and handler._parse is not None:
        return handler.parse(value)

    if control.type == "number":
        cleaned = re.sub(r"[,$]", "", value)
        try:
            return float(cleaned)
        except ValueError:
            return value

    if control.type == "boolean":
        return value.lower() in {"true", "yes", "1", "on"}

    if control.type == "date":
        for fmt in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
            try:
                dt = datetime.strptime(value, fmt)
                return dt.strftime("%Y-%m-%dT%H:%M:%S") + "Z" if "T" in value else dt.strftime("%Y-%m-%d")
            except ValueError:
                continue
        return value

    # text, email, select, default
    return value


# ============================================================================
# VALUE FORMATTING
# ============================================================================


def format_value(value: JsonValue, control: FormControl) -> str:
    """Format a value for display."""
    if value is None:
        return ""

    handler = _type_handlers.get(control.type)
    if handler is not None and handler._format is not None:
        return handler.format(value)

    # Sensitive masking
    if control.sensitive:
        str_val = str(value)
        if len(str_val) > 8:
            return f"{str_val[:4]}...{str_val[-4:]}"
        return "****"

    if control.type == "number":
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return f"{value:,}" if isinstance(value, int) else f"{value:,.2f}" if value != int(value) else f"{int(value):,}"
        return str(value)

    if control.type == "boolean":
        return "Yes" if value else "No"

    if control.type == "date":
        return str(value)

    if control.type == "select":
        if control.options:
            for opt in control.options:
                if opt.value == str(value):
                    return opt.label
        return str(value)

    if control.type == "file":
        if isinstance(value, list):
            return ", ".join(
                (f.get("name", "file") if isinstance(f, dict) else "file") for f in value
            )
        if isinstance(value, dict):
            return value.get("name", "file")  # type: ignore[return-value]
        return "file"

    return str(value)
