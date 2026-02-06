//! Publish profile action for the Nostr plugin.

use crate::service::NostrService;
use crate::types::*;
use serde::{Deserialize, Serialize};
use tracing::debug;

/// Parameters for publishing a Nostr profile
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishProfileParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub about: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub picture: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub banner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nip05: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lud16: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub website: Option<String>,
}

/// Result of the publish profile action
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishProfileResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub relays: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Execute the publish profile action
pub async fn execute_publish_profile(
    service: &NostrService,
    params: PublishProfileParams,
) -> PublishProfileResult {
    // Check connection
    if !service.is_connected().await {
        return PublishProfileResult {
            success: false,
            event_id: None,
            relays: Vec::new(),
            error: Some("Nostr service not connected".to_string()),
        };
    }

    // Create profile
    let profile = NostrProfile {
        name: params.name,
        display_name: params.display_name,
        about: params.about,
        picture: params.picture,
        banner: params.banner,
        nip05: params.nip05,
        lud16: params.lud16,
        website: params.website,
    };

    // Publish profile
    let result = service.publish_profile(profile).await;

    if !result.success {
        return PublishProfileResult {
            success: false,
            event_id: None,
            relays: Vec::new(),
            error: result.error,
        };
    }

    debug!("Published profile, event_id: {:?}", result.event_id);

    PublishProfileResult {
        success: true,
        event_id: result.event_id,
        relays: result.relays,
        error: None,
    }
}

/// Action metadata
pub const PUBLISH_PROFILE_ACTION_NAME: &str = "NOSTR_PUBLISH_PROFILE";
pub const PUBLISH_PROFILE_ACTION_DESCRIPTION: &str =
    "Publish or update the bot's Nostr profile (kind:0 metadata)";
pub const PUBLISH_PROFILE_ACTION_SIMILES: &[&str] = &[
    "UPDATE_NOSTR_PROFILE",
    "SET_NOSTR_PROFILE",
    "NOSTR_PROFILE",
];
