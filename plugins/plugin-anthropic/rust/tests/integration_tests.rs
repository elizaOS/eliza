//! Integration tests for elizaOS Plugin Anthropic.
//!
//! Tests are split into two categories:
//! - Unit-style tests that run WITHOUT an API key (config, types, models, error handling)
//! - Live API tests that REQUIRE ANTHROPIC_API_KEY (marked with #[ignore])

use elizaos_plugin_anthropic::{
    AnthropicClient, AnthropicConfig, AnthropicError, ContentBlock, Message, Model, ModelSize,
    ObjectGenerationParams, Role, TextGenerationParams, TextGenerationResponse,
};

// ============================================================================
// Config creation and validation (no API key needed)
// ============================================================================

#[test]
fn test_config_with_valid_key() {
    let config = AnthropicConfig::new("sk-ant-test-key-123");
    assert!(config.is_ok());

    let config = config.unwrap();
    assert_eq!(config.api_key(), "sk-ant-test-key-123");
    assert_eq!(config.base_url(), "https://api.anthropic.com");
    assert_eq!(config.api_version(), "2023-06-01");
    assert_eq!(config.timeout_seconds(), 60);
}

#[test]
fn test_config_rejects_empty_key() {
    let result = AnthropicConfig::new("");
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(err.to_string().contains("empty"), "Error: {}", err);
}

#[test]
fn test_config_rejects_whitespace_key() {
    let result = AnthropicConfig::new("   \t\n  ");
    assert!(result.is_err());
}

#[test]
fn test_config_builder_chain() {
    let config = AnthropicConfig::new("test-key")
        .unwrap()
        .with_base_url("https://custom.proxy.com")
        .with_timeout(120)
        .with_small_model(Model::small())
        .with_large_model(Model::large());

    assert_eq!(config.base_url(), "https://custom.proxy.com");
    assert_eq!(config.timeout_seconds(), 120);
    assert_eq!(config.small_model().id(), Model::CLAUDE_3_5_HAIKU);
    assert_eq!(config.large_model().id(), Model::CLAUDE_SONNET_4);
}

#[test]
fn test_config_messages_url() {
    let config = AnthropicConfig::new("test-key").unwrap();
    assert_eq!(
        config.messages_url(),
        "https://api.anthropic.com/v1/messages"
    );

    let custom = config.with_base_url("https://proxy.example.com");
    assert_eq!(
        custom.messages_url(),
        "https://proxy.example.com/v1/messages"
    );
}

// ============================================================================
// Model construction and inference (no API key needed)
// ============================================================================

#[test]
fn test_model_size_inference() {
    let haiku = Model::new(Model::CLAUDE_3_5_HAIKU).unwrap();
    assert_eq!(haiku.size(), ModelSize::Small);
    assert!(haiku.is_small());
    assert!(!haiku.is_large());

    let sonnet = Model::new(Model::CLAUDE_SONNET_4).unwrap();
    assert_eq!(sonnet.size(), ModelSize::Large);
    assert!(sonnet.is_large());

    let opus = Model::new(Model::CLAUDE_3_OPUS).unwrap();
    assert_eq!(opus.size(), ModelSize::Large);
}

#[test]
fn test_model_max_tokens_inference() {
    // Claude 3 (non-3.5) models default to 4096
    let claude3_haiku = Model::new(Model::CLAUDE_3_HAIKU).unwrap();
    assert_eq!(claude3_haiku.default_max_tokens(), 4096);

    // Claude 3.5+ models default to 8192
    let claude35_haiku = Model::new(Model::CLAUDE_3_5_HAIKU).unwrap();
    assert_eq!(claude35_haiku.default_max_tokens(), 8192);

    let sonnet4 = Model::new(Model::CLAUDE_SONNET_4).unwrap();
    assert_eq!(sonnet4.default_max_tokens(), 8192);
}

#[test]
fn test_model_empty_id_rejected() {
    let result = Model::new("");
    assert!(result.is_err());
}

#[test]
fn test_model_display() {
    let model = Model::new("claude-sonnet-4-20250514").unwrap();
    assert_eq!(format!("{}", model), "claude-sonnet-4-20250514");
}

