//! State types (proto-backed) with helpers for dynamic values.

use prost_types::{value::Kind, Struct, Value};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;

pub use super::generated::eliza::v1::{
    ActionPlan, ActionPlanStep, ProviderCacheEntry, State, StateData, StateValues,
    WorkingMemoryItem,
};
use super::components::ActionResult;
use super::environment::{Entity, Room, World};

// ============================================================================
// Dynamic Prompt Execution Types
// ============================================================================

/// Schema row for dynamic prompt execution.
///
/// WHY: `dynamic_prompt_exec_from_state` generates structured prompts that ask the LLM
/// to output specific fields. Each `SchemaRow` defines one field the LLM must produce.
/// The schema also controls validation behavior for streaming scenarios.
///
/// # Example
/// ```
/// use elizaos::types::SchemaRow;
///
/// let schema = vec![
///     SchemaRow::new("thought", "Your internal reasoning"),
///     SchemaRow::new("text", "Response to user").required(),
///     SchemaRow::new("actions", "Actions to execute"),
/// ];
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaRow {
    /// Field name - will become an XML tag or JSON property
    pub field: String,
    /// Description shown to LLM - explains what to put in this field
    pub description: String,
    /// If true, validation fails when field is empty/missing
    #[serde(default)]
    pub required: bool,
    /// Control per-field validation codes for streaming (levels 0-1 only).
    ///
    /// WHY: Validation codes are UUID snippets that surround each field. If the LLM
    /// outputs the same code before and after a field, we know the context window
    /// wasn't truncated mid-field. This trades off token usage for reliability.
    ///
    /// Behavior by level:
    /// - Level 0 (Trusted): default false. Set to true to opt-in to per-field codes.
    /// - Level 1 (Progressive): default true. Set to false to opt-out of codes.
    /// - Levels 2-3: ignored (uses checkpoint codes at start/end of response instead).
    #[serde(default)]
    pub validate_field: Option<bool>,
    /// Control whether this field's content is streamed to the consumer.
    ///
    /// WHY: Not all fields should be shown to users in real-time:
    /// - 'thought': Internal reasoning - might be verbose or confusing to show
    /// - 'actions': System field for action routing - not user-visible
    /// - 'text': The actual response - should definitely stream
    ///
    /// Default: true for 'text' field, false for others.
    #[serde(default)]
    pub stream_field: Option<bool>,
}

impl SchemaRow {
    /// Create a new schema row with field name and description.
    pub fn new(field: impl Into<String>, description: impl Into<String>) -> Self {
        Self {
            field: field.into(),
            description: description.into(),
            required: false,
            validate_field: None,
            stream_field: None,
        }
    }

    /// Mark this field as required.
    pub fn required(mut self) -> Self {
        self.required = true;
        self
    }

    /// Set whether to validate this field with codes.
    pub fn validate(mut self, validate: bool) -> Self {
        self.validate_field = Some(validate);
        self
    }

    /// Set whether to stream this field's content.
    pub fn stream(mut self, stream: bool) -> Self {
        self.stream_field = Some(stream);
        self
    }
}

/// Configuration for retry backoff timing.
///
/// WHY: When retries happen, immediate retries can:
/// - Overwhelm rate-limited APIs
/// - Hit transient failures repeatedly
/// - Waste resources on brief outages
///
/// Backoff gives the system time to recover between attempts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetryBackoffConfig {
    /// Initial delay in milliseconds before first retry. Default: 1000ms (1 second)
    #[serde(default = "default_initial_ms")]
    pub initial_ms: u64,
    /// Multiplier for exponential backoff. delay = initial_ms * multiplier^(retry_count - 1). Default: 2
    #[serde(default = "default_multiplier")]
    pub multiplier: f64,
    /// Maximum delay in milliseconds. Caps exponential growth. Default: 30000ms (30 seconds)
    #[serde(default = "default_max_ms")]
    pub max_ms: u64,
}

fn default_initial_ms() -> u64 {
    1000
}
fn default_multiplier() -> f64 {
    2.0
}
fn default_max_ms() -> u64 {
    30000
}

impl Default for RetryBackoffConfig {
    fn default() -> Self {
        Self {
            initial_ms: 1000,
            multiplier: 2.0,
            max_ms: 30000,
        }
    }
}

impl RetryBackoffConfig {
    /// Calculate the delay for a given retry attempt (1-indexed).
    pub fn delay_for_retry(&self, retry_count: u32) -> u64 {
        let delay = (self.initial_ms as f64) * self.multiplier.powi(retry_count as i32 - 1);
        (delay as u64).min(self.max_ms)
    }
}

/// Stream event types for validation-aware streaming.
/// Rich consumers receive these typed events for custom UX handling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamEventType {
    /// Regular content chunk being streamed
    Chunk,
    /// A field passed validation (level 1)
    FieldValidated,
    /// Starting a retry attempt
    RetryStart,
    /// Unrecoverable error occurred
    Error,
    /// Successfully finished all validation
    Complete,
}

/// Rich stream event for sophisticated consumers.
///
/// WHY: Simple consumers just want text chunks. Advanced UIs want to know
/// about validation progress, retries, and errors to show appropriate UI
/// (spinners, clear partial content, error messages).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamEvent {
    /// Event type
    #[serde(rename = "type")]
    pub event_type: StreamEventType,
    /// Field name (for chunk and field_validated events)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    /// Content chunk (for chunk events)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunk: Option<String>,
    /// Retry attempt number (for retry_start events)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_count: Option<u32>,
    /// Error message (for error events)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Timestamp of the event (milliseconds since epoch)
    pub timestamp: u64,
}

