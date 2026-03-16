//! Send location action for the LINE plugin.

use crate::service::LineService;
use crate::types::*;
use serde::{Deserialize, Serialize};
use tracing::debug;

/// Parameters for sending a LINE location message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendLocationParams {
    /// Place name
    pub title: String,
    /// Full address
    pub address: String,
    /// Latitude coordinate
    pub latitude: f64,
    /// Longitude coordinate
    pub longitude: f64,
    /// Target user/group/room ID
    pub to: String,
}

/// Result of the send location action
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendLocationResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Execute the send location action
pub async fn execute_send_location(
    service: &LineService,
    params: SendLocationParams,
) -> SendLocationResult {
    // Check connection
    if !service.is_connected().await {
        return SendLocationResult {
            success: false,
            to: None,
            message_id: None,
            error: Some("LINE service not connected".to_string()),
        };
    }

    // Validate target
    let target = match normalize_line_target(&params.to) {
        Some(t) if is_valid_line_id(&t) => t,
        _ => {
            return SendLocationResult {
                success: false,
                to: None,
                message_id: None,
                error: Some("Invalid target ID".to_string()),
            }
        }
    };

    // Create location message
    let location = LineLocationMessage {
        title: params.title,
        address: params.address,
        latitude: params.latitude,
        longitude: params.longitude,
    };

    // Send message
    let result = service.send_location_message(&target, location).await;

    if !result.success {
        return SendLocationResult {
            success: false,
            to: Some(target),
            message_id: None,
            error: result.error,
        };
    }

    debug!("Sent LINE location to {}", target);

    SendLocationResult {
        success: true,
        to: Some(target),
        message_id: result.message_id,
        error: None,
    }
}

/// Action metadata
pub const SEND_LOCATION_ACTION_NAME: &str = "LINE_SEND_LOCATION";
pub const SEND_LOCATION_ACTION_DESCRIPTION: &str = "Send a location message via LINE";
pub const SEND_LOCATION_ACTION_SIMILES: &[&str] = &[
    "SEND_LINE_LOCATION",
    "LINE_LOCATION",
    "LINE_MAP",
    "SHARE_LOCATION_LINE",
];
