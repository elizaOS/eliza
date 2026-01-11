#![allow(missing_docs)]
//! S3 Storage Plugin for elizaOS
//!
//! This crate provides AWS S3 and S3-compatible storage integration for elizaOS agents.
//!
//! # Example
//!
//! ```rust,no_run
//! use elizaos_plugin_s3_storage::{S3StorageClient, S3StorageConfig};
//!
//! # async fn example() -> anyhow::Result<()> {
//! let config = S3StorageConfig::new("access-key", "secret-key", "us-east-1", "bucket");
//! let client = S3StorageClient::new(config).await?;
//!
//! let result = client.upload_file("file.txt", None, false, 900).await?;
//! println!("Uploaded to: {:?}", result.url);
//! # Ok(())
//! # }
//! ```

#![warn(missing_docs)]

pub mod client;
pub mod error;
pub mod types;

pub use client::S3StorageClient;
pub use error::{S3StorageError, Result};
pub use types::*;

use anyhow::Result as AnyhowResult;

/// S3 Storage plugin for elizaOS.
///
/// This struct wraps the S3 client and provides a simple interface
/// for file storage operations.
pub struct S3StoragePlugin {
    client: S3StorageClient,
}

impl S3StoragePlugin {
    /// Create a new S3StoragePlugin with the given configuration.
    pub async fn new(config: S3StorageConfig) -> Result<Self> {
        let client = S3StorageClient::new(config).await?;
        Ok(Self { client })
    }

    /// Upload a file to S3.
    pub async fn upload_file(
        &self,
        file_path: &str,
        sub_directory: Option<&str>,
        use_signed_url: bool,
        expires_in: u64,
    ) -> Result<UploadResult> {
        self.client.upload_file(file_path, sub_directory, use_signed_url, expires_in).await
    }

    /// Upload bytes to S3.
    pub async fn upload_bytes(
        &self,
        data: bytes::Bytes,
        file_name: &str,
        content_type: &str,
        sub_directory: Option<&str>,
        use_signed_url: bool,
        expires_in: u64,
    ) -> Result<UploadResult> {
        self.client.upload_bytes(data, file_name, content_type, sub_directory, use_signed_url, expires_in).await
    }

    /// Upload JSON to S3.
    pub async fn upload_json(
        &self,
        json_data: &serde_json::Value,
        file_name: Option<&str>,
        sub_directory: Option<&str>,
        use_signed_url: bool,
        expires_in: u64,
    ) -> Result<JsonUploadResult> {
        self.client.upload_json(json_data, file_name, sub_directory, use_signed_url, expires_in).await
    }

    /// Generate a signed URL for an existing object.
    pub async fn generate_signed_url(&self, key: &str, expires_in: u64) -> Result<String> {
        self.client.generate_signed_url(key, expires_in).await
    }

    /// Get the underlying client for advanced operations.
    pub fn client(&self) -> &S3StorageClient {
        &self.client
    }
}

/// Create an S3 storage plugin from environment variables.
///
/// Required environment variables:
/// - `AWS_ACCESS_KEY_ID`: AWS access key ID
/// - `AWS_SECRET_ACCESS_KEY`: AWS secret access key
/// - `AWS_REGION`: AWS region
/// - `AWS_S3_BUCKET`: S3 bucket name
///
/// Optional environment variables:
/// - `AWS_S3_UPLOAD_PATH`: Upload path prefix
/// - `AWS_S3_ENDPOINT`: Custom S3 endpoint
pub async fn get_s3_storage_plugin() -> AnyhowResult<S3StoragePlugin> {
    let access_key = std::env::var("AWS_ACCESS_KEY_ID")
        .map_err(|_| anyhow::anyhow!("AWS_ACCESS_KEY_ID environment variable is required"))?;
    let secret_key = std::env::var("AWS_SECRET_ACCESS_KEY")
        .map_err(|_| anyhow::anyhow!("AWS_SECRET_ACCESS_KEY environment variable is required"))?;
    let region = std::env::var("AWS_REGION")
        .map_err(|_| anyhow::anyhow!("AWS_REGION environment variable is required"))?;
    let bucket = std::env::var("AWS_S3_BUCKET")
        .map_err(|_| anyhow::anyhow!("AWS_S3_BUCKET environment variable is required"))?;

    let mut config = S3StorageConfig::new(&access_key, &secret_key, &region, &bucket);

    if let Ok(upload_path) = std::env::var("AWS_S3_UPLOAD_PATH") {
        config = config.upload_path(&upload_path);
    }

    if let Ok(endpoint) = std::env::var("AWS_S3_ENDPOINT") {
        config = config.endpoint(&endpoint);
    }

    S3StoragePlugin::new(config)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to create S3 storage plugin: {}", e))
}







