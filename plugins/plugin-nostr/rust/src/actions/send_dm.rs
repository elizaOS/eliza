//! Send DM action for the Nostr plugin.

use crate::service::NostrService;
use crate::types::*;
use serde::{Deserialize, Serialize};
use tracing::debug;

/// Parameters for sending a Nostr DM
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendDmParams {
    /// Message text to send
    pub text: String,
    /// Target pubkey (hex or npub format)
    pub to_pubkey: String,
}

/// Result of the send DM action
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendDmResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_pubkey: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub relays: Vec<String>,
    pub chunks_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Execute the send DM action
pub async fn execute_send_dm(service: &NostrService, params: SendDmParams) -> SendDmResult {
    // Check connection
    if !service.is_connected().await {
        return SendDmResult {
            success: false,
            to_pubkey: None,
            event_id: None,
            relays: Vec::new(),
            chunks_count: 0,
            error: Some("Nostr service not connected".to_string()),
        };
    }

    // Validate and normalize target pubkey
    let to_pubkey = match normalize_pubkey(&params.to_pubkey) {
        Ok(pk) => pk,
        Err(e) => {
            return SendDmResult {
                success: false,
                to_pubkey: None,
                event_id: None,
                relays: Vec::new(),
                chunks_count: 0,
                error: Some(format!("Invalid target pubkey: {}", e)),
            }
        }
    };

    // Split message if too long
    let chunks = split_message_for_nostr(&params.text, None);
    let chunks_count = chunks.len();

    // Send each chunk
    let mut last_event_id = None;
    let mut last_relays = Vec::new();

    for chunk in chunks {
        let options = NostrDmSendOptions {
            to_pubkey: to_pubkey.clone(),
            text: chunk,
        };

        let result = service.send_dm(options).await;

        if !result.success {
            return SendDmResult {
                success: false,
                to_pubkey: Some(to_pubkey),
                event_id: None,
                relays: Vec::new(),
                chunks_count,
                error: result.error,
            };
        }

        last_event_id = result.event_id;
        last_relays = result.relays;
        debug!("Sent DM chunk, event_id: {:?}", last_event_id);
    }

    SendDmResult {
        success: true,
        to_pubkey: Some(to_pubkey),
        event_id: last_event_id,
        relays: last_relays,
        chunks_count,
        error: None,
    }
}

/// Action metadata
pub const SEND_DM_ACTION_NAME: &str = "NOSTR_SEND_DM";
pub const SEND_DM_ACTION_DESCRIPTION: &str = "Send an encrypted direct message via Nostr (NIP-04)";
pub const SEND_DM_ACTION_SIMILES: &[&str] = &[
    "SEND_NOSTR_DM",
    "NOSTR_MESSAGE",
    "NOSTR_TEXT",
    "DM_NOSTR",
];
