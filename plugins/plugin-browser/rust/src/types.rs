use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CaptchaType {
    Turnstile,
    RecaptchaV2,
    RecaptchaV3,
    Hcaptcha,
    #[default]
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    ServiceNotAvailable,
    SessionError,
    NavigationError,
    ActionError,
    SecurityError,
    CaptchaError,
    TimeoutError,
    NoUrlFound,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserSession {
    pub id: String,
    pub created_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

impl BrowserSession {
    pub fn new(id: String) -> Self {
        Self {
            id,
            created_at: Utc::now(),
            url: None,
            title: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NavigationResult {
    pub success: bool,
    pub url: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<HashMap<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ActionResult {
    pub fn success(data: HashMap<String, serde_json::Value>) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn failure(error: String) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(error),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractResult {
    pub success: bool,
    pub found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenshotResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>, // Base64 encoded
    #[serde(default = "default_mime_type")]
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn default_mime_type() -> String {
    "image/png".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptchaResult {
    pub detected: bool,
    #[serde(rename = "type")]
    pub captcha_type: CaptchaType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_key: Option<String>,
    pub solved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityConfig {
    #[serde(default)]
    pub allowed_domains: Vec<String>,
    #[serde(default = "default_blocked_domains")]
    pub blocked_domains: Vec<String>,
    #[serde(default = "default_max_url_length")]
    pub max_url_length: usize,
    #[serde(default = "default_true")]
    pub allow_localhost: bool,
    #[serde(default)]
    pub allow_file_protocol: bool,
}

fn default_blocked_domains() -> Vec<String> {
    vec!["malware.com".to_string(), "phishing.com".to_string()]
}

fn default_max_url_length() -> usize {
    2048
}

fn default_true() -> bool {
    true
}

impl Default for SecurityConfig {
    fn default() -> Self {
        Self {
            allowed_domains: Vec::new(),
            blocked_domains: default_blocked_domains(),
            max_url_length: 2048,
            allow_localhost: true,
            allow_file_protocol: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetryConfig {
    #[serde(default = "default_max_attempts")]
    pub max_attempts: u32,
    #[serde(default = "default_initial_delay")]
    pub initial_delay_ms: u64,
    #[serde(default = "default_max_delay")]
    pub max_delay_ms: u64,
    #[serde(default = "default_backoff_multiplier")]
    pub backoff_multiplier: f64,
}

fn default_max_attempts() -> u32 {
    3
}

fn default_initial_delay() -> u64 {
    1000
}

fn default_max_delay() -> u64 {
    5000
}

fn default_backoff_multiplier() -> f64 {
    2.0
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            initial_delay_ms: 1000,
            max_delay_ms: 5000,
            backoff_multiplier: 2.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserConfig {
    #[serde(default = "default_true")]
    pub headless: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browserbase_api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browserbase_project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub openai_api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anthropic_api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ollama_base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ollama_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capsolver_api_key: Option<String>,
    #[serde(default = "default_server_port")]
    pub server_port: u16,
}

fn default_server_port() -> u16 {
    3456
}

impl Default for BrowserConfig {
    fn default() -> Self {
        Self {
            headless: true,
            browserbase_api_key: None,
            browserbase_project_id: None,
            openai_api_key: None,
            anthropic_api_key: None,
            ollama_base_url: None,
            ollama_model: None,
            capsolver_api_key: None,
            server_port: 3456,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSocketMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<HashMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSocketResponse {
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<HashMap<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RateLimitEntry {
    pub count: u32,
    pub reset_time: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RateLimitConfig {
    #[serde(default = "default_max_actions")]
    pub max_actions_per_minute: u32,
    #[serde(default = "default_max_sessions")]
    pub max_sessions_per_hour: u32,
}

fn default_max_actions() -> u32 {
    60
}

fn default_max_sessions() -> u32 {
    10
}

impl Default for RateLimitConfig {
    fn default() -> Self {
        Self {
            max_actions_per_minute: 60,
            max_sessions_per_hour: 10,
        }
    }
}
