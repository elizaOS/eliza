"""Form capability -- conversational form management.

Provides agent-guided user journeys with field extraction, session tracking,
built-in control types, and lifecycle management.
"""

from .actions import form_restore_action
from .builtins import (
    BUILTIN_TYPE_MAP,
    BUILTIN_TYPES,
    ControlType,
    get_builtin_type,
    is_builtin_type,
    register_builtin_types,
)
from .evaluators import form_evaluator
from .intent import (
    has_data_to_extract,
    is_lifecycle_intent,
    is_ux_intent,
    quick_intent_detect,
)
from .providers import form_context_provider
from .service import FormService
from .types import (
    FORM_AUTOFILL_COMPONENT,
    FORM_CONTROL_DEFAULTS,
    FORM_DEFINITION_DEFAULTS,
    FORM_SESSION_COMPONENT,
    FORM_SUBMISSION_COMPONENT,
    ExternalActivation,
    ExternalFieldState,
    ExtractionResult,
    FieldHistoryEntry,
    FieldState,
    FilledFieldSummary,
    FormAutofillData,
    FormContextState,
    FormControl,
    FormControlDependency,
    FormControlFileOptions,
    FormControlI18n,
    FormControlOption,
    FormControlUI,
    FormDefinition,
    FormDefinitionHooks,
    FormDefinitionI18n,
    FormDefinitionNudge,
    FormDefinitionTTL,
    FormDefinitionUX,
    FormSession,
    FormSubmission,
    IntentResult,
    MissingFieldSummary,
    PendingExternalFieldSummary,
    SessionEffort,
    UncertainFieldSummary,
    ValidationResult,
)

__all__ = [
    # Service
    "FormService",
    # Actions
    "form_restore_action",
    # Evaluators
    "form_evaluator",
    # Providers
    "form_context_provider",
    # Builtins
    "BUILTIN_TYPE_MAP",
    "BUILTIN_TYPES",
    "ControlType",
    "get_builtin_type",
    "is_builtin_type",
    "register_builtin_types",
    # Intent
    "has_data_to_extract",
    "is_lifecycle_intent",
    "is_ux_intent",
    "quick_intent_detect",
    # Types
    "ExternalActivation",
    "ExternalFieldState",
    "ExtractionResult",
    "FieldHistoryEntry",
    "FieldState",
    "FilledFieldSummary",
    "FormAutofillData",
    "FormContextState",
    "FormControl",
    "FormControlDependency",
    "FormControlFileOptions",
    "FormControlI18n",
    "FormControlOption",
    "FormControlUI",
    "FormDefinition",
    "FormDefinitionHooks",
    "FormDefinitionI18n",
    "FormDefinitionNudge",
    "FormDefinitionTTL",
    "FormDefinitionUX",
    "FormSession",
    "FormSubmission",
    "IntentResult",
    "MissingFieldSummary",
    "PendingExternalFieldSummary",
    "SessionEffort",
    "UncertainFieldSummary",
    "ValidationResult",
    "FORM_AUTOFILL_COMPONENT",
    "FORM_CONTROL_DEFAULTS",
    "FORM_DEFINITION_DEFAULTS",
    "FORM_SESSION_COMPONENT",
    "FORM_SUBMISSION_COMPONENT",
]
