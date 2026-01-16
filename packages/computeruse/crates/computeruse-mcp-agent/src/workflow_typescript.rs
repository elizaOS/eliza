// TypeScript workflow executor

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use tokio::io::{AsyncBufReadExt, BufReader};
use tracing::{debug, error, info, warn, Instrument};

use crate::child_process;
use crate::event_pipe::{create_event_channel, try_parse_event, EventPipeServer};
use crate::execution_logger::CapturedLogEntry;
use crate::log_pipe::{create_log_channel, forward_log_to_tracing, LogPipeServer};
use chrono::Utc;
use rmcp::ErrorData as McpError;
use std::sync::{Arc, Mutex};

// Re-export types for use by other modules
pub use crate::event_pipe::{EventSender, WorkflowEvent};

#[derive(Debug, Clone, PartialEq)]
pub enum JsRuntime {
    /// Bun runtime with the resolved executable path
    Bun(String),
    Node,
}

/// Detect available JavaScript runtime (prefer bun, fallback to node)
/// Uses bundled bun from mediar-app if available, otherwise searches PATH
pub fn detect_js_runtime() -> JsRuntime {
    // Use find_executable which checks bundled location first, then PATH
    if let Some(bun_path) = crate::scripting_engine::find_executable("bun") {
        if let Ok(output) = Command::new(&bun_path).arg("--version").output() {
            if output.status.success() {
                info!("Using bun runtime: {}", bun_path);
                return JsRuntime::Bun(bun_path);
            }
        }
    }

    // Fallback to node
    info!("Bun not found, using node runtime");
    JsRuntime::Node
}

/// Log level parsed from TypeScript console output
#[derive(Debug, Clone, PartialEq)]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
}

/// Parsed log line from TypeScript workflow output
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedLogLine {
    pub level: LogLevel,
    pub message: String,
}

/// Parse a log line from TypeScript workflow stderr output
/// Returns the log level and message content
pub fn parse_log_line(line: &str) -> ParsedLogLine {
    if let Some(msg) = line.strip_prefix("[ERROR] ") {
        ParsedLogLine {
            level: LogLevel::Error,
            message: msg.to_string(),
        }
    } else if let Some(msg) = line.strip_prefix("[WARN] ") {
        ParsedLogLine {
            level: LogLevel::Warn,
            message: msg.to_string(),
        }
    } else if let Some(msg) = line.strip_prefix("[DEBUG] ") {
        ParsedLogLine {
            level: LogLevel::Debug,
            message: msg.to_string(),
        }
    } else if let Some(msg) = line.strip_prefix("[INFO] ") {
        ParsedLogLine {
            level: LogLevel::Info,
            message: msg.to_string(),
        }
    } else {
        // Default to info for unprefixed lines
        ParsedLogLine {
            level: LogLevel::Info,
            message: line.to_string(),
        }
    }
}

/// Copy directory contents recursively (cross-platform)
fn copy_dir_recursive(src: &PathBuf, dst: &PathBuf) -> Result<(), McpError> {
    use std::fs;

    debug!("Copying {} to {}", src.display(), dst.display());

    // Create destination directory
    fs::create_dir_all(dst).map_err(|e| {
        McpError::internal_error(
            format!("Failed to create temp directory: {e}"),
            Some(json!({"error": e.to_string(), "path": dst.display().to_string()})),
        )
    })?;

    // Use robocopy for better performance and symlink handling
    let output = Command::new("robocopy")
        .arg(src)
        .arg(dst)
        .arg("/E") // Copy subdirectories, including empty ones
        .arg("/NFL") // No file list
        .arg("/NDL") // No directory list
        .arg("/NJH") // No job header
        .arg("/NJS") // No job summary
        .arg("/nc") // No class
        .arg("/ns") // No size
        .arg("/np") // No progress
        .output()
        .map_err(|e| {
            McpError::internal_error(
                format!("Failed to execute robocopy: {e}"),
                Some(json!({"error": e.to_string()})),
            )
        })?;

    // robocopy exit codes: 0-7 are success, 8+ are errors
    let exit_code = output.status.code().unwrap_or(16);
    if exit_code >= 8 {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(McpError::internal_error(
            format!("Robocopy failed with exit code {exit_code}: {stderr}"),
            Some(json!({
                "exit_code": exit_code,
                "stderr": stderr.to_string(),
            })),
        ));
    }

    debug!("Successfully copied directory using robocopy");
    Ok(())
}

/// Clean up temporary directory
fn cleanup_temp_dir(path: &PathBuf) {
    use std::fs;
    if let Err(e) = fs::remove_dir_all(path) {
        warn!(
            "Failed to clean up temporary directory {}: {}",
            path.display(),
            e
        );
    } else {
        debug!("Cleaned up temporary directory: {}", path.display());
    }
}

#[derive(Debug)]
pub struct TypeScriptWorkflow {
    workflow_path: PathBuf,
    entry_file: String,
}

impl TypeScriptWorkflow {
    /// Validate that only one workflow exists in the folder
    fn validate_single_workflow(path: &PathBuf) -> Result<(), McpError> {
        use std::fs;

        // Count .ts files that might be workflows (excluding computeruse.ts itself)
        let mut workflow_files = Vec::new();

        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.flatten() {
                if let Ok(file_type) = entry.file_type() {
                    if file_type.is_file() {
                        if let Some(file_name) = entry.file_name().to_str() {
                            // Check for common workflow file patterns (but not computeruse.ts)
                            if file_name.ends_with(".workflow.ts")
                                || (file_name.ends_with(".ts")
                                    && file_name != "computeruse.ts"
                                    && file_name.contains("workflow"))
                            {
                                workflow_files.push(file_name.to_string());
                            }
                        }
                    }
                }
            }
        }

        if !workflow_files.is_empty() {
            return Err(McpError::invalid_params(
                format!(
                    "Multiple workflow files detected. Only one workflow per folder is allowed. Found: {}",
                    workflow_files.join(", ")
                ),
                Some(json!({
                    "path": path.display().to_string(),
                    "conflicting_files": workflow_files,
                    "hint": "Move additional workflows to separate folders or rename them to not include 'workflow' in the filename"
                })),
            ));
        }

