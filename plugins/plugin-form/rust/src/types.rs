//! Core type definitions for the Form Plugin.
//!
//! Forms are guardrails for agent-guided user journeys.
//!
//! - **FormDefinition** = The journey map (what stops are required)
//! - **FormControl** = A stop on the journey (what info to collect)
//! - **FormSession** = Progress through the journey (where we are)
//! - **FormSubmission** = Journey complete (the outcome)

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;

// ============================================================================
// FORM CONTROL - Individual field definition
// ============================================================================

/// Select/choice option for select-type fields.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FormControlOption {
    pub value: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// File upload configuration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct FormControlFileOptions {
    /// MIME type patterns, e.g., ["image/*", "application/pdf"]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accept: Option<Vec<String>>,
    /// Maximum file size in bytes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_size: Option<u64>,
    /// Maximum number of files (for multiple uploads).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_files: Option<usize>,
}

/// Conditional field dependency condition.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DependencyCondition {
    Exists,
    Equals,
    NotEquals,
}

/// Conditional field dependency.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FormControlDependency {
    /// Key of the field this one depends on.
    pub field: String,
    /// When should this field be shown/asked.
    pub condition: DependencyCondition,
    /// Value to compare against for equals/not_equals.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<JsonValue>,
}

/// UI hints for future frontends.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct FormControlUI {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub help_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub widget: Option<String>,
}

/// Localization for a field.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct FormControlI18n {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ask_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub help_text: Option<String>,
}

/// FormControl - The central field abstraction.
///
/// Each FormControl defines what data to collect, how to validate it,
/// how the agent should ask for it, and how to store it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FormControl {
    // ═══ IDENTITY ═══
    /// Unique key within the form.
    pub key: String,
    /// Human-readable label.
    pub label: String,
    /// Field type. Built-in: text, number, email, boolean, select, date, file.
    #[serde(rename = "type")]
    pub type_name: String,

    // ═══ BEHAVIOR ═══
    #[serde(default)]
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multiple: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub readonly: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sensitive: Option<bool>,

    // ═══ DATABASE BINDING ═══
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dbbind: Option<String>,

    // ═══ VALIDATION ═══
    /// Regex pattern for validation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    /// Minimum value (for numbers) or minimum length (for strings).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    /// Maximum value (for numbers) or maximum length (for strings).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    /// Minimum string length.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_length: Option<usize>,
    /// Maximum string length.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_length: Option<usize>,
    /// Allowed string values (enum).
    #[serde(rename = "enum", skip_serializing_if = "Option::is_none")]
    pub enum_values: Option<Vec<String>>,

    // ═══ SELECT OPTIONS ═══
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<FormControlOption>>,

    // ═══ FILE OPTIONS ═══
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<FormControlFileOptions>,

    // ═══ DEFAULTS & CONDITIONS ═══
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_value: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depends_on: Option<FormControlDependency>,

    // ═══ ACCESS CONTROL ═══
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roles: Option<Vec<String>>,

    // ═══ AGENT HINTS ═══
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ask_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extract_hints: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirm_threshold: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub example: Option<String>,

    // ═══ UI HINTS ═══
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui: Option<FormControlUI>,

    // ═══ I18N ═══
    #[serde(skip_serializing_if = "Option::is_none")]
    pub i18n: Option<HashMap<String, FormControlI18n>>,

    // ═══ NESTED FIELDS ═══
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<FormControl>>,

    // ═══ EXTENSION ═══
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<HashMap<String, JsonValue>>,
}

impl Default for FormControl {
    fn default() -> Self {
        Self {
            key: String::new(),
            label: String::new(),
            type_name: "text".to_string(),
            required: false,
            multiple: None,
            readonly: None,
            hidden: None,
            sensitive: None,
            dbbind: None,
            pattern: None,
            min: None,
            max: None,
            min_length: None,
            max_length: None,
            enum_values: None,
            options: None,
            file: None,
            default_value: None,
            depends_on: None,
            roles: None,
            description: None,
            ask_prompt: None,
            extract_hints: None,
            confirm_threshold: None,
            example: None,
            ui: None,
            i18n: None,
            fields: None,
            meta: None,
        }
    }
}

// ============================================================================
// FORM DEFINITION
// ============================================================================

