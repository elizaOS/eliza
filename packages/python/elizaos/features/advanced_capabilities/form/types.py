"""Core type definitions for the Form capability.

Forms are guardrails for agent-guided user journeys:
- FormDefinition = the journey map (what stops are required)
- FormControl = a stop on the journey (what info to collect)
- FormSession = progress through the journey (where we are)
- FormSubmission = journey complete (the outcome)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

FORM_SESSION_COMPONENT = "form_session"
FORM_SUBMISSION_COMPONENT = "form_submission"
FORM_AUTOFILL_COMPONENT = "form_autofill"

# ---------------------------------------------------------------------------
# Control-level types
# ---------------------------------------------------------------------------

FormIntent = Literal[
    "fill_form",
    "submit",
    "stash",
    "restore",
    "cancel",
    "undo",
    "skip",
    "explain",
    "example",
    "progress",
    "autofill",
    "other",
]

FieldStatus = Literal["empty", "filled", "uncertain", "invalid", "skipped", "pending"]

FieldSource = Literal["extraction", "autofill", "default", "manual", "correction", "external"]

ExternalStatus = Literal["pending", "confirmed", "failed", "expired"]

SessionStatus = Literal["active", "ready", "submitted", "stashed", "cancelled", "expired"]

DependencyCondition = Literal["exists", "equals", "not_equals"]


@dataclass
class FormControlOption:
    """Select/choice option for select-type fields."""

    value: str
    label: str
    description: str | None = None


@dataclass
class FormControlFileOptions:
    """File upload configuration."""

    accept: list[str] | None = None
    max_size: int | None = None
    max_files: int | None = None


@dataclass
class FormControlDependency:
    """Conditional field dependency."""

    field: str
    condition: DependencyCondition = "exists"
    value: Any = None


@dataclass
class FormControlUI:
    """UI hints for future frontends."""

    section: str | None = None
    order: int | None = None
    placeholder: str | None = None
    help_text: str | None = None
    widget: str | None = None


@dataclass
class FormControlI18n:
    """Localization for a field."""

    label: str | None = None
    description: str | None = None
    ask_prompt: str | None = None
    help_text: str | None = None


@dataclass
class FormControl:
    """Central field abstraction -- the heart of the form system."""

    key: str
    label: str
    type: str = "text"
    required: bool = False
    multiple: bool = False
    readonly: bool = False
    hidden: bool = False
    sensitive: bool = False
    dbbind: str | None = None
    pattern: str | None = None
    min: float | None = None
    max: float | None = None
    min_length: int | None = None
    max_length: int | None = None
    enum: list[str] | None = None
    options: list[FormControlOption] | None = None
    file: FormControlFileOptions | None = None
    default_value: Any = None
    depends_on: FormControlDependency | None = None
    roles: list[str] | None = None
    description: str | None = None
    ask_prompt: str | None = None
    extract_hints: list[str] | None = None
    confirm_threshold: float = 0.8
    example: str | None = None
    ui: FormControlUI | None = None
    i18n: dict[str, FormControlI18n] | None = None
    fields: list[FormControl] | None = None
    meta: dict[str, Any] | None = None


# ---------------------------------------------------------------------------
# Form definition types
# ---------------------------------------------------------------------------


@dataclass
class FormDefinitionUX:
    allow_undo: bool = True
    allow_skip: bool = True
    max_undo_steps: int = 5
    show_examples: bool = True
    show_explanations: bool = True
    allow_autofill: bool = True


@dataclass
class FormDefinitionTTL:
    min_days: int = 14
    max_days: int = 90
    effort_multiplier: float = 0.5


@dataclass
class FormDefinitionNudge:
    enabled: bool = True
    after_inactive_hours: int = 48
    max_nudges: int = 3
    message: str | None = None


@dataclass
class FormDefinitionHooks:
    on_start: str | None = None
    on_field_change: str | None = None
    on_ready: str | None = None
    on_submit: str | None = None
    on_cancel: str | None = None
    on_expire: str | None = None


@dataclass
class FormDefinitionI18n:
    name: str | None = None
    description: str | None = None


@dataclass
class FormDefinition:
    """Complete form definition."""

    id: str
    name: str
    controls: list[FormControl]
    description: str | None = None
    version: int = 1
    status: Literal["draft", "active", "deprecated"] = "active"
    roles: list[str] | None = None
    allow_multiple: bool = False
    ux: FormDefinitionUX = field(default_factory=FormDefinitionUX)
    ttl: FormDefinitionTTL = field(default_factory=FormDefinitionTTL)
    nudge: FormDefinitionNudge = field(default_factory=FormDefinitionNudge)
    hooks: FormDefinitionHooks = field(default_factory=FormDefinitionHooks)
    debug: bool = False
    i18n: dict[str, FormDefinitionI18n] | None = None
    meta: dict[str, Any] | None = None


# ---------------------------------------------------------------------------
# Field runtime state
# ---------------------------------------------------------------------------


@dataclass
class ExternalFieldState:
    """State tracking for external/async control types."""

    status: ExternalStatus = "pending"
    reference: str | None = None
    instructions: str | None = None
    address: str | None = None
    activated_at: int | None = None
    confirmed_at: int | None = None
    external_data: dict[str, Any] | None = None


@dataclass
class FieldState:
    """Runtime state of a single field."""

    status: FieldStatus = "empty"
    value: Any = None
    confidence: float | None = None
    alternatives: list[Any] | None = None
    error: str | None = None
    files: list[dict[str, Any]] | None = None
    source: FieldSource | None = None
    message_id: str | None = None
    updated_at: int | None = None
    confirmed_at: int | None = None
    sub_fields: dict[str, FieldState] | None = None
    external_state: ExternalFieldState | None = None
    meta: dict[str, Any] | None = None


@dataclass
class FieldHistoryEntry:
    """History entry for undo functionality."""

    field: str
    old_value: Any
    new_value: Any
    timestamp: int


@dataclass
class SessionEffort:
    """Effort tracking for smart TTL."""

    interaction_count: int = 0
    time_spent_ms: int = 0
    first_interaction_at: int = 0
    last_interaction_at: int = 0


# ---------------------------------------------------------------------------
# Session
# ---------------------------------------------------------------------------


@dataclass
class FormSession:
    """Active form state for a specific user in a specific room."""

    id: str
    form_id: str
    entity_id: str
    room_id: str
    status: SessionStatus = "active"
    form_version: int | None = None
    fields: dict[str, FieldState] = field(default_factory=dict)
    history: list[FieldHistoryEntry] = field(default_factory=list)
    parent_session_id: str | None = None
    context: dict[str, Any] | None = None
    locale: str | None = None
    last_asked_field: str | None = None
    last_message_id: str | None = None
    cancel_confirmation_asked: bool = False
    effort: SessionEffort = field(default_factory=SessionEffort)
    expires_at: int = 0
    expiration_warned: bool = False
    nudge_count: int = 0
    last_nudge_at: int | None = None
    created_at: int = 0
    updated_at: int = 0
    submitted_at: int | None = None
    meta: dict[str, Any] | None = None


# ---------------------------------------------------------------------------
# Submission
# ---------------------------------------------------------------------------


@dataclass
class FormSubmission:
    """Immutable record of a completed form."""

    id: str
    form_id: str
    session_id: str
    entity_id: str
    values: dict[str, Any]
    form_version: int | None = None
    mapped_values: dict[str, Any] | None = None
    files: dict[str, list[dict[str, Any]]] | None = None
    submitted_at: int = 0
    meta: dict[str, Any] | None = None


# ---------------------------------------------------------------------------
# Extraction / intent results
# ---------------------------------------------------------------------------


@dataclass
class ExtractionResult:
    """Extraction result for a single field."""

    field: str
    value: Any
    confidence: float
    reasoning: str | None = None
    alternatives: list[Any] | None = None
    is_correction: bool = False


@dataclass
class IntentResult:
    """Combined intent and extraction result."""

    intent: FormIntent
    extractions: list[ExtractionResult] = field(default_factory=list)
    target_form_id: str | None = None


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


@dataclass
class ValidationResult:
    """Standardized validation output."""

    valid: bool
    error: str | None = None


# ---------------------------------------------------------------------------
# Control type (widget registry entry)
# ---------------------------------------------------------------------------


@dataclass
class ExternalActivation:
    """Result of activating an external control type."""

    instructions: str
    reference: str
    address: str | None = None
    expires_at: int | None = None
    meta: dict[str, Any] | None = None


# ---------------------------------------------------------------------------
# Context provider output
# ---------------------------------------------------------------------------


@dataclass
class FilledFieldSummary:
    key: str
    label: str
    display_value: str


@dataclass
class MissingFieldSummary:
    key: str
    label: str
    description: str | None = None
    ask_prompt: str | None = None


@dataclass
class UncertainFieldSummary:
    key: str
    label: str
    value: Any
    confidence: float


@dataclass
class PendingExternalFieldSummary:
    key: str
    label: str
    instructions: str
    reference: str
    activated_at: int
    address: str | None = None


@dataclass
class FormContextState:
    """Provider output injected into agent context."""

    has_active_form: bool = False
    form_id: str | None = None
    form_name: str | None = None
    progress: float = 0.0
    filled_fields: list[FilledFieldSummary] = field(default_factory=list)
    missing_required: list[MissingFieldSummary] = field(default_factory=list)
    uncertain_fields: list[UncertainFieldSummary] = field(default_factory=list)
    next_field: FormControl | None = None
    status: SessionStatus | None = None
    stashed_count: int = 0
    pending_cancel_confirmation: bool = False
    pending_external_fields: list[PendingExternalFieldSummary] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Autofill
# ---------------------------------------------------------------------------


@dataclass
class FormAutofillData:
    form_id: str
    values: dict[str, Any]
    updated_at: int = 0


# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

FORM_CONTROL_DEFAULTS = {
    "type": "text",
    "required": False,
    "confirm_threshold": 0.8,
}

FORM_DEFINITION_DEFAULTS = {
    "version": 1,
    "status": "active",
    "ux": {
        "allow_undo": True,
        "allow_skip": True,
        "max_undo_steps": 5,
        "show_examples": True,
        "show_explanations": True,
        "allow_autofill": True,
    },
    "ttl": {
        "min_days": 14,
        "max_days": 90,
        "effort_multiplier": 0.5,
    },
    "nudge": {
        "enabled": True,
        "after_inactive_hours": 48,
        "max_nudges": 3,
    },
    "debug": False,
}
