//! Windows Named Pipe server for receiving workflow events from TypeScript
//!
//! This module provides a clean IPC mechanism for TypeScript workflows to send
//! events to the Rust MCP agent without polluting stderr.
//!
//! # Architecture
//! ```text
//! TypeScript Workflow          Rust MCP Agent
//! ┌─────────────────┐         ┌─────────────────┐
//! │  emit.progress()│         │  EventPipeServer│
//! │        │        │         │        │        │
//! │        ▼        │         │        ▼        │
//! │  Write to pipe  │ ──────► │  Read events    │
//! │                 │  Named  │        │        │
//! │                 │  Pipe   │        ▼        │
//! └─────────────────┘         │  Forward to MCP │
//!                             └─────────────────┘
//! ```

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;
use tracing::{debug, error, info};

/// Workflow event emitted from TypeScript workflows
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WorkflowEvent {
    /// Progress update - maps to MCP notifications/progress
    Progress {
        current: f64,
        total: Option<f64>,
        message: Option<String>,
        timestamp: String,
    },
    /// Step started
    StepStarted {
        #[serde(rename = "stepId")]
        step_id: String,
        #[serde(rename = "stepName")]
        step_name: String,
        #[serde(rename = "stepIndex")]
        step_index: Option<u32>,
        #[serde(rename = "totalSteps")]
        total_steps: Option<u32>,
        timestamp: String,
    },
    /// Step completed
    StepCompleted {
        #[serde(rename = "stepId")]
        step_id: String,
        #[serde(rename = "stepName")]
        step_name: String,
        duration: Option<u64>,
        #[serde(rename = "stepIndex")]
        step_index: Option<u32>,
        #[serde(rename = "totalSteps")]
        total_steps: Option<u32>,
        timestamp: String,
    },
    /// Step failed
    StepFailed {
        #[serde(rename = "stepId")]
        step_id: String,
        #[serde(rename = "stepName")]
        step_name: String,
        error: Option<String>,
        duration: Option<u64>,
        timestamp: String,
    },
    /// Screenshot for visual debugging
    Screenshot {
        path: Option<String>,
        base64: Option<String>,
        annotation: Option<String>,
        element: Option<String>,
        timestamp: String,
    },
    /// Custom data event
    Data {
        key: String,
        value: Value,
        timestamp: String,
    },
    /// Status text to display on overlay
    Status {
        text: String,
        #[serde(rename = "durationMs")]
        duration_ms: Option<u64>,
        position: Option<String>,
        timestamp: String,
    },
    /// Structured log message
    Log {
        level: String,
        message: String,
        data: Option<Value>,
        timestamp: String,
    },
}

/// Raw event structure for parsing (before tag-based deserialization)
#[derive(Debug, Deserialize)]
struct RawEvent {
    #[serde(rename = "__mcp_event__")]
    is_mcp_event: bool,
    #[serde(rename = "type")]
    event_type: String,
    timestamp: String,
    // Progress fields
    current: Option<f64>,
    total: Option<f64>,
    message: Option<String>,
    // Step fields
    #[serde(rename = "stepId")]
    step_id: Option<String>,
    #[serde(rename = "stepName")]
    step_name: Option<String>,
    #[serde(rename = "stepIndex")]
    step_index: Option<u32>,
    #[serde(rename = "totalSteps")]
    total_steps: Option<u32>,
    duration: Option<u64>,
    error: Option<String>,
    // Screenshot fields
    path: Option<String>,
    base64: Option<String>,
    annotation: Option<String>,
    element: Option<String>,
    // Data fields
    key: Option<String>,
    value: Option<Value>,
    // Log fields
    level: Option<String>,
    data: Option<Value>,
}

impl TryFrom<RawEvent> for WorkflowEvent {
    type Error = String;

