//! Helper functions for elicitation with graceful fallback
//!
//! These functions make it easy to request user input during tool execution
//! while gracefully handling clients that don't support elicitation.

use rmcp::service::{ElicitationSafe, Peer, RoleServer};
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

/// Elicit structured data from the user with graceful fallback
///
/// Attempts to elicit information from the user through the MCP client.
/// If the client doesn't support elicitation, or the user declines/cancels,
/// returns the provided default value.
///
/// # Example
/// ```ignore
/// use computeruse_mcp_agent::elicitation::{elicit_with_fallback, WorkflowContext};
///
/// async fn my_tool(peer: &Peer<RoleServer>) {
///     let ctx = elicit_with_fallback(
///         peer,
///         "Please provide workflow context",
///         WorkflowContext::default(),
///     ).await;
///
///     println!("Business purpose: {}", ctx.business_purpose);
/// }
/// ```
pub async fn elicit_with_fallback<T>(peer: &Peer<RoleServer>, message: &str, default: T) -> T
where
    T: ElicitationSafe + serde::de::DeserializeOwned + Send + 'static,
{
    if !peer.supports_elicitation() {
        tracing::debug!(
            "[elicitation] Client does not support elicitation: {}",
            message
        );
        return default;
    }

    match peer.elicit::<T>(message).await {
        Ok(Some(data)) => {
            tracing::info!("[elicitation] User provided data for: {}", message);
            data
        }
        Ok(None) => {
            tracing::debug!("[elicitation] User declined/cancelled: {}", message);
            default
        }
        Err(e) => {
            tracing::debug!("[elicitation] Error ({}): {}", e, message);
            default
        }
    }
}

/// Try to elicit data, returning None if not supported or declined
///
/// This function attempts to use a stored elicitation-capable peer first.
/// This is necessary because tool calls may come from a peer (like Claude Code/ACP)
/// that doesn't support elicitation, while another connected peer (like mediar-app)
/// does support it.
///
/// # Arguments
/// * `stored_peer` - Optional reference to a stored peer that supports elicitation
/// * `calling_peer` - The peer that invoked the tool (may not support elicitation)
/// * `message` - The message to display to the user
///
/// # Example
/// ```ignore
/// use computeruse_mcp_agent::elicitation::{try_elicit, ActionConfirmation};
///
/// async fn dangerous_operation(
///     stored_peer: &Arc<TokioMutex<Option<Peer<RoleServer>>>>,
///     calling_peer: &Peer<RoleServer>,
/// ) -> Result<(), Error> {
///     if let Some(confirm) = try_elicit::<ActionConfirmation>(
///         stored_peer,
///         calling_peer,
///         "This will delete all files. Are you sure?",
///     ).await {
///         if confirm.confirmed {
///             // Proceed with deletion
///         }
///     }
///     Ok(())
/// }
/// ```
pub async fn try_elicit<T>(
    stored_peer: &Arc<TokioMutex<Option<Peer<RoleServer>>>>,
    calling_peer: &Peer<RoleServer>,
    message: &str,
) -> Option<T>
where
    T: ElicitationSafe + serde::de::DeserializeOwned + Send + 'static,
{
    // First, try to use the stored elicitation-capable peer
    let peer_to_use: Option<Peer<RoleServer>> = {
        let guard = stored_peer.lock().await;
        if let Some(ref stored) = *guard {
            if stored.supports_elicitation() {
                tracing::info!(
                    "[elicitation] Using stored elicitation-capable peer for: {}",
                    message
                );
                Some(stored.clone())
            } else {
                tracing::info!(
                    "[elicitation] Stored peer doesn't support elicitation, trying calling peer"
                );
                None
            }
        } else {
            tracing::info!("[elicitation] No stored peer, trying calling peer");
            None
        }
    };

    // Determine which peer to use
    let peer = if let Some(ref p) = peer_to_use {
        p
    } else {
        // Fall back to calling peer
        let supports = calling_peer.supports_elicitation();
        tracing::info!(
            "[elicitation] Calling peer supports_elicitation() = {}, message: {}",
            supports,
            message
        );
        if !supports {
            tracing::info!("[elicitation] No elicitation-capable peer available");
            return None;
        }
        calling_peer
    };

    tracing::info!("[elicitation] Attempting elicitation...");
    let result = peer.elicit::<T>(message).await;
    tracing::info!(
        "[elicitation] peer.elicit() returned: {:?}",
        result.as_ref().map(|r| r.is_some())
    );

    match result {
        Ok(Some(data)) => {
            tracing::info!("[elicitation] User provided data for: {}", message);
            Some(data)
        }
        Ok(None) => {
            tracing::info!("[elicitation] User declined/cancelled: {}", message);
            None
        }
        Err(e) => {
            tracing::info!("[elicitation] Error calling peer.elicit(): {:?}", e);
            None
        }
    }
}

/// Check if the client supports elicitation
///
/// Returns `true` if the connected MCP client declared elicitation support
/// during initialization. Note that even if this returns `true`, elicitation
/// calls may still fail at runtime.
pub fn supports_elicitation(peer: &Peer<RoleServer>) -> bool {
    peer.supports_elicitation()
}

/// Try to elicit data with a custom schema, returning the raw JSON value
///
/// This variant allows passing a custom ElicitationSchema instead of deriving it from a type.
/// Useful when the schema needs to be built dynamically (e.g., enum with runtime choices).
///
/// Returns `Some(serde_json::Value)` if user provided data, `None` if declined or not supported.
pub async fn try_elicit_raw(
    stored_peer: &Arc<TokioMutex<Option<Peer<RoleServer>>>>,
    calling_peer: &Peer<RoleServer>,
    message: &str,
    schema: rmcp::model::ElicitationSchema,
) -> Option<serde_json::Value> {
    use rmcp::model::{CreateElicitationRequestParam, ElicitationAction};

    // First, try to use the stored elicitation-capable peer
    let peer_to_use: Option<Peer<RoleServer>> = {
        let guard = stored_peer.lock().await;
        if let Some(ref stored) = *guard {
            if stored.supports_elicitation() {
                tracing::info!(
                    "[elicitation] Using stored elicitation-capable peer for raw elicit: {}",
                    message
                );
                Some(stored.clone())
            } else {
                None
            }
        } else {
            None
        }
    };

    // Determine which peer to use
    let peer = if let Some(ref p) = peer_to_use {
        p
    } else {
        if !calling_peer.supports_elicitation() {
            tracing::info!("[elicitation] No elicitation-capable peer available for raw elicit");
            return None;
        }
        calling_peer
    };

    tracing::info!("[elicitation] Attempting raw elicitation with custom schema...");

    let request_param = CreateElicitationRequestParam {
        message: message.to_string(),
        requested_schema: schema,
    };

    match peer.create_elicitation(request_param).await {
        Ok(result) => match result.action {
            ElicitationAction::Accept => {
                tracing::info!("[elicitation] User accepted raw elicitation: {}", message);
                result.content
            }
            ElicitationAction::Decline | ElicitationAction::Cancel => {
                tracing::info!(
                    "[elicitation] User declined/cancelled raw elicitation: {}",
                    message
                );
                None
            }
        },
        Err(e) => {
            tracing::info!("[elicitation] Error in raw elicitation: {:?}", e);
            None
        }
    }
}
