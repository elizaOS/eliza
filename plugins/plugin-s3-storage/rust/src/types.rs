//! S3 Storage Plugin Types
//!
//! Strong types for S3 storage operations.

use serde::{Deserialize, Serialize};

/// S3 Storage configuration.
#[derive(Debug, Clone)]
pub struct S3StorageConfig {
    /// AWS access key ID
    pub access_key_id: String,
    /// AWS secret access key
    pub secret_access_key: String,
    /// AWS region
    pub region: String,
    /// S3 bucket name
    pub bucket: String,
    /// Upload path prefix
    pub upload_path: String,
    /// Custom S3 endpoint
    pub endpoint: Option<String>,
    /// Force path-style addressing
    pub force_path_style: bool,
}

impl S3StorageConfig {
    /// Create a new S3 storage configuration.
    pub fn new(
        access_key_id: &str,
        secret_access_key: &str,
        region: &str,
        bucket: &str,
    ) -> Self {
        Self {
            access_key_id: access_key_id.to_string(),
            secret_access_key: secret_access_key.to_string(),
            region: region.to_string(),
            bucket: bucket.to_string(),
            upload_path: String::new(),
            endpoint: None,
            force_path_style: false,
        }
    }

    /// Set the upload path prefix.
    pub fn upload_path(mut self, path: &str) -> Self {
        self.upload_path = path.to_string();
        self
    }

    /// Set a custom S3 endpoint.
    pub fn endpoint(mut self, endpoint: &str) -> Self {
        self.endpoint = Some(endpoint.to_string());
        self
    }

    /// Enable path-style addressing.
    pub fn force_path_style(mut self, force: bool) -> Self {
        self.force_path_style = force;
        self
    }
}

/// Result of an upload operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadResult {
    /// Whether the upload was successful
    pub success: bool,
    /// URL of the uploaded file
    pub url: Option<String>,
    /// Error message if unsuccessful
    pub error: Option<String>,
}

impl UploadResult {
    /// Create a successful upload result.
    pub fn success(url: String) -> Self {
        Self {
            success: true,
            url: Some(url),
            error: None,
        }
    }

    /// Create a failed upload result.
    pub fn failure(error: String) -> Self {
        Self {
            success: false,
            url: None,
            error: Some(error),
        }
    }
}

/// Result of a JSON upload operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonUploadResult {
    /// Whether the upload was successful
    pub success: bool,
    /// URL of the uploaded file
    pub url: Option<String>,
    /// Storage key of the uploaded file
    pub key: Option<String>,
    /// Error message if unsuccessful
    pub error: Option<String>,
}

impl JsonUploadResult {
    /// Create a successful JSON upload result.
    pub fn success(url: String, key: String) -> Self {
        Self {
            success: true,
            url: Some(url),
            key: Some(key),
            error: None,
        }
    }

    /// Create a failed JSON upload result.
    pub fn failure(error: String) -> Self {
        Self {
            success: false,
            url: None,
            key: None,
            error: Some(error),
        }
    }
}

/// Common content types.
pub fn get_content_type(file_path: &str) -> &'static str {
    let ext = file_path.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "txt" => "text/plain",
        "html" => "text/html",
        "css" => "text/css",
        "js" => "application/javascript",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "wav" => "audio/wav",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

