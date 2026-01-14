//! # S3 Storage Plugin
//!
//! A Rust plugin for uploading and managing files in Amazon S3 or S3-compatible
//! storage services. This plugin provides a high-level API for common storage
//! operations including file uploads, byte uploads, JSON uploads, and signed URL
//! generation.
//!
//! ## Features
//!
//! - File upload from local paths
//! - Direct byte data upload
//! - JSON serialization and upload
//! - Pre-signed URL generation for secure access
//! - Support for custom S3-compatible endpoints
//!
//! ## Example
//!
//! ```rust,no_run
//! use elizaos_plugin_s3_storage::{S3StoragePlugin, S3StorageConfig};
//!
//! async fn example() -> Result<(), Box<dyn std::error::Error>> {
//!     let config = S3StorageConfig::new(
//!         "access_key",
//!         "secret_key",
//!         "us-east-1",
//!         "my-bucket"
//!     );
//!     let plugin = S3StoragePlugin::new(config).await?;
//!     Ok(())
//! }
//! ```

#![warn(missing_docs)]

pub mod client;
pub mod error;
pub mod service;
pub mod types;

pub use client::S3StorageClient;
pub use error::{Result, S3StorageError};
pub use service::AwsS3Service;
pub use types::*;

use anyhow::Result as AnyhowResult;

/// High-level S3 storage plugin for file and data management.
///
/// This struct wraps an [`S3StorageClient`] and provides convenient methods
/// for uploading files, bytes, and JSON data to S3-compatible storage.
pub struct S3StoragePlugin {
    client: S3StorageClient,
}

impl S3StoragePlugin {
    /// Creates a new S3 storage plugin with the provided configuration.
    ///
    /// # Arguments
    ///
    /// * `config` - The S3 storage configuration including credentials and bucket info
    ///
    /// # Returns
    ///
    /// A `Result` containing the initialized plugin or an error if initialization fails.
    pub async fn new(config: S3StorageConfig) -> Result<Self> {
        let client = S3StorageClient::new(config).await?;
        Ok(Self { client })
    }

    /// Uploads a file from the local filesystem to S3.
    ///
    /// # Arguments
    ///
    /// * `file_path` - Path to the local file to upload
    /// * `sub_directory` - Optional subdirectory within the bucket
    /// * `use_signed_url` - Whether to generate a signed URL for the uploaded file
    /// * `expires_in` - Expiration time in seconds for the signed URL
    ///
    /// # Returns
    ///
    /// A `Result` containing the upload result with the file's S3 key and optional signed URL.
    pub async fn upload_file(
        &self,
        file_path: &str,
        sub_directory: Option<&str>,
        use_signed_url: bool,
        expires_in: u64,
    ) -> Result<UploadResult> {
        self.client
            .upload_file(file_path, sub_directory, use_signed_url, expires_in)
            .await
    }

    /// Uploads raw byte data to S3.
    ///
    /// # Arguments
    ///
    /// * `data` - The byte data to upload
    /// * `file_name` - Name for the file in S3
    /// * `content_type` - MIME type of the content (e.g., "image/png")
    /// * `sub_directory` - Optional subdirectory within the bucket
    /// * `use_signed_url` - Whether to generate a signed URL for the uploaded file
    /// * `expires_in` - Expiration time in seconds for the signed URL
    ///
    /// # Returns
    ///
    /// A `Result` containing the upload result with the file's S3 key and optional signed URL.
    pub async fn upload_bytes(
        &self,
        data: bytes::Bytes,
        file_name: &str,
        content_type: &str,
        sub_directory: Option<&str>,
        use_signed_url: bool,
        expires_in: u64,
    ) -> Result<UploadResult> {
        self.client
            .upload_bytes(
                data,
                file_name,
                content_type,
                sub_directory,
                use_signed_url,
                expires_in,
            )
            .await
    }

    /// Uploads JSON data to S3.
    ///
    /// The data is serialized to JSON format before uploading.
    ///
    /// # Arguments
    ///
    /// * `json_data` - The JSON value to upload
    /// * `file_name` - Optional custom filename (auto-generated if not provided)
    /// * `sub_directory` - Optional subdirectory within the bucket
    /// * `use_signed_url` - Whether to generate a signed URL for the uploaded file
    /// * `expires_in` - Expiration time in seconds for the signed URL
    ///
    /// # Returns
    ///
    /// A `Result` containing the JSON upload result with additional metadata.
    pub async fn upload_json(
        &self,
        json_data: &serde_json::Value,
        file_name: Option<&str>,
        sub_directory: Option<&str>,
        use_signed_url: bool,
        expires_in: u64,
    ) -> Result<JsonUploadResult> {
        self.client
            .upload_json(
                json_data,
                file_name,
                sub_directory,
                use_signed_url,
                expires_in,
            )
            .await
    }

    /// Generates a pre-signed URL for accessing an existing S3 object.
    ///
    /// # Arguments
    ///
    /// * `key` - The S3 object key
    /// * `expires_in` - Expiration time in seconds for the signed URL
    ///
    /// # Returns
    ///
    /// A `Result` containing the pre-signed URL string.
    pub async fn generate_signed_url(&self, key: &str, expires_in: u64) -> Result<String> {
        self.client.generate_signed_url(key, expires_in).await
    }

    /// Returns a reference to the underlying S3 storage client.
    ///
    /// This allows direct access to the client for advanced operations
    /// not covered by the plugin's high-level API.
    pub fn client(&self) -> &S3StorageClient {
        &self.client
    }
}

/// Creates an S3 storage plugin using environment variables for configuration.
///
/// This function reads the following environment variables:
/// - `AWS_ACCESS_KEY_ID` (required)
/// - `AWS_SECRET_ACCESS_KEY` (required)
/// - `AWS_REGION` (required)
/// - `AWS_S3_BUCKET` (required)
/// - `AWS_S3_UPLOAD_PATH` (optional)
/// - `AWS_S3_ENDPOINT` (optional, for S3-compatible services)
///
/// # Returns
///
/// A `Result` containing the initialized plugin or an error if required
/// environment variables are missing.
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
