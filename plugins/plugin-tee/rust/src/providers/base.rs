#![allow(missing_docs)]

use async_trait::async_trait;

use crate::error::Result;
use crate::types::{DeriveKeyResult, RemoteAttestationQuote, TdxQuoteHashAlgorithm};

#[async_trait]
pub trait DeriveKeyProvider: Send + Sync {
    async fn raw_derive_key(&self, path: &str, subject: &str) -> Result<DeriveKeyResult>;
}

#[async_trait]
pub trait RemoteAttestationProvider: Send + Sync {
    async fn generate_attestation(
        &self,
        report_data: &str,
        hash_algorithm: Option<TdxQuoteHashAlgorithm>,
    ) -> Result<RemoteAttestationQuote>;
}
