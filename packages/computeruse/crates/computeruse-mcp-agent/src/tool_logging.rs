use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tracing::{Event, Subscriber};
use tracing_subscriber::{layer::Context, Layer};

/// A single log entry captured during tool execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub timestamp: DateTime<Utc>,
    pub level: String,
    pub target: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<serde_json::Map<String, serde_json::Value>>,
}

/// Thread-safe log capture mechanism for collecting logs during tool execution
#[derive(Clone)]
pub struct LogCapture {
    logs: Arc<Mutex<Vec<LogEntry>>>,
    capture_enabled: Arc<Mutex<bool>>,
    max_entries: usize,
}

impl LogCapture {
    /// Create a new LogCapture instance with a maximum number of entries
    pub fn new(max_entries: usize) -> Self {
        Self {
            logs: Arc::new(Mutex::new(Vec::new())),
            capture_enabled: Arc::new(Mutex::new(false)),
            max_entries,
        }
    }

    /// Start capturing logs, clearing any existing logs
    pub fn start_capture(&self) {
        let mut enabled = self.capture_enabled.lock().unwrap();
        *enabled = true;
        let mut logs = self.logs.lock().unwrap();
        logs.clear();
    }

    /// Stop capturing logs and return all captured entries
    pub fn stop_capture(&self) -> Vec<LogEntry> {
        let mut enabled = self.capture_enabled.lock().unwrap();
        *enabled = false;
        let mut logs = self.logs.lock().unwrap();
        logs.drain(..).collect()
    }

    /// Check if capture is currently enabled
    pub fn is_capturing(&self) -> bool {
        *self.capture_enabled.lock().unwrap()
    }

    /// Add a log entry to the buffer (internal use)
    fn add_log(&self, entry: LogEntry) {
        // Quick check without lock first
        if !self.is_capturing() {
            return;
        }

        let mut logs = self.logs.lock().unwrap();

        // Enforce max entries limit
        if logs.len() >= self.max_entries {
            logs.remove(0); // Remove oldest entry
        }

        logs.push(entry);
    }

    /// Get current log count without stopping capture
    #[allow(dead_code)]
    pub fn log_count(&self) -> usize {
        self.logs.lock().unwrap().len()
    }
}

/// Tracing layer that captures log events to a LogCapture instance
pub struct LogCaptureLayer {
    capture: LogCapture,
}

impl LogCaptureLayer {
    pub fn new(capture: LogCapture) -> Self {
        Self { capture }
    }
}

impl<S> Layer<S> for LogCaptureLayer
where
    S: Subscriber,
{
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        // Skip if not capturing
        if !self.capture.is_capturing() {
            return;
        }

        // Extract fields from the event
        let mut visitor = FieldVisitor::default();
        event.record(&mut visitor);

        // Build log entry
        let entry = LogEntry {
            timestamp: Utc::now(),
            level: format!("{}", event.metadata().level()),
            target: event.metadata().target().to_string(),
            message: visitor.message.unwrap_or_default(),
            fields: if visitor.fields.is_empty() {
                None
            } else {
                Some(visitor.fields)
            },
        };

        // Add to capture buffer
        self.capture.add_log(entry);
    }
}

/// Visitor for extracting fields from tracing events
#[derive(Default)]
struct FieldVisitor {
    message: Option<String>,
    fields: serde_json::Map<String, serde_json::Value>,
}

impl tracing::field::Visit for FieldVisitor {
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "message" {
            self.message = Some(value.to_string());
        } else {
            self.fields.insert(
                field.name().to_string(),
                serde_json::Value::String(value.to_string()),
            );
        }
    }

    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.message = Some(format!("{value:?}"));
        } else {
            self.fields.insert(
                field.name().to_string(),
                serde_json::Value::String(format!("{value:?}")),
            );
        }
    }

    fn record_i64(&mut self, field: &tracing::field::Field, value: i64) {
        self.fields.insert(
            field.name().to_string(),
            serde_json::Value::Number(value.into()),
        );
    }

    fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
        if let Some(num) = serde_json::Number::from_f64(value as f64) {
            self.fields
                .insert(field.name().to_string(), serde_json::Value::Number(num));
        }
    }

    fn record_bool(&mut self, field: &tracing::field::Field, value: bool) {
        self.fields
            .insert(field.name().to_string(), serde_json::Value::Bool(value));
    }

    fn record_f64(&mut self, field: &tracing::field::Field, value: f64) {
        if let Some(num) = serde_json::Number::from_f64(value) {
            self.fields
                .insert(field.name().to_string(), serde_json::Value::Number(num));
        }
    }
}
