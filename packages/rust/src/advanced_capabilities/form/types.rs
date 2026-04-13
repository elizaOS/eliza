//! Form types — Rust port of the TypeScript form/types.ts.
//!
//! Forms are guardrails for agent-guided user journeys:
//! - FormDefinition = the journey map (what stops are required)
//! - FormControl = a stop on the journey (what info to collect)
//! - FormSession = progress through the journey (where we are)
//! - FormSubmission = journey complete (the outcome)

use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ============================================================================
// FORM CONTROL
// ============================================================================

/// Select/choice option for select-type fields.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormControlOption {
    pub value: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// File upload configuration.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormControlFileOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accept: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_files: Option<u32>,
}

/// Conditional field dependency.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormControlDependency {
    pub field: String,
    pub condition: FormDependencyCondition,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
}

/// Condition type for field dependencies.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FormDependencyCondition {
    Exists,
    Equals,
    NotEquals,
}

/// UI hints for future frontends.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormControlUI {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub help_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub widget: Option<String>,
}

/// A single form field definition.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormControl {
    // Identity
    pub key: String,
    pub label: String,
    #[serde(rename = "type", default = "default_control_type")]
    pub control_type: String,

    // Behavior
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub multiple: bool,
    #[serde(default)]
    pub readonly: bool,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub sensitive: bool,

    // Database binding
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dbbind: Option<String>,

    // Validation
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_length: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_length: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enum_values: Option<Vec<String>>,

    // Select options
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<FormControlOption>>,

    // File options
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<FormControlFileOptions>,

    // Defaults & conditions
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_value: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depends_on: Option<FormControlDependency>,

    // Access control
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roles: Option<Vec<String>>,

    // Agent hints
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ask_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extract_hints: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_threshold: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub example: Option<String>,

    // UI hints
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui: Option<FormControlUI>,

    // Nested fields
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<FormControl>>,

    // Extension
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Value>,
}

fn default_control_type() -> String {
    "text".to_string()
}

// ============================================================================
// FORM DEFINITION
// ============================================================================

/// UX options for form interaction.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormDefinitionUX {
    #[serde(default = "default_true")]
    pub allow_undo: bool,
    #[serde(default = "default_true")]
    pub allow_skip: bool,
    #[serde(default = "default_max_undo")]
    pub max_undo_steps: usize,
    #[serde(default = "default_true")]
    pub show_examples: bool,
    #[serde(default = "default_true")]
    pub show_explanations: bool,
    #[serde(default = "default_true")]
    pub allow_autofill: bool,
}

impl Default for FormDefinitionUX {
    fn default() -> Self {
        Self {
            allow_undo: true,
            allow_skip: true,
            max_undo_steps: 5,
            show_examples: true,
            show_explanations: true,
            allow_autofill: true,
        }
    }
}

/// Smart TTL configuration based on user effort.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormDefinitionTTL {
    #[serde(default = "default_min_days")]
    pub min_days: u32,
    #[serde(default = "default_max_days")]
    pub max_days: u32,
    #[serde(default = "default_effort_multiplier")]
    pub effort_multiplier: f64,
}

impl Default for FormDefinitionTTL {
    fn default() -> Self {
        Self {
            min_days: 14,
            max_days: 90,
            effort_multiplier: 0.5,
        }
    }
}

/// Nudge configuration for inactive forms.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormDefinitionNudge {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_inactive_hours")]
    pub after_inactive_hours: u32,
    #[serde(default = "default_max_nudges")]
    pub max_nudges: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl Default for FormDefinitionNudge {
    fn default() -> Self {
        Self {
            enabled: true,
            after_inactive_hours: 48,
            max_nudges: 3,
            message: None,
        }
    }
}

/// Lifecycle hook names.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormDefinitionHooks {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_start: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_field_change: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_ready: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_submit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_cancel: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_expire: Option<String>,
}

/// Form definition status.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FormDefinitionStatus {
    Draft,
    Active,
    Deprecated,
}

/// Container for form controls: the journey map.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormDefinition {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default = "default_version")]
    pub version: u32,

    pub controls: Vec<FormControl>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<FormDefinitionStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roles: Option<Vec<String>>,
    #[serde(default)]
    pub allow_multiple: bool,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ux: Option<FormDefinitionUX>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl: Option<FormDefinitionTTL>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nudge: Option<FormDefinitionNudge>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hooks: Option<FormDefinitionHooks>,
    #[serde(default)]
    pub debug: bool,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Value>,
}

