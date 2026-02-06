"""
form_plugin – Guardrails for agent-guided user journeys (Python port).
"""

# Types
from .types import (
    JsonValue,
    UUID,
    FieldStatus,
    SessionStatus,
    FormStatus,
    FieldSource,
    ExternalStatus,
    DependencyCondition,
    FormIntent,
    FormControlOption,
    FormControlFileOptions,
    FormControlDependency,
    FormControlUI,
    FormControlI18n,
    FormControl,
    FormDefinitionUX,
    FormDefinitionTTL,
    FormDefinitionNudge,
    FormDefinitionHooks,
    FormDefinitionI18n,
    FormDefinition,
    FieldFile,
    ExternalFieldState,
    FieldState,
    FieldHistoryEntry,
    SessionEffort,
    FormSession,
    FormSubmission,
    ValidationResult,
    FormContextState,
    ExtractionResult,
    IntentResult,
    FORM_CONTROL_DEFAULTS,
    FORM_DEFINITION_DEFAULTS,
    FORM_SESSION_COMPONENT,
    FORM_SUBMISSION_COMPONENT,
    FORM_AUTOFILL_COMPONENT,
)

# Validation
from .validation import (
    TypeHandler,
    register_type_handler,
    get_type_handler,
    clear_type_handlers,
    validate_field,
    matches_mime_type,
    parse_value,
    format_value,
)

# Intent
from .intent import (
    quick_intent_detect,
    is_lifecycle_intent,
    is_ux_intent,
    has_data_to_extract,
)

# TTL
from .ttl import (
    calculate_ttl,
    should_nudge,
    is_expiring_soon,
    is_expired,
    should_confirm_cancel,
    format_time_remaining,
    format_effort,
)

# Defaults
from .defaults import (
    prettify,
    apply_control_defaults,
    apply_form_defaults,
)

# Builder
from .builder import (
    ControlBuilder,
    FormBuilder,
    Form,
    C,
)

# Template
from .template import (
    TEMPLATE_PATTERN,
    build_template_values,
    render_template,
    resolve_control_templates,
)

# Builtins
from .builtins import (
    BUILTIN_TYPES,
    BUILTIN_TYPE_MAP,
    register_builtin_types,
    get_builtin_type,
    is_builtin_type,
)

__all__ = [
    # Types
    "JsonValue",
    "UUID",
    "FieldStatus",
    "SessionStatus",
    "FormStatus",
    "FieldSource",
    "ExternalStatus",
    "DependencyCondition",
    "FormIntent",
    "FormControlOption",
    "FormControlFileOptions",
    "FormControlDependency",
    "FormControlUI",
    "FormControlI18n",
    "FormControl",
    "FormDefinitionUX",
    "FormDefinitionTTL",
    "FormDefinitionNudge",
    "FormDefinitionHooks",
    "FormDefinitionI18n",
    "FormDefinition",
    "FieldFile",
    "ExternalFieldState",
    "FieldState",
    "FieldHistoryEntry",
    "SessionEffort",
    "FormSession",
    "FormSubmission",
    "ValidationResult",
    "FormContextState",
    "ExtractionResult",
    "IntentResult",
    "FORM_CONTROL_DEFAULTS",
    "FORM_DEFINITION_DEFAULTS",
    "FORM_SESSION_COMPONENT",
    "FORM_SUBMISSION_COMPONENT",
    "FORM_AUTOFILL_COMPONENT",
    # Validation
    "TypeHandler",
    "register_type_handler",
    "get_type_handler",
    "clear_type_handlers",
    "validate_field",
    "matches_mime_type",
    "parse_value",
    "format_value",
    # Intent
    "quick_intent_detect",
    "is_lifecycle_intent",
    "is_ux_intent",
    "has_data_to_extract",
    # TTL
    "calculate_ttl",
    "should_nudge",
    "is_expiring_soon",
    "is_expired",
    "should_confirm_cancel",
    "format_time_remaining",
    "format_effort",
    # Defaults
    "prettify",
    "apply_control_defaults",
    "apply_form_defaults",
    # Builder
    "ControlBuilder",
    "FormBuilder",
    "Form",
    "C",
    # Template
    "TEMPLATE_PATTERN",
    "build_template_values",
    "render_template",
    "resolve_control_templates",
    # Builtins
    "BUILTIN_TYPES",
    "BUILTIN_TYPE_MAP",
    "register_builtin_types",
    "get_builtin_type",
    "is_builtin_type",
]
