//! Comprehensive integration tests for cloud features.
//! These tests validate request construction, parameter validation,
//! error handling, and response parsing — all without needing real API keys.

use std::collections::HashMap;

use elizaos_plugin_elizacloud::cloud_api::CloudApiClient;
use elizaos_plugin_elizacloud::cloud_providers::{
    cloud_status::get_cloud_status,
    container_health::get_container_health,
    credit_balance::{format_balance, get_credit_balance},
};
use elizaos_plugin_elizacloud::cloud_types::*;
use elizaos_plugin_elizacloud::services::{
    CloudBackupService, CloudBridgeService, CloudContainerService,
};

// ─── Cloud Types Tests ──────────────────────────────────────────────────────

#[test]
fn test_container_status_serialization() {
    let status = ContainerStatus::Running;
    let json = serde_json::to_string(&status).unwrap();
    assert_eq!(json, "\"running\"");

    for s in &["pending", "building", "deploying", "running", "stopped", "failed", "suspended"] {
        let deser: ContainerStatus = serde_json::from_str(&format!("\"{}\"", s)).unwrap();
        assert_eq!(deser.to_string(), *s);
    }
}

#[test]
fn test_container_architecture_serialization() {
    let arm: ContainerArchitecture = serde_json::from_str("\"arm64\"").unwrap();
    assert_eq!(arm, ContainerArchitecture::Arm64);

    let x86: ContainerArchitecture = serde_json::from_str("\"x86_64\"").unwrap();
    assert_eq!(x86, ContainerArchitecture::X86_64);
}

#[test]
fn test_cloud_plugin_config_defaults() {
    let cfg = CloudPluginConfig::default();
    assert!(!cfg.enabled);
    assert_eq!(cfg.base_url, "https://www.elizacloud.ai/api/v1");
    assert_eq!(cfg.inference_mode, InferenceMode::Cloud);
    assert!(!cfg.auto_provision);
    assert_eq!(cfg.bridge.reconnect_interval_ms, 3000);
    assert_eq!(cfg.backup.max_snapshots, 10);
    assert_eq!(cfg.container.default_port, 3000);
    assert_eq!(cfg.container.default_cpu, 1792);
}

#[test]
fn test_create_container_request_serialization() {
    let req = CreateContainerRequest {
        name: "test-agent".to_string(),
        project_name: "test-project".to_string(),
        ecr_image_uri: "elizaos/agent:latest".to_string(),
        description: Some("A test agent".to_string()),
        port: Some(3000),
        cpu: Some(1792),
        memory: Some(1792),
        architecture: Some(ContainerArchitecture::Arm64),
        environment_vars: Some(HashMap::from([("KEY".to_string(), "val".to_string())])),
        health_check_path: Some("/health".to_string()),
        desired_count: None,
        ecr_repository_uri: None,
        image_tag: None,
    };

    let json = serde_json::to_value(&req).unwrap();
    assert_eq!(json["name"], "test-agent");
    assert_eq!(json["port"], 3000);
    // Optional fields that are None should not be serialized
    assert!(json.get("desired_count").is_none());
}

#[test]
fn test_bridge_message_request_format() {
    let mut params = HashMap::new();
    params.insert("text".to_string(), serde_json::json!("Hello"));
    let msg = BridgeMessage::new_request(42, "message.send", params);

    assert_eq!(msg.jsonrpc, "2.0");
    assert_eq!(msg.id, Some(serde_json::json!(42)));
    assert_eq!(msg.method.as_deref(), Some("message.send"));
    assert!(msg.error.is_none());
}

#[test]
fn test_bridge_message_notification_format() {
    let params = HashMap::new();
    let msg = BridgeMessage::new_notification("heartbeat", params);

    assert!(msg.id.is_none());
    assert_eq!(msg.method.as_deref(), Some("heartbeat"));
}

#[test]
fn test_action_result_constructors() {
    let ok = ActionResult::ok("Deployed", serde_json::json!({"id": "c-1"}));
    assert!(ok.success);
    assert!(ok.error.is_none());
    assert_eq!(ok.text.as_deref(), Some("Deployed"));

    let err = ActionResult::err("Missing parameter");
    assert!(!err.success);
    assert_eq!(err.error.as_deref(), Some("Missing parameter"));
    assert!(err.text.is_none());
}

