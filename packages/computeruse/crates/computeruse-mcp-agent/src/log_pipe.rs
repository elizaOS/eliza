//! Windows Named Pipe server for receiving workflow logs from TypeScript
//!
//! This module provides a clean IPC mechanism for TypeScript workflows to send
//! structured logs to the Rust MCP agent without polluting stderr.
//!
//! # Architecture
//! ```text
//! TypeScript Workflow          Rust MCP Agent
//! ┌─────────────────┐         ┌─────────────────┐
//! │  console.log()  │         │  LogPipeServer  │
//! │        │        │         │        │        │
//! │        ▼        │         │        ▼        │
//! │  Write to pipe  │ ──────► │  Read logs      │
//! │                 │  Named  │        │        │
//! │                 │  Pipe   │        ▼        │
//! └─────────────────┘         │  Forward to     │
//!                             │  tracing        │
//!                             └─────────────────┘
//! ```

use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

/// Log entry received from TypeScript workflow
#[derive(Debug, Clone, Deserialize)]
pub struct LogEntry {
    /// Log level: "debug", "info", "warn", "error"
    pub level: String,
    /// Log message
    pub message: String,
    /// Optional structured data
    #[serde(default)]
    pub data: Option<serde_json::Value>,
    /// Timestamp from TypeScript
    pub timestamp: String,
}

/// Channel sender for log entries
pub type LogSender = mpsc::UnboundedSender<LogEntry>;
pub type LogReceiver = mpsc::UnboundedReceiver<LogEntry>;

/// Create a new log channel
pub fn create_log_channel() -> (LogSender, LogReceiver) {
    mpsc::unbounded_channel()
}

/// Generate a unique pipe name for workflow logs
pub fn generate_log_pipe_name(execution_id: &str) -> String {
    format!(r"\\.\pipe\mcp-workflow-logs-{}", execution_id)
}

/// Try to parse a line as a log entry
/// Returns Some(entry) if valid JSON log, None otherwise
pub fn try_parse_log(line: &str) -> Option<LogEntry> {
    let trimmed = line.trim();
    if !trimmed.starts_with('{') {
        return None;
    }

    serde_json::from_str::<LogEntry>(trimmed).ok()
}

/// Windows Named Pipe server for receiving workflow logs
#[cfg(windows)]
pub struct LogPipeServer {
    pipe_name: String,
    log_sender: LogSender,
}

#[cfg(windows)]
impl LogPipeServer {
    /// Create a new log pipe server
    pub fn new(execution_id: &str, log_sender: LogSender) -> Self {
        Self {
            pipe_name: generate_log_pipe_name(execution_id),
            log_sender,
        }
    }

    /// Get the pipe name for passing to TypeScript
    pub fn pipe_name(&self) -> &str {
        &self.pipe_name
    }

    /// Start the pipe server and return a handle to stop it
    pub async fn start(self) -> Result<LogPipeServerHandle, std::io::Error> {
        use tokio::net::windows::named_pipe::{PipeMode, ServerOptions};

        let pipe_name = self.pipe_name.clone();
        let log_sender = self.log_sender;

        // Create the named pipe server
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .pipe_mode(PipeMode::Byte)
            .create(&pipe_name)?;

        info!("Created log pipe: {}", pipe_name);

        let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);

        let handle = tokio::spawn(async move {
            // Wait for client connection
            debug!("Waiting for TypeScript to connect to log pipe...");

            tokio::select! {
                result = server.connect() => {
                    match result {
                        Ok(()) => {
                            info!("TypeScript connected to log pipe");

                            let reader = BufReader::new(server);
                            let mut lines = reader.lines();

                            loop {
                                // Use biased select to prefer reading data over shutdown signal.
                                // This ensures we drain all buffered data before responding to shutdown.
                                tokio::select! {
                                    biased;

                                    line_result = lines.next_line() => {
                                        match line_result {
                                            Ok(Some(line)) => {
                                                if let Some(entry) = try_parse_log(&line) {
                                                    debug!("Received log from pipe: {:?}", entry);
                                                    if log_sender.send(entry).is_err() {
                                                        debug!("Log receiver dropped, stopping log pipe server");
                                                        break;
                                                    }
                                                }
                                            }
                                            Ok(None) => {
                                                debug!("Log pipe closed by client");
                                                break;
                                            }
                                            Err(e) => {
                                                error!("Error reading from log pipe: {}", e);
                                                break;
                                            }
                                        }
                                    }
                                    _ = shutdown_rx.recv() => {
                                        debug!("Log pipe server shutdown requested");
                                        break;
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            error!("Failed to accept log pipe connection: {}", e);
                        }
                    }
                }
                _ = shutdown_rx.recv() => {
                    debug!("Log pipe server shutdown before connection");
                }
            }
        });

        Ok(LogPipeServerHandle {
            handle,
            shutdown_tx,
        })
    }
}

/// Stub log pipe server for non-Windows platforms.
///
/// The TypeScript workflow IPC currently uses Windows Named Pipes. On macOS/Linux
/// we keep the type available so the crate compiles; the server is a no-op.
#[cfg(not(windows))]
pub struct LogPipeServer {
    pipe_name: String,
    #[allow(dead_code)]
    log_sender: LogSender,
}

#[cfg(not(windows))]
impl LogPipeServer {
    pub fn new(execution_id: &str, log_sender: LogSender) -> Self {
        Self {
            pipe_name: format!("mcp-workflow-logs-{}", execution_id),
            log_sender,
        }
    }

    pub fn pipe_name(&self) -> &str {
        &self.pipe_name
    }

    pub async fn start(self) -> Result<LogPipeServerHandle, std::io::Error> {
        let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);
        let handle = tokio::spawn(async move {
            let _ = shutdown_rx.recv().await;
        });

        Ok(LogPipeServerHandle { handle, shutdown_tx })
    }
}

/// Handle to control the log pipe server
pub struct LogPipeServerHandle {
    handle: tokio::task::JoinHandle<()>,
    shutdown_tx: mpsc::Sender<()>,
}

impl LogPipeServerHandle {
    /// Signal the log pipe server to shutdown (does not wait for completion)
    #[allow(dead_code)]
    pub async fn shutdown(self) {
        let _ = self.shutdown_tx.send(()).await;
    }