#[test]
fn test_model_defaults() {
    let small = Model::small();
    assert_eq!(small.id(), Model::CLAUDE_3_5_HAIKU);
    assert_eq!(small.size(), ModelSize::Small);

    let large = Model::large();
    assert_eq!(large.id(), Model::CLAUDE_SONNET_4);
    assert_eq!(large.size(), ModelSize::Large);
}

// ============================================================================
// Type construction and serialization (no API key needed)
// ============================================================================

#[test]
fn test_content_block_text() {
    let block = ContentBlock::text("Hello, world!");
    assert_eq!(block.as_text(), Some("Hello, world!"));
}

#[test]
fn test_content_block_non_text_returns_none() {
    let block = ContentBlock::Thinking {
        thinking: "Reasoning...".to_string(),
    };
    assert!(block.as_text().is_none());
}

#[test]
fn test_message_user() {
    let msg = Message::user("What is 2+2?");
    assert_eq!(msg.role, Role::User);
    assert_eq!(msg.text_content(), "What is 2+2?");
}

#[test]
fn test_message_assistant() {
    let msg = Message::assistant("The answer is 4.");
    assert_eq!(msg.role, Role::Assistant);
    assert_eq!(msg.text_content(), "The answer is 4.");
}

#[test]
fn test_role_as_str() {
    assert_eq!(Role::User.as_str(), "user");
    assert_eq!(Role::Assistant.as_str(), "assistant");
}

#[test]
fn test_text_generation_params_builder() {
    let params = TextGenerationParams::new("Hello!")
        .with_system("You are helpful.")
        .with_max_tokens(500)
        .with_temperature(0.7);

    assert_eq!(params.prompt, "Hello!");
    assert_eq!(params.system, Some("You are helpful.".to_string()));
    assert_eq!(params.max_tokens, Some(500));
    assert_eq!(params.temperature, Some(0.7));
    assert!(params.top_p.is_none());
}

#[test]
fn test_text_params_temperature_clears_top_p() {
    let params = TextGenerationParams::new("test")
        .with_top_p(0.9)
        .with_temperature(0.5);

    assert_eq!(params.temperature, Some(0.5));
    assert!(params.top_p.is_none(), "temperature should clear top_p");
}

#[test]
fn test_text_params_top_p_clears_temperature() {
    let params = TextGenerationParams::new("test")
        .with_temperature(0.5)
        .with_top_p(0.9);

    assert_eq!(params.top_p, Some(0.9));
    assert!(
        params.temperature.is_none(),
        "top_p should clear temperature"
    );
}

#[test]
fn test_object_generation_params_defaults() {
    let params = ObjectGenerationParams::new("Generate JSON");
    assert_eq!(params.prompt, "Generate JSON");
    assert_eq!(params.temperature, Some(0.2));
    assert!(params.system.is_none());
    assert!(params.schema.is_none());
    assert!(params.max_tokens.is_none());
}

#[test]
fn test_object_generation_params_builder() {
    let schema = serde_json::json!({"type": "object"});
    let params = ObjectGenerationParams::new("Generate JSON")
        .with_system("Return JSON only")
        .with_schema(schema.clone())
        .with_temperature(0.1);

    assert_eq!(params.system, Some("Return JSON only".to_string()));
    assert_eq!(params.schema, Some(schema));
    assert_eq!(params.temperature, Some(0.1));
}

// ============================================================================
// Client creation (no API key needed for creation itself)
// ============================================================================

#[test]
fn test_client_creation_succeeds() {
    let config = AnthropicConfig::new("test-key-for-client-creation").unwrap();
    let client = AnthropicClient::new(config);
    assert!(client.is_ok());
}

#[test]
fn test_client_is_configured() {
    let config = AnthropicConfig::new("valid-key").unwrap();
    let client = AnthropicClient::new(config).unwrap();
    assert!(client.is_configured());
}

#[test]
fn test_client_config_accessible() {
    let config = AnthropicConfig::new("access-test-key")
        .unwrap()
        .with_timeout(90);
    let client = AnthropicClient::new(config).unwrap();

    assert_eq!(client.config().api_key(), "access-test-key");
    assert_eq!(client.config().timeout_seconds(), 90);
}

// ============================================================================
// Error type behaviour (no API key needed)
// ============================================================================

