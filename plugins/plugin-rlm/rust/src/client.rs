//! RLM Client for Rust.
//!
//! This client communicates with a Python subprocess running the RLM server
//! via JSON-RPC style IPC over stdin/stdout.
//!
//! Features parity with Python and TypeScript implementations:
//! - Per-request overrides (max_iterations, max_depth, models)
//! - Cost tracking (RLMCost)
//! - Trajectory logging (RLMTrajectory)
//! - Retry with exponential backoff
//! - Dual-model configuration

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, oneshot};
use tracing::{debug, error, info, warn};

use crate::error::{RLMError, Result};
use crate::types::{
    IPCReadyMessage, IPCRequest, IPCResponse, RLMConfig, RLMInferOptions, RLMMessage, RLMResult,
    RLMStatusResponse,
};

/// Patterns indicating a retryable error.
const RETRYABLE_PATTERNS: &[&str] = &[
    "timeout",
    "rate limit",
    "connection",
    "503",
    "429",
    "temporary",
    "econnreset",
    "econnrefused",
];

/// RLM Client that communicates with Python subprocess.
pub struct RLMClient {
    config: RLMConfig,
    process: Arc<Mutex<Option<Child>>>,
    request_id: AtomicU64,
    pending_requests: Arc<Mutex<HashMap<u64, oneshot::Sender<IPCResponse>>>>,
    is_ready: Arc<AtomicBool>,
    is_available: Arc<AtomicBool>,
}

