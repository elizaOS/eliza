//! Cloud-specific types for ElizaCloud integration.
//!
//! These types mirror the eliza-cloud-v2 database schemas and API contracts
//! for containers, auth, credits, bridge messaging, and agent state snapshots.

#![allow(missing_docs)]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ─── Container Types ────────────────────────────────────────────────────────

/// Status of a cloud container.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContainerStatus {
    Pending,
    Building,
    Deploying,
    Running,
    Stopped,
    Failed,
    Suspended,
}

impl std::fmt::Display for ContainerStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pending => write!(f, "pending"),
            Self::Building => write!(f, "building"),
            Self::Deploying => write!(f, "deploying"),
            Self::Running => write!(f, "running"),
            Self::Stopped => write!(f, "stopped"),
            Self::Failed => write!(f, "failed"),
            Self::Suspended => write!(f, "suspended"),
        }
    }
}

/// Billing status of a cloud container.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContainerBillingStatus {
    Active,
    Warning,
    Suspended,
    ShutdownPending,
    Archived,
}

/// Container CPU architecture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ContainerArchitecture {
    #[serde(rename = "arm64")]
    Arm64,
    #[serde(rename = "x86_64")]
    X86_64,
}

/// A cloud container instance.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudContainer {
    pub id: String,
    pub name: String,
    pub project_name: String,
    pub description: Option<String>,
    pub organization_id: String,
    pub user_id: String,
    pub status: ContainerStatus,
    pub image_tag: Option<String>,
    pub port: u16,
    pub desired_count: u32,
    pub cpu: u32,
    pub memory: u32,
    pub architecture: ContainerArchitecture,
    pub environment_vars: HashMap<String, String>,
    pub health_check_path: String,
    pub load_balancer_url: Option<String>,
    pub ecr_repository_uri: Option<String>,
    pub ecr_image_tag: Option<String>,
    pub cloudformation_stack_name: Option<String>,
    pub billing_status: ContainerBillingStatus,
    pub total_billed: String,
    pub last_deployed_at: Option<String>,
    pub last_health_check: Option<String>,
    pub deployment_log: Option<String>,
    pub error_message: Option<String>,
    pub metadata: HashMap<String, serde_json::Value>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateContainerRequest {
    pub name: String,
    pub project_name: String,
    pub ecr_image_uri: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desired_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment_vars: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health_check_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ecr_repository_uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_tag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub architecture: Option<ContainerArchitecture>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PollingInfo {
    pub endpoint: String,
    pub interval_ms: u64,
    pub expected_duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateContainerResponse {
    pub success: bool,
    pub data: CloudContainer,
    pub message: String,
    pub credits_deducted: f64,
    pub credits_remaining: f64,
    pub stack_name: String,
    pub polling: PollingInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContainerListResponse {
    pub success: bool,
    pub data: Vec<CloudContainer>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContainerGetResponse {
    pub success: bool,
    pub data: CloudContainer,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContainerDeleteResponse {
    pub success: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerHealthData {
    pub status: String,
    pub healthy: bool,
    pub last_check: Option<String>,
    pub uptime: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContainerHealthResponse {
    pub success: bool,
    pub data: ContainerHealthData,
}

// ─── Auth Types ─────────────────────────────────────────────────────────────

/// Platform identifier for device authentication.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DevicePlatform {
    Ios,
    Android,
    Macos,
    Windows,
    Linux,
    Web,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAuthRequest {
    pub device_id: String,
    pub platform: DevicePlatform,
    pub app_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAuthData {
    pub api_key: String,
    pub user_id: String,
    pub organization_id: String,
    pub credits: f64,
    pub is_new: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceAuthResponse {
    pub success: bool,
    pub data: DeviceAuthData,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudCredentials {
    pub api_key: String,
    pub user_id: String,
    pub organization_id: String,
    pub authenticated_at: f64,
}

// ─── Credits Types ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreditBalanceData {
    pub balance: f64,
    pub currency: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreditBalanceResponse {
    pub success: bool,
    pub data: CreditBalanceData,
}

/// Type of credit transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CreditTransactionType {
    Credit,
    Debit,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreditTransaction {
    pub id: String,
    pub amount: f64,
    pub description: String,
    #[serde(rename = "type")]
    pub transaction_type: CreditTransactionType,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditSummaryData {
    pub balance: f64,
    pub total_spent: f64,
    pub total_added: f64,
    pub recent_transactions: Vec<CreditTransaction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreditSummaryResponse {
    pub success: bool,
    pub data: CreditSummaryData,
}

// ─── Bridge Types ───────────────────────────────────────────────────────────

/// State of a bridge WebSocket connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BridgeConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeMessage {
    pub jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<HashMap<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<BridgeError>,
}

impl BridgeMessage {
    pub fn new_request(id: u64, method: &str, params: HashMap<String, serde_json::Value>) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id: Some(serde_json::Value::Number(id.into())),
            method: Some(method.to_string()),
            params: Some(params),
            result: None,
            error: None,
        }
    }

    pub fn new_notification(method: &str, params: HashMap<String, serde_json::Value>) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id: None,
            method: Some(method.to_string()),
            params: Some(params),
            result: None,
            error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeConnection {
    pub container_id: String,
    pub state: BridgeConnectionState,
    pub connected_at: Option<f64>,
    pub last_heartbeat: Option<f64>,
    pub reconnect_attempts: u32,
}

// ─── Snapshot / Backup Types ────────────────────────────────────────────────

/// Type of agent snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SnapshotType {
    Manual,
    Auto,
    PreEviction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSnapshot {
    pub id: String,
    pub container_id: String,
    pub organization_id: String,
    pub snapshot_type: SnapshotType,
    pub storage_url: String,
    pub size_bytes: u64,
    pub agent_config: HashMap<String, serde_json::Value>,
    pub metadata: HashMap<String, serde_json::Value>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSnapshotRequest {
    #[serde(default = "default_snapshot_type")]
    pub snapshot_type: SnapshotType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, serde_json::Value>>,
}

fn default_snapshot_type() -> SnapshotType {
    SnapshotType::Manual
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateSnapshotResponse {
    pub success: bool,
    pub data: AgentSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotListResponse {
    pub success: bool,
    pub data: Vec<AgentSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSnapshotRequest {
    pub snapshot_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RestoreSnapshotResponse {
    pub success: bool,
    pub message: String,
}

// ─── Cloud Config Types ─────────────────────────────────────────────────────

/// Inference mode for the plugin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InferenceMode {
    Cloud,
    Byok,
    Local,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeConfig {
    pub reconnect_interval_ms: u64,
    pub max_reconnect_attempts: u32,
    pub heartbeat_interval_ms: u64,
}

impl Default for BridgeConfig {
    fn default() -> Self {
        Self {
            reconnect_interval_ms: 3000,
            max_reconnect_attempts: 20,
            heartbeat_interval_ms: 30_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupConfig {
    pub auto_backup_interval_ms: u64,
    pub max_snapshots: u32,
}

impl Default for BackupConfig {
    fn default() -> Self {
        Self {
            auto_backup_interval_ms: 3_600_000, // 1 hour
            max_snapshots: 10,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContainerDefaults {
    pub default_image: String,
    pub default_architecture: ContainerArchitecture,
    pub default_cpu: u32,
    pub default_memory: u32,
    pub default_port: u16,
}

impl Default for ContainerDefaults {
    fn default() -> Self {
        Self {
            default_image: "elizaos/agent:latest".to_string(),
            default_architecture: ContainerArchitecture::Arm64,
            default_cpu: 1792,
            default_memory: 1792,
            default_port: 3000,
        }
    }
}

/// Full plugin configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudPluginConfig {
    pub enabled: bool,
    pub base_url: String,
    pub api_key: Option<String>,
    pub device_id: Option<String>,
    pub platform: Option<DevicePlatform>,
    pub inference_mode: InferenceMode,
    pub auto_provision: bool,
    pub bridge: BridgeConfig,
    pub backup: BackupConfig,
    pub container: ContainerDefaults,
}

impl Default for CloudPluginConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            base_url: "https://www.elizacloud.ai/api/v1".to_string(),
            api_key: None,
            device_id: None,
            platform: None,
            inference_mode: InferenceMode::Cloud,
            auto_provision: false,
            bridge: BridgeConfig::default(),
            backup: BackupConfig::default(),
            container: ContainerDefaults::default(),
        }
    }
}

// ─── API Error Types ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudApiErrorBody {
    pub success: bool,
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<HashMap<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "requiredCredits")]
    pub required_credits: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quota: Option<QuotaInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuotaInfo {
    pub current: u32,
    pub max: u32,
}

/// Error from the ElizaCloud API.
#[derive(Debug, thiserror::Error)]
#[error("CloudApiError({status_code}): {}", error_body.error)]
pub struct CloudApiError {
    pub status_code: u16,
    pub error_body: CloudApiErrorBody,
}

/// Insufficient credits error (HTTP 402).
#[derive(Debug, thiserror::Error)]
#[error("InsufficientCreditsError: {} (required: {})", error_body.error, required_credits)]
pub struct InsufficientCreditsError {
    pub error_body: CloudApiErrorBody,
    pub required_credits: f64,
}

// ─── Action Result ──────────────────────────────────────────────────────────

/// Generic result returned by cloud actions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl ActionResult {
    pub fn ok(text: impl Into<String>, data: serde_json::Value) -> Self {
        Self {
            success: true,
            error: None,
            text: Some(text.into()),
            data: Some(data),
        }
    }

    pub fn err(error: impl Into<String>) -> Self {
        Self {
            success: false,
            error: Some(error.into()),
            text: None,
            data: None,
        }
    }
}

/// Provider result returned by cloud providers.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderResult {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

// ─── Forwarded Settings ─────────────────────────────────────────────────────

/// Runtime settings keys forwarded into cloud containers.
pub const FORWARDED_SETTINGS: &[&str] = &[
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GROQ_API_KEY",
    "ELIZAOS_CLOUD_API_KEY",
    "SMALL_MODEL",
    "LARGE_MODEL",
    "ELIZAOS_CLOUD_SMALL_MODEL",
    "ELIZAOS_CLOUD_LARGE_MODEL",
];

/// Collect forwarded settings from environment variables.
pub fn collect_env_vars(settings: &HashMap<String, String>) -> HashMap<String, String> {
    let mut result = HashMap::new();
    for &key in FORWARDED_SETTINGS {
        if let Some(val) = settings.get(key) {
            result.insert(key.to_string(), val.clone());
        } else if let Ok(val) = std::env::var(key) {
            result.insert(key.to_string(), val);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_cloud_plugin_config() {
        let cfg = CloudPluginConfig::default();
        assert!(!cfg.enabled);
        assert_eq!(cfg.base_url, "https://www.elizacloud.ai/api/v1");
        assert_eq!(cfg.inference_mode, InferenceMode::Cloud);
        assert!(!cfg.auto_provision);
    }

    #[test]
    fn test_bridge_config_defaults() {
        let cfg = BridgeConfig::default();
        assert_eq!(cfg.reconnect_interval_ms, 3000);
        assert_eq!(cfg.max_reconnect_attempts, 20);
        assert_eq!(cfg.heartbeat_interval_ms, 30_000);
    }

    #[test]
    fn test_backup_config_defaults() {
        let cfg = BackupConfig::default();
        assert_eq!(cfg.auto_backup_interval_ms, 3_600_000);
        assert_eq!(cfg.max_snapshots, 10);
    }

    #[test]
    fn test_container_defaults() {
        let cfg = ContainerDefaults::default();
        assert_eq!(cfg.default_image, "elizaos/agent:latest");
        assert_eq!(cfg.default_architecture, ContainerArchitecture::Arm64);
        assert_eq!(cfg.default_cpu, 1792);
        assert_eq!(cfg.default_port, 3000);
    }

    #[test]
    fn test_container_status_display() {
        assert_eq!(ContainerStatus::Running.to_string(), "running");
        assert_eq!(ContainerStatus::Pending.to_string(), "pending");
        assert_eq!(ContainerStatus::Failed.to_string(), "failed");
    }

    #[test]
    fn test_action_result_ok() {
        let result = ActionResult::ok("Success", serde_json::json!({"id": "c-1"}));
        assert!(result.success);
        assert_eq!(result.text.as_deref(), Some("Success"));
    }

    #[test]
    fn test_action_result_err() {
        let result = ActionResult::err("Something failed");
        assert!(!result.success);
        assert_eq!(result.error.as_deref(), Some("Something failed"));
    }

    #[test]
    fn test_bridge_message_request() {
        let mut params = HashMap::new();
        params.insert(
            "text".to_string(),
            serde_json::Value::String("Hello".to_string()),
        );
        let msg = BridgeMessage::new_request(1, "message.send", params);
        assert_eq!(msg.jsonrpc, "2.0");
        assert!(msg.id.is_some());
        assert_eq!(msg.method.as_deref(), Some("message.send"));
    }

    #[test]
    fn test_bridge_message_notification() {
        let params = HashMap::new();
        let msg = BridgeMessage::new_notification("heartbeat", params);
        assert!(msg.id.is_none());
        assert_eq!(msg.method.as_deref(), Some("heartbeat"));
    }

    #[test]
    fn test_container_serialization() {
        let status = ContainerStatus::Running;
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, "\"running\"");

        let deserialized: ContainerStatus = serde_json::from_str("\"pending\"").unwrap();
        assert_eq!(deserialized, ContainerStatus::Pending);
    }

    #[test]
    fn test_collect_env_vars() {
        let mut settings = HashMap::new();
        settings.insert("OPENAI_API_KEY".to_string(), "sk-123".to_string());
        settings.insert("UNKNOWN".to_string(), "ignored".to_string());

        let result = collect_env_vars(&settings);
        assert_eq!(result.get("OPENAI_API_KEY"), Some(&"sk-123".to_string()));
        assert!(!result.contains_key("UNKNOWN"));
    }

    #[test]
    fn test_forwarded_settings_count() {
        assert_eq!(FORWARDED_SETTINGS.len(), 8);
        assert!(FORWARDED_SETTINGS.contains(&"OPENAI_API_KEY"));
        assert!(FORWARDED_SETTINGS.contains(&"ELIZAOS_CLOUD_API_KEY"));
    }
}
