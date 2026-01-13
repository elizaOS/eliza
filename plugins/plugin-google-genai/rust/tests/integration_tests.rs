use elizaos_plugin_google_genai::{
    EmbeddingParams, GoogleGenAIClient, GoogleGenAIConfig, ObjectGenerationParams,
    TextGenerationParams,
};

fn get_client() -> Option<GoogleGenAIClient> {
    dotenvy::dotenv().ok();
    GoogleGenAIConfig::from_env()
        .ok()
        .and_then(|config| GoogleGenAIClient::new(config).ok())
}

#[tokio::test]
async fn test_generate_text_small() {
    let Some(client) = get_client() else {
        eprintln!("Skipping test: GOOGLE_GENERATIVE_AI_API_KEY not set");
        return;
    };

    let params =
        TextGenerationParams::new("What is 2+2? Answer with just the number.").with_max_tokens(10);

    let response = client.generate_text_small(params).await;
    assert!(
        response.is_ok(),
        "Failed to generate text: {:?}",
        response.err()
    );

    let response = response.unwrap();
    assert!(!response.text.is_empty());
    assert!(response.text.contains('4'));
}

#[tokio::test]
async fn test_generate_text_large() {
    let Some(client) = get_client() else {
        eprintln!("Skipping test: GOOGLE_GENERATIVE_AI_API_KEY not set");
        return;
    };

    let params = TextGenerationParams::new("Say hello in French.");

    let response = client.generate_text_large(params).await;
    assert!(
        response.is_ok(),
        "Failed to generate text: {:?}",
        response.err()
    );

    let response = response.unwrap();
    assert!(!response.text.is_empty());
}

#[tokio::test]
async fn test_generate_embedding() {
    let Some(client) = get_client() else {
        eprintln!("Skipping test: GOOGLE_GENERATIVE_AI_API_KEY not set");
        return;
    };

    let params = EmbeddingParams::new("Hello, world!");

    let response = client.generate_embedding(params).await;
    assert!(
        response.is_ok(),
        "Failed to generate embedding: {:?}",
        response.err()
    );

    let response = response.unwrap();
    assert!(!response.embedding.is_empty());
}

#[tokio::test]
async fn test_generate_object_small() {
    let Some(client) = get_client() else {
        eprintln!("Skipping test: GOOGLE_GENERATIVE_AI_API_KEY not set");
        return;
    };

    let params = ObjectGenerationParams::new(
        "Create a JSON object with a 'greeting' field that says 'hello'.",
    );

    let response = client.generate_object_small(params).await;
    assert!(
        response.is_ok(),
        "Failed to generate object: {:?}",
        response.err()
    );

    let response = response.unwrap();
    assert!(response.object.is_object());
}

#[tokio::test]
async fn test_generate_object_with_schema() {
    let Some(client) = get_client() else {
        eprintln!("Skipping test: GOOGLE_GENERATIVE_AI_API_KEY not set");
        return;
    };

    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "age": {"type": "number"}
        },
        "required": ["name", "age"]
    });

    let params = ObjectGenerationParams::new("Generate a person profile.").with_schema(schema);

    let response = client.generate_object_small(params).await;
    assert!(
        response.is_ok(),
        "Failed to generate object: {:?}",
        response.err()
    );

    let response = response.unwrap();
    assert!(response.object.get("name").is_some());
    assert!(response.object.get("age").is_some());
}
