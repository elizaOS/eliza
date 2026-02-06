//! Types for the RLM (Recursive Language Model) plugin.
//!
//! Reference: <https://arxiv.org/abs/2512.24601>

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Supported LLM backends for RLM.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RLMBackend {
    /// OpenAI models (GPT-4, GPT-5, etc.)
    OpenAI,
    /// Anthropic models (Claude family)
    Anthropic,
    /// Google Gemini models (default)
    #[default]
    Gemini,
    /// Groq accelerated inference
    Groq,
    /// OpenRouter unified API
    OpenRouter,
}

impl std::fmt::Display for RLMBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RLMBackend::OpenAI => write!(f, "openai"),
            RLMBackend::Anthropic => write!(f, "anthropic"),
            RLMBackend::Gemini => write!(f, "gemini"),
            RLMBackend::Groq => write!(f, "groq"),
            RLMBackend::OpenRouter => write!(f, "openrouter"),
        }
    }
}

/// Supported execution environments for RLM.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RLMEnvironment {
    /// Local Python execution (default)
    #[default]
    Local,
    /// Docker container execution
    Docker,
    /// Modal cloud execution
    Modal,
    /// Prime cloud execution
    Prime,
}

impl std::fmt::Display for RLMEnvironment {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RLMEnvironment::Local => write!(f, "local"),
            RLMEnvironment::Docker => write!(f, "docker"),
            RLMEnvironment::Modal => write!(f, "modal"),
            RLMEnvironment::Prime => write!(f, "prime"),
        }
    }
}

/// Configuration for the RLM client.
/// 
/// Matches Python `RLMConfig` and TypeScript `RLMClientConfig`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RLMConfig {
    /// LLM backend to use.
    #[serde(default)]
    pub backend: RLMBackend,
    /// Root model for main inference (e.g., "gpt-5", "claude-3-opus").
    #[serde(default)]
    pub root_model: String,
    /// Backend for sub-calls (falls back to main backend if empty).
    #[serde(default)]
    pub subcall_backend: String,
    /// Model for sub-calls (falls back to root_model if empty).
    #[serde(default)]
    pub subcall_model: String,
    /// Additional backend-specific configuration.
    #[serde(default)]
    pub backend_kwargs: HashMap<String, String>,
    /// Execution environment.
    #[serde(default)]
    pub environment: RLMEnvironment,
    /// Maximum REPL iterations.
    #[serde(default = "default_max_iterations")]
    pub max_iterations: u32,
    /// Maximum recursion depth.
    #[serde(default = "default_max_depth")]
    pub max_depth: u32,
    /// Enable verbose logging.
    #[serde(default)]
    pub verbose: bool,
    /// Enable cost tracking.
    #[serde(default = "default_true")]
    pub track_costs: bool,
    /// Enable trajectory logging.
    #[serde(default = "default_true")]
    pub log_trajectories: bool,
    /// Maximum retries for transient errors.
    #[serde(default = "default_max_retries")]
    pub max_retries: u32,
    /// Base delay for retry backoff (seconds).
    #[serde(default = "default_retry_base_delay")]
    pub retry_base_delay: f64,
    /// Maximum delay for retry backoff (seconds).
    #[serde(default = "default_retry_max_delay")]
    pub retry_max_delay: f64,
    /// Path to Python executable for IPC.
    #[serde(default = "default_python_path")]
    pub python_path: String,
}

fn default_max_iterations() -> u32 {
    4
}

fn default_max_depth() -> u32 {
    1
}

fn default_true() -> bool {
    true
}

fn default_max_retries() -> u32 {
    3
}

fn default_retry_base_delay() -> f64 {
    1.0
}

fn default_retry_max_delay() -> f64 {
    30.0
}

fn default_python_path() -> String {
    "python".to_string()
}

impl Default for RLMConfig {
    fn default() -> Self {
        Self {
            backend: RLMBackend::default(),
            root_model: String::new(),
            subcall_backend: String::new(),
            subcall_model: String::new(),
            backend_kwargs: HashMap::new(),
            environment: RLMEnvironment::default(),
            max_iterations: 4,
            max_depth: 1,
            verbose: false,
            track_costs: true,
            log_trajectories: true,
            max_retries: 3,
            retry_base_delay: 1.0,
            retry_max_delay: 30.0,
            python_path: "python".to_string(),
        }
    }
}

fn env_bool(key: &str, default: bool) -> bool {
    std::env::var(key)
        .ok()
        .map(|s| matches!(s.to_lowercase().as_str(), "1" | "true" | "yes"))
        .unwrap_or(default)
}