#[test]
fn test_forwarded_settings() {
    assert_eq!(FORWARDED_SETTINGS.len(), 8);
    assert!(FORWARDED_SETTINGS.contains(&"OPENAI_API_KEY"));
    assert!(FORWARDED_SETTINGS.contains(&"ELIZAOS_CLOUD_API_KEY"));
}

#[test]
fn test_collect_env_vars() {
    let mut settings = HashMap::new();
    settings.insert("OPENAI_API_KEY".to_string(), "sk-123".to_string());
    settings.insert("UNKNOWN_KEY".to_string(), "ignored".to_string());

    let result = collect_env_vars(&settings);
    assert_eq!(result.get("OPENAI_API_KEY"), Some(&"sk-123".to_string()));
    assert!(!result.contains_key("UNKNOWN_KEY"));
}

// ─── CloudApiClient Tests ───────────────────────────────────────────────────

#[test]
fn test_cloud_api_client_construction() {
    let client = CloudApiClient::new("https://api.example.com/v1", Some("test-key")).unwrap();
    assert_eq!(client.base_url(), "https://api.example.com/v1");
    assert_eq!(client.api_key(), Some("test-key"));
}

#[test]
fn test_cloud_api_client_trailing_slash() {
    let client = CloudApiClient::new("https://api.example.com/v1/", None).unwrap();
    assert_eq!(client.base_url(), "https://api.example.com/v1");
}

#[test]
fn test_cloud_api_client_ws_url() {
    let client = CloudApiClient::new("https://api.example.com/v1", None).unwrap();
    assert_eq!(
        client.build_ws_url("/bridge/c-1"),
        "wss://api.example.com/v1/bridge/c-1"
    );

    let http_client = CloudApiClient::new("http://localhost:3000", None).unwrap();
    assert_eq!(http_client.build_ws_url("/ws"), "ws://localhost:3000/ws");
}

#[test]
fn test_cloud_api_client_set_api_key() {
    let mut client = CloudApiClient::new("https://api.example.com", None).unwrap();
    assert!(client.api_key().is_none());
    client.set_api_key("new-key");
    assert_eq!(client.api_key(), Some("new-key"));
}

// ─── CloudContainerService Tests ────────────────────────────────────────────

#[test]
fn test_container_service_initial_state() {
    let svc = CloudContainerService::new();
    assert!(svc.tracked_containers().is_empty());
    assert!(!svc.is_container_running("nonexistent"));
    assert!(svc.container_url("nonexistent").is_none());
    assert!(svc.tracked_container("nonexistent").is_none());
}

// ─── CloudBridgeService Tests ───────────────────────────────────────────────

#[tokio::test]
async fn test_bridge_connect_disconnect() {
    let mut svc = CloudBridgeService::new();
    svc.start().await;

    svc.connect("c-1").await;
    assert_eq!(
        svc.connection_state("c-1"),
        BridgeConnectionState::Connected
    );
    assert!(svc.connected_container_ids().contains(&"c-1".to_string()));

    let info = svc.connection_info("c-1");
    assert!(info.is_some());
    let info = info.unwrap();
    assert_eq!(info.state, BridgeConnectionState::Connected);
    assert!(info.connected_at.is_some());

    svc.disconnect("c-1").await;
    assert_eq!(
        svc.connection_state("c-1"),
        BridgeConnectionState::Disconnected
    );
    assert!(svc.connected_container_ids().is_empty());
}

#[tokio::test]
async fn test_bridge_double_connect() {
    let mut svc = CloudBridgeService::new();
    svc.connect("c-1").await;
    svc.connect("c-1").await; // Should not fail
    assert_eq!(svc.connected_container_ids().len(), 1);
}

#[tokio::test]
async fn test_bridge_stop_disconnects_all() {
    let mut svc = CloudBridgeService::new();
    svc.connect("c-1").await;
    svc.connect("c-2").await;
    assert_eq!(svc.connected_container_ids().len(), 2);

    svc.stop().await;
    assert!(svc.connected_container_ids().is_empty());
}

#[tokio::test]
async fn test_bridge_request_requires_connection() {
    let mut svc = CloudBridgeService::new();
    let result = svc.build_request("c-1", "test", HashMap::new());
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("Not connected"));
}

// ─── CloudBackupService Tests ───────────────────────────────────────────────