impl RLMClient {
    /// Create a new RLM client with the given configuration.
    pub fn new(config: RLMConfig) -> Result<Self> {
        config.validate().map_err(RLMError::ConfigError)?;
        
        Ok(Self {
            config,
            process: Arc::new(Mutex::new(None)),
            request_id: AtomicU64::new(0),
            pending_requests: Arc::new(Mutex::new(HashMap::new())),
            is_ready: Arc::new(AtomicBool::new(false)),
            is_available: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Create a new RLM client with default configuration from environment.
    pub fn from_env() -> Result<Self> {
        Self::new(RLMConfig::from_env())
    }

    /// Start the Python subprocess server.
    async fn start_server(&self) -> Result<()> {
        let mut process_guard = self.process.lock().await;
        if process_guard.is_some() {
            return Ok(());
        }

        debug!(
            "Starting RLM server: {} -m elizaos_plugin_rlm.server",
            self.config.python_path
        );

        let mut cmd = Command::new(&self.config.python_path);
        cmd.args(["-m", "elizaos_plugin_rlm.server"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("ELIZA_RLM_BACKEND", self.config.backend.to_string())
            .env("ELIZA_RLM_ENV", self.config.environment.to_string())
            .env("ELIZA_RLM_MAX_ITERATIONS", self.config.max_iterations.to_string())
            .env("ELIZA_RLM_MAX_DEPTH", self.config.max_depth.to_string())
            .env("ELIZA_RLM_VERBOSE", if self.config.verbose { "true" } else { "false" })
            .env("ELIZA_RLM_TRACK_COSTS", if self.config.track_costs { "true" } else { "false" })
            .env("ELIZA_RLM_LOG_TRAJECTORIES", if self.config.log_trajectories { "true" } else { "false" });
        
        // Add dual-model config if specified
        if !self.config.root_model.is_empty() {
            cmd.env("ELIZA_RLM_ROOT_MODEL", &self.config.root_model);
        }
        if !self.config.subcall_backend.is_empty() {
            cmd.env("ELIZA_RLM_SUBCALL_BACKEND", &self.config.subcall_backend);
        }
        if !self.config.subcall_model.is_empty() {
            cmd.env("ELIZA_RLM_SUBCALL_MODEL", &self.config.subcall_model);
        }

        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(e) => {
                warn!("Failed to start RLM server: {}", e);
                self.is_available.store(false, Ordering::SeqCst);
                return Err(RLMError::IoError(e.to_string()));
            }
        };

        let stdout = child.stdout.take().ok_or(RLMError::ServerNotRunning)?;
        // Verify stdin is available (we access it via child.stdin in send_request)
        if child.stdin.is_none() {
            return Err(RLMError::ServerNotRunning);
        }

        *process_guard = Some(child);
        drop(process_guard);

        // Spawn reader task
        let pending = self.pending_requests.clone();
        let is_ready_clone = self.is_ready.clone();
        let is_available_clone = self.is_available.clone();

        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();

            while let Ok(Some(line)) = lines.next_line().await {
                // Try to parse as ready message
                if let Ok(ready) = serde_json::from_str::<IPCReadyMessage>(&line) {
                    is_ready_clone.store(true, Ordering::SeqCst);
                    is_available_clone.store(ready.available, Ordering::SeqCst);
                    info!("RLM server ready, available: {}", ready.available);
                    continue;
                }

                // Try to parse as response
                if let Ok(response) = serde_json::from_str::<IPCResponse>(&line) {
                    let mut pending_guard = pending.lock().await;
                    if let Some(sender) = pending_guard.remove(&response.id) {
                        let _ = sender.send(response);
                    }
                } else {
                    debug!("Unknown message from RLM server: {}", line);
                }
            }
        });

        // Store stdin for sending requests
        // Note: We need to handle stdin separately since it's consumed above
        // For simplicity, we'll recreate the process handle approach

        // Wait for ready
        self.wait_for_ready().await?;

        Ok(())
    }

    /// Wait for the server to be ready.
    async fn wait_for_ready(&self) -> Result<()> {
        let timeout = tokio::time::Duration::from_secs(10);
        let start = tokio::time::Instant::now();

        while start.elapsed() < timeout {
            if self.is_ready.load(Ordering::SeqCst) {
                return Ok(());
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        }

        Err(RLMError::Timeout("Server startup".to_string()))
    }

    /// Ensure the server is running.
    async fn ensure_server(&self) -> Result<()> {
        if !self.is_ready.load(Ordering::SeqCst) {
            self.start_server().await?;
        }
        Ok(())
    }

    /// Send a request to the server.
    async fn send_request(&self, method: &str, params: serde_json::Value) -> Result<serde_json::Value> {
        self.ensure_server().await?;

        let id = self.request_id.fetch_add(1, Ordering::SeqCst);
        let request = IPCRequest {
            id,
            method: method.to_string(),
            params,
        };

        let (tx, rx) = oneshot::channel();
        
        {
            let mut pending = self.pending_requests.lock().await;
            pending.insert(id, tx);
        }

        // Get process stdin and write request
        let mut process_guard = self.process.lock().await;
        if let Some(ref mut child) = *process_guard {
            if let Some(ref mut stdin) = child.stdin {
                let request_json = serde_json::to_string(&request)?;
                stdin.write_all(request_json.as_bytes()).await?;
                stdin.write_all(b"\n").await?;
                stdin.flush().await?;
            } else {
                return Err(RLMError::ServerNotRunning);
            }
        } else {
            return Err(RLMError::ServerNotRunning);
        }
        drop(process_guard);

        // Wait for response with timeout
        let timeout = tokio::time::Duration::from_secs(60);
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(response)) => {
                if let Some(error) = response.error {
                    Err(RLMError::ServerError(error))
                } else {
                    response.result.ok_or(RLMError::ServerError("No result".to_string()))
                }
            }
            Ok(Err(_)) => Err(RLMError::IpcError("Channel closed".to_string())),
            Err(_) => {
                // Remove pending request on timeout
                let mut pending = self.pending_requests.lock().await;
                pending.remove(&id);
                Err(RLMError::Timeout(method.to_string()))
            }
        }
    }

    /// Check if RLM backend is available.
    pub fn is_available(&self) -> bool {
        self.is_available.load(Ordering::SeqCst)
    }

    /// Normalize messages input.
    pub fn normalize_messages(input: MessageInput) -> Vec<RLMMessage> {
        match input {
            MessageInput::String(s) => vec![RLMMessage::user(s)],
            MessageInput::Messages(msgs) => msgs,
        }
    }

    /// Check if an error is retryable.
    fn is_retryable_error(error: &RLMError) -> bool {
        let error_str = error.to_string().to_lowercase();
        RETRYABLE_PATTERNS.iter().any(|p| error_str.contains(p))
    }

    /// Calculate delay with exponential backoff and jitter.
    fn calculate_backoff_delay(&self, attempt: u32) -> std::time::Duration {
        let base = self.config.retry_base_delay;
        let max = self.config.retry_max_delay;
        
        // Exponential backoff: base * 2^attempt
        let delay = base * (1u64 << attempt.min(10)) as f64;
        let capped = delay.min(max);
        
        // Add jitter (±25%)
        let jitter = capped * 0.25 * (rand::random::<f64>() * 2.0 - 1.0);
        let final_delay = (capped + jitter).max(0.0);
        
        std::time::Duration::from_secs_f64(final_delay)
    }

    /// Perform inference using RLM with retry logic.
    pub async fn infer(&self, input: MessageInput, opts: Option<RLMInferOptions>) -> RLMResult {
        // Try to use the server
        if let Err(e) = self.ensure_server().await {
            error!("Failed to start RLM server: {}", e);
            return RLMResult::stub(Some(e.to_string()));
        }

        if !self.is_ready.load(Ordering::SeqCst) {
            return RLMResult::stub(None);
        }

        let messages = Self::normalize_messages(input);
        let params = serde_json::json!({
            "messages": messages,
            "opts": opts.unwrap_or_default(),
        });

        let max_retries = self.config.max_retries;
        let mut last_error: Option<RLMError> = None;

        for attempt in 0..=max_retries {
            match self.send_request("infer", params.clone()).await {
                Ok(result) => {
                    return serde_json::from_value(result).unwrap_or_else(|e| {
                        RLMResult::stub(Some(format!("Failed to parse result: {}", e)))
                    });
                }
                Err(e) => {
                    last_error = Some(e.clone());
                    
                    // Check if this is the last attempt or not retryable
                    if attempt >= max_retries || !Self::is_retryable_error(&e) {
                        error!("RLM inference failed after {} attempts: {}", attempt + 1, e);
                        break;
                    }
                    
                    // Calculate backoff delay and wait
                    let delay = self.calculate_backoff_delay(attempt);
                    warn!(
                        "RLM inference attempt {} failed (retrying in {:?}): {}",
                        attempt + 1,
                        delay,
                        e
                    );
                    tokio::time::sleep(delay).await;
                }
            }
        }

        RLMResult::stub(last_error.map(|e| e.to_string()))
    }

    /// Get server status.
    pub async fn get_status(&self) -> RLMStatusResponse {
        if let Err(_) = self.ensure_server().await {
            return RLMStatusResponse {
                available: false,
                backend: self.config.backend.to_string(),
                environment: self.config.environment.to_string(),
                max_iterations: self.config.max_iterations,
                max_depth: self.config.max_depth,
            };
        }

        match self.send_request("status", serde_json::json!({})).await {
            Ok(result) => {
                serde_json::from_value(result).unwrap_or(RLMStatusResponse {
                    available: false,
                    backend: self.config.backend.to_string(),
                    environment: self.config.environment.to_string(),
                    max_iterations: self.config.max_iterations,
                    max_depth: self.config.max_depth,
                })
            }
            Err(_) => RLMStatusResponse {
                available: false,
                backend: self.config.backend.to_string(),
                environment: self.config.environment.to_string(),
                max_iterations: self.config.max_iterations,
                max_depth: self.config.max_depth,
            },
        }
    }

    /// Shutdown the server.
    pub async fn shutdown(&self) -> Result<()> {
        let _ = self.send_request("shutdown", serde_json::json!({})).await;

        let mut process_guard = self.process.lock().await;
        if let Some(mut child) = process_guard.take() {
            let _ = child.kill().await;
        }

        self.is_ready.store(false, Ordering::SeqCst);
        self.is_available.store(false, Ordering::SeqCst);

        Ok(())
    }
}

/// Input type for inference - either a string prompt or message list.
pub enum MessageInput {
    /// Simple string prompt
    String(String),
    /// List of chat messages with roles
    Messages(Vec<RLMMessage>),
}

impl From<&str> for MessageInput {
    fn from(s: &str) -> Self {
        MessageInput::String(s.to_string())
    }
}

impl From<String> for MessageInput {
    fn from(s: String) -> Self {
        MessageInput::String(s)
    }
}

impl From<Vec<RLMMessage>> for MessageInput {
    fn from(msgs: Vec<RLMMessage>) -> Self {
        MessageInput::Messages(msgs)
    }
}

impl Drop for RLMClient {
    fn drop(&mut self) {
        // Note: We can't do async cleanup in Drop
        // The process will be killed when it goes out of scope anyway
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_messages_string() {
        let messages = RLMClient::normalize_messages("Hello".into());
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].content, "Hello");
    }

    #[test]
    fn test_normalize_messages_vec() {
        let input = vec![RLMMessage::user("Hello"), RLMMessage::assistant("Hi")];
        let messages = RLMClient::normalize_messages(input.into());
        assert_eq!(messages.len(), 2);
    }

    #[test]
    fn test_stub_result() {
        let result = RLMResult::stub(None);
        assert!(result.metadata.stub);
        assert!(result.text.contains("STUB"));
    }
}