    fn try_from(raw: RawEvent) -> Result<Self, Self::Error> {
        if !raw.is_mcp_event {
            return Err("Not an MCP event".to_string());
        }

        match raw.event_type.as_str() {
            "progress" => Ok(WorkflowEvent::Progress {
                current: raw.current.unwrap_or(0.0),
                total: raw.total,
                message: raw.message,
                timestamp: raw.timestamp,
            }),
            "step_started" => Ok(WorkflowEvent::StepStarted {
                step_id: raw.step_id.unwrap_or_default(),
                step_name: raw.step_name.unwrap_or_default(),
                step_index: raw.step_index,
                total_steps: raw.total_steps,
                timestamp: raw.timestamp,
            }),
            "step_completed" => Ok(WorkflowEvent::StepCompleted {
                step_id: raw.step_id.unwrap_or_default(),
                step_name: raw.step_name.unwrap_or_default(),
                duration: raw.duration,
                step_index: raw.step_index,
                total_steps: raw.total_steps,
                timestamp: raw.timestamp,
            }),
            "step_failed" => Ok(WorkflowEvent::StepFailed {
                step_id: raw.step_id.unwrap_or_default(),
                step_name: raw.step_name.unwrap_or_default(),
                error: raw.error,
                duration: raw.duration,
                timestamp: raw.timestamp,
            }),
            "screenshot" => Ok(WorkflowEvent::Screenshot {
                path: raw.path,
                base64: raw.base64,
                annotation: raw.annotation,
                element: raw.element,
                timestamp: raw.timestamp,
            }),
            "data" => Ok(WorkflowEvent::Data {
                key: raw.key.unwrap_or_default(),
                value: raw.value.unwrap_or(Value::Null),
                timestamp: raw.timestamp,
            }),
            "status" => Ok(WorkflowEvent::Status {
                text: raw.message.unwrap_or_default(),
                duration_ms: raw.duration,
                position: raw.element,
                timestamp: raw.timestamp,
            }),
            "log" => Ok(WorkflowEvent::Log {
                level: raw.level.unwrap_or_else(|| "info".to_string()),
                message: raw.message.unwrap_or_default(),
                data: raw.data,
                timestamp: raw.timestamp,
            }),
            other => Err(format!("Unknown event type: {}", other)),
        }
    }
}

/// Try to parse a line as a workflow event
/// Returns Some(event) if the line is a valid MCP event JSON, None otherwise
pub fn try_parse_event(line: &str) -> Option<WorkflowEvent> {
    // Quick check - MCP events start with {"__mcp_event__":true
    let trimmed = line.trim();
    if !trimmed.starts_with("{") {
        return None;
    }

    // Try to parse as raw event
    match serde_json::from_str::<RawEvent>(trimmed) {
        Ok(raw) => {
            if !raw.is_mcp_event {
                return None;
            }
            match WorkflowEvent::try_from(raw) {
                Ok(event) => Some(event),
                Err(e) => {
                    debug!("Failed to convert raw event: {}", e);
                    None
                }
            }
        }
        Err(_) => None,
    }
}

/// Channel sender for workflow events
pub type EventSender = mpsc::UnboundedSender<WorkflowEvent>;
pub type EventReceiver = mpsc::UnboundedReceiver<WorkflowEvent>;

/// Create a new event channel
pub fn create_event_channel() -> (EventSender, EventReceiver) {
    mpsc::unbounded_channel()
}

/// Generate a unique pipe name for a workflow execution
pub fn generate_pipe_name(execution_id: &str) -> String {
    format!(r"\\.\pipe\mcp-workflow-events-{}", execution_id)
}

/// Windows Named Pipe server for receiving workflow events
#[cfg(windows)]
pub struct EventPipeServer {
    pipe_name: String,
    event_sender: EventSender,
}

#[cfg(windows)]
impl EventPipeServer {
    /// Create a new event pipe server
    pub fn new(execution_id: &str, event_sender: EventSender) -> Self {
        Self {
            pipe_name: generate_pipe_name(execution_id),
            event_sender,
        }
    }

