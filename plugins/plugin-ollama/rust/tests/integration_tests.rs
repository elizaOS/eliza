use elizaos_plugin_ollama::{
    EmbeddingParams, ObjectGenerationParams, OllamaClient, OllamaConfig, TextGenerationParams,
};

fn should_run_integration_tests() -> bool {
    std::env::var("OLLAMA_INTEGRATION_TESTS").is_ok_and(|v| v == "1")
}

fn get_client() -> OllamaClient {
    let config = OllamaConfig::from_env().expect("Failed to load config from env");
    OllamaClient::new(config).expect("Failed to create client")
}

#[tokio::test]
async fn test_list_models() {
    if !should_run_integration_tests() {
        return;
    }

    let client = get_client();
    let models = client.list_models().await;
    assert!(models.is_ok());
}

#[tokio::test]
async fn test_generate_text_small() {
    if !should_run_integration_tests() {
        return;
    }

    let client = get_client();
    let params = TextGenerationParams::new("Say hello in one word.");
    let response = client.generate_text_small(params).await;

    assert!(response.is_ok());
    let response = response.unwrap();
    assert!(!response.text.is_empty());
    assert!(!response.model.is_empty());
}

#[tokio::test]
async fn test_generate_text_large() {
    if !should_run_integration_tests() {
        return;
    }

    let client = get_client();
    let params = TextGenerationParams::new("What is 2+2? Answer with just the number.");
    let response = client.generate_text_large(params).await;

    assert!(response.is_ok());
    let response = response.unwrap();
    assert!(response.text.contains('4'));
}

#[tokio::test]
async fn test_generate_object_small() {
    if !should_run_integration_tests() {
        return;
    }

    let client = get_client();
    let params = ObjectGenerationParams::new("Generate a simple JSON object with a message field");
    let response = client.generate_object_small(params).await;

    assert!(response.is_ok());
    let response = response.unwrap();
    assert!(response.object.is_object());
}

#[tokio::test]
async fn test_generate_embedding() {
    if !should_run_integration_tests() {
        return;
    }

    let client = get_client();
    let params = EmbeddingParams::new("Hello, world!");
    let response = client.generate_embedding(params).await;

    assert!(response.is_ok());
    let response = response.unwrap();
    assert!(!response.embedding.is_empty());
}