    /// Signal shutdown AND wait for the pipe server task to complete.
    /// This ensures all buffered data has been read from the pipe and sent
    /// through the channel before returning.
    pub async fn shutdown_and_wait(self) {
        // Signal shutdown
        let _ = self.shutdown_tx.send(()).await;
        // Wait for the task to complete - this ensures all data has been processed
        let _ = self.handle.await;
    }
}

/// Forward log entries to tracing with optional execution_id for OTEL filtering
pub fn forward_log_to_tracing(entry: &LogEntry, execution_id: Option<&str>) {
    let msg = &entry.message;

    // Skip empty messages to avoid log spam during shutdown
    if msg.trim().is_empty() {
        return;
    }

    match (execution_id, entry.level.as_str()) {
        (Some(exec_id), "error") => {
            error!(target: "workflow.typescript", execution_id = %exec_id, "{}", msg)
        }
        (Some(exec_id), "warn") => {
            warn!(target: "workflow.typescript", execution_id = %exec_id, "{}", msg)
        }
        (Some(exec_id), "debug") => {
            debug!(target: "workflow.typescript", execution_id = %exec_id, "{}", msg)
        }
        (Some(exec_id), _) => {
            info!(target: "workflow.typescript", execution_id = %exec_id, "{}", msg)
        }
        (None, "error") => {
            error!(target: "workflow.typescript", "{}", msg)
        }
        (None, "warn") => {
            warn!(target: "workflow.typescript", "{}", msg)
        }
        (None, "debug") => {
            debug!(target: "workflow.typescript", "{}", msg)
        }
        (None, _) => {
            info!(target: "workflow.typescript", "{}", msg)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_log_entry() {
        let json = r#"{"level":"info","message":"Hello world","timestamp":"2025-01-01T00:00:00Z"}"#;
        let entry = try_parse_log(json).unwrap();
        assert_eq!(entry.level, "info");
        assert_eq!(entry.message, "Hello world");
        assert!(entry.data.is_none());
    }

    #[test]
    fn test_parse_log_entry_with_data() {
        let json = r#"{"level":"debug","message":"Item processed","data":{"count":42},"timestamp":"2025-01-01T00:00:00Z"}"#;
        let entry = try_parse_log(json).unwrap();
        assert_eq!(entry.level, "debug");
        assert_eq!(entry.message, "Item processed");
        assert!(entry.data.is_some());
    }

    #[test]
    fn test_parse_invalid_json() {
        assert!(try_parse_log("not json").is_none());
        assert!(try_parse_log("").is_none());
        assert!(try_parse_log("[1,2,3]").is_none());
    }

    #[test]
    fn test_generate_pipe_name() {
        let name = generate_log_pipe_name("exec-123");
        assert_eq!(name, r"\\.\pipe\mcp-workflow-logs-exec-123");
    }

    #[test]
    fn test_log_channel() {
        let (tx, mut rx) = create_log_channel();

        let entry = LogEntry {
            level: "info".to_string(),
            message: "Test".to_string(),
            data: None,
            timestamp: "2025-01-01T00:00:00Z".to_string(),
        };

        tx.send(entry.clone()).unwrap();
        let received = rx.try_recv().unwrap();
        assert_eq!(received.level, entry.level);
        assert_eq!(received.message, entry.message);
    }
}

#[cfg(all(test, windows))]
mod windows_integration_tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::AsyncWriteExt;
    use tokio::time::timeout;

    #[tokio::test]
    async fn test_log_pipe_server_basic() {
        let (tx, mut rx) = create_log_channel();
        let server = LogPipeServer::new("test-log-basic", tx);
        let pipe_name = server.pipe_name().to_string();

        let handle = server
            .start()
            .await
            .expect("Failed to start log pipe server");

        tokio::time::sleep(Duration::from_millis(100)).await;

        let client_task = tokio::spawn(async move {
            use tokio::net::windows::named_pipe::ClientOptions;

            let mut client = ClientOptions::new()
                .open(&pipe_name)
                .expect("Failed to connect to log pipe");

            let log_json = r#"{"level":"info","message":"Test log message","timestamp":"2025-01-01T00:00:00Z"}"#;
            client.write_all(log_json.as_bytes()).await.unwrap();
            client.write_all(b"\n").await.unwrap();
            client.flush().await.unwrap();
        });

        let entry = timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("Timeout waiting for log")
            .expect("Channel closed");

        assert_eq!(entry.level, "info");
        assert_eq!(entry.message, "Test log message");

        client_task.await.unwrap();
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn test_log_pipe_server_multiple_logs() {
        let (tx, mut rx) = create_log_channel();
        let server = LogPipeServer::new("test-log-multi", tx);
        let pipe_name = server.pipe_name().to_string();

        let handle = server
            .start()
            .await
            .expect("Failed to start log pipe server");
        tokio::time::sleep(Duration::from_millis(100)).await;

        let client_task = tokio::spawn(async move {
            use tokio::net::windows::named_pipe::ClientOptions;

            let mut client = ClientOptions::new()
                .open(&pipe_name)
                .expect("Failed to connect to log pipe");

            let logs = vec![
                r#"{"level":"debug","message":"Debug msg","timestamp":"T"}"#,
                r#"{"level":"info","message":"Info msg","timestamp":"T"}"#,
                r#"{"level":"warn","message":"Warn msg","timestamp":"T"}"#,
                r#"{"level":"error","message":"Error msg","timestamp":"T"}"#,
            ];

            for log_json in logs {
                client.write_all(log_json.as_bytes()).await.unwrap();
                client.write_all(b"\n").await.unwrap();
            }
            client.flush().await.unwrap();
        });

        let mut received = Vec::new();
        for _ in 0..4 {
            if let Ok(Some(entry)) = timeout(Duration::from_secs(5), rx.recv()).await {
                received.push(entry);
            }
        }

        assert_eq!(received.len(), 4);
        assert_eq!(received[0].level, "debug");
        assert_eq!(received[1].level, "info");
        assert_eq!(received[2].level, "warn");
        assert_eq!(received[3].level, "error");

        client_task.await.unwrap();
        handle.shutdown().await;
    }

    /// Test that reproduces the race condition where logs are lost
    /// when shutdown is called immediately after client disconnects.
    ///
    /// This simulates the real workflow pattern:
    /// 1. A separate task processes logs from the receiver and captures them
    /// 2. Client writes many logs and disconnects quickly
    /// 3. shutdown() is called and logs are extracted immediately
    ///
    /// Without proper synchronization, some logs may be lost.
    #[tokio::test]
    async fn test_log_pipe_race_condition() {
        use std::sync::{Arc, Mutex};

        let (tx, mut rx) = create_log_channel();
        let server = LogPipeServer::new("test-race-condition", tx);
        let pipe_name = server.pipe_name().to_string();

        let handle = server
            .start()
            .await
            .expect("Failed to start log pipe server");
        tokio::time::sleep(Duration::from_millis(100)).await;

        // Simulate the workflow pattern: a separate task captures logs
        let captured_logs: Arc<Mutex<Vec<LogEntry>>> = Arc::new(Mutex::new(Vec::new()));
        let logs_clone = captured_logs.clone();

        // This is the receiver task (like line 562-576 in workflow_typescript.rs)
        let receiver_task = tokio::spawn(async move {
            while let Some(entry) = rx.recv().await {
                if let Ok(mut logs) = logs_clone.lock() {
                    logs.push(entry);
                }
            }
        });

        // Client writes many logs quickly and disconnects
        let num_logs = 100;
        let client_task = tokio::spawn(async move {
            use tokio::net::windows::named_pipe::ClientOptions;

            let mut client = ClientOptions::new()
                .open(&pipe_name)
                .expect("Failed to connect to log pipe");

            for i in 0..num_logs {
                let log_json = format!(
                    r#"{{"level":"info","message":"Log message {}","timestamp":"T"}}"#,
                    i
                );
                client.write_all(log_json.as_bytes()).await.unwrap();
                client.write_all(b"\n").await.unwrap();
            }
            client.flush().await.unwrap();
            // Client disconnects immediately after flush
        });

        // Wait for client to finish
        client_task.await.unwrap();

        // This is what the old code did: shutdown and extract immediately
        // The 50ms sleep was not enough to guarantee all logs were processed
        handle.shutdown_and_wait().await;

        // Now wait for the receiver task to complete
        // (This is what the fix adds - waiting for the receiver task)
        receiver_task.await.unwrap();

        // Extract captured logs
        let logs = captured_logs.lock().unwrap();

        // With the fix, we should have all logs
        assert_eq!(
            logs.len(),
            num_logs,
            "Expected {} logs but got {}. Race condition caused log loss!",
            num_logs,
            logs.len()
        );
    }
}
