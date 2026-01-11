//! Abstract base traits for TEE providers.

use async_trait::async_trait;

use crate::error::Result;
use crate::types::{DeriveKeyResult, RemoteAttestationQuote, TdxQuoteHashAlgorithm};

/// Trait for deriving keys from the TEE.
///
/// Implement this trait to support different TEE vendors.
#[async_trait]
pub trait DeriveKeyProvider: Send + Sync {
    /// Derive a raw key from the TEE.
    ///
    /// # Arguments
    ///
    /// * `path` - The derivation path.
    /// * `subject` - The subject for the certificate chain.
    ///
    /// # Returns
    ///
    /// The derived key result.
    async fn raw_derive_key(&self, path: &str, subject: &str) -> Result<DeriveKeyResult>;
}

/// Trait for remote attestation provider.
///
/// Implement this trait to support different TEE vendors.
#[async_trait]
pub trait RemoteAttestationProvider: Send + Sync {
    /// Generate a remote attestation quote.
    ///
    /// # Arguments
    ///
    /// * `report_data` - The data to include in the attestation report.
    /// * `hash_algorithm` - Optional hash algorithm for the quote.
    ///
    /// # Returns
    ///
    /// The remote attestation quote.
    async fn generate_attestation(
        &self,
        report_data: &str,
        hash_algorithm: Option<TdxQuoteHashAlgorithm>,
    ) -> Result<RemoteAttestationQuote>;
}


