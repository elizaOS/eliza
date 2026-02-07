//! Identity context provider for the Nostr plugin.

use crate::service::NostrService;
use serde::{Deserialize, Serialize};

/// Identity context data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NostrIdentityContext {
    pub public_key: String,
    pub npub: String,
    pub relays: Vec<String>,
    pub relay_count: usize,
    pub connected: bool,
}

/// Identity context response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdentityContextResponse {
    pub data: NostrIdentityContext,
    pub values: serde_json::Value,
    pub text: String,
}

/// Get the bot's Nostr identity context
pub async fn get_identity_context(
    service: &NostrService,
    agent_name: Option<&str>,
) -> IdentityContextResponse {
    let agent = agent_name.unwrap_or("The agent");

    if !service.is_connected().await {
        return IdentityContextResponse {
            data: NostrIdentityContext {
                public_key: String::new(),
                npub: String::new(),
                relays: Vec::new(),
                relay_count: 0,
                connected: false,
            },
            values: serde_json::json!({ "connected": false }),
            text: String::new(),
        };
    }

    let public_key = service.get_public_key().await.unwrap_or_default();
    let npub = service.get_npub().await.unwrap_or_default();
    let relays = service.get_relays().await;
    let relay_count = relays.len();

    let text = format!(
        "{} is connected to Nostr with pubkey {}. Connected to {} relay(s): {}. \
         Nostr is a decentralized social protocol using cryptographic keys for identity.",
        agent,
        npub,
        relay_count,
        relays.join(", ")
    );

    IdentityContextResponse {
        data: NostrIdentityContext {
            public_key: public_key.clone(),
            npub: npub.clone(),
            relays: relays.clone(),
            relay_count,
            connected: true,
        },
        values: serde_json::json!({
            "public_key": public_key,
            "npub": npub,
            "relay_count": relay_count,
        }),
        text,
    }
}

/// Provider metadata
pub const IDENTITY_CONTEXT_PROVIDER_NAME: &str = "nostrIdentityContext";
pub const IDENTITY_CONTEXT_PROVIDER_DESCRIPTION: &str =
    "Provides information about the bot's Nostr identity";