/// UX options for the form.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FormDefinitionUX {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_undo: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_skip: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_undo_steps: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub show_examples: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub show_explanations: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_autofill: Option<bool>,
}

impl Default for FormDefinitionUX {
    fn default() -> Self {
        Self {
            allow_undo: Some(true),
            allow_skip: Some(true),
            max_undo_steps: Some(5),
            show_examples: Some(true),
            show_explanations: Some(true),
            allow_autofill: Some(true),
        }
    }
}

/// Smart TTL configuration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FormDefinitionTTL {
    /// Minimum retention in days. Default: 14.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_days: Option<f64>,
    /// Maximum retention in days. Default: 90.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_days: Option<f64>,
    /// Days added per minute of user effort. Default: 0.5.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort_multiplier: Option<f64>,
}

impl Default for FormDefinitionTTL {
    fn default() -> Self {
        Self {
            min_days: Some(14.0),
            max_days: Some(90.0),
            effort_multiplier: Some(0.5),
        }
    }
}

/// Nudge configuration for stale sessions.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FormDefinitionNudge {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// Hours of inactivity before first nudge. Default: 48.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_inactive_hours: Option<f64>,
    /// Maximum nudge messages to send. Default: 3.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_nudges: Option<u32>,
    /// Custom nudge message template.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl Default for FormDefinitionNudge {
    fn default() -> Self {
        Self {
            enabled: Some(true),
            after_inactive_hours: Some(48.0),
            max_nudges: Some(3),
            message: None,
        }
    }
}

/// Hook configuration (task worker names).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct FormDefinitionHooks {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_start: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_field_change: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_ready: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_submit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_cancel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_expire: Option<String>,
}

/// Form definition status.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FormStatus {
    Draft,
    Active,
    Deprecated,
}

impl Default for FormStatus {
    fn default() -> Self {
        FormStatus::Active
    }
}

/// Localization for the form definition.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct FormDefinitionI18n {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// FormDefinition - The form container.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FormDefinition {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    pub controls: Vec<FormControl>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<FormStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roles: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_multiple: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ux: Option<FormDefinitionUX>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttl: Option<FormDefinitionTTL>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nudge: Option<FormDefinitionNudge>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hooks: Option<FormDefinitionHooks>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub i18n: Option<HashMap<String, FormDefinitionI18n>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<HashMap<String, JsonValue>>,
}

impl Default for FormDefinition {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            description: None,
            version: Some(1),
            controls: Vec::new(),
            status: Some(FormStatus::Active),
            roles: None,
            allow_multiple: None,
            ux: Some(FormDefinitionUX::default()),
            ttl: Some(FormDefinitionTTL::default()),
            nudge: Some(FormDefinitionNudge::default()),
            hooks: None,
            debug: Some(false),
            i18n: None,
            meta: None,
        }
    }
}

// ============================================================================
// FIELD STATE - Runtime state of a single field
// ============================================================================

/// Status of a field during collection.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FieldStatus {
    Empty,
    Filled,
    Uncertain,
    Invalid,
    Skipped,
    Pending,
}

impl Default for FieldStatus {
    fn default() -> Self {
        FieldStatus::Empty
    }
}

/// Status of an external async field.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExternalStatus {
    Pending,
    Confirmed,
    Failed,
    Expired,
}

/// State for external/async control types.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExternalFieldState {
    pub status: ExternalStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activated_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmed_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_data: Option<HashMap<String, JsonValue>>,
}

/// File attachment metadata.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FieldFile {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size: u64,
    pub url: String,
}

/// Source of how a field value was obtained.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FieldSource {
    Extraction,
    Autofill,
    Default,
    Manual,
    Correction,
    External,
}

/// FieldState - Runtime state of a field.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FieldState {
    pub status: FieldStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alternatives: Option<Vec<JsonValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<FieldFile>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<FieldSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmed_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sub_fields: Option<HashMap<String, FieldState>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_state: Option<ExternalFieldState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<HashMap<String, JsonValue>>,
}

impl Default for FieldState {
    fn default() -> Self {
        Self {
            status: FieldStatus::Empty,
            value: None,
            confidence: None,
            alternatives: None,
            error: None,
            files: None,
            source: None,
            message_id: None,
            updated_at: None,
            confirmed_at: None,
            sub_fields: None,
            external_state: None,
            meta: None,
        }
    }
}

// ============================================================================
// FORM SESSION
// ============================================================================