    /// Get the pipe name for passing to TypeScript
    pub fn pipe_name(&self) -> &str {
        &self.pipe_name
    }

    /// Start the pipe server and return a handle to stop it
    /// This spawns a background task that reads events from the pipe
    pub async fn start(self) -> Result<PipeServerHandle, std::io::Error> {
        use tokio::net::windows::named_pipe::{PipeMode, ServerOptions};

        let pipe_name = self.pipe_name.clone();
        let event_sender = self.event_sender;

        // Create the named pipe server
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .pipe_mode(PipeMode::Byte)
            .create(&pipe_name)?;

        info!("Created named pipe: {}", pipe_name);

        let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);

        let handle = tokio::spawn(async move {
            // Wait for client connection
            debug!("Waiting for TypeScript to connect to pipe...");

            tokio::select! {
                result = server.connect() => {
                    match result {
                        Ok(()) => {
                            info!("TypeScript connected to event pipe");

                            // Read events from pipe
                            let reader = BufReader::new(server);
                            let mut lines = reader.lines();

                            loop {
                                tokio::select! {
                                    line_result = lines.next_line() => {
                                        match line_result {
                                            Ok(Some(line)) => {
                                                if let Some(event) = try_parse_event(&line) {
                                                    debug!("Received event from pipe: {:?}", event);
                                                    if event_sender.send(event).is_err() {
                                                        debug!("Event receiver dropped, stopping pipe server");
                                                        break;
                                                    }
                                                }
                                            }
                                            Ok(None) => {
                                                debug!("Pipe closed by client");
                                                break;
                                            }
                                            Err(e) => {
                                                error!("Error reading from pipe: {}", e);
                                                break;
                                            }
                                        }
                                    }
                                    _ = shutdown_rx.recv() => {
                                        debug!("Pipe server shutdown requested");
                                        break;
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            error!("Failed to accept pipe connection: {}", e);
                        }
                    }
                }
                _ = shutdown_rx.recv() => {
                    debug!("Pipe server shutdown before connection");
                }
            }
        });

        Ok(PipeServerHandle {
            _handle: handle,
            shutdown_tx,
        })
    }
}

/// Stub event pipe server for non-Windows platforms.
///
/// The TypeScript workflow IPC currently uses Windows Named Pipes. On macOS/Linux
/// we keep the type available so the crate compiles; the server is a no-op.
#[cfg(not(windows))]
pub struct EventPipeServer {
    pipe_name: String,
    #[allow(dead_code)]
    event_sender: EventSender,
}

#[cfg(not(windows))]
impl EventPipeServer {
    pub fn new(execution_id: &str, event_sender: EventSender) -> Self {
        Self {
            // Keep a stable, debuggable identifier even though it's not used yet.
            pipe_name: format!("mcp-workflow-events-{}", execution_id),
            event_sender,
        }
    }

    pub fn pipe_name(&self) -> &str {
        &self.pipe_name
    }

    pub async fn start(self) -> Result<PipeServerHandle, std::io::Error> {
        let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);
        let handle = tokio::spawn(async move {
            let _ = shutdown_rx.recv().await;
        });

        Ok(PipeServerHandle {
            _handle: handle,
            shutdown_tx,
        })
    }
}

/// Handle to control the pipe server
pub struct PipeServerHandle {
    _handle: tokio::task::JoinHandle<()>,
    shutdown_tx: mpsc::Sender<()>,
}

impl PipeServerHandle {
    /// Signal the pipe server to shutdown
    pub async fn shutdown(self) {
        let _ = self.shutdown_tx.send(()).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_progress_event() {
        let json = r#"{"__mcp_event__":true,"type":"progress","current":1,"total":4,"message":"Starting...","timestamp":"2025-01-01T00:00:00Z"}"#;
        let event = try_parse_event(json).unwrap();

        match event {
            WorkflowEvent::Progress {
                current,
                total,
                message,
                timestamp,
            } => {
                assert_eq!(current, 1.0);
                assert_eq!(total, Some(4.0));
                assert_eq!(message, Some("Starting...".to_string()));
                assert_eq!(timestamp, "2025-01-01T00:00:00Z");
            }
            _ => panic!("Expected Progress event"),
        }
    }

    #[test]
    fn test_parse_progress_event_no_total() {
        let json = r#"{"__mcp_event__":true,"type":"progress","current":5,"timestamp":"2025-01-01T00:00:00Z"}"#;
        let event = try_parse_event(json).unwrap();

        match event {
            WorkflowEvent::Progress {
                current,
                total,
                message,
                ..
            } => {
                assert_eq!(current, 5.0);
                assert_eq!(total, None);
                assert_eq!(message, None);
            }
            _ => panic!("Expected Progress event"),
        }
    }

    #[test]
    fn test_parse_step_started_event() {
        let json = r#"{"__mcp_event__":true,"type":"step_started","stepId":"login","stepName":"Login Step","stepIndex":0,"totalSteps":3,"timestamp":"2025-01-01T00:00:00Z"}"#;
        let event = try_parse_event(json).unwrap();

        match event {
            WorkflowEvent::StepStarted {
                step_id,
                step_name,
                step_index,
                total_steps,
                ..
            } => {
                assert_eq!(step_id, "login");
                assert_eq!(step_name, "Login Step");
                assert_eq!(step_index, Some(0));
                assert_eq!(total_steps, Some(3));
            }
            _ => panic!("Expected StepStarted event"),
        }
    }

    #[test]
    fn test_parse_step_completed_event() {
        let json = r#"{"__mcp_event__":true,"type":"step_completed","stepId":"login","stepName":"Login Step","duration":1500,"stepIndex":0,"totalSteps":3,"timestamp":"2025-01-01T00:00:00Z"}"#;
        let event = try_parse_event(json).unwrap();

        match event {
            WorkflowEvent::StepCompleted {
                step_id,
                step_name,
                duration,
                step_index,
                total_steps,
                ..
            } => {
                assert_eq!(step_id, "login");
                assert_eq!(step_name, "Login Step");
                assert_eq!(duration, Some(1500));
                assert_eq!(step_index, Some(0));
                assert_eq!(total_steps, Some(3));
            }
            _ => panic!("Expected StepCompleted event"),
        }
    }

    #[test]
    fn test_parse_step_failed_event() {
        let json = r#"{"__mcp_event__":true,"type":"step_failed","stepId":"login","stepName":"Login Step","error":"Element not found","duration":500,"timestamp":"2025-01-01T00:00:00Z"}"#;
        let event = try_parse_event(json).unwrap();

        match event {
            WorkflowEvent::StepFailed {
                step_id,
                step_name,
                error,
                duration,
                ..
            } => {
                assert_eq!(step_id, "login");
                assert_eq!(step_name, "Login Step");
                assert_eq!(error, Some("Element not found".to_string()));
                assert_eq!(duration, Some(500));
            }
            _ => panic!("Expected StepFailed event"),
        }
    }

    #[test]
    fn test_parse_screenshot_event() {
        let json = r#"{"__mcp_event__":true,"type":"screenshot","path":"/tmp/screenshot.png","annotation":"Login screen","timestamp":"2025-01-01T00:00:00Z"}"#;
        let event = try_parse_event(json).unwrap();

        match event {
            WorkflowEvent::Screenshot {
                path,
                annotation,
                base64,
                element,
                ..
            } => {
                assert_eq!(path, Some("/tmp/screenshot.png".to_string()));
                assert_eq!(annotation, Some("Login screen".to_string()));
                assert_eq!(base64, None);
                assert_eq!(element, None);
            }
            _ => panic!("Expected Screenshot event"),
        }
    }

    #[test]
    fn test_parse_screenshot_event_base64() {
        let json = r#"{"__mcp_event__":true,"type":"screenshot","base64":"iVBORw0KGgo...","element":"role:Button","timestamp":"2025-01-01T00:00:00Z"}"#;
        let event = try_parse_event(json).unwrap();

        match event {
            WorkflowEvent::Screenshot {
                path,
                base64,
                element,
                ..
            } => {
                assert_eq!(path, None);
                assert_eq!(base64, Some("iVBORw0KGgo...".to_string()));
                assert_eq!(element, Some("role:Button".to_string()));
            }
            _ => panic!("Expected Screenshot event"),
        }
    }

    #[test]
    fn test_parse_data_event_string() {
        let json = r#"{"__mcp_event__":true,"type":"data","key":"username","value":"john@example.com","timestamp":"2025-01-01T00:00:00Z"}"#;
        let event = try_parse_event(json).unwrap();

        match event {
            WorkflowEvent::Data { key, value, .. } => {
                assert_eq!(key, "username");
                assert_eq!(value, serde_json::json!("john@example.com"));
            }
            _ => panic!("Expected Data event"),
        }
    }

    #[test]
    fn test_parse_data_event_object() {
        let json = r#"{"__mcp_event__":true,"type":"data","key":"config","value":{"retries":3,"timeout":5000},"timestamp":"2025-01-01T00:00:00Z"}"#;
        let event = try_parse_event(json).unwrap();

        match event {
            WorkflowEvent::Data { key, value, .. } => {
                assert_eq!(key, "config");
                assert_eq!(value, serde_json::json!({"retries": 3, "timeout": 5000}));
            }
            _ => panic!("Expected Data event"),
        }
    }

    #[test]
    fn test_parse_data_event_array() {
        let json = r#"{"__mcp_event__":true,"type":"data","key":"items","value":["a","b","c"],"timestamp":"2025-01-01T00:00:00Z"}"#;
        let event = try_parse_event(json).unwrap();

        match event {
            WorkflowEvent::Data { key, value, .. } => {
                assert_eq!(key, "items");
                assert_eq!(value, serde_json::json!(["a", "b", "c"]));
            }
            _ => panic!("Expected Data event"),
        }
    }

    #[test]
    fn test_parse_log_event_info() {
        let json = r#"{"__mcp_event__":true,"type":"log","level":"info","message":"Processing item 5 of 10","timestamp":"2025-01-01T00:00:00Z"}"#;
        let event = try_parse_event(json).unwrap();

        match event {
            WorkflowEvent::Log {
                level,
                message,
                data,
                ..
            } => {
                assert_eq!(level, "info");
                assert_eq!(message, "Processing item 5 of 10");
                assert_eq!(data, None);
            }
            _ => panic!("Expected Log event"),
        }
    }

    #[test]
    fn test_parse_log_event_error_with_data() {
        let json = r#"{"__mcp_event__":true,"type":"log","level":"error","message":"Failed to click button","data":{"selector":"role:Button","error":"timeout"},"timestamp":"2025-01-01T00:00:00Z"}"#;
        let event = try_parse_event(json).unwrap();

        match event {
            WorkflowEvent::Log {
                level,
                message,
                data,
                ..
            } => {
                assert_eq!(level, "error");
                assert_eq!(message, "Failed to click button");
                assert_eq!(
                    data,
                    Some(serde_json::json!({"selector": "role:Button", "error": "timeout"}))
                );
            }
            _ => panic!("Expected Log event"),
        }
    }

    #[test]
    fn test_parse_log_event_default_level() {
        let json = r#"{"__mcp_event__":true,"type":"log","message":"Some message","timestamp":"2025-01-01T00:00:00Z"}"#;
        let event = try_parse_event(json).unwrap();

        match event {
            WorkflowEvent::Log { level, .. } => {
                assert_eq!(level, "info"); // Default level
            }
            _ => panic!("Expected Log event"),
        }
    }

    #[test]
    fn test_parse_invalid_json() {
        let json = "not json at all";
        assert!(try_parse_event(json).is_none());
    }

    #[test]
    fn test_parse_json_without_mcp_event_flag() {
        let json = r#"{"type":"progress","current":1}"#;
        assert!(try_parse_event(json).is_none());
    }

    #[test]
    fn test_parse_mcp_event_false() {
        let json = r#"{"__mcp_event__":false,"type":"progress","current":1,"timestamp":"2025-01-01T00:00:00Z"}"#;
        assert!(try_parse_event(json).is_none());
    }

    #[test]
    fn test_parse_unknown_event_type() {
        let json =
            r#"{"__mcp_event__":true,"type":"unknown_type","timestamp":"2025-01-01T00:00:00Z"}"#;
        assert!(try_parse_event(json).is_none());
    }

    #[test]
    fn test_parse_with_whitespace() {
        let json = r#"  {"__mcp_event__":true,"type":"progress","current":1,"timestamp":"2025-01-01T00:00:00Z"}  "#;
        let event = try_parse_event(json);
        assert!(event.is_some());
    }

    #[test]
    fn test_parse_empty_string() {
        assert!(try_parse_event("").is_none());
    }

    #[test]
    fn test_parse_non_object_json() {
        assert!(try_parse_event("[1,2,3]").is_none());
        assert!(try_parse_event("123").is_none());
        assert!(try_parse_event("\"string\"").is_none());
    }

    #[test]
    fn test_generate_pipe_name() {
        let name = generate_pipe_name("exec-123");
        assert_eq!(name, r"\\.\pipe\mcp-workflow-events-exec-123");
    }

    #[test]
    fn test_event_channel() {
        let (tx, mut rx) = create_event_channel();

        let event = WorkflowEvent::Progress {
            current: 1.0,
            total: Some(10.0),
            message: Some("Test".to_string()),
            timestamp: "2025-01-01T00:00:00Z".to_string(),
        };

        tx.send(event.clone()).unwrap();

        let received = rx.try_recv().unwrap();
        assert_eq!(received, event);
    }

    #[test]
    fn test_workflow_event_serialization_roundtrip() {
        let events = vec![
            WorkflowEvent::Progress {
                current: 5.0,
                total: Some(10.0),
                message: Some("Half done".to_string()),
                timestamp: "2025-01-01T00:00:00Z".to_string(),
            },
            WorkflowEvent::StepStarted {
                step_id: "step1".to_string(),
                step_name: "First Step".to_string(),
                step_index: Some(0),
                total_steps: Some(3),
                timestamp: "2025-01-01T00:00:00Z".to_string(),
            },
            WorkflowEvent::Data {
                key: "result".to_string(),
                value: serde_json::json!({"status": "ok", "count": 42}),
                timestamp: "2025-01-01T00:00:00Z".to_string(),
            },
        ];

        for event in events {
            let json = serde_json::to_string(&event).unwrap();
            let parsed: WorkflowEvent = serde_json::from_str(&json).unwrap();
            assert_eq!(event, parsed);
        }
    }
}

#[cfg(all(test, windows))]
mod windows_integration_tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::AsyncWriteExt;
    use tokio::time::timeout;

