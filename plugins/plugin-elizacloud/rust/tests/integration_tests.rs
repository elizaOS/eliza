use elizaos_plugin_elizacloud::providers::ElizaCloudClient;
use elizaos_plugin_elizacloud::types::{
    ElizaCloudConfig, TextEmbeddingParams, TextGenerationParams,
};

fn get_config() -> Option<ElizaCloudConfig> {
    std::env::var("ELIZAOS_CLOUD_API_KEY")
        .ok()
        .filter(|k| !k.is_empty())
        .map(ElizaCloudConfig::new)
}

#[tokio::test]
#[ignore = "Requires API key"]
async fn test_text_generation_small() {
    let Some(config) = get_config() else {
        println!("Skipping test: ELIZAOS_CLOUD_API_KEY not set");
        return;
    };

    let client = ElizaCloudClient::new(config).expect("Failed to create client");
    let result = client
        .generate_text_small(TextGenerationParams {
            prompt: "Say hello in one word.".to_string(),
            max_tokens: 10,
            ..Default::default()
        })
        .await;

    assert!(result.is_ok(), "Failed: {:?}", result.err());
    assert!(!result.unwrap().is_empty());
}

#[tokio::test]
#[ignore = "Requires API key"]
async fn test_text_generation_large() {
    let Some(config) = get_config() else {
        println!("Skipping test: ELIZAOS_CLOUD_API_KEY not set");
        return;
    };

    let client = ElizaCloudClient::new(config).expect("Failed to create client");
    let result = client
        .generate_text_large(TextGenerationParams {
            prompt: "What is 2 + 2?".to_string(),
            max_tokens: 10,
            ..Default::default()
        })
        .await;

    assert!(result.is_ok(), "Failed: {:?}", result.err());
    assert!(!result.unwrap().is_empty());
}

#[tokio::test]
#[ignore = "Requires API key"]
async fn test_embedding_single() {
    let Some(config) = get_config() else {
        println!("Skipping test: ELIZAOS_CLOUD_API_KEY not set");
        return;
    };

    let client = ElizaCloudClient::new(config).expect("Failed to create client");
    let result = client
        .generate_embedding(TextEmbeddingParams::single("Hello, world!"))
        .await;

    assert!(result.is_ok(), "Failed: {:?}", result.err());
    let embeddings = result.unwrap();
    assert_eq!(embeddings.len(), 1);
    assert!(!embeddings[0].is_empty());
}

#[tokio::test]
#[ignore = "Requires API key"]
async fn test_embedding_batch() {
    let Some(config) = get_config() else {
        println!("Skipping test: ELIZAOS_CLOUD_API_KEY not set");
        return;
    };

    let client = ElizaCloudClient::new(config).expect("Failed to create client");
    let result = client
        .generate_embedding(TextEmbeddingParams::batch(vec![
            "Hello".to_string(),
            "World".to_string(),
            "!".to_string(),
        ]))
        .await;

    assert!(result.is_ok(), "Failed: {:?}", result.err());
    let embeddings = result.unwrap();
    assert_eq!(embeddings.len(), 3);
}
