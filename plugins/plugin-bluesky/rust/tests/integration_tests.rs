use elizaos_plugin_bluesky::{
    BlueSkyClient, BlueSkyConfig, CreatePostRequest, PostReference, TimelineRequest,
};

fn get_test_config() -> Option<BlueSkyConfig> {
    BlueSkyConfig::from_env().ok()
}

#[tokio::test]
async fn test_config_creation() {
    let config = BlueSkyConfig::new("test.bsky.social", "test-password");
    assert!(config.is_ok());

    let config = config.unwrap();
    assert_eq!(config.handle(), "test.bsky.social");
    assert_eq!(config.service(), "https://bsky.social");
}

#[tokio::test]
async fn test_config_with_custom_service() {
    let config = BlueSkyConfig::new("test.bsky.social", "test-password")
        .unwrap()
        .with_service("https://custom.bsky.social");

    assert_eq!(config.service(), "https://custom.bsky.social");
}

#[tokio::test]
async fn test_config_dry_run() {
    let config = BlueSkyConfig::new("test.bsky.social", "test-password")
        .unwrap()
        .with_dry_run(true);

    assert!(config.dry_run());
}

#[tokio::test]
async fn test_client_creation() {
    let config = BlueSkyConfig::new("test.bsky.social", "test-password").unwrap();
    let client = BlueSkyClient::new(config);
    assert!(client.is_ok());
}

#[tokio::test]
async fn test_client_not_authenticated() {
    let config = BlueSkyConfig::new("test.bsky.social", "test-password").unwrap();
    let client = BlueSkyClient::new(config).unwrap();
    assert!(client.session().await.is_none());
}

#[tokio::test]
async fn test_timeline_request() {
    let request = TimelineRequest::new().with_limit(25);
    assert_eq!(request.limit, Some(25));
}

#[tokio::test]
async fn test_create_post_request() {
    let request = CreatePostRequest::new("Hello, world!");
    assert_eq!(request.text, "Hello, world!");
}

#[tokio::test]
async fn test_create_post_request_with_reply() {
    let mut request = CreatePostRequest::new("This is a reply");
    request.reply_to = Some(PostReference {
        uri: "at://did:plc:test/app.bsky.feed.post/abc".to_string(),
        cid: "bafytest".to_string(),
    });

    assert!(request.reply_to.is_some());
    let reply = request.reply_to.unwrap();
    assert_eq!(reply.uri, "at://did:plc:test/app.bsky.feed.post/abc");
    assert_eq!(reply.cid, "bafytest");
}

#[tokio::test]
#[ignore]
async fn test_authentication() {
    let config = match get_test_config() {
        Some(c) => c,
        None => {
            println!("Skipping test - no credentials");
            return;
        }
    };

    let client = BlueSkyClient::new(config).unwrap();
    let result = client.authenticate().await;

    assert!(result.is_ok());
    let session = result.unwrap();
    assert!(!session.did.is_empty());
    assert!(!session.handle.is_empty());
}

#[tokio::test]
#[ignore]
async fn test_get_profile() {
    let config = match get_test_config() {
        Some(c) => c,
        None => {
            println!("Skipping test - no credentials");
            return;
        }
    };

    let client = BlueSkyClient::new(config.clone()).unwrap();
    client.authenticate().await.unwrap();

    let profile = client.get_profile(config.handle()).await;
    assert!(profile.is_ok());

    let profile = profile.unwrap();
    assert_eq!(profile.handle, config.handle());
}

#[tokio::test]
#[ignore]
async fn test_get_timeline() {
    let config = match get_test_config() {
        Some(c) => c,
        None => {
            println!("Skipping test - no credentials");
            return;
        }
    };

    let client = BlueSkyClient::new(config).unwrap();
    client.authenticate().await.unwrap();

    let timeline = client
        .get_timeline(TimelineRequest::new().with_limit(5))
        .await;
    assert!(timeline.is_ok());
}
