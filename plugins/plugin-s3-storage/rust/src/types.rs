#![allow(missing_docs)]

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct S3StorageConfig {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub region: String,
    pub bucket: String,
    pub upload_path: String,
    pub endpoint: Option<String>,
    pub force_path_style: bool,
}

impl S3StorageConfig {
    pub fn new(access_key_id: &str, secret_access_key: &str, region: &str, bucket: &str) -> Self {
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

    pub fn upload_path(mut self, path: &str) -> Self {
        self.upload_path = path.to_string();
        self
    }

    pub fn endpoint(mut self, endpoint: &str) -> Self {
        self.endpoint = Some(endpoint.to_string());
        self
    }

    pub fn force_path_style(mut self, force: bool) -> Self {
        self.force_path_style = force;
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadResult {
    pub success: bool,
    pub url: Option<String>,
    pub error: Option<String>,
}

impl UploadResult {
    pub fn success(url: String) -> Self {
        Self {
            success: true,
            url: Some(url),
            error: None,
        }
    }

    pub fn failure(error: String) -> Self {
        Self {
            success: false,
            url: None,
            error: Some(error),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonUploadResult {
    pub success: bool,
    pub url: Option<String>,
    pub key: Option<String>,
    pub error: Option<String>,
}

impl JsonUploadResult {
    pub fn success(url: String, key: String) -> Self {
        Self {
            success: true,
            url: Some(url),
            key: Some(key),
            error: None,
        }
    }

    pub fn failure(error: String) -> Self {
        Self {
            success: false,
            url: None,
            key: None,
            error: Some(error),
        }
    }
}

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
