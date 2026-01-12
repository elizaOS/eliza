//! Integration tests for the N8n Plugin.

use elizaos_plugin_n8n::{
    ClaudeModel, JobStatus, N8nConfig, PluginCreationClient, PluginSpecification,
};

#[test]
fn test_config_creation() {
    let config = N8nConfig::new("test-api-key");
    assert_eq!(config.api_key, "test-api-key");
    assert_eq!(config.model, ClaudeModel::default());
}

#[test]
fn test_config_with_model() {
    let config = N8nConfig::new("test-api-key").with_model(ClaudeModel::Sonnet35);
    assert_eq!(config.model, ClaudeModel::Sonnet35);
}

#[test]
fn test_plugin_specification_builder() {
    let spec = PluginSpecification::builder()
        .name("@test/plugin-example")
        .description("A test plugin")
        .version("1.0.0")
        .build()
        .unwrap();

    assert_eq!(spec.name, "@test/plugin-example");
    assert_eq!(spec.description, "A test plugin");
    assert_eq!(spec.version, "1.0.0");
}

#[test]
fn test_plugin_specification_builder_missing_name() {
    let result = PluginSpecification::builder()
        .description("A test plugin")
        .build();

    assert!(result.is_err());
}

#[test]
fn test_job_status_is_active() {
    assert!(JobStatus::Pending.is_active());
    assert!(JobStatus::Running.is_active());
    assert!(!JobStatus::Completed.is_active());
    assert!(!JobStatus::Failed.is_active());
    assert!(!JobStatus::Cancelled.is_active());
}

#[test]
fn test_job_status_is_terminal() {
    assert!(!JobStatus::Pending.is_terminal());
    assert!(!JobStatus::Running.is_terminal());
    assert!(JobStatus::Completed.is_terminal());
    assert!(JobStatus::Failed.is_terminal());
    assert!(JobStatus::Cancelled.is_terminal());
}

#[tokio::test]
async fn test_client_creation() {
    let config = N8nConfig::new("test-api-key");
    let client = PluginCreationClient::new(config);
    assert!(client.is_ok());
}

#[tokio::test]
async fn test_client_empty_jobs() {
    let config = N8nConfig::new("test-api-key");
    let client = PluginCreationClient::new(config).unwrap();

    let jobs = client.get_all_jobs().await;
    assert!(jobs.is_empty());
}

#[tokio::test]
async fn test_client_empty_plugins() {
    let config = N8nConfig::new("test-api-key");
    let client = PluginCreationClient::new(config).unwrap();

    let plugins = client.get_created_plugins().await;
    assert!(plugins.is_empty());
}

#[tokio::test]
async fn test_client_plugin_not_created() {
    let config = N8nConfig::new("test-api-key");
    let client = PluginCreationClient::new(config).unwrap();

    assert!(!client.is_plugin_created("@test/non-existent").await);
}

#[tokio::test]
async fn test_client_job_not_found() {
    let config = N8nConfig::new("test-api-key");
    let client = PluginCreationClient::new(config).unwrap();

    let job = client.get_job_status("non-existent-id").await;
    assert!(job.is_none());
}

#[tokio::test]
async fn test_client_cancel_non_existent_job() {
    let config = N8nConfig::new("test-api-key");
    let client = PluginCreationClient::new(config).unwrap();

    let result = client.cancel_job("non-existent-id").await;
    assert!(!result);
}

#[tokio::test]
async fn test_client_cleanup_empty() {
    let config = N8nConfig::new("test-api-key");
    let client = PluginCreationClient::new(config).unwrap();

    let count = client.cleanup_old_jobs(7).await;
    assert_eq!(count, 0);
}