impl RLMConfig {
    /// Create config from environment variables.
    pub fn from_env() -> Self {
        let backend = std::env::var("ELIZA_RLM_BACKEND")
            .ok()
            .and_then(|s| match s.to_lowercase().as_str() {
                "openai" => Some(RLMBackend::OpenAI),
                "anthropic" => Some(RLMBackend::Anthropic),
                "gemini" => Some(RLMBackend::Gemini),
                "groq" => Some(RLMBackend::Groq),
                "openrouter" => Some(RLMBackend::OpenRouter),
                _ => None,
            })
            .unwrap_or_default();

        let environment = std::env::var("ELIZA_RLM_ENV")
            .ok()
            .and_then(|s| match s.to_lowercase().as_str() {
                "local" => Some(RLMEnvironment::Local),
                "docker" => Some(RLMEnvironment::Docker),
                "modal" => Some(RLMEnvironment::Modal),
                "prime" => Some(RLMEnvironment::Prime),
                _ => None,
            })
            .unwrap_or_default();

        let max_iterations = std::env::var("ELIZA_RLM_MAX_ITERATIONS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(4);

        let max_depth = std::env::var("ELIZA_RLM_MAX_DEPTH")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(1);

        let verbose = env_bool("ELIZA_RLM_VERBOSE", false);
        let track_costs = env_bool("ELIZA_RLM_TRACK_COSTS", true);
        let log_trajectories = env_bool("ELIZA_RLM_LOG_TRAJECTORIES", true);

        let max_retries = std::env::var("ELIZA_RLM_MAX_RETRIES")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(3);

        let retry_base_delay = std::env::var("ELIZA_RLM_RETRY_DELAY")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(1.0);

        let retry_max_delay = std::env::var("ELIZA_RLM_RETRY_MAX_DELAY")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(30.0);

        let python_path = std::env::var("ELIZA_RLM_PYTHON_PATH")
            .unwrap_or_else(|_| "python".to_string());

        let root_model = std::env::var("ELIZA_RLM_ROOT_MODEL").unwrap_or_default();
        let subcall_backend = std::env::var("ELIZA_RLM_SUBCALL_BACKEND").unwrap_or_default();
        let subcall_model = std::env::var("ELIZA_RLM_SUBCALL_MODEL").unwrap_or_default();

        Self {
            backend,
            root_model,
            subcall_backend,
            subcall_model,
            backend_kwargs: HashMap::new(),
            environment,
            max_iterations,
            max_depth,
            verbose,
            track_costs,
            log_trajectories,
            max_retries,
            retry_base_delay,
            retry_max_delay,
            python_path,
        }
    }

    /// Validate configuration values.
    pub fn validate(&self) -> Result<(), String> {
        if self.max_iterations < 1 {
            return Err("max_iterations must be >= 1".to_string());
        }
        if self.max_depth < 1 {
            return Err("max_depth must be >= 1".to_string());
        }
        if self.max_retries == 0 {
            // max_retries can be 0, just a warning might be appropriate
        }
        if self.retry_max_delay < self.retry_base_delay {
            return Err("retry_max_delay must be >= retry_base_delay".to_string());
        }
        Ok(())
    }

    /// Get effective subcall backend (falls back to main backend).
    pub fn effective_subcall_backend(&self) -> String {
        if self.subcall_backend.is_empty() {
            self.backend.to_string()
        } else {
            self.subcall_backend.clone()
        }
    }

    /// Get effective subcall model (falls back to root model).
    pub fn effective_subcall_model(&self) -> String {
        if self.subcall_model.is_empty() {
            self.root_model.clone()
        } else {
            self.subcall_model.clone()
        }
    }
}

/// Message format for RLM input.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RLMMessage {
    /// Role of the message sender ("user", "assistant", "system")
    pub role: String,
    /// Content of the message
    pub content: String,
}

impl RLMMessage {
    /// Create a user message.
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: "user".to_string(),
            content: content.into(),
        }
    }

    /// Create an assistant message.
    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: "assistant".to_string(),
            content: content.into(),
        }
    }

    /// Create a system message.
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: "system".to_string(),
            content: content.into(),
        }
    }
}

/// Cost tracking for RLM inference.
/// 
/// Matches Python `RLMCost` for tracking token usage and costs.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RLMCost {
    /// Input tokens for root model.
    pub root_input_tokens: u64,
    /// Output tokens for root model.
    pub root_output_tokens: u64,
    /// Input tokens for subcall model.
    pub subcall_input_tokens: u64,
    /// Output tokens for subcall model.
    pub subcall_output_tokens: u64,
    /// Cost for root model calls (USD).
    pub root_cost_usd: f64,
    /// Cost for subcall model calls (USD).
    pub subcall_cost_usd: f64,
}