/// History entry for undo functionality.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FieldHistoryEntry {
    pub field: String,
    pub old_value: JsonValue,
    pub new_value: JsonValue,
    pub timestamp: i64,
}

/// Effort tracking for smart TTL.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionEffort {
    pub interaction_count: u32,
    pub time_spent_ms: i64,
    pub first_interaction_at: i64,
    pub last_interaction_at: i64,
}

impl Default for SessionEffort {
    fn default() -> Self {
        let now = chrono::Utc::now().timestamp_millis();
        Self {
            interaction_count: 0,
            time_spent_ms: 0,
            first_interaction_at: now,
            last_interaction_at: now,
        }
    }
}

/// Session lifecycle status.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Active,
    Ready,
    Submitted,
    Stashed,
    Cancelled,
    Expired,
}

impl Default for SessionStatus {
    fn default() -> Self {
        SessionStatus::Active
    }
}

/// FormSession - Active form state.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FormSession {
    pub id: String,
    pub form_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub form_version: Option<u32>,
    pub entity_id: String,
    pub room_id: String,
    pub status: SessionStatus,
    pub fields: HashMap<String, FieldState>,
    pub history: Vec<FieldHistoryEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<HashMap<String, JsonValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_asked_field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancel_confirmation_asked: Option<bool>,
    pub effort: SessionEffort,
    pub expires_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expiration_warned: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nudge_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_nudge_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submitted_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<HashMap<String, JsonValue>>,
}

// ============================================================================
// FORM SUBMISSION
// ============================================================================

/// FormSubmission - Completed form record.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FormSubmission {
    pub id: String,
    pub form_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub form_version: Option<u32>,
    pub session_id: String,
    pub entity_id: String,
    pub values: HashMap<String, JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mapped_values: Option<HashMap<String, JsonValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<HashMap<String, Vec<FieldFile>>>,
    pub submitted_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<HashMap<String, JsonValue>>,
}

// ============================================================================
// VALIDATION
// ============================================================================

/// Standardized validation output.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ValidationResult {
    pub valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ValidationResult {
    /// Create a valid result.
    pub fn ok() -> Self {
        Self { valid: true, error: None }
    }

    /// Create an invalid result with an error message.
    pub fn err(msg: impl Into<String>) -> Self {
        Self { valid: false, error: Some(msg.into()) }
    }
}

// ============================================================================
// INTENT SYSTEM
// ============================================================================

/// All supported user intents.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FormIntent {
    // Lifecycle
    FillForm,
    Submit,
    Stash,
    Restore,
    Cancel,
    // UX Magic
    Undo,
    Skip,
    Explain,
    Example,
    Progress,
    Autofill,
    // Fallback
    Other,
}

/// Extraction result for a single field.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExtractionResult {
    pub field: String,
    pub value: JsonValue,
    pub confidence: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alternatives: Option<Vec<JsonValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_correction: Option<bool>,
}

/// Combined intent and extraction result.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IntentResult {
    pub intent: FormIntent,
    pub extractions: Vec<ExtractionResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_form_id: Option<String>,
}

// ============================================================================
// CONSTANTS / DEFAULTS
// ============================================================================

/// Default values for FormControl fields.
pub fn form_control_defaults() -> FormControl {
    FormControl {
        key: String::new(),
        label: String::new(),
        type_name: "text".to_string(),
        required: false,
        confirm_threshold: Some(0.8),
        ..Default::default()
    }
}

/// Default values for FormDefinition fields.
pub fn form_definition_defaults() -> FormDefinition {
    FormDefinition::default()
}

/// Default TTL min days.
pub const DEFAULT_TTL_MIN_DAYS: f64 = 14.0;
/// Default TTL max days.
pub const DEFAULT_TTL_MAX_DAYS: f64 = 90.0;
/// Default TTL effort multiplier.
pub const DEFAULT_TTL_EFFORT_MULTIPLIER: f64 = 0.5;
/// Default nudge after inactive hours.
pub const DEFAULT_NUDGE_AFTER_INACTIVE_HOURS: f64 = 48.0;
/// Default max nudges.
pub const DEFAULT_NUDGE_MAX_NUDGES: u32 = 3;
/// Default confirm threshold.
pub const DEFAULT_CONFIRM_THRESHOLD: f64 = 0.8;
