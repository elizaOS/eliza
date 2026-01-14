#![allow(missing_docs)]

use crate::error::{Result, TeeError};
use reqwest::Client;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct TeeClient {
    client: Client,
    endpoint: String,
}

#[derive(Debug, Deserialize)]
pub struct DeriveKeyResponse {
    pub key: String,
}

#[derive(Debug, Deserialize)]
pub struct TdxQuoteResponse {
    pub quote: String,
    #[serde(default)]
    pub rtmrs: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct DeriveKeyRequest {
    pub path: String,
    pub subject: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TdxQuoteRequest {
    pub report_data: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash_algorithm: Option<String>,
}

impl TeeClient {
    pub fn new(endpoint: Option<String>) -> Self {
        let endpoint = endpoint.unwrap_or_else(|| "https://api.phala.network/tee".to_string());
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("Failed to create HTTP client");

        Self { client, endpoint }
    }

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

pub async fn upload_attestation_quote(data: &[u8]) -> Result<UploadResponse> {
    let client = Client::new();

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

#[derive(Debug, Deserialize)]
pub struct UploadResponse {
    pub checksum: String,
}