impl RLMCost {
    /// Total input tokens.
    pub fn total_input_tokens(&self) -> u64 {
        self.root_input_tokens + self.subcall_input_tokens
    }

    /// Total output tokens.
    pub fn total_output_tokens(&self) -> u64 {
        self.root_output_tokens + self.subcall_output_tokens
    }

    /// Total tokens.
    pub fn total_tokens(&self) -> u64 {
        self.total_input_tokens() + self.total_output_tokens()
    }

    /// Total cost (USD).
    pub fn total_cost_usd(&self) -> f64 {
        self.root_cost_usd + self.subcall_cost_usd
    }
}

/// RLM strategies from Paper Section 4.1.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RLMStrategy {
    /// Examining prefix/suffix
    Peek,
    /// Regex filtering
    Grep,
    /// Splitting for parallel processing
    Chunk,
    /// Combining sub-call results
    Stitch,
    /// Recursive self-call
    Subcall,
    /// Unclassified strategy
    Other,
}

impl std::fmt::Display for RLMStrategy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RLMStrategy::Peek => write!(f, "peek"),
            RLMStrategy::Grep => write!(f, "grep"),
            RLMStrategy::Chunk => write!(f, "chunk"),
            RLMStrategy::Stitch => write!(f, "stitch"),
            RLMStrategy::Subcall => write!(f, "subcall"),
            RLMStrategy::Other => write!(f, "other"),
        }
    }
}

/// A single step in an RLM trajectory.
/// 
/// Matches Python `RLMTrajectoryStep`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RLMTrajectoryStep {
    /// Unique step identifier.
    pub step_id: String,
    /// Step number in sequence.
    pub step_number: u32,
    /// Timestamp in milliseconds.
    pub timestamp_ms: u64,
    /// Code that was executed.
    #[serde(default)]
    pub code_executed: String,
    /// Output from REPL execution.
    #[serde(default)]
    pub repl_output: String,
    /// Variables updated in this step.
    #[serde(default)]
    pub variables_updated: Vec<String>,
    /// Strategy used (peek, grep, chunk, stitch, subcall, other).
    #[serde(default)]
    pub strategy: String,
    /// Whether this is a subcall.
    #[serde(default)]
    pub is_subcall: bool,
    /// Subcall prompt if this is a subcall.
    #[serde(default)]
    pub subcall_prompt: String,
    /// Subcall response if this is a subcall.
    #[serde(default)]
    pub subcall_response: String,
    /// Input tokens for this step.
    #[serde(default)]
    pub input_tokens: u64,
    /// Output tokens for this step.
    #[serde(default)]
    pub output_tokens: u64,
    /// Duration in milliseconds.
    #[serde(default)]
    pub duration_ms: u64,
}

/// Full trajectory of an RLM inference.
/// 
/// Matches Python `RLMTrajectory` for debugging and observability.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RLMTrajectory {
    /// Unique trajectory identifier.
    pub trajectory_id: String,
    /// Start time in milliseconds.
    pub start_time_ms: u64,
    /// End time in milliseconds.
    pub end_time_ms: u64,
    /// Length of input prompt.
    pub prompt_length: usize,
    /// Preview of input prompt.
    #[serde(default)]
    pub prompt_preview: String,
    /// Steps in the trajectory.
    #[serde(default)]
    pub steps: Vec<RLMTrajectoryStep>,
    /// Final generated response.
    #[serde(default)]
    pub final_response: String,
    /// Total iterations performed.
    pub total_iterations: u32,
    /// Maximum depth reached.
    pub max_depth_reached: u32,
    /// Number of subcalls made.
    pub subcall_count: u32,
    /// Cost information.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<RLMCost>,
    /// Strategies used during inference.
    #[serde(default)]
    pub strategies_used: Vec<String>,
}

impl RLMTrajectory {
    /// Duration in milliseconds.
    pub fn duration_ms(&self) -> u64 {
        if self.end_time_ms == 0 {
            0
        } else {
            self.end_time_ms.saturating_sub(self.start_time_ms)
        }
    }
}

/// Metadata returned from RLM inference.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RLMMetadata {
    /// Whether the response is from stub mode.
    pub stub: bool,
    /// Number of REPL iterations used.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iterations: Option<u32>,
    /// Recursion depth reached.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depth: Option<u32>,
    /// Error message if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Result from an RLM inference call.
/// 
/// Matches Python `RLMResult` with cost and trajectory support.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RLMResult {
    /// Generated text.
    pub text: String,
    /// Result metadata.
    pub metadata: RLMMetadata,
    /// Cost information (if track_costs enabled).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<RLMCost>,
    /// Full trajectory (if log_trajectories enabled).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trajectory: Option<RLMTrajectory>,
}

