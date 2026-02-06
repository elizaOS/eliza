//! Unit tests for Vercel AI Gateway plugin.
//!
//! These tests validate configuration, type construction, error variants,
//! client construction, and temperature-model logic WITHOUT requiring an API key.

use elizaos_plugin_gateway::{
    EmbeddingParams, GatewayClient, GatewayConfig, GatewayError, ImageDescriptionParams,
    ImageGenerationParams, ImageGenerationResult, TextGenerationParams,
};
use elizaos_plugin_gateway::types::{
    ChatCompletionResponse, ChatMessage, EmbeddingResponse,
    ImageGenerationResponse, ImageQuality, ImageSize, ImageStyle,
};
use elizaos_plugin_gateway::config::model_supports_temperature;

// ===========================================================================
// GatewayConfig creation and defaults
// ===========================================================================

#[test]
fn test_config_new_sets_api_key() {
    let config = GatewayConfig::new("test-key-123");
    assert_eq!(config.api_key, "test-key-123");
}

#[test]
fn test_config_new_sets_default_base_url() {
    let config = GatewayConfig::new("k");
    assert_eq!(config.base_url, "https://ai-gateway.vercel.sh/v1");
}

#[test]
fn test_config_new_sets_default_models() {
    let config = GatewayConfig::new("k");
    assert_eq!(config.large_model, "gpt-5");
    assert_eq!(config.small_model, "gpt-5-mini");
    assert_eq!(config.image_model, "dall-e-3");
    assert_eq!(config.embedding_model, "text-embedding-3-small");
}

#[test]
fn test_config_new_sets_default_embedding_dimensions() {
    let config = GatewayConfig::new("k");
    assert_eq!(config.embedding_dimensions, 1536);
}

#[test]
fn test_config_new_sets_default_timeout() {
    let config = GatewayConfig::new("k");
    assert_eq!(config.timeout_secs, 60);
}

// ===========================================================================
// GatewayConfig builder methods
// ===========================================================================

#[test]
fn test_config_base_url_override() {
    let config = GatewayConfig::new("k").base_url("https://custom.api/v2");
    assert_eq!(config.base_url, "https://custom.api/v2");
}

#[test]
fn test_config_large_model_override() {
    let config = GatewayConfig::new("k").large_model("claude-3-opus");
    assert_eq!(config.large_model, "claude-3-opus");
}

#[test]
fn test_config_small_model_override() {
    let config = GatewayConfig::new("k").small_model("claude-3-haiku");
    assert_eq!(config.small_model, "claude-3-haiku");
}

#[test]
fn test_config_embedding_model_override() {
    let config = GatewayConfig::new("k").embedding_model("text-embedding-3-large");
    assert_eq!(config.embedding_model, "text-embedding-3-large");
}

#[test]
fn test_config_embedding_dimensions_override() {
    let config = GatewayConfig::new("k").embedding_dimensions(3072);
    assert_eq!(config.embedding_dimensions, 3072);
}

#[test]
fn test_config_builder_chaining() {
    let config = GatewayConfig::new("my-key")
        .base_url("https://example.com")
        .large_model("big-model")
        .small_model("small-model")
        .embedding_model("embed-model")
        .embedding_dimensions(512);

    assert_eq!(config.api_key, "my-key");
    assert_eq!(config.base_url, "https://example.com");
    assert_eq!(config.large_model, "big-model");
    assert_eq!(config.small_model, "small-model");
    assert_eq!(config.embedding_model, "embed-model");
    assert_eq!(config.embedding_dimensions, 512);
}

// ===========================================================================
// GatewayConfig::from_env tests
// ===========================================================================

#[test]
fn test_config_from_env_fails_without_key() {
    // Ensure the env vars are not set
    std::env::remove_var("AI_GATEWAY_API_KEY");
    std::env::remove_var("AIGATEWAY_API_KEY");
    std::env::remove_var("VERCEL_OIDC_TOKEN");

    let result = GatewayConfig::from_env();
    assert!(result.is_err());
    let err = result.unwrap_err();
    match err {
        GatewayError::ConfigError(msg) => {
            assert!(msg.contains("API_KEY") || msg.contains("OIDC_TOKEN"));
        }
        _ => panic!("Expected ConfigError, got {:?}", err),
    }
}

// ===========================================================================
// model_supports_temperature tests
// ===========================================================================

#[test]
fn test_reasoning_models_do_not_support_temperature() {
    assert!(!model_supports_temperature("o1"));
    assert!(!model_supports_temperature("o1-preview"));
    assert!(!model_supports_temperature("o1-mini"));
    assert!(!model_supports_temperature("o3"));
    assert!(!model_supports_temperature("o3-mini"));
}

#[test]
fn test_gpt5_models_do_not_support_temperature() {
    assert!(!model_supports_temperature("gpt-5"));
    assert!(!model_supports_temperature("gpt-5-mini"));
}