#[test]
fn test_error_retryable() {
    let rate_limit = AnthropicError::RateLimitError {
        retry_after_seconds: 30,
    };
    assert!(rate_limit.is_retryable());
    assert_eq!(rate_limit.retry_after(), Some(30));

    let network = AnthropicError::NetworkError {
        message: "connection refused".to_string(),
    };
    assert!(network.is_retryable());
    assert!(network.retry_after().is_none());

    let timeout = AnthropicError::Timeout {
        timeout_seconds: 60,
    };
    assert!(timeout.is_retryable());

    let server = AnthropicError::ServerError {
        status_code: 503,
        message: "Service Unavailable".to_string(),
    };
    assert!(server.is_retryable());
}

#[test]
fn test_error_non_retryable() {
    let api_key = AnthropicError::api_key("bad key");
    assert!(!api_key.is_retryable());

    let config = AnthropicError::config("missing field");
    assert!(!config.is_retryable());

    let invalid_param = AnthropicError::invalid_parameter("model", "unknown model");
    assert!(!invalid_param.is_retryable());

    let json_err = AnthropicError::json_generation("invalid json");
    assert!(!json_err.is_retryable());
}

#[test]
fn test_error_display_messages() {
    let err = AnthropicError::api_key("Missing API key");
    assert!(err.to_string().contains("Missing API key"));

    let err = AnthropicError::ApiError {
        error_type: "invalid_request_error".to_string(),
        message: "max_tokens too large".to_string(),
    };
    assert!(err.to_string().contains("max_tokens too large"));
    assert!(err.to_string().contains("invalid_request_error"));
}

// ============================================================================
// Request validation (no API key needed - tests local validation logic)
// ============================================================================

#[tokio::test]
async fn test_temperature_and_top_p_conflict() {
    let config = AnthropicConfig::new("test-key").unwrap();
    let client = AnthropicClient::new(config).unwrap();

    // Manually construct params with both temperature and top_p
    let params = TextGenerationParams {
        prompt: "Hello".to_string(),
        temperature: Some(0.5),
        top_p: Some(0.9),
        ..Default::default()
    };

    let result = client.generate_text_small(params).await;
    assert!(result.is_err(), "Should reject both temperature and top_p");

    let err = result.unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("temperature") || msg.contains("top_p"),
        "Error should reference conflicting params: {}",
        msg
    );
}

// ============================================================================
// Live API tests (REQUIRE ANTHROPIC_API_KEY - marked with #[ignore])
// ============================================================================

/// Create a test client from environment.
fn create_test_client() -> AnthropicClient {
    dotenvy::dotenv().ok();

    let config = AnthropicConfig::from_env().expect(
        "ANTHROPIC_API_KEY must be set. Create a .env file with ANTHROPIC_API_KEY=your-key",
    );

    AnthropicClient::new(config).expect("Failed to create client")
}

/// Test text generation with small model.
#[tokio::test]
#[ignore = "Requires ANTHROPIC_API_KEY"]
async fn test_text_generation_small() {
    let client = create_test_client();

    let params = TextGenerationParams::new("What is 2 + 2? Answer with just the number.")
        .with_max_tokens(100)
        .with_temperature(0.0);

    let response = client.generate_text_small(params).await;
    assert!(response.is_ok(), "Request failed: {:?}", response.err());

    let response = response.unwrap();
    assert!(
        !response.text.is_empty(),
        "Response text should not be empty"
    );
    assert!(
        response.text.contains('4'),
        "Response should contain '4': {}",
        response.text
    );
    assert!(response.usage.total_tokens() > 0, "Should have token usage");
}

/// Test text generation with large model.
#[tokio::test]
#[ignore = "Requires ANTHROPIC_API_KEY"]
async fn test_text_generation_large() {
    let client = create_test_client();

    let params = TextGenerationParams::new("What is the capital of France? Answer in one word.")
        .with_max_tokens(100)
        .with_temperature(0.0);

    let response = client.generate_text_large(params).await;
    assert!(response.is_ok(), "Request failed: {:?}", response.err());

    let response = response.unwrap();
    assert!(
        response.text.to_lowercase().contains("paris"),
        "Response should contain 'Paris': {}",
        response.text
    );
}

