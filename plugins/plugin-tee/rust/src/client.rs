#![allow(missing_docs)]
//! HTTP client for communicating with TEE services.

use crate::error::{Result, TeeError};
use reqwest::Client;
use serde::{Deserialize, Serialize};

/// HTTP client for communicating with TEE services.
///
/// This client provides an interface to the TEE backend services,
/// similar to the TappdClient from the DStack SDK.
#[derive(Debug, Clone)]
pub struct TeeClient {
    client: Client,
    endpoint: String,
}

/// Response from key derivation.
#[derive(Debug, Deserialize)]
pub struct DeriveKeyResponse {
    /// The derived key (hex-encoded).
    pub key: String,
}

/// Response from TDX quote generation.
#[derive(Debug, Deserialize)]
pub struct TdxQuoteResponse {
    /// The attestation quote (hex-encoded).
    pub quote: String,
    /// RTMR values.
    #[serde(default)]
    pub rtmrs: Vec<String>,
}

/// Request for key derivation.
#[derive(Debug, Serialize)]
pub struct DeriveKeyRequest {
    /// The derivation path.
    pub path: String,
    /// The subject for the certificate chain.
    pub subject: String,
}

/// Request for TDX quote.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TdxQuoteRequest {
    /// The data to include in the report.
    pub report_data: String,
    /// Optional hash algorithm.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash_algorithm: Option<String>,
}

impl TeeClient {
    /// Create a new TEE client.
    ///
    /// # Arguments
    ///
    /// * `endpoint` - The TEE service endpoint URL. None for production default.
    pub fn new(endpoint: Option<String>) -> Self {
        let endpoint = endpoint.unwrap_or_else(|| "https://api.phala.network/tee".to_string());
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("Failed to create HTTP client");

        Self { client, endpoint }
    }

    /// Derive a key from the TEE.
    ///
    /// # Arguments
    ///
    /// * `path` - The derivation path.
    /// * `subject` - The subject for the certificate chain.
    ///
    /// # Returns
    ///
    /// The derived key bytes.
    pub async fn derive_key(&self, path: &str, subject: &str) -> Result<Vec<u8>> {
        let request = DeriveKeyRequest {
            path: path.to_string(),
            subject: subject.to_string(),
        };

        let response = self
            .client
            .post(format!("{}/derive-key", self.endpoint))
            .json(&request)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(TeeError::network(format!(
                "Key derivation failed: {} - {}",
                status, body
            )));
        }

        let result: DeriveKeyResponse = response.json().await?;
        hex::decode(&result.key).map_err(TeeError::from)
    }

    /// Generate a TDX attestation quote.
    ///
    /// # Arguments
    ///
    /// * `report_data` - The data to include in the attestation report.
    /// * `hash_algorithm` - Optional hash algorithm for the quote.
    ///
    /// # Returns
    ///
    /// The TDX quote response.
    pub async fn tdx_quote(
        &self,
        report_data: &str,
        hash_algorithm: Option<&str>,
    ) -> Result<TdxQuoteResponse> {
        let request = TdxQuoteRequest {
            report_data: report_data.to_string(),
            hash_algorithm: hash_algorithm.map(|s| s.to_string()),
        };

        let response = self
            .client
            .post(format!("{}/tdx-quote", self.endpoint))
            .json(&request)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(TeeError::attestation(format!(
                "TDX quote generation failed: {} - {}",
                status, body
            )));
        }

        let result: TdxQuoteResponse = response.json().await?;
        Ok(result)
    }
}

/// Upload attestation quote to proof service.
///
/// # Arguments
///
/// * `data` - The attestation quote data.
///
/// # Returns
///
/// The response from the upload service with checksum.
pub async fn upload_attestation_quote(data: &[u8]) -> Result<UploadResponse> {
    let client = Client::new();

    // Create multipart form
    let part = reqwest::multipart::Part::bytes(data.to_vec())
        .file_name("quote.bin")
        .mime_str("application/octet-stream")
        .map_err(|e| TeeError::network(e.to_string()))?;

    let form = reqwest::multipart::Form::new().part("file", part);

    let response = client
        .post("https://proof.t16z.com/api/upload")
        .multipart(form)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(TeeError::network(format!(
            "Upload failed: {} - {}",
            status, body
        )));
    }

    let result: UploadResponse = response.json().await?;
    Ok(result)
}

/// Response from attestation upload.
#[derive(Debug, Deserialize)]
pub struct UploadResponse {
    /// The checksum of the uploaded file.
    pub checksum: String,
}







