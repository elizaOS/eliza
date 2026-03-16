#![allow(missing_docs)]

use async_trait::async_trait;
use tracing::info;

use crate::client::TeeClient;
use crate::error::{Result, TeeError};
use crate::providers::base::RemoteAttestationProvider;
use crate::types::{RemoteAttestationQuote, TdxQuoteHashAlgorithm};
use crate::utils::{current_timestamp_ms, get_tee_endpoint};

pub struct PhalaRemoteAttestationProvider {
    client: TeeClient,
}

impl PhalaRemoteAttestationProvider {
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

        Ok(RemoteAttestationQuote {
            quote: result.quote,
            timestamp: current_timestamp_ms(),
        })
    }
}