    #[tokio::test]
    async fn test_pipe_server_basic() {
        let (tx, mut rx) = create_event_channel();
        let server = EventPipeServer::new("test-basic", tx);
        let pipe_name = server.pipe_name().to_string();

        let handle = server.start().await.expect("Failed to start pipe server");

        // Give server time to start
        tokio::time::sleep(Duration::from_millis(100)).await;

        // Connect as client and send event
        let client_task = tokio::spawn(async move {
            use tokio::net::windows::named_pipe::ClientOptions;

            let mut client = ClientOptions::new()
                .open(&pipe_name)
                .expect("Failed to connect to pipe");

            let event_json = r#"{"__mcp_event__":true,"type":"progress","current":1,"total":5,"message":"Test","timestamp":"2025-01-01T00:00:00Z"}"#;
            client.write_all(event_json.as_bytes()).await.unwrap();
            client.write_all(b"\n").await.unwrap();
            client.flush().await.unwrap();
        });

        // Wait for event
        let event = timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("Timeout waiting for event")
            .expect("Channel closed");

        match event {
            WorkflowEvent::Progress {
                current,
                total,
                message,
                ..
            } => {
                assert_eq!(current, 1.0);
                assert_eq!(total, Some(5.0));
                assert_eq!(message, Some("Test".to_string()));
            }
            _ => panic!("Expected Progress event"),
        }

        client_task.await.unwrap();
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn test_pipe_server_multiple_events() {
        let (tx, mut rx) = create_event_channel();
        let server = EventPipeServer::new("test-multi", tx);
        let pipe_name = server.pipe_name().to_string();

        let handle = server.start().await.expect("Failed to start pipe server");
        tokio::time::sleep(Duration::from_millis(100)).await;

        let client_task = tokio::spawn(async move {
            use tokio::net::windows::named_pipe::ClientOptions;

            let mut client = ClientOptions::new()
                .open(&pipe_name)
                .expect("Failed to connect to pipe");

            let events = vec![
                r#"{"__mcp_event__":true,"type":"step_started","stepId":"s1","stepName":"Step 1","timestamp":"2025-01-01T00:00:00Z"}"#,
                r#"{"__mcp_event__":true,"type":"progress","current":1,"total":2,"timestamp":"2025-01-01T00:00:00Z"}"#,
                r#"{"__mcp_event__":true,"type":"step_completed","stepId":"s1","stepName":"Step 1","duration":100,"timestamp":"2025-01-01T00:00:00Z"}"#,
            ];

            for event_json in events {
                client.write_all(event_json.as_bytes()).await.unwrap();
                client.write_all(b"\n").await.unwrap();
            }
            client.flush().await.unwrap();
        });

        // Receive all events
        let mut received = Vec::new();
        for _ in 0..3 {
            if let Ok(Some(event)) = timeout(Duration::from_secs(5), rx.recv()).await {
                received.push(event);
            }
        }

        assert_eq!(received.len(), 3);
        assert!(matches!(received[0], WorkflowEvent::StepStarted { .. }));
        assert!(matches!(received[1], WorkflowEvent::Progress { .. }));
        assert!(matches!(received[2], WorkflowEvent::StepCompleted { .. }));

        client_task.await.unwrap();
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn test_pipe_server_ignores_non_events() {
        let (tx, mut rx) = create_event_channel();
        let server = EventPipeServer::new("test-ignore", tx);
        let pipe_name = server.pipe_name().to_string();

        let handle = server.start().await.expect("Failed to start pipe server");
        tokio::time::sleep(Duration::from_millis(100)).await;

        let client_task = tokio::spawn(async move {
            use tokio::net::windows::named_pipe::ClientOptions;

            let mut client = ClientOptions::new()
                .open(&pipe_name)
                .expect("Failed to connect to pipe");

            let lines = vec![
                "This is not JSON\n",
                "{\"not_an_event\": true}\n",
                r#"{"__mcp_event__":true,"type":"progress","current":1,"timestamp":"T"}"#,
                "\n",
                "More random text\n",
            ];

            for line in lines {
                client.write_all(line.as_bytes()).await.unwrap();
            }
            client.flush().await.unwrap();
        });

        // Should only receive the valid event
        let event = timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("Timeout")
            .expect("Channel closed");

        assert!(matches!(event, WorkflowEvent::Progress { .. }));

        // Wait for client to finish writing
        client_task.await.unwrap();

        // Now check there are no more events (pipe should be closed or no valid events)
        // Use try_recv() instead of timeout since channel might have closed
        let extra_events = rx.try_recv();
        assert!(
            extra_events.is_err(),
            "Should not receive any more events, got: {:?}",
            extra_events
        );

        handle.shutdown().await;
    }
}