#[test]
fn test_standard_models_support_temperature() {
    assert!(model_supports_temperature("claude-3-sonnet"));
    assert!(model_supports_temperature("claude-3-opus"));
    assert!(model_supports_temperature("gpt-4-turbo"));
    assert!(model_supports_temperature("llama-3-70b"));
    assert!(model_supports_temperature("mistral-large"));
}

#[test]
fn test_model_supports_temperature_case_insensitive() {
    assert!(!model_supports_temperature("O1-Preview"));
    assert!(!model_supports_temperature("GPT-5"));
    assert!(!model_supports_temperature("O3-MINI"));
}

// ===========================================================================
// TextGenerationParams tests
// ===========================================================================

#[test]
fn test_text_params_new_sets_prompt() {
    let params = TextGenerationParams::new("Hello world");
    assert_eq!(params.prompt, "Hello world");
    assert!(params.system.is_none());
    assert!(params.model.is_none());
    assert!(params.temperature.is_none());
    assert!(params.max_tokens.is_none());
    assert!(params.frequency_penalty.is_none());
    assert!(params.presence_penalty.is_none());
    assert!(params.stop.is_none());
}

#[test]
fn test_text_params_builder_methods() {
    let params = TextGenerationParams::new("prompt")
        .system("Be helpful")
        .model("gpt-4-turbo")
        .temperature(0.7)
        .max_tokens(1000);

    assert_eq!(params.prompt, "prompt");
    assert_eq!(params.system.unwrap(), "Be helpful");
    assert_eq!(params.model.unwrap(), "gpt-4-turbo");
    assert!((params.temperature.unwrap() - 0.7).abs() < f32::EPSILON);
    assert_eq!(params.max_tokens.unwrap(), 1000);
}

#[test]
fn test_text_params_accepts_string_types() {
    let params = TextGenerationParams::new(String::from("owned string"));
    assert_eq!(params.prompt, "owned string");

    let params2 = TextGenerationParams::new("str ref");
    assert_eq!(params2.prompt, "str ref");
}

// ===========================================================================
// EmbeddingParams tests
// ===========================================================================

#[test]
fn test_embedding_params_new() {
    let params = EmbeddingParams::new("embed this text");
    assert_eq!(params.text, "embed this text");
    assert!(params.model.is_none());
    assert!(params.dimensions.is_none());
}

// ===========================================================================
// ImageGenerationParams tests
// ===========================================================================

#[test]
fn test_image_params_new() {
    let params = ImageGenerationParams::new("a sunset over mountains");
    assert_eq!(params.prompt, "a sunset over mountains");
    assert!(params.model.is_none());
    assert!(params.n.is_none());
    assert!(params.size.is_none());
    assert!(params.quality.is_none());
    assert!(params.style.is_none());
}

// ===========================================================================
// ImageDescriptionParams tests
// ===========================================================================

#[test]
fn test_image_description_params_new() {
    let params = ImageDescriptionParams::new("https://example.com/image.png");
    assert_eq!(params.image_url, "https://example.com/image.png");
    assert!(params.model.is_none());
    assert!(params.prompt.is_none());
    assert!(params.max_tokens.is_none());
}

// ===========================================================================
// Image enum defaults
// ===========================================================================

#[test]
fn test_image_size_default() {
    let size = ImageSize::default();
    assert_eq!(size, ImageSize::Size1024);
}

#[test]
fn test_image_quality_default() {
    let quality = ImageQuality::default();
    assert_eq!(quality, ImageQuality::Standard);
}

#[test]
fn test_image_style_default() {
    let style = ImageStyle::default();
    assert_eq!(style, ImageStyle::Vivid);
}

// ===========================================================================
// Image enum serialization
// ===========================================================================

#[test]
fn test_image_size_serialization() {
    let sizes = [
        (ImageSize::Size256, "256x256"),
        (ImageSize::Size512, "512x512"),
        (ImageSize::Size1024, "1024x1024"),
        (ImageSize::Size1792x1024, "1792x1024"),
        (ImageSize::Size1024x1792, "1024x1792"),
    ];

    for (size, expected) in &sizes {
        let json = serde_json::to_string(size).unwrap();
        assert_eq!(json, format!("\"{}\"", expected));
    }
}

#[test]
fn test_image_quality_serialization() {
    let json = serde_json::to_string(&ImageQuality::Standard).unwrap();
    assert_eq!(json, "\"standard\"");

    let json = serde_json::to_string(&ImageQuality::Hd).unwrap();
    assert_eq!(json, "\"hd\"");
}

#[test]
fn test_image_style_serialization() {
    let json = serde_json::to_string(&ImageStyle::Vivid).unwrap();
    assert_eq!(json, "\"vivid\"");

    let json = serde_json::to_string(&ImageStyle::Natural).unwrap();
    assert_eq!(json, "\"natural\"");
}

// ===========================================================================
// ChatMessage / Response type tests
// ===========================================================================

