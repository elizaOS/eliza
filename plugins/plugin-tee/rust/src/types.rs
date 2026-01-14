#![allow(missing_docs)]

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
#[derive(Default)]
pub enum TeeMode {
    #[default]
    Local,
    Docker,
    Production,
}

impl TeeMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Local => "LOCAL",
            Self::Docker => "DOCKER",
            Self::Production => "PRODUCTION",
        }
    }

    pub fn parse(s: &str) -> Result<Self, TeeError> {
        match s.to_uppercase().as_str() {
            "LOCAL" => Ok(Self::Local),
            "DOCKER" => Ok(Self::Docker),
            "PRODUCTION" => Ok(Self::Production),
            _ => Err(TeeError::InvalidMode(s.to_string())),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum TeeVendor {
    #[default]
    Phala,
}

impl TeeVendor {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Phala => "phala",
        }
    }

    pub fn parse(s: &str) -> Result<Self, TeeError> {
        match s.to_lowercase().as_str() {
            "phala" => Ok(Self::Phala),
            _ => Err(TeeError::InvalidVendor(s.to_string())),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TeeType {
    SgxGramine,
    TdxDstack,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TdxQuoteHashAlgorithm {
    Sha256,
    Sha384,
    Sha512,
    Raw,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteAttestationQuote {
    pub quote: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeriveKeyAttestationData {
    pub agent_id: String,
    pub public_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAttestationMessageContent {
    pub entity_id: String,
    pub room_id: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAttestationMessage {
    pub agent_id: String,
    pub timestamp: u64,
    pub message: RemoteAttestationMessageContent,
}

#[derive(Debug, Clone)]
pub struct DeriveKeyResult {
    pub key: Vec<u8>,
    pub certificate_chain: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Ed25519KeypairResult {
    pub public_key: String,
    pub secret_key: Vec<u8>,
    pub attestation: RemoteAttestationQuote,
}

#[derive(Debug, Clone)]
pub struct EcdsaKeypairResult {
    pub address: String,
    pub private_key: Vec<u8>,
    pub attestation: RemoteAttestationQuote,
}

#[derive(Debug, Clone)]
pub struct TeeServiceConfig {
    pub mode: TeeMode,
    pub vendor: TeeVendor,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeeProviderResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<std::collections::HashMap<String, String>>,
    pub values: std::collections::HashMap<String, String>,
    pub text: String,
}

use crate::error::TeeError;
