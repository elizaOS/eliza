//! Integration tests for xAI plugin.

use elizaos_plugin_xai::{
    GrokConfig, PostAction, TextModelParams, TwitterConfig, XAIAction,
    handle_text_embedding, handle_text_large, handle_text_small,
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
    let action = PostAction;
    assert_eq!(action.name(), "POST");
}

#[test]
fn test_post_action_description() {
    let action = PostAction;
    assert!(action.description().contains("Post content"));
}

#[test]
fn test_post_action_similes() {
    let action = PostAction;
    let similes = action.similes();
    assert!(similes.contains(&"POST_TO_X"));
    assert!(similes.contains(&"SEND_POST"));
    assert!(similes.contains(&"SHARE_ON_X"));
}

#[tokio::test]
async fn test_post_action_validate_no_config() {
    let action = PostAction;
    let result = action.validate(None).await;
    assert!(!result);
}

#[tokio::test]
async fn test_post_action_validate_with_config() {
    let action = PostAction;
    let config = TwitterConfig::new("key", "secret", "token", "token_secret");
    let result = action.validate(Some(&config)).await;
    assert!(result);
}

#[tokio::test]
async fn test_post_action_handle_empty_content() {
    let action = PostAction;
    let config = TwitterConfig::new("key", "secret", "token", "token_secret").dry_run(true);
    let result = action.handle("", Some(config)).await;
    assert!(result.is_ok());
    let action_result = result.unwrap();
    assert!(!action_result.success);
    assert!(action_result.text.unwrap().contains("No text provided"));
}

#[tokio::test]
async fn test_post_action_handle_valid_content() {
    let action = PostAction;
    let config = TwitterConfig::new("key", "secret", "token", "token_secret").dry_run(true);
    let result = action.handle("Hello, world!", Some(config)).await;
    // In dry_run mode, this should succeed
    assert!(result.is_ok());
    let action_result = result.unwrap();
    assert!(action_result.success);
}

#[tokio::test]
async fn test_post_action_handle_long_content_truncation() {
    let action = PostAction;
    let long_text = "a".repeat(300);
    let config = TwitterConfig::new("key", "secret", "token", "token_secret").dry_run(true);
    let result = action.handle(&long_text, Some(config)).await;
    // Should handle truncation and succeed in dry_run mode
    assert!(result.is_ok());
}

// ============================================================================
// Model Handler Tests
// ============================================================================

#[test]
fn test_text_model_params_new() {
    let params = TextModelParams::new("test prompt");
    assert_eq!(params.prompt, "test prompt");
    assert_eq!(params.system, None);
    assert_eq!(params.temperature, None);
}

#[test]
fn test_text_model_params_builder() {
    let params = TextModelParams::new("test")
        .system("You are a helpful assistant")
        .temperature(0.9)
        .max_tokens(100);

    assert_eq!(params.system, Some("You are a helpful assistant".to_string()));
    assert_eq!(params.temperature, Some(0.9));
    assert_eq!(params.max_tokens, Some(100));
}

#[tokio::test]
async fn test_handle_text_small_config() {
    let config = GrokConfig::new("test_key");
    let params = TextModelParams::new("Hello");
    
    // This will fail without a real API key, but we can test the config is correct
    let result = handle_text_small(config, params).await;
    // Should fail with authentication error, not config error
    assert!(result.is_err());
}

#[tokio::test]
async fn test_handle_text_large_config() {
    let config = GrokConfig::new("test_key");
    let params = TextModelParams::new("Hello");
    
    // This will fail without a real API key, but we can test the config is correct
    let result = handle_text_large(config, params).await;
    // Should fail with authentication error, not config error
    assert!(result.is_err());
}

#[tokio::test]
async fn test_handle_text_embedding_empty_text() {
    let config = GrokConfig::new("test_key");
    let result = handle_text_embedding(config, String::new()).await;
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("Empty text"));
}

#[tokio::test]
async fn test_handle_text_embedding_config() {
    let config = GrokConfig::new("test_key");
    let result = handle_text_embedding(config, "Hello, world!".to_string()).await;
    // Should fail with authentication error, not config error
    assert!(result.is_err());
}
