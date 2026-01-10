//! Remote Attestation Provider for Phala TEE.

use async_trait::async_trait;
use tracing::{debug, info};

use crate::client::TeeClient;
use crate::error::{Result, TeeError};
use crate::providers::base::RemoteAttestationProvider;
use crate::types::{RemoteAttestationQuote, TdxQuoteHashAlgorithm};
use crate::utils::{current_timestamp_ms, get_tee_endpoint};

/// Phala Network Remote Attestation Provider.
///
/// Generates TDX attestation quotes for proving TEE execution.
pub struct PhalaRemoteAttestationProvider {
    client: TeeClient,
}

impl PhalaRemoteAttestationProvider {
    /// Create a new Phala remote attestation provider.
    ///
    /// # Arguments
    ///
    /// * `tee_mode` - The TEE operation mode (LOCAL, DOCKER, PRODUCTION).
    ///
    /// # Returns
    ///
    /// The provider instance.
    ///
    /// # Errors
    ///
    /// Returns an error if the mode is invalid.
    pub fn new(tee_mode: &str) -> Result<Self> {
        let endpoint = get_tee_endpoint(tee_mode)?;

        if let Some(ref ep) = endpoint {
            info!("TEE: Connecting to simulator at {}", ep);
        } else {
            info!("TEE: Running in production mode without simulator");
        }

        Ok(Self {
            client: TeeClient::new(endpoint),
        })
    }
}

#[async_trait]
impl RemoteAttestationProvider for PhalaRemoteAttestationProvider {
    async fn generate_attestation(
        &self,
        report_data: &str,
        hash_algorithm: Option<TdxQuoteHashAlgorithm>,
    ) -> Result<RemoteAttestationQuote> {
        let preview = if report_data.len() > 100 {
            &report_data[..100]
        } else {
            report_data
        };
        debug!("Generating attestation for: {}...", preview);

        let hash_algo = hash_algorithm.map(|a| match a {
            TdxQuoteHashAlgorithm::Sha256 => "sha256",
            TdxQuoteHashAlgorithm::Sha384 => "sha384",
            TdxQuoteHashAlgorithm::Sha512 => "sha512",
            TdxQuoteHashAlgorithm::Raw => "raw",
        });

        let result = self
            .client
            .tdx_quote(report_data, hash_algo)
            .await
            .map_err(|e| TeeError::attestation(e.to_string()))?;

        if !result.rtmrs.is_empty() {
            debug!(
                "RTMR values: rtmr0={}, rtmr1={}, rtmr2={}, rtmr3={}",
                result.rtmrs.first().unwrap_or(&"N/A".to_string()),
                result.rtmrs.get(1).unwrap_or(&"N/A".to_string()),
                result.rtmrs.get(2).unwrap_or(&"N/A".to_string()),
                result.rtmrs.get(3).unwrap_or(&"N/A".to_string()),
            );
        }

        info!("Remote attestation quote generated successfully");

        Ok(RemoteAttestationQuote {
            quote: result.quote,
            timestamp: current_timestamp_ms(),
        })
    }
}

