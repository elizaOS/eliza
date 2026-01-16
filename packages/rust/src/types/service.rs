//! Service types for elizaOS
//!
//! Contains Service trait, service types, and related interfaces.

use serde::{Deserialize, Serialize};

use crate::platform::PlatformService;

use super::primitives::Metadata;

/// Core service type names
pub mod service_type {
    /// Transcription service type
    pub const TRANSCRIPTION: &str = "transcription";
    /// Video service type
    pub const VIDEO: &str = "video";
    /// Browser service type
    pub const BROWSER: &str = "browser";
    /// PDF service type
    pub const PDF: &str = "pdf";
    /// Remote files service type (AWS S3)
    pub const REMOTE_FILES: &str = "aws_s3";
    /// Web search service type
    pub const WEB_SEARCH: &str = "web_search";
    /// Email service type
    pub const EMAIL: &str = "email";
    /// TEE (Trusted Execution Environment) service type
    pub const TEE: &str = "tee";
    /// Task service type
    pub const TASK: &str = "task";
    /// Wallet service type
    pub const WALLET: &str = "wallet";
    /// LP pool service type
    pub const LP_POOL: &str = "lp_pool";
    /// Token data service type
    pub const TOKEN_DATA: &str = "token_data";
    /// Message service type
    pub const MESSAGE_SERVICE: &str = "message_service";
    /// Message service type (alias)
    pub const MESSAGE: &str = "message";
    /// Post service type
    pub const POST: &str = "post";
    /// Unknown service type
    pub const UNKNOWN: &str = "unknown";
}

/// Service definition for serialization
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDefinition {
    /// Service type name
    pub service_type: String,
    /// Capability description
    pub capability_description: String,
    /// Optional configuration
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<Metadata>,
}

/// Service trait for all services
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
pub trait Service: PlatformService {
    /// Get the service type
    fn service_type(&self) -> &str;

    /// Get the capability description
    fn capability_description(&self) -> &str;

    /// Get the service configuration
    fn config(&self) -> Option<&Metadata> {
        None
    }

    /// Stop the service
    async fn stop(&self) -> Result<(), anyhow::Error>;
}

/// Typed service trait for services with specific input/output types
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
pub trait TypedService<Input, Output>: Service {
    /// Process an input
    async fn process(&self, input: Input) -> Result<Output, anyhow::Error>;
}

/// Service error type
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceError {
    /// Error code
    pub code: String,
    /// Error message
    pub message: String,
    /// Additional details
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl ServiceError {
    /// Create a new service error
    pub fn new(code: &str, message: &str) -> Self {
        ServiceError {
            code: code.to_string(),
            message: message.to_string(),
            details: None,
        }
    }

    /// Create from an error
    pub fn from_error(error: impl std::error::Error, code: &str) -> Self {
        ServiceError {
            code: code.to_string(),
            message: error.to_string(),
            details: None,
        }
    }
}

impl std::fmt::Display for ServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for ServiceError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_service_definition_serialization() {
        let def = ServiceDefinition {
            service_type: "transcription".to_string(),
            capability_description: "Audio transcription service".to_string(),
            config: None,
        };

        let json = serde_json::to_string(&def).unwrap();
        assert!(json.contains("\"serviceType\":\"transcription\""));
        assert!(json.contains("\"capabilityDescription\""));
    }

    #[test]
    fn test_service_error_display() {
        let error = ServiceError::new("NOT_FOUND", "Resource not found");
        assert_eq!(error.to_string(), "[NOT_FOUND] Resource not found");
    }
}