#[test]
fn test_chat_message_serialization() {
    let msg = ChatMessage {
        role: "user".to_string(),
        content: Some("Hello".to_string()),
    };
    let json = serde_json::to_string(&msg).unwrap();
    assert!(json.contains("\"role\":\"user\""));
    assert!(json.contains("\"content\":\"Hello\""));
}

#[test]
fn test_chat_message_with_none_content() {
    let msg = ChatMessage {
        role: "assistant".to_string(),
        content: None,
    };
    let json = serde_json::to_string(&msg).unwrap();
    assert!(json.contains("\"role\":\"assistant\""));
    assert!(json.contains("\"content\":null"));
}

#[test]
fn test_chat_completion_response_deserialization() {
    let json = r#"{
        "id": "chatcmpl-123",
        "object": "chat.completion",
        "created": 1700000000,
        "model": "gpt-5",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": "Hi!"},
            "finish_reason": "stop"
        }]
    }"#;

    let response: ChatCompletionResponse = serde_json::from_str(json).unwrap();
    assert_eq!(response.id, "chatcmpl-123");
    assert_eq!(response.model, "gpt-5");
    assert_eq!(response.choices.len(), 1);
    assert_eq!(
        response.choices[0].message.content.as_deref(),
        Some("Hi!")
    );
    assert_eq!(
        response.choices[0].finish_reason.as_deref(),
        Some("stop")
    );
}

#[test]
fn test_embedding_response_deserialization() {
    let json = r#"{
        "data": [{
            "embedding": [0.1, 0.2, 0.3],
            "index": 0
        }],
        "model": "text-embedding-3-small"
    }"#;

    let response: EmbeddingResponse = serde_json::from_str(json).unwrap();
    assert_eq!(response.model, "text-embedding-3-small");
    assert_eq!(response.data.len(), 1);
    assert_eq!(response.data[0].embedding.len(), 3);
    assert!((response.data[0].embedding[0] - 0.1).abs() < f32::EPSILON);
}

#[test]
fn test_image_generation_response_deserialization() {
    let json = r#"{
        "created": 1700000000,
        "data": [{
            "url": "https://example.com/image.png",
            "revised_prompt": "A beautiful sunset"
        }]
    }"#;

    let response: ImageGenerationResponse = serde_json::from_str(json).unwrap();
    assert_eq!(response.data.len(), 1);
    assert_eq!(
        response.data[0].url.as_deref(),
        Some("https://example.com/image.png")
    );
    assert_eq!(
        response.data[0].revised_prompt.as_deref(),
        Some("A beautiful sunset")
    );
}

// ===========================================================================
// GatewayError variant tests
// ===========================================================================

#[test]
fn test_error_config_display() {
    let err = GatewayError::ConfigError("missing key".to_string());
    let display = format!("{}", err);
    assert!(display.contains("Configuration error"));
    assert!(display.contains("missing key"));
}

#[test]
fn test_error_api_display() {
    let err = GatewayError::ApiError {
        status: 429,
        message: "rate limited".to_string(),
    };
    let display = format!("{}", err);
    assert!(display.contains("429"));
    assert!(display.contains("rate limited"));
}

#[test]
fn test_error_parse_display() {
    let err = GatewayError::ParseError("invalid json".to_string());
    let display = format!("{}", err);
    assert!(display.contains("Parse error"));
    assert!(display.contains("invalid json"));
}

#[test]
fn test_error_empty_response_display() {
    let err = GatewayError::EmptyResponse;
    let display = format!("{}", err);
    assert!(display.contains("Empty response"));
}

#[test]
fn test_error_json_from_serde() {
    let serde_err = serde_json::from_str::<serde_json::Value>("invalid").unwrap_err();
    let err: GatewayError = serde_err.into();
    let display = format!("{}", err);
    assert!(display.contains("JSON error"));
}

// ===========================================================================
// GatewayClient construction tests
// ===========================================================================

#[test]
fn test_client_construction_with_valid_config() {
    let config = GatewayConfig::new("test-api-key");
    let client = GatewayClient::new(config);
    assert!(client.is_ok());
}

#[test]
fn test_client_construction_with_custom_config() {
    let config = GatewayConfig::new("key-123")
        .base_url("https://my-proxy.com/v1")
        .large_model("custom-model");
    let client = GatewayClient::new(config);
    assert!(client.is_ok());
}

// ===========================================================================
// Plugin metadata tests
// ===========================================================================

#[test]
fn test_plugin_name() {
    assert_eq!(elizaos_plugin_gateway::PLUGIN_NAME, "gateway");
}

#[test]
fn test_plugin_description_mentions_gateway() {
    assert!(elizaos_plugin_gateway::PLUGIN_DESCRIPTION.contains("Gateway"));
}

#[test]
fn test_plugin_version_not_empty() {
    assert!(!elizaos_plugin_gateway::PLUGIN_VERSION.is_empty());
}