// ============================================================================
// FIELD STATE
// ============================================================================

/// Runtime status of a single field.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FieldStatus {
    Empty,
    Filled,
    Uncertain,
    Invalid,
    Skipped,
    Pending,
}

/// Source of a field value.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FieldSource {
    Extraction,
    Autofill,
    Default,
    Manual,
    Correction,
    External,
}

/// Runtime state of a single field.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldState {
    pub status: FieldStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alternatives: Option<Vec<serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<FieldSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmed_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sub_fields: Option<std::collections::HashMap<String, FieldState>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Value>,
}

// ============================================================================
// FORM SESSION
// ============================================================================

/// Undo history entry.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldHistoryEntry {
    pub field: String,
    pub old_value: serde_json::Value,
    pub new_value: serde_json::Value,
    pub timestamp: i64,
}

/// Effort tracking for smart TTL.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEffort {
    pub interaction_count: u32,
    pub time_spent_ms: i64,
    pub first_interaction_at: i64,
    pub last_interaction_at: i64,
}

/// Session status.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FormSessionStatus {
    Active,
    Ready,
    Submitted,
    Stashed,
    Cancelled,
    Expired,
}

/// An active form being filled.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormSession {
    pub id: String,
    pub form_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub form_version: Option<u32>,

    pub entity_id: Uuid,
    pub room_id: Uuid,

    pub status: FormSessionStatus,

    pub fields: std::collections::HashMap<String, FieldState>,
    #[serde(default)]
    pub history: Vec<FieldHistoryEntry>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_asked_field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message_id: Option<String>,
    #[serde(default)]
    pub cancel_confirmation_asked: bool,

    #[serde(default)]
    pub effort: SessionEffort,

    pub expires_at: i64,
    #[serde(default)]
    pub expiration_warned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nudge_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_nudge_at: Option<i64>,

    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submitted_at: Option<i64>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Value>,
}

// ============================================================================
// FORM SUBMISSION
// ============================================================================

/// Completed form data.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormSubmission {
    pub id: String,
    pub form_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub form_version: Option<u32>,
    pub session_id: String,
    pub entity_id: Uuid,

    pub values: std::collections::HashMap<String, serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mapped_values: Option<std::collections::HashMap<String, serde_json::Value>>,

    pub submitted_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Value>,
}

// ============================================================================
// CONTEXT STATE (provider output)
// ============================================================================

/// Summary of a filled field.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilledFieldSummary {
    pub key: String,
    pub label: String,
    pub display_value: String,
}

/// Summary of a missing required field.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingFieldSummary {
    pub key: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ask_prompt: Option<String>,
}

/// Form context injected into agent state.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormContextState {
    pub has_active_form: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub form_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub form_name: Option<String>,
    pub progress: f64,
    pub filled_fields: Vec<FilledFieldSummary>,
    pub missing_required: Vec<MissingFieldSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<FormSessionStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stashed_count: Option<usize>,
    #[serde(default)]
    pub pending_cancel_confirmation: bool,
}

// ============================================================================
// INTENT / EXTRACTION
// ============================================================================

/// User intent within a form context.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FormIntent {
    FillForm,
    Submit,
    Stash,
    Restore,
    Cancel,
    Undo,
    Skip,
    Explain,
    Example,
    Progress,
    Autofill,
    Other,
}

/// Result of extracting a field value from user input.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractionResult {
    pub field: String,
    pub value: serde_json::Value,
    pub confidence: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alternatives: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    pub is_correction: bool,
}

// ============================================================================
// Defaults helpers
// ============================================================================

fn default_true() -> bool {
    true
}
fn default_max_undo() -> usize {
    5
}
fn default_min_days() -> u32 {
    14
}
fn default_max_days() -> u32 {
    90
}
fn default_effort_multiplier() -> f64 {
    0.5
}
fn default_inactive_hours() -> u32 {
    48
}
fn default_max_nudges() -> u32 {
    3
}
fn default_version() -> u32 {
    1
}
