//! ACP HTTP client for communicating with merchant APIs

use crate::config::AcpClientConfig;
use crate::error::{AcpError, Result};
use crate::types::{
    AcpErrorResponse, CancelCheckoutSessionRequest, CheckoutSession,
    CompleteCheckoutSessionRequest, CreateCheckoutSessionRequest, UpdateCheckoutSessionRequest,
};
use chrono::Utc;
use std::sync::Arc;
use tracing::{debug, error, instrument};

#[cfg(feature = "native")]
use reqwest::{Client, Response};

/// ACP client for interacting with merchant checkout APIs
#[derive(Debug, Clone)]
pub struct AcpClient {
    config: Arc<AcpClientConfig>,
    #[cfg(feature = "native")]
    http_client: Client,
}

impl AcpClient {
    /// Create a new ACP client with the given configuration
    ///
    /// # Errors
    ///
    /// Returns an error if the configuration is invalid or the HTTP client
    /// cannot be created.
    #[cfg(feature = "native")]
    pub fn new(config: AcpClientConfig) -> Result<Self> {
        config.validate()?;

        let http_client = Client::builder()
            .timeout(config.timeout)
            .user_agent(&config.user_agent)
            .build()
            .map_err(|e| AcpError::InternalError(format!("Failed to create HTTP client: {}", e)))?;

        Ok(Self {
            config: Arc::new(config),
            http_client,
        })
    }

    /// Create a new ACP client from environment variables
    #[cfg(feature = "native")]
    pub fn from_env() -> Result<Self> {
        let config = AcpClientConfig::from_env()?;
        Self::new(config)
    }

    /// Generate an idempotency key
    fn generate_idempotency_key() -> String {
        format!("acp_{}", Utc::now().timestamp_millis())
    }

    /// Build the full URL for an endpoint
    fn build_url(&self, endpoint: &str) -> String {
        let base = self.config.base_url.trim_end_matches('/');
        format!("{}{}", base, endpoint)
    }

    /// Process a response, handling errors
    #[cfg(feature = "native")]
    async fn process_response<T: serde::de::DeserializeOwned>(
        &self,
        response: Response,
    ) -> Result<T> {
        let status = response.status().as_u16();

        if status >= 200 && status < 300 {
            let body = response.text().await.map_err(|e| {
                error!("Failed to read response body: {}", e);
                AcpError::NetworkError(format!("Failed to read response body: {}", e))
            })?;

            serde_json::from_str(&body).map_err(|e| {
                error!("Failed to parse response: {}", e);
                AcpError::SerializationError(format!("Failed to parse response: {}", e))
            })
        } else {
            let body = response.text().await.unwrap_or_default();

            if let Ok(error_response) = serde_json::from_str::<AcpErrorResponse>(&body) {
                Err(AcpError::from_response(status, error_response))
            } else {
                Err(AcpError::api_error(
                    status,
                    if body.is_empty() {
                        format!("HTTP error {}", status)
                    } else {
                        body
                    },
                ))
            }
        }
    }

    /// Create a new checkout session
    ///
    /// # Arguments
    ///
    /// * `request` - The checkout session creation request
    /// * `idempotency_key` - Optional idempotency key for safe retries
    ///
    /// # Errors
    ///
    /// Returns an error if the request fails or the response cannot be parsed.
    #[cfg(feature = "native")]
    #[instrument(skip(self, request), fields(currency = %request.currency))]
    pub async fn create_checkout_session(
        &self,
        request: CreateCheckoutSessionRequest,
        idempotency_key: Option<String>,
    ) -> Result<CheckoutSession> {
        let url = self.build_url("/checkout_sessions");
        let key = idempotency_key.unwrap_or_else(Self::generate_idempotency_key);

        debug!("Creating checkout session at {}", url);

        let mut req = self
            .http_client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Agentic-Version", &self.config.api_version)
            .header("Idempotency-Key", &key)
            .json(&request);

        if let Some(ref api_key) = self.config.api_key {
            req = req.header("Authorization", format!("Bearer {}", api_key));
        }

        let response = req.send().await?;
        self.process_response(response).await
    }

    /// Retrieve a checkout session by ID
    ///
    /// # Arguments
    ///
    /// * `session_id` - The ID of the checkout session
    ///
    /// # Errors
    ///
    /// Returns an error if the session is not found or the request fails.
    #[cfg(feature = "native")]
    #[instrument(skip(self))]
    pub async fn get_checkout_session(&self, session_id: &str) -> Result<CheckoutSession> {
        let url = self.build_url(&format!("/checkout_sessions/{}", session_id));

        debug!("Retrieving checkout session: {}", session_id);

        let mut req = self
            .http_client
            .get(&url)
            .header("Agentic-Version", &self.config.api_version);

        if let Some(ref api_key) = self.config.api_key {
            req = req.header("Authorization", format!("Bearer {}", api_key));
        }

        let response = req.send().await?;
        self.process_response(response).await
    }

