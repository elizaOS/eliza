use elizaos_plugin_local_ai::{LocalAIConfig, LocalAIPlugin};
use std::path::PathBuf;

fn get_models_dir() -> PathBuf {
    directories::BaseDirs::new()
        .map(|d| d.home_dir().join(".eliza").join("models"))
        .unwrap_or_else(|| PathBuf::from("~/.eliza/models"))
}

#[test]
fn test_config_with_real_models() {
    println!("\n🧪 Testing Rust Config with Real Models...");

    let models_dir = get_models_dir();
    println!("   Models directory: {:?}", models_dir);

    let config = LocalAIConfig::new(&models_dir)
        .small_model("tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf")
        .embedding_model("bge-small-en-v1.5.Q4_K_M.gguf");

    println!("   ✓ Config created");
    println!("   Small model: {}", config.small_model);
    println!("   Embedding model: {}", config.embedding_model);
    println!("   Embedding dimensions: {}", config.embedding_dimensions);

    // Verify model files exist
    let small_model_path = models_dir.join(&config.small_model);
    let embedding_model_path = models_dir.join(&config.embedding_model);

    if small_model_path.exists() {
        println!("   ✓ Small model file exists: {:?}", small_model_path);
    } else {
        println!("   ⚠️  Small model file not found: {:?}", small_model_path);
    }

    if embedding_model_path.exists() {
        println!(
            "   ✓ Embedding model file exists: {:?}",
            embedding_model_path
        );
    } else {
        println!(
            "   ⚠️  Embedding model file not found: {:?}",
            embedding_model_path
        );
    }

    println!("   ✅ Config Test PASSED\n");
}

#[test]
fn test_plugin_creation_with_models() {
    println!("\n🧪 Testing Rust Plugin Creation...");

    let models_dir = get_models_dir();

    let config = LocalAIConfig::new(&models_dir)
        .small_model("tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf")
        .embedding_model("bge-small-en-v1.5.Q4_K_M.gguf");

    let _plugin = LocalAIPlugin::new(config).expect("Failed to create plugin");

    println!("   ✓ Plugin created successfully");
    println!("   ✅ Plugin Creation Test PASSED\n");

    println!("   Note: Full LLM inference requires the 'llm' feature flag");
    println!("   Enable with: cargo test --features llm");
}

#[tokio::test]
#[ignore = "Requires local model files to be present"]
async fn test_async_plugin_methods() {
    println!("\n🧪 Testing Rust Async Plugin Methods...");

    let models_dir = get_models_dir();

    let config = LocalAIConfig::new(&models_dir)
        .small_model("tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf")
        .embedding_model("bge-small-en-v1.5.Q4_K_M.gguf");

    let plugin = LocalAIPlugin::new(config).expect("Failed to create plugin");

    let response = plugin.generate_text("Hello").await;
    assert!(response.is_ok(), "Text generation should succeed");
    let text = response.unwrap();
    println!("   ✓ Text generation method works");
    println!("   Response: {}", text);

    let embedding = plugin.create_embedding("Hello").await;
    assert!(embedding.is_ok(), "Embedding generation should succeed");
    let vec = embedding.unwrap();
    println!("   ✓ Embedding method works");
    println!("   Dimensions: {}", vec.len());

    println!("   ✅ Async Methods Test PASSED\n");
}
