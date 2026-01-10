//! Type definitions for the elizaOS Forms Plugin.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

/// Possible types for form fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FormFieldType {
    Text,
    Number,
    Email,
    Tel,
    Url,
    Textarea,
    Choice,
    Checkbox,
    Date,
    Time,
    Datetime,
}

impl Default for FormFieldType {
    fn default() -> Self {
        Self::Text
    }
}

/// Possible statuses for a form.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FormStatus {
    Active,
    Completed,
    Cancelled,
}

impl Default for FormStatus {
    fn default() -> Self {
        Self::Active
    }
}

/// Value types that can be stored in form fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FieldValue {
    String(String),
    Number(f64),
    Boolean(bool),
}

impl From<String> for FieldValue {
    fn from(s: String) -> Self {
        Self::String(s)
    }
}

impl From<&str> for FieldValue {
    fn from(s: &str) -> Self {
        Self::String(s.to_string())
    }
}

impl From<f64> for FieldValue {
    fn from(n: f64) -> Self {
        Self::Number(n)
    }
}

impl From<bool> for FieldValue {
    fn from(b: bool) -> Self {
        Self::Boolean(b)
    }
}

/// Represents a single field in a form.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormField {
    /// Unique identifier for the field.
    pub id: String,
    /// Display label for the field.
    pub label: String,
    /// Field type.
    #[serde(rename = "type")]
    pub field_type: FormFieldType,
    /// Optional field description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Optional validation criteria.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub criteria: Option<String>,
    /// Whether this field is optional.
    #[serde(default)]
    pub optional: bool,
    /// Whether this field contains sensitive data.
    #[serde(default)]
    pub secret: bool,
    /// Current value of the field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<FieldValue>,
    /// Validation error message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Additional metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, serde_json::Value>>,
}

impl FormField {
    /// Create a new form field.
    pub fn new(id: impl Into<String>, label: impl Into<String>, field_type: FormFieldType) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            field_type,
            description: None,
            criteria: None,
            optional: false,
            secret: false,
            value: None,
            error: None,
            metadata: None,
        }
    }

    /// Set the description.
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Set the criteria.
    pub fn with_criteria(mut self, criteria: impl Into<String>) -> Self {
        self.criteria = Some(criteria.into());
        self
    }

    /// Mark as optional.
    pub fn optional(mut self) -> Self {
        self.optional = true;
        self
    }

    /// Mark as secret.
    pub fn secret(mut self) -> Self {
        self.secret = true;
        self
    }
}

/// Represents a step in a multi-step form.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormStep {
    /// Unique identifier for the step.
    pub id: String,
    /// Display name for the step.
    pub name: String,
    /// Fields in this step.
    pub fields: Vec<FormField>,
    /// Whether this step is completed.
    #[serde(default)]
    pub completed: bool,
}

impl FormStep {
    /// Create a new form step.
    pub fn new(id: impl Into<String>, name: impl Into<String>, fields: Vec<FormField>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            fields,
            completed: false,
        }
    }
}

/// Represents a complete form instance.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Form {
    /// Unique identifier for the form.
    pub id: Uuid,
    /// Form name/type.
    pub name: String,
    /// Optional form description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Steps in the form.
    pub steps: Vec<FormStep>,
    /// Current step index.
    pub current_step_index: usize,
    /// Form status.
    pub status: FormStatus,
    /// Creation timestamp.
    pub created_at: DateTime<Utc>,
    /// Last update timestamp.
    pub updated_at: DateTime<Utc>,
    /// Completion timestamp.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
    /// Agent that owns this form.
    pub agent_id: Uuid,
    /// Additional metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, serde_json::Value>>,
}

/// Template for creating forms.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormTemplate {
    /// Template name.
    pub name: String,
    /// Template description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Template steps.
    pub steps: Vec<FormStep>,
    /// Template metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, serde_json::Value>>,
}

impl FormTemplate {
    /// Create a new form template.
    pub fn new(name: impl Into<String>, steps: Vec<FormStep>) -> Self {
        Self {
            name: name.into(),
            description: None,
            steps,
            metadata: None,
        }
    }

    /// Set the description.
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }
}

/// Validation error for a field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldError {
    /// ID of the field with error.
    pub field_id: String,
    /// Error message.
    pub message: String,
}

/// Result of a form update operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormUpdateResult {
    /// Whether the update was successful.
    pub success: bool,
    /// Updated form data.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub form: Option<Form>,
    /// Fields that were updated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_fields: Option<Vec<String>>,
    /// Validation errors.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub errors: Option<Vec<FieldError>>,
    /// Whether the current step was completed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_completed: Option<bool>,
    /// Whether the entire form was completed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub form_completed: Option<bool>,
    /// Current step name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_step: Option<String>,
    /// Optional message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl FormUpdateResult {
    /// Create a success result.
    pub fn success() -> Self {
        Self {
            success: true,
            form: None,
            updated_fields: None,
            errors: None,
            step_completed: None,
            form_completed: None,
            current_step: None,
            message: None,
        }
    }

    /// Create a failure result.
    pub fn failure(message: impl Into<String>) -> Self {
        Self {
            success: false,
            form: None,
            updated_fields: None,
            errors: None,
            step_completed: None,
            form_completed: None,
            current_step: None,
            message: Some(message.into()),
        }
    }
}

