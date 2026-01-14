use elizaos_plugin_local_ai::{LocalAIConfig, LocalAIPlugin};

#[tokio::test]
async fn test_plugin_creation() {
    let temp_dir = tempfile::tempdir().unwrap();
    let config = LocalAIConfig::new(temp_dir.path());

    let result = LocalAIPlugin::new(config);
    assert!(result.is_ok());
}

#[tokio::test]
async fn test_config_defaults() {
    let config = LocalAIConfig::default();

    assert_eq!(
        config.small_model,
        "DeepHermes-3-Llama-3-3B-Preview-q4.gguf"
    );
    assert_eq!(config.large_model, "DeepHermes-3-Llama-3-8B-q4.gguf");
    assert_eq!(config.embedding_model, "bge-small-en-v1.5.Q4_K_M.gguf");
    assert_eq!(config.embedding_dimensions, 384);
    assert_eq!(config.context_size, 8192);
}

#[tokio::test]
async fn test_config_builder() {
    let config = LocalAIConfig::new("/tmp/models")
        .small_model("custom-small.gguf")
        .large_model("custom-large.gguf")
        .gpu_layers(32)
        .context_size(4096);

    assert_eq!(config.small_model, "custom-small.gguf");
    assert_eq!(config.large_model, "custom-large.gguf");
    assert_eq!(config.gpu_layers, 32);
    assert_eq!(config.context_size, 4096);
}
