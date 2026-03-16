//! Type definitions for plugin-lobster

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Lobster pipeline actions
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LobsterAction {
    Run,
    Resume,
}

/// Parameters for running a Lobster pipeline
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LobsterRunParams {
    pub pipeline: String,
    #[serde(default)]
    pub args: HashMap<String, serde_json::Value>,
    pub cwd: Option<String>,
}

/// Parameters for resuming a paused Lobster pipeline
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LobsterResumeParams {
    pub token: String,
    #[serde(default = "default_approve")]
    pub approve: bool,
}

fn default_approve() -> bool {
    true
}

/// Approval request from a paused pipeline
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LobsterApprovalRequest {
    pub step_name: String,
    pub description: String,
    pub resume_token: String,
}

/// Success response from Lobster
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LobsterSuccessEnvelope {
    pub status: String,
    pub outputs: Option<HashMap<String, serde_json::Value>>,
    pub approval: Option<LobsterApprovalRequest>,
}

/// Error response from Lobster
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LobsterErrorEnvelope {
    pub status: String,
    pub error: String,
    pub code: Option<String>,
}

/// Combined envelope type
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum LobsterEnvelope {
    Success(LobsterSuccessEnvelope),
    Error(LobsterErrorEnvelope),
}

/// Configuration for the Lobster service
#[derive(Debug, Clone)]
pub struct LobsterConfig {
    pub lobster_path: String,
    pub timeout_ms: u64,
    pub max_stdout_bytes: usize,
}

impl Default for LobsterConfig {
    fn default() -> Self {
        Self {
            lobster_path: "lobster".to_string(),
            timeout_ms: 300_000, // 5 minutes
            max_stdout_bytes: 1_048_576, // 1MB
        }
    }
}

/// Builder for LobsterConfig
#[derive(Debug, Default)]
pub struct LobsterConfigBuilder {
    lobster_path: Option<String>,
    timeout_ms: Option<u64>,
    max_stdout_bytes: Option<usize>,
}

impl LobsterConfigBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn lobster_path(mut self, path: impl Into<String>) -> Self {
        self.lobster_path = Some(path.into());
        self
    }

    pub fn timeout_ms(mut self, ms: u64) -> Self {
        self.timeout_ms = Some(ms);
        self
    }

    pub fn max_stdout_bytes(mut self, bytes: usize) -> Self {
        self.max_stdout_bytes = Some(bytes);
        self
    }

    pub fn build(self) -> LobsterConfig {
        LobsterConfig {
            lobster_path: self.lobster_path.unwrap_or_else(|| "lobster".to_string()),
            timeout_ms: self.timeout_ms.unwrap_or(300_000),
            max_stdout_bytes: self.max_stdout_bytes.unwrap_or(1_048_576),
        }
    }
}

/// Result from a Lobster operation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LobsterResult {
    pub success: bool,
    pub status: String,
    pub outputs: Option<HashMap<String, serde_json::Value>>,
    pub approval: Option<LobsterApprovalRequest>,
    pub error: Option<String>,
}

impl LobsterResult {
    pub fn success(outputs: Option<HashMap<String, serde_json::Value>>) -> Self {
        Self {
            success: true,
            status: "success".to_string(),
            outputs,
            approval: None,
            error: None,
        }
    }

    pub fn needs_approval(approval: LobsterApprovalRequest) -> Self {
        Self {
            success: true,
            status: "needs_approval".to_string(),
            outputs: None,
            approval: Some(approval),
            error: None,
        }
    }

    pub fn error(msg: impl Into<String>) -> Self {
        Self {
            success: false,
            status: "error".to_string(),
            outputs: None,
            approval: None,
            error: Some(msg.into()),
        }
    }
}
