//! Sender context provider for the Nostr plugin.

use crate::service::NostrService;
use crate::types::{get_pubkey_display_name, pubkey_to_npub};
use serde::{Deserialize, Serialize};

/// Sender context data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NostrSenderContext {
    pub sender_pubkey: String,
    pub sender_npub: String,
    pub display_name: String,
    pub is_encrypted: bool,
}

/// Sender context response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SenderContextResponse {
    pub data: Option<NostrSenderContext>,
    pub values: serde_json::Value,
    pub text: String,
}

/// Get the Nostr sender context
pub async fn get_sender_context(
    service: &NostrService,
    sender_pubkey: Option<&str>,
    agent_name: Option<&str>,
) -> SenderContextResponse {
    let agent = agent_name.unwrap_or("The agent");

    if !service.is_connected().await {
        return SenderContextResponse {
            data: None,
            values: serde_json::json!({ "connected": false }),
            text: String::new(),
        };
    }

    let pubkey = match sender_pubkey {
        Some(pk) => pk,
        None => {
            return SenderContextResponse {
                data: None,
                values: serde_json::json!({ "connected": true }),
                text: String::new(),
            }
        }
    };

    let sender_npub = pubkey_to_npub(pubkey).unwrap_or_default();
    let display_name = get_pubkey_display_name(pubkey);

    let text = format!(
        "{} is talking to {} on Nostr. Their pubkey is {}. \
         This is an encrypted direct message conversation using NIP-04.",
        agent,
        display_name,
        if sender_npub.is_empty() {
            pubkey.to_string()
        } else {
            sender_npub.clone()
        }
    );

    SenderContextResponse {
        data: Some(NostrSenderContext {
            sender_pubkey: pubkey.to_string(),
            sender_npub: sender_npub.clone(),
            display_name: display_name.clone(),
            is_encrypted: true,
        }),
        values: serde_json::json!({
            "sender_pubkey": pubkey,
            "sender_npub": sender_npub,
            "display_name": display_name,
        }),
        text,
    }
}

/// Provider metadata
pub const SENDER_CONTEXT_PROVIDER_NAME: &str = "nostrSenderContext";
pub const SENDER_CONTEXT_PROVIDER_DESCRIPTION: &str =
    "Provides information about the Nostr user in the current conversation";
