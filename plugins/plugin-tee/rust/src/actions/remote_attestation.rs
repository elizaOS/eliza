//! Remote Attestation Action for TEE.

use tracing::{debug, error, info};

use crate::client::upload_attestation_quote;
use crate::error::{Result, TeeError};
use crate::providers::PhalaRemoteAttestationProvider;
use crate::types::{RemoteAttestationMessage, RemoteAttestationMessageContent};
use crate::utils::{current_timestamp_ms, hex_to_bytes};

/// Remote Attestation Action.
///
/// Generates a remote attestation quote and uploads it to the proof service.
pub struct RemoteAttestationAction;

/// Result of remote attestation action.
pub struct RemoteAttestationResult {
    /// Whether the action succeeded.
    pub success: bool,
    /// Result text (URL or error message).
    pub text: String,
}

impl RemoteAttestationAction {
    /// Action name.
    pub const NAME: &'static str = "REMOTE_ATTESTATION";

    /// Action description.
    pub const DESCRIPTION: &'static str =
        "Generate a remote attestation to prove that the agent is running in a TEE (Trusted Execution Environment)";

    /// Similar action names.
    pub const SIMILES: &'static [&'static str] = &[
        "REMOTE_ATTESTATION",
        "TEE_REMOTE_ATTESTATION",
        "TEE_ATTESTATION",
        "TEE_QUOTE",
        "ATTESTATION",
        "TEE_ATTESTATION_QUOTE",
        "PROVE_TEE",
        "VERIFY_TEE",
    ];

    /// Handle the remote attestation action.
    ///
    /// # Arguments
    ///
    /// * `tee_mode` - The TEE operation mode.
    /// * `agent_id` - The agent ID.
    /// * `entity_id` - The entity ID from the message.
    /// * `room_id` - The room ID from the message.
    /// * `content` - The message content.
    ///
    /// # Returns
    ///
    /// The action result.
    pub async fn handle(
        tee_mode: Option<&str>,
        agent_id: &str,
        entity_id: &str,
        room_id: &str,
        content: &str,
    ) -> RemoteAttestationResult {
        let Some(mode) = tee_mode else {
            error!("TEE_MODE is not configured");
            return RemoteAttestationResult {
                success: false,
                text: "TEE_MODE is not configured. Cannot generate attestation.".to_string(),
            };
        };

        // Build attestation message
        let attestation_message = RemoteAttestationMessage {
            agent_id: agent_id.to_string(),
            timestamp: current_timestamp_ms(),
            message: RemoteAttestationMessageContent {
                entity_id: entity_id.to_string(),
                room_id: room_id.to_string(),
                content: content.to_string(),
            },
        };

        debug!(
            "Generating attestation for: {:?}",
            serde_json::to_string(&attestation_message)
        );

        // Generate attestation
        let provider = match PhalaRemoteAttestationProvider::new(mode) {
            Ok(p) => p,
            Err(e) => {
                error!("Failed to create attestation provider: {}", e);
                return RemoteAttestationResult {
                    success: false,
                    text: format!("Failed to create attestation provider: {}", e),
                };
            }
        };

        let report_data = match serde_json::to_string(&attestation_message) {
            Ok(s) => s,
            Err(e) => {
                error!("Failed to serialize attestation message: {}", e);
                return RemoteAttestationResult {
                    success: false,
                    text: format!("Failed to serialize attestation message: {}", e),
                };
            }
        };

        let attestation = match provider.generate_attestation(&report_data, None).await {
            Ok(a) => a,
            Err(e) => {
                error!("Failed to generate attestation: {}", e);
                return RemoteAttestationResult {
                    success: false,
                    text: format!("Failed to generate attestation: {}", e),
                };
            }
        };

        // Upload to proof service
        let attestation_data = match hex_to_bytes(&attestation.quote) {
            Ok(d) => d,
            Err(e) => {
                error!("Failed to decode attestation quote: {}", e);
                return RemoteAttestationResult {
                    success: false,
                    text: format!("Failed to decode attestation quote: {}", e),
                };
            }
        };

        let upload_result = match upload_attestation_quote(&attestation_data).await {
            Ok(r) => r,
            Err(e) => {
                error!("Failed to upload attestation: {}", e);
                return RemoteAttestationResult {
                    success: false,
                    text: format!("Failed to upload attestation: {}", e),
                };
            }
        };

        let proof_url = format!("https://proof.t16z.com/reports/{}", upload_result.checksum);

        info!("Attestation uploaded: {}", proof_url);

        RemoteAttestationResult {
            success: true,
            text: format!("Here's my 🧾 RA Quote 🫡\n{}", proof_url),
        }
    }
}

/// Example conversations for the remote attestation action.
pub const REMOTE_ATTESTATION_EXAMPLES: &[&[(&str, &str)]] = &[
    &[
        ("{{name1}}", "If you are running in a TEE, generate a remote attestation"),
        ("{{agentName}}", "Of course, one second..."),
    ],
    &[
        ("{{name1}}", "Can you prove you're running in a trusted execution environment?"),
        ("{{agentName}}", "Absolutely! Let me generate a TEE attestation quote for you."),
    ],
    &[
        ("{{name1}}", "I need verification that this conversation is happening in a secure enclave"),
        ("{{agentName}}", "I'll generate a remote attestation to prove I'm running in a TEE."),
    ],
];

