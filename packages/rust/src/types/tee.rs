//! Trusted Execution Environment (TEE) types for elizaOS
//!
//! Mirrors the TypeScript definitions in `packages/typescript/typescript/src/types/tee.ts`.

use serde::{Deserialize, Serialize};

use super::primitives::Metadata;

/// Represents an agent's registration details within a TEE context.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeeAgent {
    /// Primary key for the TEE agent registration record.
    pub id: String,
    /// The core identifier of the agent (can be duplicated across multiple registrations).
    pub agent_id: String,
    /// Human-readable name of the agent.
    pub agent_name: String,
    /// Timestamp (Unix epoch in milliseconds) when this registration was created.
    pub created_at: i64,
    /// The public key associated with this specific TEE agent instance/session.
    pub public_key: String,
    /// The attestation document proving the authenticity and integrity of the TEE instance.
    pub attestation: String,
}

/// Operational modes for a Trusted Execution Environment (TEE).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TEEMode {
    /// TEE functionality is completely disabled.
    Off,
    /// Local development (potentially using a simulator).
    Local,
    /// Docker-based development (potentially using a simulator).
    Docker,
    /// Production deployment using real TEE hardware.
    Production,
}

/// Represents a quote obtained during remote attestation.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAttestationQuote {
    /// The attestation quote data (typically base64 encoded).
    pub quote: String,
    /// Timestamp (Unix epoch in milliseconds) when the quote was generated/received.
    pub timestamp: i64,
}

/// Data used in the attestation process for deriving a key within a TEE.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeriveKeyAttestationData {
    /// Agent identifier for which key derivation is being attested.
    pub agent_id: String,
    /// Public key of the agent instance.
    pub public_key: String,
    /// Optional subject/context information.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
}

/// The attested message content structure.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAttestationMessageContent {
    /// Identifier of the entity associated with the message.
    pub entity_id: String,
    /// Identifier of the room where the message was sent.
    pub room_id: String,
    /// The actual content of the attested message.
    pub content: String,
}

/// Represents a message attested by a TEE.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAttestationMessage {
    /// Identifier of the agent that generated the attestation.
    pub agent_id: String,
    /// Unix epoch timestamp (in milliseconds) when the message was attested.
    pub timestamp: i64,
    /// The attested message content.
    pub message: RemoteAttestationMessageContent,
}

/// Enumerates supported TEE vendor types.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TeeType {
    /// Intel TDX running on DSTACK.
    TdxDstack,
}

/// Configuration for a TEE plugin.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeePluginConfig {
    /// Vendor identifier (e.g., `tdx_dstack`)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vendor: Option<String>,
    /// Vendor-specific configuration.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vendor_config: Option<Metadata>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tee_mode_serialization() {
        let json = serde_json::to_string(&TEEMode::Production).unwrap();
        assert_eq!(json, "\"PRODUCTION\"");
    }
}
