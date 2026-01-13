use elizaos_plugin_roblox::{RobloxClient, RobloxConfig};

#[tokio::test]
async fn test_config_creation() {
    let config = RobloxConfig::new("test-api-key", "12345678")
        .with_place_id("87654321")
        .with_messaging_topic("test-topic")
        .with_dry_run(true);

    assert_eq!(config.api_key, "test-api-key");
    assert_eq!(config.universe_id, "12345678");
    assert_eq!(config.place_id, Some("87654321".to_string()));
    assert_eq!(config.messaging_topic, "test-topic");
    assert!(config.dry_run);
}

#[tokio::test]
async fn test_client_creation() {
    let config = RobloxConfig::new("test-api-key", "12345678").with_dry_run(true);

    let client = RobloxClient::new(config).expect("Failed to create client");
    assert!(client.is_dry_run());
}

#[tokio::test]
async fn test_dry_run_message() {
    let config = RobloxConfig::new("test-api-key", "12345678").with_dry_run(true);

    let client = RobloxClient::new(config).expect("Failed to create client");

    let result = client
        .publish_message("test-topic", "Hello from test!", None)
        .await;

    assert!(result.is_ok());
}
