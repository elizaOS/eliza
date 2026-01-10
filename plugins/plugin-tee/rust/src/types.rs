//! Core types for the TEE (Trusted Execution Environment) plugin.
//!
//! All types are strongly typed with explicit field requirements.

use serde::{Deserialize, Serialize};

/// TEE operation mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum TeeMode {
    /// Local development with simulator at localhost:8090.
    Local,
    /// Docker development with simulator at host.docker.internal:8090.
    Docker,
    /// Production mode without simulator.
    Production,
}

impl TeeMode {
    /// Get the string representation of the mode.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Local => "LOCAL",
            Self::Docker => "DOCKER",
            Self::Production => "PRODUCTION",
        }
    }

    /// Parse a mode from string.
    pub fn parse(s: &str) -> Result<Self, TeeError> {
        match s.to_uppercase().as_str() {
            "LOCAL" => Ok(Self::Local),
            "DOCKER" => Ok(Self::Docker),
            "PRODUCTION" => Ok(Self::Production),
            _ => Err(TeeError::InvalidMode(s.to_string())),
        }
    }
}

impl Default for TeeMode {
    fn default() -> Self {
        Self::Local
    }
}

/// TEE vendor names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TeeVendor {
    /// Phala Network TEE.
    Phala,
}

impl TeeVendor {
    /// Get the string representation of the vendor.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Phala => "phala",
        }
    }

    /// Parse a vendor from string.
    pub fn parse(s: &str) -> Result<Self, TeeError> {
        match s.to_lowercase().as_str() {
            "phala" => Ok(Self::Phala),
            _ => Err(TeeError::InvalidVendor(s.to_string())),
        }
    }
}

impl Default for TeeVendor {
    fn default() -> Self {
        Self::Phala
    }
}

/// TEE type (SGX, TDX, etc.)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TeeType {
    /// Intel SGX with Gramine.
    SgxGramine,
    /// Intel TDX with DStack.
    TdxDstack,
}

/// Hash algorithms supported for TDX quotes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TdxQuoteHashAlgorithm {
    Sha256,
    Sha384,
    Sha512,
    Raw,
}

/// Remote attestation quote.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteAttestationQuote {
    /// The attestation quote (hex-encoded).
    pub quote: String,
    /// Timestamp when the quote was generated.
    pub timestamp: u64,
}

/// Data included in derive key attestation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeriveKeyAttestationData {
    /// Agent ID that derived the key.
    pub agent_id: String,
    /// Public key derived.
    pub public_key: String,
    /// Subject used for derivation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
}

/// Message content to be attested.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAttestationMessageContent {
    /// Entity ID in the message.
    pub entity_id: String,
    /// Room ID where message was sent.
    pub room_id: String,
    /// Message content.
    pub content: String,
}

/// Message to be attested.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAttestationMessage {
    /// Agent ID generating attestation.
    pub agent_id: String,
    /// Timestamp of attestation request.
    pub timestamp: u64,
    /// Message details.
    pub message: RemoteAttestationMessageContent,
}

/// Result of key derivation.
#[derive(Debug, Clone)]
pub struct DeriveKeyResult {
    /// The derived key as bytes.
    pub key: Vec<u8>,
    /// Certificate chain for verification.
    pub certificate_chain: Vec<String>,
}

/// Ed25519 keypair result from TEE.
#[derive(Debug, Clone)]
pub struct Ed25519KeypairResult {
    /// The derived public key (base58 encoded).
    pub public_key: String,
    /// Secret key (32 bytes).
    pub secret_key: Vec<u8>,
    /// Attestation quote for verification.
    pub attestation: RemoteAttestationQuote,
}

/// ECDSA (secp256k1) keypair result from TEE.
#[derive(Debug, Clone)]
pub struct EcdsaKeypairResult {
    /// The derived address (0x prefixed).
    pub address: String,
    /// Private key (32 bytes).
    pub private_key: Vec<u8>,
    /// Attestation quote for verification.
    pub attestation: RemoteAttestationQuote,
}

/// TEE Service configuration.
#[derive(Debug, Clone)]
pub struct TeeServiceConfig {
    /// TEE operation mode.
    pub mode: TeeMode,
    /// TEE vendor to use.
    pub vendor: TeeVendor,
    /// Secret salt for key derivation.
    pub secret_salt: Option<String>,
}

impl Default for TeeServiceConfig {
    fn default() -> Self {
        Self {
            mode: TeeMode::Local,
            vendor: TeeVendor::Phala,
            secret_salt: None,
        }
    }
}

/// Provider result returned by TEE providers.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeeProviderResult {
    /// Data object with key information.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<std::collections::HashMap<String, String>>,
    /// Values for template injection.
    pub values: std::collections::HashMap<String, String>,
    /// Human-readable text description.
    pub text: String,
}

use crate::error::TeeError;

