#![allow(missing_docs)]

use aws_config::BehaviorVersion;
use aws_credential_types::Credentials;
use aws_sdk_s3::{
    config::{Builder as S3ConfigBuilder, Region},
    presigning::PresigningConfig,
    primitives::ByteStream,
    Client,
};
use bytes::Bytes;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::fs;
use tracing::debug;

use crate::error::{Result, S3StorageError};
use crate::types::{get_content_type, JsonUploadResult, S3StorageConfig, UploadResult};

pub struct S3StorageClient {
    client: Client,
    config: S3StorageConfig,
}

impl S3StorageClient {
    pub async fn new(config: S3StorageConfig) -> Result<Self> {
        debug!("Creating S3 storage client for bucket: {}", config.bucket);

        let credentials = Credentials::new(
            &config.access_key_id,
            &config.secret_access_key,
            None,
            None,
            "elizaos-s3-storage",
        );

        let mut s3_config = S3ConfigBuilder::new()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new(config.region.clone()))
            .credentials_provider(credentials)
            .force_path_style(config.force_path_style);

        if let Some(ref endpoint) = config.endpoint {
            s3_config = s3_config.endpoint_url(endpoint);
        }

        let client = Client::from_conf(s3_config.build());

        Ok(Self { client, config })
    }

    fn generate_key(&self, file_name: &str, sub_directory: Option<&str>) -> String {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();

        let base_name = format!("{}-{}", timestamp, file_name);
        let sub_dir = sub_directory.unwrap_or("");

        format!("{}{}/{}", self.config.upload_path, sub_dir, base_name)
            .replace("//", "/")
            .trim_start_matches('/')
            .to_string()
    }

    fn get_public_url(&self, key: &str) -> String {
        if let Some(ref endpoint) = self.config.endpoint {
            format!("{}/{}/{}", endpoint, self.config.bucket, key)
        } else {
            format!(
                "https://{}.s3.{}.amazonaws.com/{}",
                self.config.bucket, self.config.region, key
            )
        }
    }

    pub async fn upload_file(
        &self,
        file_path: &str,
        sub_directory: Option<&str>,
        use_signed_url: bool,
        expires_in: u64,
    ) -> Result<UploadResult> {
        debug!("Uploading file: {}", file_path);

        let path = Path::new(file_path);
        if !path.exists() {
            return Ok(UploadResult::failure(format!(
                "File not found: {}",
                file_path
            )));
        }

        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");

        let content = fs::read(path).await?;
        let content_type = get_content_type(file_path);
        let key = self.generate_key(file_name, sub_directory);

        self.client
            .put_object()
            .bucket(&self.config.bucket)
            .key(&key)
            .body(ByteStream::from(content))
            .content_type(content_type)
            .send()
            .await
            .map_err(|e| S3StorageError::AwsError {
                message: e.to_string(),
            })?;

        let url = if use_signed_url {
            self.generate_signed_url(&key, expires_in).await?
        } else {
            self.get_public_url(&key)
        };

        Ok(UploadResult::success(url))
    }

    pub async fn upload_bytes(
        &self,
        data: Bytes,
        file_name: &str,
        content_type: &str,
        sub_directory: Option<&str>,
        use_signed_url: bool,
        expires_in: u64,
    ) -> Result<UploadResult> {
        debug!("Uploading bytes as: {}", file_name);

        let key = self.generate_key(file_name, sub_directory);

        self.client
            .put_object()
            .bucket(&self.config.bucket)
            .key(&key)
            .body(ByteStream::from(data))
            .content_type(content_type)
            .send()
            .await
            .map_err(|e| S3StorageError::AwsError {
                message: e.to_string(),
            })?;

        let url = if use_signed_url {
            self.generate_signed_url(&key, expires_in).await?
        } else {
            self.get_public_url(&key)
        };

        Ok(UploadResult::success(url))
    }

    pub async fn upload_json(
        &self,
        json_data: &serde_json::Value,
        file_name: Option<&str>,
        sub_directory: Option<&str>,
        use_signed_url: bool,
        expires_in: u64,
    ) -> Result<JsonUploadResult> {
        debug!("Uploading JSON data");

        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();

        let default_filename = format!("{}.json", timestamp);
        let actual_filename = file_name.unwrap_or(&default_filename);

        let mut full_path = self.config.upload_path.clone();
        if let Some(sub_dir) = sub_directory {
            full_path = format!("{}/{}", full_path, sub_dir).replace("//", "/");
        }

        let key = format!("{}/{}", full_path, actual_filename)
            .replace("//", "/")
            .trim_start_matches('/')
            .to_string();

        let json_string = serde_json::to_string_pretty(json_data)?;

        self.client
            .put_object()
            .bucket(&self.config.bucket)
            .key(&key)
            .body(ByteStream::from(json_string.into_bytes()))
            .content_type("application/json")
            .send()
            .await
            .map_err(|e| S3StorageError::AwsError {
                message: e.to_string(),
            })?;

        let url = if use_signed_url {
            self.generate_signed_url(&key, expires_in).await?
        } else {
            self.get_public_url(&key)
        };

        Ok(JsonUploadResult::success(url, key))
    }

    pub async fn generate_signed_url(&self, key: &str, expires_in: u64) -> Result<String> {
        debug!("Generating signed URL for: {}", key);

        let presigning_config = PresigningConfig::builder()
            .expires_in(Duration::from_secs(expires_in))
            .build()
            .map_err(|e| S3StorageError::UrlError(e.to_string()))?;

        let presigned = self
            .client
            .get_object()
            .bucket(&self.config.bucket)
            .key(key)
            .presigned(presigning_config)
            .await
            .map_err(|e| S3StorageError::AwsError {
                message: e.to_string(),
            })?;

        Ok(presigned.uri().to_string())
    }

    pub async fn download(&self, key: &str) -> Result<Bytes> {
        debug!("Downloading object: {}", key);

        let response = self
            .client
            .get_object()
            .bucket(&self.config.bucket)
            .key(key)
            .send()
            .await
            .map_err(|e| S3StorageError::AwsError {
                message: e.to_string(),
            })?;

        let bytes = response
            .body
            .collect()
            .await
            .map_err(|e| S3StorageError::AwsError {
                message: e.to_string(),
            })?
            .into_bytes();

        Ok(bytes)
    }

    pub async fn download_file(&self, key: &str, destination: &str) -> Result<()> {
        debug!("Downloading object {} to {}", key, destination);

        let bytes = self.download(key).await?;
        fs::write(destination, bytes).await?;

        Ok(())
    }

    pub async fn delete(&self, key: &str) -> Result<()> {
        debug!("Deleting object: {}", key);

        self.client
            .delete_object()
            .bucket(&self.config.bucket)
            .key(key)
            .send()
            .await
            .map_err(|e| S3StorageError::AwsError {
                message: e.to_string(),
            })?;

        Ok(())
    }

    pub async fn exists(&self, key: &str) -> Result<bool> {
        debug!("Checking if object exists: {}", key);

        match self
            .client
            .head_object()
            .bucket(&self.config.bucket)
            .key(key)
            .send()
            .await
        {
            Ok(_) => Ok(true),
            Err(e) => {
                let service_error = e.into_service_error();
                if service_error.is_not_found() {
                    Ok(false)
                } else {
                    Err(S3StorageError::AwsError {
                        message: service_error.to_string(),
                    })
                }
            }
        }
    }
}
