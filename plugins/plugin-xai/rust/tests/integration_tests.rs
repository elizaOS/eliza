//! Integration tests for xAI plugin.

use elizaos_plugin_xai::{
    GrokClient, GrokConfig, PostAction, TextEmbeddingHandler, TextGenerationParams,
    TextLargeHandler, TextSmallHandler, TwitterClient, TwitterConfig,
};

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
    let config = TwitterConfig::new("key", "secret", "token", "token_secret");
    assert_eq!(config.api_key, "key");
    assert_eq!(config.api_secret, "secret");
    assert_eq!(config.access_token, "token");
    assert_eq!(config.access_token_secret, "token_secret");
    assert!(!config.dry_run);
}

#[test]
fn test_x_config_builder() {
    let config = TwitterConfig::new("key", "secret", "token", "token_secret")
        .bearer_token("bearer")
        .dry_run(true);

    assert_eq!(config.bearer_token, Some("bearer".to_string()));
    assert!(config.dry_run);
}

// ============================================================================
// Action Tests
// ============================================================================

#[test]
fn test_post_action_name() {
    assert_eq!(PostAction::NAME, "POST");
}

#[test]
fn test_post_action_description() {
    assert!(PostAction::DESCRIPTION.contains("Post content"));
}

#[test]
fn test_post_action_similes() {
    let similes = PostAction::SIMILES;
    assert!(similes.contains(&"POST_TO_X"));
    assert!(similes.contains(&"SEND_POST"));
    assert!(similes.contains(&"SHARE_ON_X"));
}

#[test]
fn test_post_action_validate_with_client() {
    let config = TwitterConfig::new("key", "secret", "token", "token_secret");
    let client = TwitterClient::new(config).expect("Failed to create client");
    let result = PostAction::validate(&client);
    assert!(result);
}

#[tokio::test]
async fn test_post_action_handle_empty_content() {
    let config = TwitterConfig::new("key", "secret", "token", "token_secret").dry_run(true);
    let client = TwitterClient::new(config).expect("Failed to create client");
    let result = PostAction::handle(&client, "").await;
    assert!(!result.success);
    assert!(result.error.unwrap().contains("No text provided"));
}

#[tokio::test]
async fn test_post_action_handle_valid_content() {
    let config = TwitterConfig::new("key", "secret", "token", "token_secret").dry_run(true);
    let client = TwitterClient::new(config).expect("Failed to create client");
    let result = PostAction::handle(&client, "Hello, world!").await;
    // In dry_run mode, this should succeed
    assert!(result.success);
}

#[tokio::test]
async fn test_post_action_handle_long_content_truncation() {
    let long_text = "a".repeat(300);
    let config = TwitterConfig::new("key", "secret", "token", "token_secret").dry_run(true);
    let client = TwitterClient::new(config).expect("Failed to create client");
    let result = PostAction::handle(&client, &long_text).await;
    // Should handle truncation and succeed in dry_run mode
    assert!(result.success);
}

// ============================================================================
// Model Handler Tests
// ============================================================================

#[test]
fn test_text_generation_params_new() {
    let params = TextGenerationParams::new("test prompt");
    assert_eq!(params.prompt, "test prompt");
    assert_eq!(params.system, None);
    assert_eq!(params.temperature, 0.7);
}

#[test]
fn test_text_generation_params_builder() {
    let params = TextGenerationParams::new("test")
        .system("You are a helpful assistant")
        .temperature(0.9)
        .max_tokens(100);

    assert_eq!(
        params.system,
        Some("You are a helpful assistant".to_string())
    );
    assert_eq!(params.temperature, 0.9);
    assert_eq!(params.max_tokens, Some(100));
}

#[test]
fn test_text_small_handler_metadata() {
    assert_eq!(TextSmallHandler::MODEL_TYPE, "TEXT_SMALL");
    assert_eq!(TextSmallHandler::MODEL_NAME, "grok-3-mini");
}

#[test]
fn test_text_large_handler_metadata() {
    assert_eq!(TextLargeHandler::MODEL_TYPE, "TEXT_LARGE");
    assert_eq!(TextLargeHandler::MODEL_NAME, "grok-3");
}

#[test]
fn test_text_embedding_handler_metadata() {
    assert_eq!(TextEmbeddingHandler::MODEL_TYPE, "TEXT_EMBEDDING");
    assert_eq!(TextEmbeddingHandler::MODEL_NAME, "grok-embedding");
}

#[tokio::test]
async fn test_grok_client_text_generation_requires_auth() {
    let config = GrokConfig::new("invalid_test_key");
    let client = GrokClient::new(config).expect("Failed to create client");
    let params = TextGenerationParams::new("Hello");

    // This will fail with authentication error, not config error
    let result = client.generate_text(&params, false).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_text_small_handler_requires_valid_client() {
    let config = GrokConfig::new("invalid_test_key");
    let client = GrokClient::new(config).expect("Failed to create client");

    // This will fail without a real API key, but we can test the handler is called correctly
    let result = TextSmallHandler::handle(&client, "Hello", None, None).await;
    // Should fail with authentication error
    assert!(!result.success);
    assert!(result.error.is_some());
}

#[tokio::test]
async fn test_text_large_handler_requires_valid_client() {
    let config = GrokConfig::new("invalid_test_key");
    let client = GrokClient::new(config).expect("Failed to create client");

    // This will fail without a real API key, but we can test the handler is called correctly
    let result = TextLargeHandler::handle(&client, "Hello", None, None).await;
    // Should fail with authentication error
    assert!(!result.success);
    assert!(result.error.is_some());
}

#[tokio::test]
async fn test_text_embedding_handler_requires_valid_client() {
    let config = GrokConfig::new("invalid_test_key");
    let client = GrokClient::new(config).expect("Failed to create client");

    // This will fail without a real API key
    let result = TextEmbeddingHandler::handle(&client, "Hello, world!").await;
    // Should fail with authentication error
    assert!(!result.success);
    assert!(result.error.is_some());
}
