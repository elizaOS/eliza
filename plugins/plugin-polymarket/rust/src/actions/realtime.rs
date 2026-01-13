#![allow(missing_docs)]
//! Real-time WebSocket actions for Polymarket

use crate::client::ClobClient;
use crate::error::{PolymarketError, Result};

/// WebSocket subscription status
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubscriptionStatus {
    /// Disconnected
    Disconnected,
    /// Connecting
    Connecting,
    /// Connected
    Connected,
    /// Error state
    Error,
}

/// WebSocket configuration
#[derive(Debug, Clone)]
pub struct WebsocketConfig {
    /// WebSocket URL
    pub url: String,
    /// Channels to subscribe to
    pub channels: Vec<String>,
    /// Asset IDs to subscribe to
    pub asset_ids: Vec<String>,
    /// Whether authentication is required
    pub authenticated: bool,
    /// Connection status
    pub status: SubscriptionStatus,
}

/// Setup WebSocket connection for real-time updates
///
/// # Arguments
///
/// * `client` - The CLOB client
/// * `ws_url` - WebSocket URL
/// * `channels` - Channels to subscribe to (e.g., "book", "price", "trade")
/// * `asset_ids` - Asset IDs to subscribe to
/// * `authenticated` - Whether to use authenticated connection
///
/// # Errors
///
/// Returns an error if configuration is invalid
pub fn setup_websocket(
    _client: &ClobClient,
    ws_url: &str,
    channels: &[String],
    asset_ids: &[String],
    authenticated: bool,
) -> Result<WebsocketConfig> {
    if ws_url.is_empty() {
        return Err(PolymarketError::config_error("WebSocket URL is required"));
    }

    if channels.is_empty() {
        return Err(PolymarketError::config_error(
            "At least one channel must be specified",
        ));
    }

    // Validate channel names
    let valid_channels = ["book", "price", "trade", "ticker", "user"];
    for channel in channels {
        if !valid_channels.contains(&channel.as_str()) {
            return Err(PolymarketError::config_error(format!(
                "Invalid channel: {channel}. Valid channels are: {}",
                valid_channels.join(", ")
            )));
        }
    }

    Ok(WebsocketConfig {
        url: ws_url.to_string(),
        channels: channels.to_vec(),
        asset_ids: asset_ids.to_vec(),
        authenticated,
        status: SubscriptionStatus::Disconnected,
    })
}

/// Handle real-time updates subscription management
///
/// # Arguments
///
/// * `client` - The CLOB client
/// * `action` - Action to perform ("subscribe", "unsubscribe", or "status")
/// * `channel` - Channel name (required for subscribe/unsubscribe)
/// * `asset_ids` - Asset IDs (required for subscribe)
///
/// # Errors
///
/// Returns an error if the operation fails
pub fn handle_realtime_updates(
    _client: &ClobClient,
    action: &str,
    channel: Option<&str>,
    asset_ids: Option<&[String]>,
) -> Result<String> {
    match action {
        "subscribe" => {
            let channel = channel.ok_or_else(|| {
                PolymarketError::config_error("Channel is required for subscription")
            })?;
            let asset_ids = asset_ids.ok_or_else(|| {
                PolymarketError::config_error("Asset IDs are required for subscription")
            })?;

            if asset_ids.is_empty() {
                return Err(PolymarketError::config_error(
                    "At least one asset ID is required for subscription",
                ));
            }

            Ok(format!(
                "Subscribed to {} channel for assets: {}",
                channel,
                asset_ids.join(", ")
            ))
        }
        "unsubscribe" => {
            let channel = channel.ok_or_else(|| {
                PolymarketError::config_error("Channel is required for unsubscription")
            })?;
            Ok(format!("Unsubscribed from {} channel", channel))
        }
        "status" => Ok(
            "WebSocket status: Use PolymarketService for actual connection management".to_string(),
        ),
        _ => Err(PolymarketError::config_error(format!(
            "Invalid action: {action}. Valid actions are: subscribe, unsubscribe, status"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::ClobClient;

    fn test_client() -> ClobClient {
        futures::executor::block_on(ClobClient::new(None, &format!("0x{}", "11".repeat(32))))
            .expect("client init")
    }

    #[test]
    fn test_setup_websocket_empty_url() {
        let client = test_client();
        let err = setup_websocket(&client, "", &[], &[], false).unwrap_err();
        assert!(err.to_string().contains("WebSocket URL is required"));
    }

    #[test]
    fn test_setup_websocket_invalid_channel() {
        let client = test_client();

        let channels = vec!["nope".to_string()];
        let err = setup_websocket(&client, "wss://example.com/ws", &channels, &[], false).unwrap_err();
        assert!(err.to_string().contains("Invalid channel"));
    }

    #[test]
    fn test_handle_realtime_updates_invalid_action() {
        let client = test_client();

        let err = handle_realtime_updates(&client, "nope", None, None).unwrap_err();
        assert!(err.to_string().contains("Invalid action"));
    }
}