        Ok(())
    }

    pub fn new(url: &str) -> Result<Self, McpError> {
        let path_str = url.strip_prefix("file://").ok_or_else(|| {
            McpError::invalid_params(
                "TypeScript workflows must use file:// URLs".to_string(),
                Some(json!({"url": url})),
            )
        })?;
        // Handle Windows file:/// URLs (strip leading / before drive letter like /C:)
        let path_str = if path_str.starts_with('/')
            && path_str.len() > 2
            && path_str.chars().nth(2) == Some(':')
        {
            &path_str[1..]
        } else {
            path_str
        };

        let path = PathBuf::from(path_str);

        // Determine workflow path and entry file
        let (workflow_path, entry_file) = if path.is_dir() {
            // Directory: Check for computeruse.ts in root or src/
            let root_computeruse = path.join("computeruse.ts");
            let src_computeruse = path.join("src").join("computeruse.ts");

            let entry_file = if root_computeruse.exists() {
                "computeruse.ts".to_string()
            } else if src_computeruse.exists() {
                "src/computeruse.ts".to_string()
            } else {
                return Err(McpError::invalid_params(
                    "Missing required entrypoint: computeruse.ts or src/computeruse.ts. TypeScript workflows must use 'computeruse.ts' as the entry file.".to_string(),
                    Some(json!({
                        "path": path.display().to_string(),
                        "hint": "Create a computeruse.ts or src/computeruse.ts file that exports your workflow"
                    })),
                ));
            };

            // Validate single workflow per folder
            Self::validate_single_workflow(&path)?;

            (path, entry_file)
        } else if path.is_file() {
            // File: determine the workflow root directory
            let parent = path.parent().ok_or_else(|| {
                McpError::invalid_params(
                    "Cannot determine parent directory".to_string(),
                    Some(json!({"path": path.display().to_string()})),
                )
            })?;

            // If the file is in a src/ directory, use the parent of src/ as the workflow path
            let (workflow_path, relative_entry) =
                if parent.file_name() == Some(std::ffi::OsStr::new("src")) {
                    let grandparent = parent.parent().ok_or_else(|| {
                        McpError::invalid_params(
                            "Cannot determine workflow root directory".to_string(),
                            Some(json!({"path": path.display().to_string()})),
                        )
                    })?;
                    let file_name = path.file_name().and_then(|n| n.to_str()).ok_or_else(|| {
                        McpError::invalid_params(
                            "Invalid file name".to_string(),
                            Some(json!({"path": path.display().to_string()})),
                        )
                    })?;
                    (grandparent.to_path_buf(), format!("src/{file_name}"))
                } else {
                    // Use parent directory and file name
                    let file_name = path.file_name().and_then(|n| n.to_str()).ok_or_else(|| {
                        McpError::invalid_params(
                            "Invalid file name".to_string(),
                            Some(json!({"path": path.display().to_string()})),
                        )
                    })?;
                    (parent.to_path_buf(), file_name.to_string())
                };

            (workflow_path, relative_entry)
        } else {
            return Err(McpError::invalid_params(
                "Workflow path does not exist".to_string(),
                Some(json!({"path": path.display().to_string()})),
            ));
        };

        Ok(Self {
            workflow_path,
            entry_file,
        })
    }

    /// Execute the entire TypeScript workflow with state management
    pub async fn execute(
        &self,
        inputs: Value,
        start_from_step: Option<&str>,
        end_at_step: Option<&str>,
        restored_state: Option<Value>,
        execution_id: Option<&str>,
    ) -> Result<TypeScriptWorkflowExecutionResult, McpError> {
        self.execute_with_events(
            inputs,
            start_from_step,
            end_at_step,
            restored_state,
            execution_id,
            None,
            None,
        )
        .await
    }

    /// Execute the entire TypeScript workflow with state management and event streaming
    ///
    /// When `event_sender` is provided, workflow events emitted via `emit.*()` in TypeScript
    /// are parsed from stderr and sent through the channel in real-time.
    #[allow(clippy::too_many_arguments)]
    pub async fn execute_with_events(
        &self,
        inputs: Value,
        start_from_step: Option<&str>,
        end_at_step: Option<&str>,
        restored_state: Option<Value>,
        execution_id: Option<&str>,
        event_sender: Option<EventSender>,
        workflow_id: Option<&str>,
    ) -> Result<TypeScriptWorkflowExecutionResult, McpError> {
        use std::env;

        // Check execution mode
        let execution_mode = env::var("MCP_EXECUTION_MODE").unwrap_or_default();
        let use_local_copy = execution_mode == "local-copy";

        // Determine execution directory
        let (execution_dir, temp_dir_guard) = if use_local_copy {
            info!("🔄 Local-copy mode enabled - copying workflow to temporary directory");

            // Create unique temporary directory
            let temp_base = env::var("TEMP")
                .or_else(|_| env::var("TMP"))
                .unwrap_or_else(|_| {
                    if cfg!(target_os = "windows") {
                        "C:\\Temp".to_string()
                    } else {
                        "/tmp".to_string()
                    }
                });

            let temp_dir =
                PathBuf::from(temp_base).join(format!("mcp-exec-{}", uuid::Uuid::new_v4()));

            info!("📁 Temporary directory: {}", temp_dir.display());

            // Copy workflow files to temp directory
            copy_dir_recursive(&self.workflow_path, &temp_dir)?;

            info!("✅ Files copied successfully");

            (temp_dir.clone(), Some(temp_dir))
        } else {
            debug!("📍 Direct mode - executing from source directory");
            (self.workflow_path.clone(), None)
        };

        // Ensure dependencies are installed and cached
        self.ensure_dependencies_in(&execution_dir).await?;

        // Extract ORG_TOKEN from inputs for KV HTTP backend (before inputs is consumed)
        let org_token = inputs
            .get("ORG_TOKEN")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // Create execution script (using execution_dir for imports)
        let exec_script = self.create_execution_script(
            &execution_dir,
            inputs,
            start_from_step,
            end_at_step,
            restored_state,
            execution_id,
        )?;

        debug!(
            "Executing TypeScript workflow with script:\n{}",
            exec_script
        );

        // Execute via bun (priority) or node (fallback)
        // Use tokio::process for async stderr streaming with tracing integration
        let runtime = detect_js_runtime();

        // Set up Windows named pipe for event streaming if event_sender is provided
        #[cfg(windows)]
        let pipe_server_handle = if event_sender.is_some() {
            let exec_id = execution_id.unwrap_or("default");
            let (pipe_tx, mut pipe_rx) = create_event_channel();
            let pipe_server = EventPipeServer::new(exec_id, pipe_tx);
            let pipe_name = pipe_server.pipe_name().to_string();

            // Start the pipe server
            let handle = pipe_server.start().await.map_err(|e| {
                McpError::internal_error(
                    format!("Failed to start event pipe server: {e}"),
                    Some(json!({"error": e.to_string()})),
                )
            })?;

            // Spawn a task to forward pipe events to the event_sender
            let event_sender_clone = event_sender.clone();
            tokio::spawn(async move {
                while let Some(event) = pipe_rx.recv().await {
                    debug!(target: "workflow.event", "Received event from pipe: {:?}", event);

                    // Log events as structured data for OTEL
                    match &event {
                        WorkflowEvent::Progress {
                            current,
                            total,
                            message,
                            ..
                        } => {
                            info!(
                                target: "workflow.event",
                                event_type = "progress",
                                current = %current,
                                total = ?total,
                                "Progress: {}", message.as_deref().unwrap_or("...")
                            );
                        }
                        WorkflowEvent::StepStarted {
                            step_id,
                            step_name,
                            step_index,
                            total_steps,
                            ..
                        } => {
                            info!(
                                target: "workflow.event",
                                event_type = "step_started",
                                step_id = %step_id,
                                step_name = %step_name,
                                step_index = ?step_index,
                                total_steps = ?total_steps,
                                "Step started: {}", step_name
                            );
                        }
                        WorkflowEvent::StepCompleted {
                            step_id,
                            step_name,
                            duration,
                            ..
                        } => {
                            info!(
                                target: "workflow.event",
                                event_type = "step_completed",
                                step_id = %step_id,
                                step_name = %step_name,
                                duration_ms = ?duration,
                                "Step completed: {}", step_name
                            );
                        }
                        WorkflowEvent::StepFailed {
                            step_id,
                            step_name,
                            error,
                            ..
                        } => {
                            error!(
                                target: "workflow.event",
                                event_type = "step_failed",
                                step_id = %step_id,
                                step_name = %step_name,
                                error = ?error,
                                "Step failed: {}", step_name
                            );
                        }
                        WorkflowEvent::Log { level, message, .. } => match level.as_str() {
                            "error" => error!(target: "workflow.event", "{}", message),
                            "warn" => warn!(target: "workflow.event", "{}", message),
                            "debug" => debug!(target: "workflow.event", "{}", message),
                            _ => info!(target: "workflow.event", "{}", message),
                        },
                        _ => {
                            debug!(target: "workflow.event", "Event: {:?}", event);
                        }
                    }

                    // Forward to event_sender
                    if let Some(ref sender) = event_sender_clone {
                        if let Err(e) = sender.send(event) {
                            debug!("Failed to forward workflow event: {}", e);
                            break;
                        }
                    }
                }
            });

            Some((handle, pipe_name))
        } else {
            None
        };

        #[cfg(not(windows))]
        let pipe_server_handle: Option<((), String)> = None;

        // Set up Windows named pipe for log streaming
        #[cfg(windows)]
        let log_pipe_handle = {
            let exec_id = execution_id.unwrap_or("default");
            let (log_tx, mut log_rx) = create_log_channel();
            let log_server = LogPipeServer::new(exec_id, log_tx);
            let log_pipe_name = log_server.pipe_name().to_string();

            // Start the log pipe server
            let handle = log_server.start().await.map_err(|e| {
                McpError::internal_error(
                    format!("Failed to start log pipe server: {e}"),
                    Some(json!({"error": e.to_string()})),
                )
            })?;

            // Clone for the spawned task
            let captured_logs_for_pipe: Arc<Mutex<Vec<CapturedLogEntry>>> =
                Arc::new(Mutex::new(Vec::new()));
            let logs_pipe_clone = captured_logs_for_pipe.clone();
            let exec_id_for_pipe = execution_id.map(|s| s.to_string());

            // Spawn a task to forward log entries to tracing
            // IMPORTANT: Keep the JoinHandle so we can wait for it to complete before extracting logs
            let receiver_task = tokio::spawn(async move {
                while let Some(entry) = log_rx.recv().await {
                    // Forward to tracing
                    forward_log_to_tracing(&entry, exec_id_for_pipe.as_deref());

                    // Capture for return value
                    if let Ok(mut logs) = logs_pipe_clone.lock() {
                        logs.push(CapturedLogEntry {
                            timestamp: Utc::now(),
                            level: entry.level.to_uppercase(),
                            message: entry.message.clone(),
                        });
                    }
                }
            });

            Some((handle, log_pipe_name, captured_logs_for_pipe, receiver_task))
        };

        #[cfg(not(windows))]
        let log_pipe_handle: Option<(
            (),
            String,
            Arc<Mutex<Vec<CapturedLogEntry>>>,
            tokio::task::JoinHandle<()>,
        )> = None;

        use std::process::Stdio;
        let mut cmd = match runtime {
            JsRuntime::Bun(ref bun_path) => {
                info!(
                    "Executing workflow with bun: {}/{}",
                    execution_dir.display(),
                    self.entry_file
                );
                let mut cmd = tokio::process::Command::new(bun_path);
                cmd.current_dir(&execution_dir)
                    .arg("--eval")
                    .arg(&exec_script)
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());
                cmd
            }
            JsRuntime::Node => {
                info!(
                    "Executing workflow with node: {}/{}",
                    execution_dir.display(),
                    self.entry_file
                );
                let mut cmd = tokio::process::Command::new("node");
                cmd.current_dir(&execution_dir)
                    .arg("--import")
                    .arg("tsx/esm")
                    .arg("--eval")
                    .arg(&exec_script)
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());
                cmd
            }
        };

        // Set the pipe path environment variables if we have pipe servers
        #[cfg(windows)]
        if let Some((_, ref pipe_name)) = pipe_server_handle {
            cmd.env("MCP_EVENT_PIPE", pipe_name);
            info!("Set MCP_EVENT_PIPE={}", pipe_name);
        }

        #[cfg(windows)]
        if let Some((_, ref log_pipe_name, _, _)) = log_pipe_handle {
            cmd.env("MCP_LOG_PIPE", log_pipe_name);
            info!("Set MCP_LOG_PIPE={}", log_pipe_name);
        }

        // Pass parent PID so child can monitor for orphan detection
        let parent_pid = std::process::id();
        cmd.env("MCP_PARENT_PID", parent_pid.to_string());
        debug!("Set MCP_PARENT_PID={}", parent_pid);

        // Pass workflow folder name so SDK can store screenshots in workflow folder
        if let Some(folder) = workflow_id {
            cmd.env("COMPUTERUSE_WORKFLOW_ID", folder);
            debug!("Set COMPUTERUSE_WORKFLOW_ID={} (folder name)", folder);
        }

        // Set ORG_TOKEN and KV_URL for HTTP KV backend if token is provided
        // This allows workflows to use the remote KV store via @mediar-ai/kv
        if let Some(ref token) = org_token {
            cmd.env("ORG_TOKEN", token);
            cmd.env("KV_URL", "https://app.mediar.ai/api/kv");
            debug!("Set ORG_TOKEN and KV_URL for HTTP KV backend");
        }

        let mut child = cmd.spawn().map_err(|e| {
            McpError::internal_error(
                format!("Failed to execute workflow: {e}"),
                Some(json!({"error": e.to_string()})),
            )
        })?;

        // Register child process for cleanup on MCP shutdown
        let child_pid = child.id();
        if let Some(pid) = child_pid {
            child_process::register(pid, execution_id.map(|s| s.to_string()));
            debug!("Registered child process PID {} for cleanup tracking", pid);
        }

        // Take stderr and spawn a task to stream logs through tracing AND capture them
        // execution_id is passed as a structured field for OpenTelemetry/ClickHouse filtering
        let stderr = child.stderr.take();
        let exec_id_for_logs = execution_id.map(|s| s.to_string());

        // Create shared vector for captured logs
        let captured_logs: Arc<Mutex<Vec<CapturedLogEntry>>> = Arc::new(Mutex::new(Vec::new()));
        let logs_clone = captured_logs.clone();

        // Determine if events/logs are going through pipe (Windows only)
        #[cfg(windows)]
        let events_via_pipe = pipe_server_handle.is_some();
        #[cfg(not(windows))]
        let events_via_pipe = false;

        #[cfg(windows)]
        let logs_via_pipe = log_pipe_handle.is_some();
        #[cfg(not(windows))]
        let logs_via_pipe = false;

        #[allow(clippy::manual_map)]
        let stderr_handle = if let Some(stderr) = stderr {
            Some(tokio::spawn(
                async move {
                    let reader = BufReader::new(stderr);
                    let mut lines = reader.lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        // On non-Windows or when pipe is not available, parse events from stderr
                        // This is kept as a fallback for backwards compatibility
                        if !events_via_pipe {
                            if let Some(event) = try_parse_event(&line) {
                                debug!(target: "workflow.event", "Received workflow event from stderr: {:?}", event);

                                // Send event through channel if sender is available
                                if let Some(ref sender) = event_sender {
                                    if let Err(e) = sender.send(event.clone()) {
                                        debug!("Failed to send workflow event: {}", e);
                                    }
                                }

                                // Log events as structured data for OTEL
                                match &event {
                                    WorkflowEvent::Progress { current, total, message, .. } => {
                                        info!(
                                            target: "workflow.event",
                                            event_type = "progress",
                                            current = %current,
                                            total = ?total,
                                            "Progress: {}", message.as_deref().unwrap_or("...")
                                        );
                                    }
                                    WorkflowEvent::StepStarted { step_id, step_name, step_index, total_steps, .. } => {
                                        info!(
                                            target: "workflow.event",
                                            event_type = "step_started",
                                            step_id = %step_id,
                                            step_name = %step_name,
                                            step_index = ?step_index,
                                            total_steps = ?total_steps,
                                            "Step started: {}", step_name
                                        );
                                    }
                                    WorkflowEvent::StepCompleted { step_id, step_name, duration, .. } => {
                                        info!(
                                            target: "workflow.event",
                                            event_type = "step_completed",
                                            step_id = %step_id,
                                            step_name = %step_name,
                                            duration_ms = ?duration,
                                            "Step completed: {}", step_name
                                        );
                                    }
                                    WorkflowEvent::StepFailed { step_id, step_name, error, .. } => {
                                        error!(
                                            target: "workflow.event",
                                            event_type = "step_failed",
                                            step_id = %step_id,
                                            step_name = %step_name,
                                            error = ?error,
                                            "Step failed: {}", step_name
                                        );
                                    }
                                    WorkflowEvent::Log { level, message, .. } => {
                                        match level.as_str() {
                                            "error" => error!(target: "workflow.event", "{}", message),
                                            "warn" => warn!(target: "workflow.event", "{}", message),
                                            "debug" => debug!(target: "workflow.event", "{}", message),
                                            _ => info!(target: "workflow.event", "{}", message),
                                        }
                                    }
                                    _ => {
                                        debug!(target: "workflow.event", "Event: {:?}", event);
                                    }
                                }

                                // Don't process as a regular log line
                                continue;
                            }
                        }

                        // Skip MCP event lines when using event pipe
                        if events_via_pipe && line.trim_start().starts_with("{\"__mcp_event__\":true") {
                            continue;
                        }

                        // Skip log lines when using log pipe (they're handled there)
                        // Log pipe entries are JSON objects with "level" field
                        if logs_via_pipe {
                            let trimmed = line.trim_start();
                            if trimmed.starts_with("{\"level\":") {
                                continue;
                            }
                            // Also skip the prefixed format if it somehow appears
                            if trimmed.starts_with("[ERROR]")
                                || trimmed.starts_with("[WARN]")
                                || trimmed.starts_with("[INFO]")
                                || trimmed.starts_with("[DEBUG]")
                            {
                                continue;
                            }
                        }

                        // Skip empty lines to avoid log spam during shutdown
                        if line.trim().is_empty() {
                            continue;
                        }

                        // Regular log line processing (fallback when logs not via pipe)
                        let parsed = parse_log_line(&line);
                        let msg = parsed.message.clone();

                        // Capture the log entry
                        let level_str = match parsed.level {
                            LogLevel::Error => "ERROR",
                            LogLevel::Warn => "WARN",
                            LogLevel::Debug => "DEBUG",
                            LogLevel::Info => "INFO",
                        };
                        if let Ok(mut logs) = logs_clone.lock() {
                            logs.push(CapturedLogEntry {
                                timestamp: Utc::now(),
                                level: level_str.to_string(),
                                message: parsed.message.clone(),
                            });
                        }

                        // Pass execution_id as structured field (not in message body)
                        // This keeps logs clean while still enabling ClickHouse filtering via OTEL attributes
                        match (&exec_id_for_logs, parsed.level) {
                            (Some(exec_id), LogLevel::Error) => {
                                error!(target: "workflow.typescript", execution_id = %exec_id, "{}", msg)
                            }
                            (Some(exec_id), LogLevel::Warn) => {
                                warn!(target: "workflow.typescript", execution_id = %exec_id, "{}", msg)
                            }
                            (Some(exec_id), LogLevel::Debug) => {
                                debug!(target: "workflow.typescript", execution_id = %exec_id, "{}", msg)
                            }
                            (Some(exec_id), LogLevel::Info) => {
                                info!(target: "workflow.typescript", execution_id = %exec_id, "{}", msg)
                            }
                            (None, LogLevel::Error) => {
                                error!(target: "workflow.typescript", "{}", msg)
                            }
                            (None, LogLevel::Warn) => {
                                warn!(target: "workflow.typescript", "{}", msg)
                            }
                            (None, LogLevel::Debug) => {
                                debug!(target: "workflow.typescript", "{}", msg)
                            }
                            (None, LogLevel::Info) => {
                                info!(target: "workflow.typescript", "{}", msg)
                            }
                        }
                    }
                }
                .in_current_span(),
            ))
        } else {
            None
        };

        // Wait for completion and get output
        let output = child.wait_with_output().await.map_err(|e| {
            McpError::internal_error(
                format!("Failed to wait for workflow completion: {e}"),
                Some(json!({"error": e.to_string()})),
            )
        })?;

        // Unregister child process now that it has completed
        if let Some(pid) = child_pid {
            child_process::unregister(pid);
            debug!("Unregistered child process PID {} (completed)", pid);
        }

        if !output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);

            // Wait for stderr handler to finish before extracting logs
            if let Some(handle) = stderr_handle {
                let _ = tokio::time::timeout(std::time::Duration::from_millis(100), handle).await;
            }

            // Extract captured logs even on failure - merge from stderr and log pipe
            let mut logs: Vec<CapturedLogEntry> = captured_logs
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .drain(..)
                .collect();

            // Merge logs from log pipe on error path (Windows only)
            // This ensures console.log output is captured even when workflow fails
            #[cfg(windows)]
            let log_pipe_handle = if let Some((handle, _, pipe_logs, receiver_task)) =
                log_pipe_handle
            {
                // Wait for the pipe server to finish reading all data
                handle.shutdown_and_wait().await;

                // Wait for receiver task with timeout to prevent hanging on error
                let _ = tokio::time::timeout(std::time::Duration::from_millis(100), receiver_task)
                    .await;

                if let Ok(mut pipe_captured) = pipe_logs.lock() {
                    debug!(
                        "[workflow_typescript] Error path: merging {} pipe logs with {} stderr logs",
                        pipe_captured.len(),
                        logs.len()
                    );
                    logs.extend(pipe_captured.drain(..));
                }
                None::<(
                    crate::log_pipe::LogPipeServerHandle,
                    String,
                    std::sync::Arc<std::sync::Mutex<Vec<CapturedLogEntry>>>,
                    tokio::task::JoinHandle<()>,
                )>
            } else {
                None
            };
            // Suppress unused variable warning
            let _ = &log_pipe_handle;

            // Sort logs by timestamp
            logs.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));

            // Try to extract JSON from stdout (same logic as success case)
            let mut error_message = format!(
                "Workflow execution failed with exit code: {:?}",
                output.status.code()
            );
            let mut parsed_result: Option<serde_json::Value> = None;

            // Try to find and parse JSON in stdout
            let json_str = if let Some(start) = stdout.rfind(
                "
{",
            ) {
                Some(&stdout[start + 1..])
            } else if stdout.trim().starts_with('{') {
                Some(stdout.trim())
            } else if let Some(start) = stdout.find('{') {
                stdout.rfind('}').map(|end| &stdout[start..=end])
            } else {
                None
            };

            if let Some(json_str) = json_str {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(json_str) {
                    // Extract error message from result if available
                    if let Some(msg) = parsed
                        .get("result")
                        .and_then(|r| r.get("message"))
                        .and_then(|m| m.as_str())
                    {
                        error_message = msg.to_string();
                    }
                    parsed_result = Some(parsed);
                }
            }

            // Build error data with logs
            let mut error_data = json!({
                "exit_code": output.status.code(),
                "stderr": String::from_utf8_lossy(&output.stderr).to_string(),
            });

            if let Some(result) = parsed_result {
                error_data["workflow_result"] = result;
            } else {
                error_data["stdout"] = json!(stdout.to_string());
            }

            // Add captured logs to error data
            if !logs.is_empty() {
                error_data["logs"] = json!(logs
                    .iter()
                    .map(|l| json!({
                        "timestamp": l.timestamp.to_rfc3339(),
                        "level": l.level,
                        "message": l.message
                    }))
                    .collect::<Vec<_>>());
            }

            // Shutdown the event pipe server on error (log_pipe already handled above) (Windows only)
            #[cfg(windows)]
            if let Some((handle, _)) = pipe_server_handle {
                handle.shutdown().await;
            }

            return Err(McpError::internal_error(error_message, Some(error_data)));
        }

        // Parse result - try to extract JSON from potentially mixed output
        let result_json = String::from_utf8_lossy(&output.stdout);
        debug!("Workflow output:\n{}", result_json);

        // Try to find JSON in the output (it should start with { and end with })
        let json_result = if let Some(start) = result_json.rfind("\n{") {
            // Found JSON after newline, extract from there
            &result_json[start + 1..]
        } else if result_json.trim().starts_with('{') {
            // The whole output is JSON
            result_json.trim()
        } else {
            // Try to find any JSON object in the output
            if let Some(start) = result_json.find('{') {
                if let Some(end) = result_json.rfind('}') {
                    &result_json[start..=end]
                } else {
                    &result_json[start..]
                }
            } else {
                // No JSON found at all
                return Err(McpError::internal_error(
                    "No JSON output found in workflow result".to_string(),
                    Some(json!({
                        "output": result_json.to_string(),
                        "stderr": String::from_utf8_lossy(&output.stderr).to_string(),
                    })),
                ));
            }
        };

        let result: TypeScriptWorkflowResult = serde_json::from_str(json_result).map_err(|e| {
            McpError::internal_error(
                format!("Invalid workflow result: {e}"),
                Some(json!({
                    "error": e.to_string(),
                    "output": result_json.to_string(),
                    "extracted_json": json_result,
                })),
            )
        })?;

        // Clean up temporary directory if used
        if let Some(temp_dir) = temp_dir_guard {
            cleanup_temp_dir(&temp_dir);
        }

        // Shutdown the pipe servers (Windows only)
        #[cfg(windows)]
        if let Some((handle, _)) = pipe_server_handle {
            handle.shutdown().await;
        }

        // Note: log_pipe_handle shutdown is handled below after extracting logs

        // Wait for stderr handler to finish (with short timeout)
        if let Some(handle) = stderr_handle {
            let _ = tokio::time::timeout(std::time::Duration::from_millis(100), handle).await;
        }

        // Extract captured logs - merge from stderr and log pipe
        let mut logs: Vec<CapturedLogEntry> = captured_logs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain(..)
            .collect();

        // Merge logs from log pipe (Windows only)
        #[cfg(windows)]
        if let Some((handle, _, pipe_logs, receiver_task)) = log_pipe_handle {
            // Wait for the pipe server to finish reading all data from the pipe
            // This is important: shutdown_and_wait() ensures the pipe server has read
            // everything and sent it through the channel before we proceed
            handle.shutdown_and_wait().await;

            // Now wait for the receiver task to finish processing all channel messages
            // This ensures all logs have been captured in pipe_logs before we extract them
            let _ = receiver_task.await;

            if let Ok(mut pipe_captured) = pipe_logs.lock() {
                logs.extend(pipe_captured.drain(..));
            }
        }

        // Sort logs by timestamp
        logs.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));

        Ok(TypeScriptWorkflowExecutionResult { result, logs })
    }

    fn create_execution_script(
        &self,
        execution_dir: &Path,
        inputs: Value,
        start_from_step: Option<&str>,
        end_at_step: Option<&str>,
        restored_state: Option<Value>,
        _execution_id: Option<&str>,
    ) -> Result<String, McpError> {
        // Convert Windows path to forward slashes for file:// URL
        let workflow_path_str = execution_dir.display().to_string();
        let workflow_path = workflow_path_str.replace('\\', "/");
        let entry_file = &self.entry_file;

        // Serialize inputs
        let inputs_json = serde_json::to_string(&inputs).map_err(|e| {
            McpError::internal_error(
                format!("Failed to serialize inputs: {e}"),
                Some(json!({"error": e.to_string()})),
            )
        })?;

        // Build step control options object
        let mut step_options_obj = serde_json::Map::new();
        if let Some(start) = start_from_step {
            step_options_obj.insert("startFromStep".to_string(), json!(start));
        }
        if let Some(end) = end_at_step {
            step_options_obj.insert("endAtStep".to_string(), json!(end));
        }
        if let Some(state) = restored_state {
            step_options_obj.insert("restoredState".to_string(), state);
        }

        let step_options_json =
            serde_json::to_string(&Value::Object(step_options_obj)).map_err(|e| {
                McpError::internal_error(
                    format!("Failed to serialize step options: {e}"),
                    Some(json!({"error": e.to_string()})),
                )
            })?;

        // Clean approach: Call workflow.run() with step control options
        // This automatically skips onError when step control options are present
        Ok(format!(
            r#"
// Set up logging transport - uses named pipe if MCP_LOG_PIPE is set, otherwise stderr
const fs = require('fs');
const originalLog = console.log;
const originalError = console.error;

// Log pipe transport
let logPipe = null;
let logPipeReady = false;
const logPipePath = process.env.MCP_LOG_PIPE;

if (logPipePath) {{
    try {{
        logPipe = fs.createWriteStream(logPipePath, {{ flags: 'w' }});
        logPipe.on('error', () => {{ logPipe = null; }});
        logPipeReady = true;
    }} catch (e) {{
        logPipe = null;
    }}
}}

// Send structured log entry
const sendLog = (level, message, data) => {{
    const entry = {{
        level,
        message,
        timestamp: new Date().toISOString(),
        ...(data !== undefined && {{ data }})
    }};

    if (logPipe && logPipeReady) {{
        try {{
            logPipe.write(JSON.stringify(entry) + '\n');
            return;
        }} catch (e) {{
            // Fall through to stderr
        }}
    }}

    // Fallback to stderr with level prefix
    originalError(`[${{level.toUpperCase()}}] ${{message}}${{data !== undefined ? ' ' + JSON.stringify(data) : ''}}`);
}};

// Format args to string for logging
const formatArgs = (...args) => args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');

console.log = (...args) => {{
    // Only allow JSON output to stdout (for result parsing)
    if (args.length === 1 && typeof args[0] === 'string' && args[0].startsWith('{{')) {{
        originalLog(...args);
    }} else {{
        sendLog('info', formatArgs(...args));
    }}
}};
console.info = (...args) => sendLog('info', formatArgs(...args));
console.warn = (...args) => sendLog('warn', formatArgs(...args));
console.error = (...args) => sendLog('error', formatArgs(...args));
console.debug = (...args) => sendLog('debug', formatArgs(...args));

// Drain log pipe - waits for all buffered writes to complete
const drainLogPipe = () => new Promise((resolve) => {{
    if (logPipe && logPipeReady) {{
        // Mark pipe as not ready BEFORE calling end() to prevent any further writes
        logPipeReady = false;
        logPipe.end(() => {{
            // Don't use console.debug here - the pipe is already ended!
            resolve();
        }});
    }} else {{
        resolve();
    }}
}});

// Cleanup on exit (fallback, but drain should be called explicitly)
process.on('exit', () => {{ if (logPipe) try {{ logPipe.end(); }} catch(e) {{}} }});

// Parent PID monitoring - exit if MCP parent process dies
// This prevents dangling bun/node processes when MCP is stopped or crashes
const parentPid = process.env.MCP_PARENT_PID ? parseInt(process.env.MCP_PARENT_PID, 10) : null;
let parentCheckInterval = null;

if (parentPid && !isNaN(parentPid)) {{
    const checkParentAlive = () => {{
        try {{
            // Signal 0 doesn't actually send a signal - it just checks if process exists
            process.kill(parentPid, 0);
        }} catch (e) {{
            // Parent process is gone - cleanup and exit
            console.error(`[orphan-detection] Parent process (PID ${{parentPid}}) terminated, exiting workflow`);
            if (parentCheckInterval) clearInterval(parentCheckInterval);
            if (logPipe) try {{ logPipe.end(); }} catch(e) {{}}
            process.exit(1);
        }}
    }};
    // Check every second
    parentCheckInterval = setInterval(checkParentAlive, 1000);
    // Don't let this interval keep the process alive if everything else is done
    if (parentCheckInterval.unref) parentCheckInterval.unref();
}}

// Set environment to suppress workflow output if supported
process.env.WORKFLOW_SILENT = 'true';
process.env.CI = 'true';

try {{
    // Import workflow
    const workflowModule = await import('file://{workflow_path}/{entry_file}');
    const workflow = workflowModule.default || workflowModule.bestPlanProWorkflow || workflowModule;

    // Check if we're just getting metadata
    if (process.argv.includes('--get-metadata')) {{
        const metadata = workflow.getMetadata ? workflow.getMetadata() : {{
            name: workflow.config?.name || 'Unknown',
            version: workflow.config?.version || '1.0.0',
            description: workflow.config?.description || '',
            steps: workflow.steps || []
        }};
        originalLog(JSON.stringify({{ metadata }}, null, 2));
        if (parentCheckInterval) clearInterval(parentCheckInterval);
        await drainLogPipe();
        process.exit(0);
    }}

    // Execute workflow using workflow.run() with step control options
    // This automatically skips onError when step control options are present
    const inputs = {inputs_json};
    const stepOptions = {step_options_json};

    // Debug logging
    console.debug('Step options being passed to workflow.run():', JSON.stringify(stepOptions));
    console.debug('Workflow has run method?', typeof workflow.run);
    console.debug('Inputs:', JSON.stringify(inputs));

    const result = await workflow.run(inputs, undefined, undefined, stepOptions);

    // Debug the result
    console.debug('Result from workflow.run():', JSON.stringify(result));

    // Get workflow metadata for response
    const metadata = workflow.getMetadata ? workflow.getMetadata() : {{
        name: workflow.config?.name || 'Unknown',
        version: workflow.config?.version || '1.0.0',
        description: workflow.config?.description || ''
    }};

    // Output clean JSON result
    // CRITICAL: Include lastStepId and lastStepIndex from SDK for state persistence
    originalLog(JSON.stringify({{
        metadata,
        result: {{
            status: result.status || 'executed_without_error',
            message: result.message || result.error || 'Workflow completed',
            data: result.data || result.context?.data || null,
            last_step_id: result.lastStepId,
            last_step_index: result.lastStepIndex
        }},
        state: result.state || {{ context: {{ data: result.data }} }}
    }}, null, 2));

    // Cleanup and drain log pipe before exit
    if (parentCheckInterval) clearInterval(parentCheckInterval);
    await drainLogPipe();
    process.exit(result.status === 'executed_without_error' ? 0 : 1);
}} catch (error) {{
    console.error('Workflow execution error:', error);
    originalLog(JSON.stringify({{
        metadata: {{ name: 'Error', version: '0.0.0' }},
        result: {{
            status: 'executed_with_error',
            error: error.message || String(error)
        }},
        state: {{}}
    }}, null, 2));
    // Cleanup and drain log pipe before exit
    if (parentCheckInterval) clearInterval(parentCheckInterval);
    await drainLogPipe();
    process.exit(1);
}}
"#
        ))
    }

    /// Ensure dependencies are installed in a specific directory
    ///
    /// Simple strategy: Just run bun/npm install in the workflow directory.
    async fn ensure_dependencies_in(&self, workflow_dir: &PathBuf) -> Result<(), McpError> {
        let package_json_path = workflow_dir.join("package.json");

        // Check if package.json exists
        if !package_json_path.exists() {
            info!("No package.json found - skipping dependency installation");
            return Ok(());
        }

        let workflow_node_modules = workflow_dir.join("node_modules");
        let runtime = detect_js_runtime();

        // Check if dependencies need updating by comparing package.json mtime with lockfile
        let needs_install = if workflow_node_modules.exists() {
            // Bun uses bun.lockb (binary, older) or bun.lock (text, newer)
            let lockfile_path = match &runtime {
                JsRuntime::Bun(_) => {
                    let lockb = workflow_dir.join("bun.lockb");
                    let lock = workflow_dir.join("bun.lock");
                    // Prefer bun.lock (newer text format), fallback to bun.lockb (older binary)
                    if lock.exists() {
                        lock
                    } else {
                        lockb
                    }
                }
                JsRuntime::Node => workflow_dir.join("package-lock.json"),
            };

            // If lockfile doesn't exist, need to install
            if !lockfile_path.exists() {
                info!("⏳ Lockfile not found - running install to generate it");
                true
            } else {
                // Compare modification times
                let package_json_mtime =
                    package_json_path.metadata().and_then(|m| m.modified()).ok();
                let lockfile_mtime = lockfile_path.metadata().and_then(|m| m.modified()).ok();

                match (package_json_mtime, lockfile_mtime) {
                    (Some(pkg_time), Some(lock_time)) => {
                        if pkg_time > lock_time {
                            info!("⏳ package.json newer than lockfile - updating dependencies");
                            true
                        } else {
                            info!("✓ Dependencies up to date (lockfile is fresh)");
                            false
                        }
                    }
                    _ => {
                        // Can't determine - safer to reinstall
                        info!("⏳ Could not check file times - reinstalling dependencies");
                        true
                    }
                }
            }
        } else {
            info!("⏳ node_modules not found - installing dependencies");
            true
        };

        if !needs_install {
            return Ok(());
        }

        // Install dependencies in workflow directory
        info!("⏳ Installing dependencies...");

        let install_result = match &runtime {
            JsRuntime::Bun(bun_path) => Command::new(bun_path)
                .arg("install")
                .current_dir(workflow_dir)
                .output(),
            JsRuntime::Node => Command::new("npm")
                .arg("install")
                .current_dir(workflow_dir)
                .output(),
        }
        .map_err(|e| {
            McpError::internal_error(
                format!("Failed to run dependency installation: {e}"),
                Some(json!({"error": e.to_string()})),
            )
        })?;

        if !install_result.status.success() {
            let stderr = String::from_utf8_lossy(&install_result.stderr);
            return Err(McpError::internal_error(
                format!("Dependency installation failed: {stderr}"),
                Some(json!({
                    "stderr": stderr.to_string(),
                    "stdout": String::from_utf8_lossy(&install_result.stdout).to_string(),
                })),
            ));
        }

        info!("✓ Dependencies installed successfully");

        Ok(())
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TypeScriptWorkflowResult {
    pub metadata: WorkflowMetadata,
    pub result: WorkflowExecutionResult,
    pub state: Value,
}

/// Result from TypeScript workflow execution including captured logs
pub struct TypeScriptWorkflowExecutionResult {
    pub result: TypeScriptWorkflowResult,
    pub logs: Vec<CapturedLogEntry>,
}

/// Trigger configuration for workflows
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TriggerConfig {
    /// Cron-based scheduling
    Cron {
        /// Cron expression (5-field or 6-field format)
        schedule: String,
        /// Optional timezone (IANA format)
        timezone: Option<String>,
        /// Whether this trigger is enabled (default: true)
        #[serde(default = "default_enabled")]
        enabled: bool,
    },
    /// Manual trigger (default)
    Manual {
        /// Whether this trigger is enabled (default: true)
        #[serde(default = "default_enabled")]
        enabled: bool,
    },
    /// Webhook trigger
    Webhook {
        /// Optional webhook path suffix
        path: Option<String>,
        /// Whether this trigger is enabled (default: true)
        #[serde(default = "default_enabled")]
        enabled: bool,
    },
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Deserialize, Serialize)]
pub struct WorkflowMetadata {
    pub name: String,
    pub description: Option<String>,
    pub version: Option<String>,
    pub input: Value,
    pub steps: Vec<StepMetadata>,
    /// Trigger configuration for the workflow
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger: Option<TriggerConfig>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct StepMetadata {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct WorkflowExecutionResult {
    pub status: String,
    pub message: Option<String>,
    pub data: Option<Value>,
    // Fields from WorkflowRunner (optional for backward compat)
    pub last_step_id: Option<String>,
    pub last_step_index: Option<usize>,
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_bun_or_node() {
        let runtime = detect_js_runtime();
        // Should return either Bun or Node (depending on environment)
        assert!(matches!(runtime, JsRuntime::Bun(_)) || matches!(runtime, JsRuntime::Node));
    }

    #[test]
    fn test_typescript_workflow_from_file() {
        use std::fs;
        use tempfile::TempDir;

        let temp_dir = TempDir::new().unwrap();
        let workflow_file = temp_dir.path().join("test-workflow.ts");
        fs::write(&workflow_file, "export default {};").unwrap();

        let url = format!("file://{}", workflow_file.display());
        let ts_workflow = TypeScriptWorkflow::new(&url).unwrap();

        assert_eq!(ts_workflow.entry_file, "test-workflow.ts");
        assert_eq!(ts_workflow.workflow_path, temp_dir.path());
    }

    #[test]
    fn test_typescript_workflow_requires_computeruse_ts() {
        use std::fs;
        use tempfile::TempDir;

        let temp_dir = TempDir::new().unwrap();

        // Create computeruse.ts
        fs::write(temp_dir.path().join("computeruse.ts"), "export default {};").unwrap();

        let url = format!("file://{}", temp_dir.path().display());
        let ts_workflow = TypeScriptWorkflow::new(&url).unwrap();

        assert_eq!(ts_workflow.entry_file, "computeruse.ts");
        assert_eq!(ts_workflow.workflow_path, temp_dir.path());
    }

    #[test]
    fn test_typescript_workflow_missing_computeruse_ts() {
        use std::fs;
        use tempfile::TempDir;

        let temp_dir = TempDir::new().unwrap();

        // Create other workflow file, but no computeruse.ts
        fs::write(temp_dir.path().join("my-workflow.ts"), "export default {};").unwrap();

        let url = format!("file://{}", temp_dir.path().display());
        let result = TypeScriptWorkflow::new(&url);

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err
            .message
            .contains("Missing required entrypoint: computeruse.ts"));
    }

    #[test]
    fn test_single_workflow_validation_passes() {
        use std::fs;
        use tempfile::TempDir;

        let temp_dir = TempDir::new().unwrap();

        // Create only computeruse.ts (no other workflow files)
        fs::write(temp_dir.path().join("computeruse.ts"), "export default {};").unwrap();
        fs::write(
            temp_dir.path().join("utils.ts"),
            "export const helper = () => {};",
        )
        .unwrap();

        let url = format!("file://{}", temp_dir.path().display());
        let result = TypeScriptWorkflow::new(&url);

        assert!(result.is_ok());
    }

    #[test]
    fn test_single_workflow_validation_fails_with_multiple_workflows() {
        use std::fs;
        use tempfile::TempDir;

        let temp_dir = TempDir::new().unwrap();

        // Create computeruse.ts and another workflow file
        fs::write(temp_dir.path().join("computeruse.ts"), "export default {};").unwrap();
        fs::write(temp_dir.path().join("my-workflow.ts"), "export default {};").unwrap();

        let url = format!("file://{}", temp_dir.path().display());
        let result = TypeScriptWorkflow::new(&url);

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.message.contains("Multiple workflow files detected"));
        assert!(err.message.contains("my-workflow.ts"));
    }

