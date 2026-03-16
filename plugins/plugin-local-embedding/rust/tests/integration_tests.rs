use elizaos_plugin_local_embedding::{
    EmbeddingModelSpec, EmbeddingParams, LocalEmbeddingConfig, LocalEmbeddingManager, ModelSpec,
    ModelSpecs, TokenDecodeParams, TokenEncodeParams, TokenizerConfig,
};
use std::path::PathBuf;

// ================================================================
// Config tests (no model download needed)
// ================================================================

#[test]
fn test_config_defaults() {
    let config = LocalEmbeddingConfig::default();
    assert_eq!(config.embedding_model(), "BAAI/bge-small-en-v1.5");
    assert_eq!(config.embedding_dimensions(), 384);
    assert_eq!(config.tokenizer_name(), "BAAI/bge-small-en-v1.5");
    assert_eq!(
        config.embedding_model_gguf(),
        "bge-small-en-v1.5.Q4_K_M.gguf"
    );
}

#[test]
fn test_config_builder_chain() {
    let config = LocalEmbeddingConfig::new()
        .with_embedding_model("custom/model")
        .with_embedding_dimensions(768)
        .with_tokenizer_name("custom/tokenizer")
        .with_models_dir("/custom/models")
        .with_cache_dir("/custom/cache");

    assert_eq!(config.embedding_model(), "custom/model");
    assert_eq!(config.embedding_dimensions(), 768);
    assert_eq!(config.tokenizer_name(), "custom/tokenizer");
    assert_eq!(config.models_dir(), &PathBuf::from("/custom/models"));
    assert_eq!(config.cache_dir(), &PathBuf::from("/custom/cache"));
}

#[test]
fn test_config_from_env_uses_defaults() {
    let config = LocalEmbeddingConfig::from_env().expect("from_env should succeed");
    assert_eq!(config.embedding_model(), "BAAI/bge-small-en-v1.5");
    assert_eq!(config.embedding_dimensions(), 384);
}

#[test]
fn test_config_builder_partial_override() {
    let config = LocalEmbeddingConfig::new().with_embedding_dimensions(512);

    // Overridden field
    assert_eq!(config.embedding_dimensions(), 512);
    // Non-overridden fields retain defaults
    assert_eq!(config.embedding_model(), "BAAI/bge-small-en-v1.5");
    assert_eq!(config.tokenizer_name(), "BAAI/bge-small-en-v1.5");
}

// ================================================================
// Type tests (no model download needed)
// ================================================================

#[test]
fn test_embedding_model_spec_values() {
    let spec = ModelSpecs::embedding();
    assert_eq!(spec.dimensions, 384);
    assert_eq!(spec.context_size, 512);
    assert_eq!(spec.quantization, "Q4_K_M");
    assert_eq!(spec.tokenizer.tokenizer_type, "bert");
    assert_eq!(spec.tokenizer.name, "BAAI/bge-small-en-v1.5");
    assert_eq!(spec.repo, "ChristianAzinn/bge-small-en-v1.5-gguf");
}

#[test]
fn test_small_model_spec_values() {
    let spec = ModelSpecs::small();
    assert_eq!(spec.size, "3B");
    assert_eq!(spec.context_size, 8192);
    assert_eq!(spec.quantization, "Q4_0");
    assert_eq!(spec.tokenizer.tokenizer_type, "llama");
}

#[test]
fn test_medium_model_spec_values() {
    let spec = ModelSpecs::medium();
    assert_eq!(spec.size, "8B");
    assert_eq!(spec.context_size, 8192);
    assert_eq!(spec.quantization, "Q4_0");
}

#[test]
fn test_model_spec_serialization_roundtrip() {
    let spec = ModelSpecs::embedding();
    let json = serde_json::to_string(&spec).expect("serialization should succeed");
    let deserialized: EmbeddingModelSpec =
        serde_json::from_str(&json).expect("deserialization should succeed");
    assert_eq!(deserialized, spec);
}

#[test]
fn test_small_model_spec_serialization_roundtrip() {
    let spec = ModelSpecs::small();
    let json = serde_json::to_string(&spec).expect("serialization should succeed");
    let deserialized: ModelSpec =
        serde_json::from_str(&json).expect("deserialization should succeed");
    assert_eq!(deserialized, spec);
}

#[test]
fn test_tokenizer_config_equality() {
    let a = TokenizerConfig {
        name: "test-model".to_string(),
        tokenizer_type: "bert".to_string(),
    };
    let b = a.clone();
    assert_eq!(a, b);

    let c = TokenizerConfig {
        name: "different".to_string(),
        tokenizer_type: "bert".to_string(),
    };
    assert_ne!(a, c);
}