impl StreamEvent {
    /// Create a chunk event.
    pub fn chunk(field: impl Into<String>, chunk: impl Into<String>) -> Self {
        Self {
            event_type: StreamEventType::Chunk,
            field: Some(field.into()),
            chunk: Some(chunk.into()),
            retry_count: None,
            error: None,
            timestamp: current_timestamp_ms(),
        }
    }

    /// Create a field_validated event.
    pub fn field_validated(field: impl Into<String>) -> Self {
        Self {
            event_type: StreamEventType::FieldValidated,
            field: Some(field.into()),
            chunk: None,
            retry_count: None,
            error: None,
            timestamp: current_timestamp_ms(),
        }
    }

    /// Create a retry_start event.
    pub fn retry_start(retry_count: u32) -> Self {
        Self {
            event_type: StreamEventType::RetryStart,
            field: None,
            chunk: None,
            retry_count: Some(retry_count),
            error: None,
            timestamp: current_timestamp_ms(),
        }
    }

    /// Create an error event.
    pub fn error(message: impl Into<String>) -> Self {
        Self {
            event_type: StreamEventType::Error,
            field: None,
            chunk: None,
            retry_count: None,
            error: Some(message.into()),
            timestamp: current_timestamp_ms(),
        }
    }

    /// Create a complete event.
    pub fn complete() -> Self {
        Self {
            event_type: StreamEventType::Complete,
            field: None,
            chunk: None,
            retry_count: None,
            error: None,
            timestamp: current_timestamp_ms(),
        }
    }
}

/// Get current timestamp in milliseconds.
fn current_timestamp_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn prost_value_from_json(value: JsonValue) -> Value {
    let kind = match value {
        JsonValue::Null => Kind::NullValue(0),
        JsonValue::Bool(v) => Kind::BoolValue(v),
        JsonValue::Number(n) => Kind::NumberValue(n.as_f64().unwrap_or(0.0)),
        JsonValue::String(s) => Kind::StringValue(s),
        JsonValue::Array(items) => Kind::ListValue(prost_types::ListValue {
            values: items.into_iter().map(prost_value_from_json).collect(),
        }),
        JsonValue::Object(map) => Kind::StructValue(Struct {
            fields: map
                .into_iter()
                .map(|(k, v)| (k, prost_value_from_json(v)))
                .collect(),
        }),
    };
    Value { kind: Some(kind) }
}

fn json_from_prost_value(value: &Value) -> JsonValue {
    match value.kind.as_ref() {
        Some(Kind::NullValue(_)) => JsonValue::Null,
        Some(Kind::BoolValue(v)) => JsonValue::Bool(*v),
        Some(Kind::NumberValue(v)) => JsonValue::Number(
            serde_json::Number::from_f64(*v).unwrap_or_else(|| serde_json::Number::from(0)),
        ),
        Some(Kind::StringValue(v)) => JsonValue::String(v.clone()),
        Some(Kind::StructValue(s)) => JsonValue::Object(
            s.fields
                .iter()
                .map(|(k, v)| (k.clone(), json_from_prost_value(v)))
                .collect(),
        ),
        Some(Kind::ListValue(list)) => {
            JsonValue::Array(list.values.iter().map(json_from_prost_value).collect())
        }
        None => JsonValue::Null,
    }
}

fn ensure_struct(target: &mut Option<Struct>) -> &mut Struct {
    target.get_or_insert_with(|| Struct {
        fields: HashMap::new(),
    })
}

impl State {
    pub fn new() -> Self {
        State {
            values: Some(StateValues::default()),
            data: Some(StateData::default()),
            text: String::new(),
            extra: None,
        }
    }

    pub fn with_text(text: &str) -> Self {
        let mut state = State::new();
        state.text = text.to_string();
        state
    }

    pub fn get_value(&self, key: &str) -> Option<JsonValue> {
        let values = self.values.as_ref()?;
        let extra = values.extra.as_ref()?;
        extra.fields.get(key).map(json_from_prost_value)
    }

    pub fn set_value(&mut self, key: &str, value: JsonValue) {
        let values = self.values.get_or_insert_with(StateValues::default);
        let extra = ensure_struct(&mut values.extra);
        extra
            .fields
            .insert(key.to_string(), prost_value_from_json(value));
    }

    pub fn values_map(&self) -> HashMap<String, JsonValue> {
        let mut out = HashMap::new();
        if let Some(values) = &self.values {
            if let Some(extra) = &values.extra {
                for (k, v) in &extra.fields {
                    out.insert(k.clone(), json_from_prost_value(v));
                }
            }
        }
        out
    }

    pub fn merge_values_struct(&mut self, values: &Struct) {
        for (k, v) in &values.fields {
            self.set_value(k, json_from_prost_value(v));
        }
    }

    pub fn data_mut(&mut self) -> &mut StateData {
        self.data.get_or_insert_with(StateData::default)
    }

    pub fn data_ref(&self) -> Option<&StateData> {
        self.data.as_ref()
    }

    pub fn set_room(&mut self, room: Room) {
        self.data_mut().room = Some(room);
    }

    pub fn set_world(&mut self, world: World) {
        self.data_mut().world = Some(world);
    }

    pub fn set_entity(&mut self, entity: Entity) {
        self.data_mut().entity = Some(entity);
    }

    pub fn add_action_result(&mut self, result: ActionResult) {
        let data = self.data_mut();
        if let Some(results) = &mut data.action_results {
            results.push(result);
        } else {
            data.action_results = Some(vec![result]);
        }
    }

    pub fn merge(&mut self, other: State) {
        for (k, v) in other.values_map() {
            self.set_value(&k, v);
        }
        if !other.text.is_empty() {
            self.text = other.text;
        }
        if let Some(extra) = other.extra {
            let target = ensure_struct(&mut self.extra);
            for (k, v) in extra.fields {
                target.fields.insert(k, v);
            }
        }
    }
}