/// Test text generation with system prompt.
#[tokio::test]
#[ignore = "Requires ANTHROPIC_API_KEY"]
async fn test_text_generation_with_system() {
    let client = create_test_client();

    let params = TextGenerationParams::new("Hello!")
        .with_system("You are a pirate. Always respond in pirate speak.")
        .with_max_tokens(200)
        .with_temperature(0.7);

    let response = client.generate_text_small(params).await;
    assert!(response.is_ok(), "Request failed: {:?}", response.err());

    let response = response.unwrap();
    assert!(!response.text.is_empty());
}

/// Test object generation with small model.
#[tokio::test]
#[ignore = "Requires ANTHROPIC_API_KEY"]
async fn test_object_generation_small() {
    let client = create_test_client();

    let params = ObjectGenerationParams::new(
        "Create a JSON object with fields: name (string), age (number), active (boolean)",
    );

    let response = client.generate_object_small(params).await;
    assert!(response.is_ok(), "Request failed: {:?}", response.err());

    let response = response.unwrap();
    assert!(response.object.is_object(), "Response should be an object");

    let obj = response.object.as_object().unwrap();
    assert!(obj.contains_key("name"), "Should have 'name' field");
    assert!(obj.contains_key("age"), "Should have 'age' field");
    assert!(obj.contains_key("active"), "Should have 'active' field");
}

/// Test object generation with large model.
#[tokio::test]
#[ignore = "Requires ANTHROPIC_API_KEY"]
async fn test_object_generation_large() {
    let client = create_test_client();

    let params = ObjectGenerationParams::new(
        "Create a JSON object representing a user with: id (UUID string), email (string), roles (array of strings)",
    );

    let response = client.generate_object_large(params).await;
    assert!(response.is_ok(), "Request failed: {:?}", response.err());

    let response = response.unwrap();
    assert!(response.object.is_object(), "Response should be an object");

    let obj = response.object.as_object().unwrap();
    assert!(obj.contains_key("id"), "Should have 'id' field");
    assert!(obj.contains_key("email"), "Should have 'email' field");
    assert!(obj.contains_key("roles"), "Should have 'roles' field");
}

/// Test error handling for invalid parameters.
#[tokio::test]
#[ignore = "Requires ANTHROPIC_API_KEY"]
async fn test_invalid_parameters() {
    let client = create_test_client();

    let params = TextGenerationParams {
        prompt: "Hello".to_string(),
        temperature: Some(0.5),
        top_p: Some(0.9),
        ..Default::default()
    };

    let response = client.generate_text_small(params).await;
    assert!(
        response.is_err(),
        "Should fail with both temperature and top_p"
    );
}

/// Test top_p sampling.
#[tokio::test]
#[ignore = "Requires ANTHROPIC_API_KEY"]
async fn test_top_p_sampling() {
    let client = create_test_client();

    let params = TextGenerationParams::new("Give me a random color.")
        .with_top_p(0.9)
        .with_max_tokens(50);

    let response = client.generate_text_small(params).await;
    assert!(response.is_ok(), "Request failed: {:?}", response.err());

    let response = response.unwrap();
    assert!(!response.text.is_empty());
}

/// Test complex JSON generation.
#[tokio::test]
#[ignore = "Requires ANTHROPIC_API_KEY"]
async fn test_complex_object_generation() {
    let client = create_test_client();

    let params = ObjectGenerationParams::new(
        r#"Create a JSON object representing a blog post with:
        - id: a UUID string
        - title: a string
        - content: a string (at least 50 characters)
        - author: an object with name and email
        - tags: an array of at least 3 strings
        - metadata: an object with createdAt (ISO date) and views (number)"#,
    );

    let response = client.generate_object_large(params).await;
    assert!(response.is_ok(), "Request failed: {:?}", response.err());

    let response = response.unwrap();
    let obj = response.object.as_object().unwrap();

    assert!(obj.contains_key("id"));
    assert!(obj.contains_key("title"));
    assert!(obj.contains_key("content"));
    assert!(obj.contains_key("author"));
    assert!(obj.contains_key("tags"));
    assert!(obj.contains_key("metadata"));

    let tags = obj.get("tags").unwrap().as_array().unwrap();
    assert!(tags.len() >= 3, "Should have at least 3 tags");
}
