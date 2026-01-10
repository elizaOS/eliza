//! Integration tests for Twitter and Grok clients.

use elizaos_plugin_twitter::{GrokClient, GrokConfig, TwitterClient, TwitterConfig};
use elizaos_plugin_twitter::grok::{TextGenerationParams, EmbeddingParams};

fn skip_if_no_twitter_auth() -> bool {
    std::env::var("TWITTER_API_KEY").is_err()
}

fn skip_if_no_grok() -> bool {
    std::env::var("XAI_API_KEY").is_err()
}

#[tokio::test]
async fn test_twitter_get_profile() {
    dotenvy::dotenv().ok();
    
    if skip_if_no_twitter_auth() {
        println!("Skipping test: Twitter credentials not configured");
        return;
    }

    let config = TwitterConfig::from_env().expect("Failed to load Twitter config");
    let client = TwitterClient::new(config).expect("Failed to create Twitter client");

    let profile = client.get_profile("elikitten").await.expect("Failed to get profile");
    assert!(!profile.id.is_empty());
    assert_eq!(profile.username.to_lowercase(), "elikitten");
}

#[tokio::test]
async fn test_twitter_me() {
    dotenvy::dotenv().ok();
    
    if skip_if_no_twitter_auth() {
        println!("Skipping test: Twitter credentials not configured");
        return;
    }

    let config = TwitterConfig::from_env().expect("Failed to load Twitter config");
    let mut client = TwitterClient::new(config).expect("Failed to create Twitter client");

    let me = client.me().await.expect("Failed to get authenticated user");
    assert!(!me.id.is_empty());
    assert!(!me.username.is_empty());
}

#[tokio::test]
async fn test_grok_text_generation() {
    dotenvy::dotenv().ok();
    
    if skip_if_no_grok() {
        println!("Skipping test: XAI_API_KEY not configured");
        return;
    }

    let config = GrokConfig::from_env().expect("Failed to load Grok config");
    let client = GrokClient::new(config).expect("Failed to create Grok client");

    let params = TextGenerationParams::new("Say hello in exactly 5 words.")
        .max_tokens(50);

    let result = client.generate_text(&params, false).await.expect("Failed to generate text");
    assert!(!result.text.is_empty());
    println!("Generated: {}", result.text);
}

#[tokio::test]
async fn test_grok_embedding() {
    dotenvy::dotenv().ok();
    
    if skip_if_no_grok() {
        println!("Skipping test: XAI_API_KEY not configured");
        return;
    }

    let config = GrokConfig::from_env().expect("Failed to load Grok config");
    let client = GrokClient::new(config).expect("Failed to create Grok client");

    let params = EmbeddingParams::new("Hello, world!");
    
    let embedding = client.create_embedding(&params).await.expect("Failed to create embedding");
    assert!(!embedding.is_empty());
    println!("Embedding dimensions: {}", embedding.len());
}

#[tokio::test]
async fn test_grok_list_models() {
    dotenvy::dotenv().ok();
    
    if skip_if_no_grok() {
        println!("Skipping test: XAI_API_KEY not configured");
        return;
    }

    let config = GrokConfig::from_env().expect("Failed to load Grok config");
    let client = GrokClient::new(config).expect("Failed to create Grok client");

    let models = client.list_models().await.expect("Failed to list models");
    println!("Available models: {}", models.len());
}

