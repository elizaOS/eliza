"""
Core type definitions for the Form Plugin.

Forms are **guardrails for agent-guided user journeys**.

- FormDefinition = The journey map (what stops are required)
- FormControl = A stop on the journey (what info to collect)
- FormSession = Progress through the journey (where we are)
- FormSubmission = Journey complete (the outcome)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Literal, Protocol, Union

# ---------------------------------------------------------------------------
# JSON-compatible value type (mirrors JsonValue from @elizaos/core)
# ---------------------------------------------------------------------------
JsonValue = Union[str, int, float, bool, None, list["JsonValue"], dict[str, "JsonValue"]]

# ---------------------------------------------------------------------------
# UUID is just a string alias in the Python port
# ---------------------------------------------------------------------------
UUID = str

# ---------------------------------------------------------------------------
# Field state status
# ---------------------------------------------------------------------------
FieldStatus = Literal["empty", "filled", "uncertain", "invalid", "skipped", "pending"]

# ---------------------------------------------------------------------------
# Session status
# ---------------------------------------------------------------------------
SessionStatus = Literal["active", "ready", "submitted", "stashed", "cancelled", "expired"]

# ---------------------------------------------------------------------------
# Form definition status
# ---------------------------------------------------------------------------
FormStatus = Literal["draft", "active", "deprecated"]

# ---------------------------------------------------------------------------
# Field value source
# ---------------------------------------------------------------------------
FieldSource = Literal["extraction", "autofill", "default", "manual", "correction", "external"]

# ---------------------------------------------------------------------------
# External state status
# ---------------------------------------------------------------------------
ExternalStatus = Literal["pending", "confirmed", "failed", "expired"]

# ---------------------------------------------------------------------------
# Dependency condition
# ---------------------------------------------------------------------------
DependencyCondition = Literal["exists", "equals", "not_equals"]

# ---------------------------------------------------------------------------
# Form intent
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


# ============================================================================
# FORM CONTROL – individual field definition
# ============================================================================


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
    condition: DependencyCondition
    value: JsonValue = None


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
    """Central field abstraction.

    Each FormControl defines what data to collect, how to validate it,
    how the agent should ask for it, and how to store it.
    """

    # Identity
    key: str
    label: str = ""
    type: str = "text"

    # Behavior
    required: bool = False
    multiple: bool = False
    readonly: bool = False
    hidden: bool = False
    sensitive: bool = False

    # Database binding
    dbbind: str | None = None

    # Validation
    pattern: str | None = None
    min: float | None = None
    max: float | None = None
    min_length: int | None = None
    max_length: int | None = None
    enum: list[str] | None = None

    # Select options
    options: list[FormControlOption] | None = None

    # File options
    file: FormControlFileOptions | None = None

    # Defaults & conditions
    default_value: JsonValue = None
    depends_on: FormControlDependency | None = None

    # Access control
    roles: list[str] | None = None

    # Agent hints
    description: str | None = None
    ask_prompt: str | None = None
    extract_hints: list[str] | None = None
    confirm_threshold: float | None = None
    example: str | None = None

    # UI hints
    ui: FormControlUI | None = None

    # I18n
    i18n: dict[str, FormControlI18n] | None = None

    # Nested fields
    fields: list[FormControl] | None = None

    # Extension
    meta: dict[str, JsonValue] | None = None


# ============================================================================
# FORM DEFINITION – the container for controls
# ============================================================================


@dataclass
class FormDefinitionUX:
    """UX options for the form."""

    allow_undo: bool = True
    allow_skip: bool = True
    max_undo_steps: int = 5
    show_examples: bool = True
    show_explanations: bool = True
    allow_autofill: bool = True


@dataclass
class FormDefinitionTTL:
    """Smart TTL configuration."""

    min_days: int = 14
    max_days: int = 90
    effort_multiplier: float = 0.5


@dataclass
class FormDefinitionNudge:
    """Nudge configuration for stale sessions."""

    enabled: bool = True
    after_inactive_hours: int = 48
    max_nudges: int = 3
    message: str | None = None


@dataclass
class FormDefinitionHooks:
    """Hook configuration (task worker names)."""

    on_start: str | None = None
    on_field_change: str | None = None
    on_ready: str | None = None
    on_submit: str | None = None
    on_cancel: str | None = None
    on_expire: str | None = None


@dataclass
class FormDefinitionI18n:
    """Localization for the form."""

    name: str | None = None
    description: str | None = None


@dataclass
class FormDefinition:
    """The form container – defines a complete form."""

    # Identity
    id: str
    name: str
    controls: list[FormControl] = field(default_factory=list)
    description: str | None = None
    version: int = 1

    # Lifecycle
    status: FormStatus = "active"

    # Permissions
    roles: list[str] | None = None

    # Behavior
    allow_multiple: bool = False

    # UX options
    ux: FormDefinitionUX | None = None

    # TTL (smart retention)
    ttl: FormDefinitionTTL | None = None

    # Nudge
    nudge: FormDefinitionNudge | None = None

    # Hooks
    hooks: FormDefinitionHooks | None = None

    # Debug
    debug: bool = False

    # I18n
    i18n: dict[str, FormDefinitionI18n] | None = None

    # Extension
    meta: dict[str, JsonValue] | None = None


# ============================================================================
# FIELD STATE – runtime state of a single field
# ============================================================================


@dataclass
class FieldFile:
    """File attachment metadata."""

    id: str
    name: str
    mime_type: str
    size: int
    url: str


@dataclass
class ExternalFieldState:
    """State tracking for external/async control types."""

    status: ExternalStatus
    reference: str | None = None
    instructions: str | None = None
    address: str | None = None
    activated_at: int | None = None
    confirmed_at: int | None = None
    external_data: dict[str, JsonValue] | None = None


@dataclass
class FieldState:
    """Runtime state of a field."""

    # Status
    status: FieldStatus = "empty"

    # Value
    value: JsonValue = None

    # Confidence
    confidence: float | None = None
    alternatives: list[JsonValue] | None = None

    # Validation
    error: str | None = None

    # Files
    files: list[FieldFile] | None = None

    # Audit trail
    source: FieldSource | None = None
    message_id: str | None = None
    updated_at: int | None = None
    confirmed_at: int | None = None

    # Composite types
    sub_fields: dict[str, FieldState] | None = None

    # External types
    external_state: ExternalFieldState | None = None

    # Extension
    meta: dict[str, JsonValue] | None = None


# ============================================================================
# FORM SESSION – active form being filled
# ============================================================================


@dataclass
class FieldHistoryEntry:
    """History entry for undo functionality."""

    field: str
    old_value: JsonValue
    new_value: JsonValue
    timestamp: int


@dataclass
class SessionEffort:
    """Effort tracking for smart TTL."""

    interaction_count: int = 0
    time_spent_ms: int = 0
    first_interaction_at: int = 0
    last_interaction_at: int = 0


@dataclass
class FormSession:
    """Active form state."""

    # Identity
    id: str
    form_id: str
    form_version: int | None = None

    # Scoping
    entity_id: UUID = ""
    room_id: UUID = ""

    # Status
    status: SessionStatus = "active"

    # Field data
    fields: dict[str, FieldState] = field(default_factory=dict)

    # History (for undo)
    history: list[FieldHistoryEntry] = field(default_factory=list)

    # Hierarchy
    parent_session_id: str | None = None

    # Context
    context: dict[str, JsonValue] | None = None
    locale: str | None = None

    # Tracking
    last_asked_field: str | None = None
    last_message_id: str | None = None
    cancel_confirmation_asked: bool = False

    # Effort (for smart TTL)
    effort: SessionEffort = field(default_factory=SessionEffort)

    # TTL
    expires_at: int = 0
    expiration_warned: bool = False
    nudge_count: int = 0
    last_nudge_at: int | None = None

    # Timestamps
    created_at: int = 0
    updated_at: int = 0
    submitted_at: int | None = None

    # Extension
    meta: dict[str, JsonValue] | None = None


# ============================================================================
# FORM SUBMISSION – completed form data
# ============================================================================


@dataclass
class FormSubmission:
    """Completed form record."""

    id: str
    form_id: str
    session_id: str
    entity_id: UUID
    values: dict[str, JsonValue] = field(default_factory=dict)
    form_version: int | None = None
    mapped_values: dict[str, JsonValue] | None = None
    files: dict[str, list[FieldFile]] | None = None
    submitted_at: int = 0
    meta: dict[str, JsonValue] | None = None


# ============================================================================
# VALIDATION RESULT
# ============================================================================


@dataclass
class ValidationResult:
    """Standardised validation output."""

    valid: bool
    error: str | None = None


# ============================================================================
# FORM CONTEXT STATE – provider output
# ============================================================================


@dataclass
class FormContextState:
    """Provider output for agent."""

    has_active_form: bool = False
    form_id: str | None = None
    form_name: str | None = None
    progress: int = 0
    filled_fields: list[dict[str, str]] = field(default_factory=list)
    missing_required: list[dict[str, str | None]] = field(default_factory=list)
    uncertain_fields: list[dict[str, JsonValue]] = field(default_factory=list)
    next_field: FormControl | None = None
    status: SessionStatus | None = None
    stashed_count: int = 0
    pending_cancel_confirmation: bool = False
    pending_external_fields: list[dict[str, JsonValue]] = field(default_factory=list)


# ============================================================================
# EXTRACTION / INTENT RESULTS
# ============================================================================


@dataclass
class ExtractionResult:
    """Extraction result for a single field."""

    field: str
    value: JsonValue
    confidence: float
    reasoning: str | None = None
    alternatives: list[JsonValue] | None = None
    is_correction: bool = False


@dataclass
class IntentResult:
    """Combined intent and extraction result."""

    intent: FormIntent
    extractions: list[ExtractionResult] = field(default_factory=list)
    target_form_id: str | None = None


# ============================================================================
# TYPE HANDLER PROTOCOL (legacy)
# ============================================================================


class TypeHandler(Protocol):
    """Custom type behaviour (legacy interface)."""

    def validate(self, value: JsonValue, control: FormControl) -> ValidationResult: ...
    def parse(self, value: str) -> JsonValue: ...
    def format(self, value: JsonValue) -> str: ...
    extraction_prompt: str | None


# ============================================================================
# DEFAULTS
# ============================================================================


FORM_CONTROL_DEFAULTS: dict[str, JsonValue] = {
    "type": "text",
    "required": False,
    "confirm_threshold": 0.8,
}

FORM_DEFINITION_DEFAULTS: dict[str, JsonValue] = {
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

FORM_SESSION_COMPONENT = "form_session"
FORM_SUBMISSION_COMPONENT = "form_submission"
FORM_AUTOFILL_COMPONENT = "form_autofill"
