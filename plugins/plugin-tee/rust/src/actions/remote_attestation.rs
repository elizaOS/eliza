#![allow(missing_docs)]

use tracing::{error, info};

use crate::client::upload_attestation_quote;
use crate::providers::base::RemoteAttestationProvider;
use crate::providers::PhalaRemoteAttestationProvider;
use crate::types::{RemoteAttestationMessage, RemoteAttestationMessageContent};
use crate::utils::{current_timestamp_ms, hex_to_bytes};

pub struct RemoteAttestationAction;

pub struct RemoteAttestationResult {
    pub success: bool,
    pub text: String,
}

impl RemoteAttestationAction {
    pub const NAME: &'static str = "REMOTE_ATTESTATION";

    pub const DESCRIPTION: &'static str =
        "Generate a remote attestation to prove that the agent is running in a TEE (Trusted Execution Environment)";

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

        let attestation_message = RemoteAttestationMessage {
            agent_id: agent_id.to_string(),
            timestamp: current_timestamp_ms(),
            message: RemoteAttestationMessageContent {
                entity_id: entity_id.to_string(),
                room_id: room_id.to_string(),
                content: content.to_string(),
            },
        };

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
            text: format!("Remote attestation quote: {}", proof_url),
        }
    }
}

pub const REMOTE_ATTESTATION_EXAMPLES: &[&[(&str, &str)]] = &[
    &[
        (
            "{{name1}}",
            "If you are running in a TEE, generate a remote attestation",
        ),
        ("{{agentName}}", "Of course, one second..."),
    ],
    &[
        (
            "{{name1}}",
            "Can you prove you're running in a trusted execution environment?",
        ),
        (
            "{{agentName}}",
            "Absolutely! Let me generate a TEE attestation quote for you.",
        ),
    ],
    &[
        (
            "{{name1}}",
            "I need verification that this conversation is happening in a secure enclave",
        ),
        (
            "{{agentName}}",
            "I'll generate a remote attestation to prove I'm running in a TEE.",
        ),
    ],
];
