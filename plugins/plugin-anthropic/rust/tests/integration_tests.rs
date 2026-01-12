//! Integration tests for elizaOS Plugin Anthropic.
//!
//! These tests require a valid ANTHROPIC_API_KEY environment variable.
//! Run with: cargo test --features native -- --ignored

use elizaos_plugin_anthropic::{
    AnthropicClient, AnthropicConfig, ObjectGenerationParams, TextGenerationParams,
};

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
    println!(
        "Small model response: {} (tokens: {})",
        response.text.trim(),
        response.usage.total_tokens()
    );
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
        !response.text.is_empty(),
        "Response text should not be empty"
    );
    assert!(
        response.text.to_lowercase().contains("paris"),
        "Response should contain 'Paris': {}",
        response.text
    );
    println!(
        "Large model response: {} (tokens: {})",
        response.text.trim(),
        response.usage.total_tokens()
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
    println!("Pirate response: {}", response.text.trim());
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

    println!(
        "Generated object: {}",
        serde_json::to_string_pretty(&response.object).unwrap()
    );
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

    println!(
        "Generated user: {}",
        serde_json::to_string_pretty(&response.object).unwrap()
    );
}

/// Test error handling for invalid parameters.
#[tokio::test]
#[ignore = "Requires ANTHROPIC_API_KEY"]
async fn test_invalid_parameters() {
    let client = create_test_client();

    // Test temperature + top_p conflict
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

    let err = response.unwrap_err();
    assert!(
        err.to_string().contains("temperature") || err.to_string().contains("top_p"),
        "Error should mention the conflicting parameters: {}",
        err
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
    println!("Random color with top_p: {}", response.text.trim());
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

    // Validate author structure
    let author = obj.get("author").unwrap().as_object().unwrap();
    assert!(author.contains_key("name"));
    assert!(author.contains_key("email"));

    // Validate tags is an array with items
    let tags = obj.get("tags").unwrap().as_array().unwrap();
    assert!(tags.len() >= 3, "Should have at least 3 tags");

    println!(
        "Complex object: {}",
        serde_json::to_string_pretty(&response.object).unwrap()
    );
}