#[test]
fn test_backup_auto_scheduling() {
    let mut svc = CloudBackupService::new();
    assert!(!svc.is_auto_backup_scheduled("c-1"));

    svc.schedule_auto_backup("c-1");
    assert!(svc.is_auto_backup_scheduled("c-1"));

    // Double schedule is idempotent
    svc.schedule_auto_backup("c-1");
    assert!(svc.is_auto_backup_scheduled("c-1"));

    svc.cancel_auto_backup("c-1");
    assert!(!svc.is_auto_backup_scheduled("c-1"));

    // Cancel nonexistent is safe
    svc.cancel_auto_backup("nonexistent");
}

// ─── Cloud Provider Tests ───────────────────────────────────────────────────

#[test]
fn test_cloud_status_unauthenticated() {
    let result = get_cloud_status(false, None, None);
    assert!(result.text.contains("Not authenticated"));
}

#[test]
fn test_cloud_status_no_containers() {
    let svc = CloudContainerService::new();
    let result = get_cloud_status(true, Some(&svc), None);
    assert!(result.text.contains("0 container(s)"));
    let values = result.values.unwrap();
    assert_eq!(values["runningContainers"], 0);
}

#[test]
fn test_credit_balance_unauthenticated() {
    let result = get_credit_balance(false, Some(100.0));
    assert!(result.text.is_empty());
}

#[test]
fn test_credit_balance_normal() {
    let result = get_credit_balance(true, Some(42.5));
    assert!(result.text.contains("$42.50"));
    assert!(!result.text.contains("LOW"));
    assert!(!result.text.contains("CRITICAL"));
}

#[test]
fn test_credit_balance_low() {
    let result = format_balance(1.5);
    assert!(result.text.contains("(LOW)"));

    let values = result.values.unwrap();
    assert_eq!(values["cloudCreditsLow"], true);
    assert_eq!(values["cloudCreditsCritical"], false);
}

#[test]
fn test_credit_balance_critical() {
    let result = format_balance(0.3);
    assert!(result.text.contains("(CRITICAL)"));

    let values = result.values.unwrap();
    assert_eq!(values["cloudCreditsCritical"], true);
}

#[test]
fn test_container_health_unauthenticated() {
    let result = get_container_health(false, None);
    assert!(result.text.is_empty());
}

#[test]
fn test_container_health_no_running() {
    let svc = CloudContainerService::new();
    let result = get_container_health(true, Some(&svc));
    assert!(result.text.contains("No running containers"));
}

// ─── Action Parameter Extraction Tests ──────────────────────────────────────

#[test]
fn test_provision_extract_params() {
    use elizaos_plugin_elizacloud::actions::provision_agent::extract_params;

    let mut opts = HashMap::new();
    opts.insert("name".to_string(), serde_json::json!("my-agent"));
    opts.insert("project_name".to_string(), serde_json::json!("proj"));
    opts.insert("count".to_string(), serde_json::json!(5)); // non-string ignored

    let params = extract_params(&opts);
    assert_eq!(params.get("name"), Some(&"my-agent".to_string()));
    assert_eq!(params.get("project_name"), Some(&"proj".to_string()));
    assert!(!params.contains_key("count"));
}

// ─── Snapshot Type Serialization Tests ──────────────────────────────────────

#[test]
fn test_snapshot_type_serialization() {
    let manual: SnapshotType = serde_json::from_str("\"manual\"").unwrap();
    assert_eq!(manual, SnapshotType::Manual);

    let auto: SnapshotType = serde_json::from_str("\"auto\"").unwrap();
    assert_eq!(auto, SnapshotType::Auto);

    let pre_eviction: SnapshotType = serde_json::from_str("\"pre-eviction\"").unwrap();
    assert_eq!(pre_eviction, SnapshotType::PreEviction);
}

// ─── Format Bytes Utility Test ──────────────────────────────────────────────

#[test]
fn test_format_bytes() {
    use elizaos_plugin_elizacloud::services::cloud_backup::format_bytes;

    assert_eq!(format_bytes(500), "500 B");
    assert_eq!(format_bytes(1024), "1.0 KB");
    assert_eq!(format_bytes(1048576), "1.0 MB");
    assert_eq!(format_bytes(1073741824), "1.0 GB");
    assert_eq!(format_bytes(2048), "2.0 KB");
}

// ─── Cloud Auth Service Tests ───────────────────────────────────────────────

#[test]
fn test_auth_service_initial_state() {
    let svc = elizaos_plugin_elizacloud::services::CloudAuthService::new().unwrap();
    assert!(!svc.is_authenticated());
    assert!(svc.credentials().is_none());
    assert!(svc.user_id().is_none());
    assert!(svc.organization_id().is_none());
}
