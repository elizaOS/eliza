//! Integration tests for the Bluesky agent.
//!
//! Run with: cargo test --features live

use std::env;

/// Check if live tests should run
fn should_run_live_tests() -> bool {
    cfg!(feature = "live")
        && env::var("BLUESKY_HANDLE").is_ok()
        && env::var("BLUESKY_PASSWORD").is_ok()
}

#[cfg(test)]
mod character_tests {
    use bluesky_agent::character::AgentCharacter;

    #[test]
    fn test_character_has_required_fields() {
        let character = AgentCharacter::new();

        assert_eq!(character.name, "BlueSkyBot");
        assert!(!character.bio.is_empty());
        assert!(!character.system.is_empty());
    }

    #[test]
    fn test_character_has_examples() {
        let character = AgentCharacter::new();

        assert!(!character.post_examples.is_empty());
    }

    #[test]
    fn test_character_default() {
        let character = AgentCharacter::default();
        assert_eq!(character.name, "BlueSkyBot");
    }
}

#[cfg(test)]
#[cfg(feature = "live")]
mod live_tests {
    use super::*;
    use elizaos_plugin_bluesky::{BlueSkyClient, BlueSkyConfig, CreatePostRequest, TimelineRequest};

    fn setup_client() -> BlueSkyClient {
        let _ = dotenvy::dotenv();
        let config = BlueSkyConfig::from_env()
            .expect("Config from env")
            .with_dry_run(true);
        BlueSkyClient::new(config).expect("Client creation")
    }

    #[tokio::test]
    async fn test_authenticate() {
        if !should_run_live_tests() {
            eprintln!("Skipping live test - credentials not available");
            return;
        }

        let client = setup_client();
        let session = client.authenticate().await.expect("Authentication");

        assert!(!session.did.is_empty());
        assert_eq!(
            session.handle,
            env::var("BLUESKY_HANDLE").expect("BLUESKY_HANDLE")
        );
    }

    #[tokio::test]
    async fn test_fetch_timeline() {
        if !should_run_live_tests() {
            eprintln!("Skipping live test - credentials not available");
            return;
        }

        let client = setup_client();
        client.authenticate().await.expect("Authentication");

        let timeline = client
            .get_timeline(TimelineRequest::new().with_limit(5))
            .await
            .expect("Timeline fetch");

        // Timeline should be a valid response (may be empty for new accounts)
        assert!(timeline.feed.len() <= 5);
    }

    #[tokio::test]
    async fn test_fetch_notifications() {
        if !should_run_live_tests() {
            eprintln!("Skipping live test - credentials not available");
            return;
        }

        let client = setup_client();
        client.authenticate().await.expect("Authentication");

        let (notifications, _cursor) = client
            .get_notifications(10, None)
            .await
            .expect("Notifications fetch");

        // Should return a valid list (may be empty)
        assert!(notifications.len() <= 10);
    }

    #[tokio::test]
    async fn test_dry_run_post() {
        if !should_run_live_tests() {
            eprintln!("Skipping live test - credentials not available");
            return;
        }

        let client = setup_client();
        client.authenticate().await.expect("Authentication");

        let request = CreatePostRequest::new("Test post from integration test");
        let post = client.send_post(request).await.expect("Post creation");

        // In dry run mode, should return a mock URI
        assert!(post.uri.contains("mock") || post.uri.starts_with("at://"));
    }

    #[tokio::test]
    async fn test_fetch_profile() {
        if !should_run_live_tests() {
            eprintln!("Skipping live test - credentials not available");
            return;
        }

        let handle = env::var("BLUESKY_HANDLE").expect("BLUESKY_HANDLE");
        let client = setup_client();
        client.authenticate().await.expect("Authentication");

        let profile = client.get_profile(&handle).await.expect("Profile fetch");

        assert_eq!(profile.handle, handle);
        assert!(!profile.did.is_empty());
    }
}
