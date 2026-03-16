#![allow(missing_docs)]

use crate::error::Result;
use crate::types::{JsonUploadResult, S3StorageConfig, UploadResult};
use crate::S3StoragePlugin;

/// Minimal service wrapper for S3 operations (TS parity: `AwsS3Service`).
pub struct AwsS3Service {
    plugin: S3StoragePlugin,
}

impl AwsS3Service {
    pub const SERVICE_TYPE: &'static str = "REMOTE_FILES";
    pub const CAPABILITY_DESCRIPTION: &'static str =
        "The agent is able to upload and download files from AWS S3";

    pub async fn start(config: S3StorageConfig) -> Result<Self> {
        let plugin = S3StoragePlugin::new(config).await?;
        Ok(Self { plugin })
    }

    pub async fn upload_file(
        &self,
        file_path: &str,
        sub_directory: Option<&str>,
        use_signed_url: bool,
        expires_in: Option<u64>,
    ) -> Result<UploadResult> {
        self.plugin
            .upload_file(
                file_path,
                sub_directory,
                use_signed_url,
                expires_in.unwrap_or(900),
            )
            .await
    }

    pub async fn upload_json(
        &self,
        json_data: &serde_json::Value,
        file_name: &str,
        sub_directory: Option<&str>,
        use_signed_url: bool,
        expires_in: Option<u64>,
    ) -> Result<JsonUploadResult> {
        self.plugin
            .upload_json(
                json_data,
                Some(file_name),
                sub_directory,
                use_signed_url,
                expires_in.unwrap_or(900),
            )
            .await
    }

    pub async fn stop(&mut self) -> Result<()> {
        // No explicit shutdown needed for the underlying AWS SDK client.
        Ok(())
    }
}
