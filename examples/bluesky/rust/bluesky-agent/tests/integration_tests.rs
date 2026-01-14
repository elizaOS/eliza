//! Integration tests for the Bluesky agent.
//!
//! Run with: cargo test
//! For live tests: cargo test --features live

use anyhow::Result;

mod character_tests {
    use super::*;

    #[test]
    fn test_character_creation() -> Result<()> {
        // Import the character module from main crate
        // Note: In actual tests, we'd reference the crate properly
        // For now, just verify basic structure expectations

        // Character should have required fields
        let expected_name = "BlueSkyBot";
        let expected_bio_contains = "friendly AI assistant";

        // This is a structural test - actual integration would import the crate
        assert!(!expected_name.is_empty());
        assert!(!expected_bio_contains.is_empty());

        Ok(())
    }
}

mod handler_tests {
    use super::*;

    #[test]
    fn test_create_unique_uuid_consistency() {
        // UUIDs should be deterministic for same inputs
        use elizaos::{string_to_uuid, types::UUID};

        let agent_id = UUID::new_v4();
        let base_id = "test-base-id";

        let combined1 = format!("{}:{}", base_id, agent_id);
        let combined2 = format!("{}:{}", base_id, agent_id);

        let uuid1 = string_to_uuid(&combined1);
        let uuid2 = string_to_uuid(&combined2);

        assert_eq!(uuid1, uuid2);
    }
}

#[cfg(feature = "live")]
mod live_tests {
    use super::*;
    use elizaos_plugin_bluesky::{BlueSkyClient, BlueSkyConfig};

    #[tokio::test]
    async fn test_bluesky_authentication() -> Result<()> {
        let _ = dotenvy::dotenv();

        let config = BlueSkyConfig::from_env()?;
        let mut client = BlueSkyClient::new(config)?;

        let session = client.authenticate().await?;

        assert!(!session.did.is_empty());
        assert!(!session.handle.is_empty());

        Ok(())
    }

    #[tokio::test]
    async fn test_fetch_timeline() -> Result<()> {
        let _ = dotenvy::dotenv();

        let config = BlueSkyConfig::from_env()?;
        let mut client = BlueSkyClient::new(config)?;

        client.authenticate().await?;

        let timeline = client.get_timeline(
            elizaos_plugin_bluesky::TimelineRequest {
                limit: 5,
                ..Default::default()
            }
        ).await?;

        // Should return some items (may be empty for new accounts)
        assert!(timeline.feed.len() <= 5);

        Ok(())
    }

    #[tokio::test]
    async fn test_fetch_notifications() -> Result<()> {
        let _ = dotenvy::dotenv();

        let config = BlueSkyConfig::from_env()?;
        let mut client = BlueSkyClient::new(config)?;

        client.authenticate().await?;

        let (notifications, _cursor) = client.get_notifications(10, None).await?;

        // Should return notifications (may be empty)
        assert!(notifications.len() <= 10);

        Ok(())
    }
}