impl RLMResult {
    /// Create a stub result.
    pub fn stub(error: Option<String>) -> Self {
        Self {
            text: "[RLM STUB] RLM backend not available".to_string(),
            metadata: RLMMetadata {
                stub: true,
                error,
                ..Default::default()
            },
            cost: None,
            trajectory: None,
        }
    }
}

/// Options for RLM inference (per-request overrides).
/// 
/// Matches Python `RLMInferOptions` and TypeScript `RLMInferOptions`.
/// Note: Custom REPL tool injection is NOT supported by the upstream RLM library.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RLMInferOptions {
    /// Model to use.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Maximum tokens to generate.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    /// Sampling temperature.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    /// Top-p sampling.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f32>,
    /// Stop sequences.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_sequences: Option<Vec<String>>,
    /// User identifier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    /// Enable streaming (not yet supported).
    #[serde(default)]
    pub stream: bool,

    // Per-request RLM overrides (Paper Algorithm 1)
    /// Override max iterations for this request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_iterations: Option<u32>,
    /// Override max recursion depth for this request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_depth: Option<u32>,
    /// Override root model for this request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_model: Option<String>,
    /// Override subcall model for this request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subcall_model: Option<String>,
    /// Enable trajectory logging for this request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_trajectories: Option<bool>,
    /// Enable cost tracking for this request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_costs: Option<bool>,
}

/// Status response from IPC server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RLMStatusResponse {
    /// Whether the RLM library is available
    pub available: bool,
    /// Current backend name
    pub backend: String,
    /// Current execution environment
    pub environment: String,
    /// Maximum REPL iterations configured
    pub max_iterations: u32,
    /// Maximum recursion depth configured
    pub max_depth: u32,
}

/// JSON-RPC style request for IPC.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IPCRequest {
    /// Unique request identifier for matching responses
    pub id: u64,
    /// Method name to invoke ("infer", "status", "shutdown")
    pub method: String,
    /// Method parameters as JSON
    pub params: serde_json::Value,
}

/// JSON-RPC style response from IPC.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IPCResponse {
    /// Request ID this response corresponds to
    pub id: u64,
    /// Successful result as JSON (mutually exclusive with error)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    /// Error message if the request failed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Ready message from IPC server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IPCReadyMessage {
    /// Whether the server is ready to accept requests
    pub ready: bool,
    /// Whether the RLM library is available
    pub available: bool,
}

/// Environment variable names for configuration.
/// 
/// Matches Python and TypeScript configuration options.
pub mod env_vars {
    /// Backend selection (openai, anthropic, gemini, groq, openrouter)
    pub const BACKEND: &str = "ELIZA_RLM_BACKEND";
    /// Root model for main inference
    pub const ROOT_MODEL: &str = "ELIZA_RLM_ROOT_MODEL";
    /// Backend for sub-calls
    pub const SUBCALL_BACKEND: &str = "ELIZA_RLM_SUBCALL_BACKEND";
    /// Model for sub-calls
    pub const SUBCALL_MODEL: &str = "ELIZA_RLM_SUBCALL_MODEL";
    /// Execution environment (local, docker, modal, prime)
    pub const ENVIRONMENT: &str = "ELIZA_RLM_ENV";
    /// Maximum REPL iterations (default: 4)
    pub const MAX_ITERATIONS: &str = "ELIZA_RLM_MAX_ITERATIONS";
    /// Maximum recursion depth (default: 1)
    pub const MAX_DEPTH: &str = "ELIZA_RLM_MAX_DEPTH";
    /// Enable verbose logging (1/true/yes)
    pub const VERBOSE: &str = "ELIZA_RLM_VERBOSE";
    /// Enable cost tracking (1/true/yes, default: true)
    pub const TRACK_COSTS: &str = "ELIZA_RLM_TRACK_COSTS";
    /// Enable trajectory logging (1/true/yes, default: true)
    pub const LOG_TRAJECTORIES: &str = "ELIZA_RLM_LOG_TRAJECTORIES";
    /// Maximum retries for transient errors (default: 3)
    pub const MAX_RETRIES: &str = "ELIZA_RLM_MAX_RETRIES";
    /// Base delay for retry backoff in seconds (default: 1.0)
    pub const RETRY_DELAY: &str = "ELIZA_RLM_RETRY_DELAY";
    /// Maximum delay for retry backoff in seconds (default: 30.0)
    pub const RETRY_MAX_DELAY: &str = "ELIZA_RLM_RETRY_MAX_DELAY";
    /// Path to Python executable for IPC
    pub const PYTHON_PATH: &str = "ELIZA_RLM_PYTHON_PATH";
}