    #[test]
    fn test_parse_log_line_error() {
        let parsed = parse_log_line("[ERROR] Something went wrong");
        assert_eq!(parsed.level, LogLevel::Error);
        assert_eq!(parsed.message, "Something went wrong");
    }

    #[test]
    fn test_parse_log_line_warn() {
        let parsed = parse_log_line("[WARN] This is a warning");
        assert_eq!(parsed.level, LogLevel::Warn);
        assert_eq!(parsed.message, "This is a warning");
    }

    #[test]
    fn test_parse_log_line_info() {
        let parsed = parse_log_line("[INFO] Informational message");
        assert_eq!(parsed.level, LogLevel::Info);
        assert_eq!(parsed.message, "Informational message");
    }

    #[test]
    fn test_parse_log_line_debug() {
        let parsed = parse_log_line("[DEBUG] Debug details here");
        assert_eq!(parsed.level, LogLevel::Debug);
        assert_eq!(parsed.message, "Debug details here");
    }

    #[test]
    fn test_parse_log_line_unprefixed_defaults_to_info() {
        let parsed = parse_log_line("Some random output without prefix");
        assert_eq!(parsed.level, LogLevel::Info);
        assert_eq!(parsed.message, "Some random output without prefix");
    }

    #[test]
    fn test_parse_log_line_empty_message() {
        let parsed = parse_log_line("[ERROR] ");
        assert_eq!(parsed.level, LogLevel::Error);
        assert_eq!(parsed.message, "");
    }