#[test]
fn test_embedding_params_construction() {
    let params = EmbeddingParams::new("hello world");
    assert_eq!(params.text, "hello world");

    let from_string = EmbeddingParams::new(String::from("hello"));
    assert_eq!(from_string.text, "hello");
}

#[test]
fn test_token_params_construction() {
    let encode_params = TokenEncodeParams::new("test text");
    assert_eq!(encode_params.text, "test text");

    let decode_params = TokenDecodeParams::new(vec![1, 2, 3, 4]);
    assert_eq!(decode_params.tokens, vec![1, 2, 3, 4]);
}

#[test]
fn test_token_decode_params_empty() {
    let params = TokenDecodeParams::new(vec![]);
    assert!(params.tokens.is_empty());
}

// ================================================================
// Integration tests (require model download)
//
// Enable with: LOCAL_EMBEDDING_INTEGRATION_TESTS=1 cargo test
// ================================================================

fn should_run_integration_tests() -> bool {
    std::env::var("LOCAL_EMBEDDING_INTEGRATION_TESTS").is_ok_and(|v| v == "1")
}

fn get_manager() -> LocalEmbeddingManager {
    let config = LocalEmbeddingConfig::from_env().expect("Config should load");
    LocalEmbeddingManager::new(config).expect("Manager should initialize")
}

#[test]
fn test_generate_embedding() {
    if !should_run_integration_tests() {
        return;
    }

    let manager = get_manager();
    let params = EmbeddingParams::new("This is a test sentence for embedding.");
    let response = manager.generate_embedding(params);

    assert!(response.is_ok());
    let response = response.unwrap();
    assert!(!response.embedding.is_empty());
    assert_eq!(response.dimensions, response.embedding.len());
    assert!(response.embedding.iter().all(|v| v.is_finite()));

    // Check L2 normalization (norm should be ~1.0)
    let l2: f32 = response
        .embedding
        .iter()
        .map(|v| v * v)
        .sum::<f32>()
        .sqrt();
    assert!(
        (l2 - 1.0).abs() < 0.01,
        "L2 norm should be ~1.0, got {l2}"
    );
}

#[test]
fn test_generate_embedding_empty_text() {
    if !should_run_integration_tests() {
        return;
    }

    let manager = get_manager();
    let params = EmbeddingParams::new("");
    let response = manager.generate_embedding(params);

    assert!(response.is_ok());
    let response = response.unwrap();
    assert_eq!(response.dimensions, 384);
    assert!(response.embedding.iter().all(|v| *v == 0.0));
}

#[test]
fn test_generate_embedding_different_texts() {
    if !should_run_integration_tests() {
        return;
    }

    let manager = get_manager();

    let response_a = manager
        .generate_embedding(EmbeddingParams::new("Cats are wonderful pets."))
        .expect("Embedding A should succeed");
    let response_b = manager
        .generate_embedding(EmbeddingParams::new("Quantum physics is fascinating."))
        .expect("Embedding B should succeed");

    assert_ne!(
        response_a.embedding, response_b.embedding,
        "Different texts should produce different embeddings"
    );
}

#[test]
fn test_encode_text() {
    if !should_run_integration_tests() {
        return;
    }

    let manager = get_manager();
    let params = TokenEncodeParams::new("Hello, world!");
    let response = manager.encode_text(params);

    assert!(response.is_ok());
    let response = response.unwrap();
    assert!(!response.tokens.is_empty());
}

#[test]
fn test_decode_tokens() {
    if !should_run_integration_tests() {
        return;
    }

    let manager = get_manager();

    // First encode some text
    let encode_response = manager
        .encode_text(TokenEncodeParams::new("Hello, world!"))
        .expect("Encoding should succeed");

    // Then decode the tokens
    let decode_response = manager.decode_tokens(TokenDecodeParams::new(encode_response.tokens));
    assert!(decode_response.is_ok());
    let decode_response = decode_response.unwrap();
    assert!(!decode_response.text.is_empty());
}

#[test]
fn test_encode_decode_roundtrip() {
    if !should_run_integration_tests() {
        return;
    }

    let manager = get_manager();
    let original_text = "The quick brown fox jumps over the lazy dog.";

    let encode_response = manager
        .encode_text(TokenEncodeParams::new(original_text))
        .expect("Encoding should succeed");

    assert!(
        !encode_response.tokens.is_empty(),
        "Encoded tokens should not be empty"
    );

    let decode_response = manager
        .decode_tokens(TokenDecodeParams::new(encode_response.tokens))
        .expect("Decoding should succeed");

    // The decoded text should contain key words from the original
    assert!(
        decode_response.text.contains("quick") && decode_response.text.contains("fox"),
        "Round-trip should preserve key words, got: {}",
        decode_response.text
    );
}
