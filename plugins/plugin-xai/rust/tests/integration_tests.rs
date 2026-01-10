//! Integration tests for xAI plugin.

use elizaos_plugin_xai::{GrokConfig, XConfig};

#[test]
fn test_grok_config_new() {
    let config = GrokConfig::new("test_key");
    assert_eq!(config.api_key, "test_key");
    assert_eq!(config.base_url, "https://api.x.ai/v1");
    assert_eq!(config.small_model, "grok-3-mini");
    assert_eq!(config.large_model, "grok-3");
    assert_eq!(config.embedding_model, "grok-embedding");
}

#[test]
fn test_grok_config_builder() {
    let config = GrokConfig::new("test_key")
        .base_url("https://custom.api/v1")
        .small_model("custom-mini")
        .large_model("custom-large");

    assert_eq!(config.base_url, "https://custom.api/v1");
    assert_eq!(config.small_model, "custom-mini");
    assert_eq!(config.large_model, "custom-large");
}

#[test]
fn test_x_config_new() {
    let config = XConfig::new("key", "secret", "token", "token_secret");
    assert_eq!(config.api_key, "key");
    assert_eq!(config.api_secret, "secret");
    assert_eq!(config.access_token, "token");
    assert_eq!(config.access_token_secret, "token_secret");
    assert!(!config.dry_run);
}

#[test]
fn test_x_config_builder() {
    let config = XConfig::new("key", "secret", "token", "token_secret")
        .bearer_token("bearer")
        .dry_run(true);

    assert_eq!(config.bearer_token, Some("bearer".to_string()));
    assert!(config.dry_run);
}