    #[test]
    fn test_parse_log_line_with_json_content() {
        let parsed = parse_log_line("[DEBUG] {\"key\": \"value\", \"count\": 42}");
        assert_eq!(parsed.level, LogLevel::Debug);
        assert_eq!(parsed.message, "{\"key\": \"value\", \"count\": 42}");
    }

    #[test]
    fn test_parse_log_line_preserves_spaces_in_message() {
        let parsed = parse_log_line("[INFO]    Multiple   spaces   here");
        assert_eq!(parsed.level, LogLevel::Info);
        assert_eq!(parsed.message, "   Multiple   spaces   here");
    }

    #[test]
    fn test_parse_log_line_case_sensitive() {
        // Lowercase prefix should not be recognized
        let parsed = parse_log_line("[error] lowercase prefix");
        assert_eq!(parsed.level, LogLevel::Info); // Falls through to default
        assert_eq!(parsed.message, "[error] lowercase prefix");
    }

    #[test]
    fn test_org_token_extraction_from_inputs() {
        // Test that ORG_TOKEN can be extracted from inputs JSON
        let inputs_with_token = serde_json::json!({
            "ORG_TOKEN": "test-token-123",
            "other_input": "value"
        });

        let org_token = inputs_with_token
            .get("ORG_TOKEN")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        assert_eq!(org_token, Some("test-token-123".to_string()));
    }

    #[test]
    fn test_org_token_extraction_missing() {
        // Test that missing ORG_TOKEN returns None
        let inputs_without_token = serde_json::json!({
            "other_input": "value"
        });

        let org_token = inputs_without_token
            .get("ORG_TOKEN")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        assert_eq!(org_token, None);
    }

    #[test]
    fn test_org_token_extraction_null() {
        // Test that null ORG_TOKEN returns None
        let inputs_null_token = serde_json::json!({
            "ORG_TOKEN": null,
            "other_input": "value"
        });

        let org_token = inputs_null_token
            .get("ORG_TOKEN")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        assert_eq!(org_token, None);
    }
}