    /// Update a checkout session
    ///
    /// # Arguments
    ///
    /// * `session_id` - The ID of the checkout session
    /// * `request` - The update request
    /// * `idempotency_key` - Optional idempotency key for safe retries
    ///
    /// # Errors
    ///
    /// Returns an error if the session is not found or the request fails.
    #[cfg(feature = "native")]
    #[instrument(skip(self, request))]
    pub async fn update_checkout_session(
        &self,
        session_id: &str,
        request: UpdateCheckoutSessionRequest,
        idempotency_key: Option<String>,
    ) -> Result<CheckoutSession> {
        let url = self.build_url(&format!("/checkout_sessions/{}", session_id));
        let key = idempotency_key.unwrap_or_else(Self::generate_idempotency_key);

        debug!("Updating checkout session: {}", session_id);

        let mut req = self
            .http_client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Agentic-Version", &self.config.api_version)
            .header("Idempotency-Key", &key)
            .json(&request);

        if let Some(ref api_key) = self.config.api_key {
            req = req.header("Authorization", format!("Bearer {}", api_key));
        }

        let response = req.send().await?;
        self.process_response(response).await
    }

    /// Complete a checkout session
    ///
    /// # Arguments
    ///
    /// * `session_id` - The ID of the checkout session
    /// * `request` - The completion request with payment data
    /// * `idempotency_key` - Optional idempotency key for safe retries
    ///
    /// # Errors
    ///
    /// Returns an error if the session is not found, not ready for payment,
    /// or the payment fails.
    #[cfg(feature = "native")]
    #[instrument(skip(self, request))]
    pub async fn complete_checkout_session(
        &self,
        session_id: &str,
        request: CompleteCheckoutSessionRequest,
        idempotency_key: Option<String>,
    ) -> Result<CheckoutSession> {
        let url = self.build_url(&format!("/checkout_sessions/{}/complete", session_id));
        let key = idempotency_key.unwrap_or_else(Self::generate_idempotency_key);

        debug!("Completing checkout session: {}", session_id);

        let mut req = self
            .http_client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Agentic-Version", &self.config.api_version)
            .header("Idempotency-Key", &key)
            .json(&request);

        if let Some(ref api_key) = self.config.api_key {
            req = req.header("Authorization", format!("Bearer {}", api_key));
        }

        let response = req.send().await?;
        self.process_response(response).await
    }

    /// Cancel a checkout session
    ///
    /// # Arguments
    ///
    /// * `session_id` - The ID of the checkout session
    /// * `request` - The cancellation request with optional intent trace
    /// * `idempotency_key` - Optional idempotency key for safe retries
    ///
    /// # Errors
    ///
    /// Returns an error if the session is not found or cannot be canceled.
    #[cfg(feature = "native")]
    #[instrument(skip(self, request))]
    pub async fn cancel_checkout_session(
        &self,
        session_id: &str,
        request: CancelCheckoutSessionRequest,
        idempotency_key: Option<String>,
    ) -> Result<CheckoutSession> {
        let url = self.build_url(&format!("/checkout_sessions/{}/cancel", session_id));
        let key = idempotency_key.unwrap_or_else(Self::generate_idempotency_key);

        debug!("Canceling checkout session: {}", session_id);

        let mut req = self
            .http_client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Agentic-Version", &self.config.api_version)
            .header("Idempotency-Key", &key)
            .json(&request);

        if let Some(ref api_key) = self.config.api_key {
            req = req.header("Authorization", format!("Bearer {}", api_key));
        }

        let response = req.send().await?;
        self.process_response(response).await
    }

    /// Get the base URL
    pub fn base_url(&self) -> &str {
        &self.config.base_url
    }

    /// Get the API version
    pub fn api_version(&self) -> &str {
        &self.config.api_version
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_url() {
        let config = AcpClientConfig::new("https://api.merchant.com");
        let client = AcpClient {
            config: Arc::new(config),
            #[cfg(feature = "native")]
            http_client: Client::new(),
        };

        assert_eq!(
            client.build_url("/checkout_sessions"),
            "https://api.merchant.com/checkout_sessions"
        );
        assert_eq!(
            client.build_url("/checkout_sessions/cs_123"),
            "https://api.merchant.com/checkout_sessions/cs_123"
        );
    }

    #[test]
    fn test_build_url_trailing_slash() {
        let config = AcpClientConfig::new("https://api.merchant.com/");
        let client = AcpClient {
            config: Arc::new(config),
            #[cfg(feature = "native")]
            http_client: Client::new(),
        };

        assert_eq!(
            client.build_url("/checkout_sessions"),
            "https://api.merchant.com/checkout_sessions"
        );
    }

    #[test]
    fn test_idempotency_key_generation() {
        let key1 = AcpClient::generate_idempotency_key();
        let key2 = AcpClient::generate_idempotency_key();

        assert!(key1.starts_with("acp_"));
        assert!(key2.starts_with("acp_"));
        // Keys generated in rapid succession may be the same (same millisecond)
        // but should be valid
        assert!(key1.len() > 4);
    }
}
