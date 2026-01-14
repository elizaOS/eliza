use elizaos_plugin_farcaster::{
    FarcasterClient, FarcasterConfig, FarcasterService, Profile, PLUGIN_DESCRIPTION, PLUGIN_NAME,
    PLUGIN_VERSION,
};

fn test_config() -> FarcasterConfig {
    FarcasterConfig::new(12345, "test-signer-uuid", "test-api-key").with_dry_run(true)
}

#[test]
fn test_plugin_metadata() {
    assert_eq!(PLUGIN_NAME, "farcaster");
    assert!(!PLUGIN_DESCRIPTION.is_empty());
    assert!(!PLUGIN_VERSION.is_empty());
}

#[test]
fn test_config_creation() {
    let config = test_config();
    assert_eq!(config.fid, 12345);
    assert_eq!(config.signer_uuid, "test-signer-uuid");
    assert!(config.dry_run);
}

#[test]
fn test_config_validation() {
    let valid_config = test_config();
    assert!(valid_config.validate().is_ok());

    let invalid_config = FarcasterConfig::new(0, "signer", "key");
    assert!(invalid_config.validate().is_err());
}

#[test]
fn test_client_creation() {
    let config = test_config();
    let client = FarcasterClient::new(config);
    assert!(client.is_ok());
}

#[tokio::test]
async fn test_service_creation() {
    let config = test_config();
    let service = FarcasterService::new(config);
    // Service should not be running initially
    assert!(!service.is_running().await);
}

#[tokio::test]
async fn test_send_cast_dry_run() {
    let config = test_config();
    let client = FarcasterClient::new(config).unwrap();
    let casts = client.send_cast("Hello Farcaster!", None).await.unwrap();
    assert_eq!(casts.len(), 1);
    assert_eq!(casts[0].hash, "dry_run_hash");
    assert_eq!(casts[0].text, "Hello Farcaster!");
}

#[tokio::test]
async fn test_send_empty_cast() {
    let config = test_config();
    let client = FarcasterClient::new(config).unwrap();
    let casts = client.send_cast("", None).await.unwrap();
    assert!(casts.is_empty());
}

#[tokio::test]
async fn test_send_whitespace_cast() {
    let config = test_config();
    let client = FarcasterClient::new(config).unwrap();
    let casts = client.send_cast("   ", None).await.unwrap();
    assert!(casts.is_empty());
}

#[tokio::test]
async fn test_service_start_stop() {
    let config = test_config();
    let service = FarcasterService::new(config);
    assert!(!service.is_running().await);
    service.start().await.unwrap();
    assert!(service.is_running().await);
    service.stop().await;
    assert!(!service.is_running().await);
}

#[test]
fn test_split_post_content() {
    use elizaos_plugin_farcaster::client::split_post_content;
    let short = "This is a short message.";
    let chunks = split_post_content(short, 320);
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0], short);
    let long = "A".repeat(400);
    let chunks = split_post_content(&long, 320);
    assert!(chunks.len() > 1);
    assert!(chunks.iter().all(|c| c.len() <= 320));
}

#[test]
fn test_profile_creation() {
    let profile = Profile::new(12345, "testuser".to_string());
    assert_eq!(profile.fid, 12345);
    assert_eq!(profile.username, "testuser");
    assert!(profile.name.is_empty());
}
