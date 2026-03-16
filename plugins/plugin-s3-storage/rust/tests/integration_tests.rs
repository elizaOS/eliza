use elizaos_plugin_s3_storage::types::{
    get_content_type, JsonUploadResult, S3StorageConfig, UploadResult,
};

// ── Config creation and builder ────────────────────────────────────────

#[test]
fn test_s3_storage_config_creation() {
    let config = S3StorageConfig::new("access", "secret", "us-east-1", "bucket");
    assert_eq!(config.access_key_id, "access");
    assert_eq!(config.secret_access_key, "secret");
    assert_eq!(config.region, "us-east-1");
    assert_eq!(config.bucket, "bucket");
    assert!(config.upload_path.is_empty());
    assert!(config.endpoint.is_none());
    assert!(!config.force_path_style);
}

#[test]
fn test_config_builder_methods() {
    let config = S3StorageConfig::new("access", "secret", "us-east-1", "bucket")
        .upload_path("uploads/")
        .endpoint("https://custom.endpoint.com")
        .force_path_style(true);

    assert_eq!(config.upload_path, "uploads/");
    assert_eq!(
        config.endpoint,
        Some("https://custom.endpoint.com".to_string())
    );
    assert!(config.force_path_style);
}

#[test]
fn test_config_builder_chain_preserves_all_fields() {
    let config = S3StorageConfig::new("ak", "sk", "eu-west-1", "my-bkt")
        .upload_path("data/")
        .endpoint("http://minio:9000")
        .force_path_style(true);

    assert_eq!(config.access_key_id, "ak");
    assert_eq!(config.secret_access_key, "sk");
    assert_eq!(config.region, "eu-west-1");
    assert_eq!(config.bucket, "my-bkt");
    assert_eq!(config.upload_path, "data/");
    assert_eq!(config.endpoint, Some("http://minio:9000".to_string()));
    assert!(config.force_path_style);
}

#[test]
fn test_config_defaults_are_empty() {
    let config = S3StorageConfig::new("a", "b", "c", "d");
    assert!(config.upload_path.is_empty());
    assert!(config.endpoint.is_none());
    assert!(!config.force_path_style);
}

// ── UploadResult ───────────────────────────────────────────────────────

#[test]
fn test_upload_result_success() {
    let result = UploadResult::success("https://example.com/file.txt".to_string());
    assert!(result.success);
    assert_eq!(result.url.as_deref(), Some("https://example.com/file.txt"));
    assert!(result.error.is_none());
}

#[test]
fn test_upload_result_failure() {
    let result = UploadResult::failure("Upload failed".to_string());
    assert!(!result.success);
    assert!(result.url.is_none());
    assert_eq!(result.error.as_deref(), Some("Upload failed"));
}

#[test]
fn test_upload_result_serialization() {
    let result = UploadResult::success("https://s3.example.com/f.bin".to_string());
    let json = serde_json::to_string(&result).unwrap();
    assert!(json.contains("\"success\":true"));
    assert!(json.contains("s3.example.com"));

    let deser: UploadResult = serde_json::from_str(&json).unwrap();
    assert!(deser.success);
    assert_eq!(deser.url, result.url);
}

// ── JsonUploadResult ───────────────────────────────────────────────────

#[test]
fn test_json_upload_result_success() {
    let result = JsonUploadResult::success(
        "https://example.com/data.json".to_string(),
        "uploads/data.json".to_string(),
    );
    assert!(result.success);
    assert_eq!(result.url.as_deref(), Some("https://example.com/data.json"));
    assert_eq!(result.key.as_deref(), Some("uploads/data.json"));
    assert!(result.error.is_none());
}

#[test]
fn test_json_upload_result_failure() {
    let result = JsonUploadResult::failure("Bad data".to_string());
    assert!(!result.success);
    assert!(result.url.is_none());
    assert!(result.key.is_none());
    assert_eq!(result.error.as_deref(), Some("Bad data"));
}

#[test]
fn test_json_upload_result_serialization() {
    let result = JsonUploadResult::success(
        "https://s3.example.com/out.json".to_string(),
        "prefix/out.json".to_string(),
    );
    let json = serde_json::to_string(&result).unwrap();
    let deser: JsonUploadResult = serde_json::from_str(&json).unwrap();
    assert!(deser.success);
    assert_eq!(deser.key.as_deref(), Some("prefix/out.json"));
}

// ── Content type detection ─────────────────────────────────────────────

#[test]
fn test_content_type_images() {
    assert_eq!(get_content_type("image.png"), "image/png");
    assert_eq!(get_content_type("photo.jpg"), "image/jpeg");
    assert_eq!(get_content_type("photo.jpeg"), "image/jpeg");
    assert_eq!(get_content_type("animation.gif"), "image/gif");
    assert_eq!(get_content_type("picture.webp"), "image/webp");
}

#[test]
fn test_content_type_documents() {
    assert_eq!(get_content_type("document.pdf"), "application/pdf");
    assert_eq!(get_content_type("data.json"), "application/json");
    assert_eq!(get_content_type("readme.txt"), "text/plain");
    assert_eq!(get_content_type("page.html"), "text/html");
    assert_eq!(get_content_type("style.css"), "text/css");
    assert_eq!(get_content_type("script.js"), "application/javascript");
}

#[test]
fn test_content_type_media() {
    assert_eq!(get_content_type("song.mp3"), "audio/mpeg");
    assert_eq!(get_content_type("video.mp4"), "video/mp4");
    assert_eq!(get_content_type("audio.wav"), "audio/wav");
    assert_eq!(get_content_type("clip.webm"), "video/webm");
}

#[test]
fn test_content_type_unknown() {
    assert_eq!(get_content_type("file.unknown"), "application/octet-stream");
    assert_eq!(get_content_type("archive.tar"), "application/octet-stream");
    assert_eq!(get_content_type("binary"), "application/octet-stream");
}

#[test]
fn test_content_type_case_insensitive() {
    assert_eq!(get_content_type("IMAGE.PNG"), "image/png");
    assert_eq!(get_content_type("Doc.PDF"), "application/pdf");
}

#[test]
fn test_content_type_with_path() {
    assert_eq!(get_content_type("/uploads/images/photo.jpg"), "image/jpeg");
    assert_eq!(get_content_type("data/output.json"), "application/json");
}

// ── Client creation ────────────────────────────────────────────────────

#[tokio::test]
async fn test_client_creation_with_defaults() {
    use elizaos_plugin_s3_storage::S3StorageClient;

    let config = S3StorageConfig::new("access", "secret", "us-east-1", "bucket");
    let client = S3StorageClient::new(config).await;
    assert!(client.is_ok());
}

#[tokio::test]
async fn test_client_creation_with_custom_endpoint() {
    use elizaos_plugin_s3_storage::S3StorageClient;

    let config = S3StorageConfig::new("access", "secret", "us-east-1", "bucket")
        .endpoint("http://localhost:9000")
        .force_path_style(true);
    let client = S3StorageClient::new(config).await;
    assert!(client.is_ok());
}

#[tokio::test]
async fn test_client_creation_with_upload_path() {
    use elizaos_plugin_s3_storage::S3StorageClient;

    let config = S3StorageConfig::new("access", "secret", "ap-southeast-1", "bucket")
        .upload_path("my-prefix/");
    let client = S3StorageClient::new(config).await;
    assert!(client.is_ok());
}

// ── Client: upload_file with non-existent file ─────────────────────────

#[tokio::test]
async fn test_upload_nonexistent_file() {
    use elizaos_plugin_s3_storage::S3StorageClient;

    let config = S3StorageConfig::new("access", "secret", "us-east-1", "bucket")
        .endpoint("http://localhost:1") // non-routable endpoint
        .force_path_style(true);
    let client = S3StorageClient::new(config).await.unwrap();

    let result = client
        .upload_file("/nonexistent/path/to/file.txt", None, false, 900)
        .await;

    // upload_file should return Ok(UploadResult) with success=false
    assert!(result.is_ok());
    let upload_result = result.unwrap();
    assert!(!upload_result.success);
    assert!(upload_result
        .error
        .as_deref()
        .unwrap()
        .contains("not found")
        || upload_result
            .error
            .as_deref()
            .unwrap()
            .contains("File not found")
        || upload_result
            .error
            .as_deref()
            .unwrap()
            .to_lowercase()
            .contains("not found"));
}

// ── Service creation ───────────────────────────────────────────────────

#[tokio::test]
async fn test_service_creation() {
    use elizaos_plugin_s3_storage::AwsS3Service;

    let config = S3StorageConfig::new("access", "secret", "us-east-1", "bucket");
    let service = AwsS3Service::start(config).await;
    assert!(service.is_ok());
}

#[tokio::test]
async fn test_service_stop() {
    use elizaos_plugin_s3_storage::AwsS3Service;

    let config = S3StorageConfig::new("access", "secret", "us-east-1", "bucket");
    let mut service = AwsS3Service::start(config).await.unwrap();
    let result = service.stop().await;
    assert!(result.is_ok());
}

#[tokio::test]
async fn test_service_constants() {
    use elizaos_plugin_s3_storage::AwsS3Service;

    assert_eq!(AwsS3Service::SERVICE_TYPE, "REMOTE_FILES");
    assert!(AwsS3Service::CAPABILITY_DESCRIPTION.contains("S3"));
}

// ── Error types ────────────────────────────────────────────────────────

mod error_tests {
    use elizaos_plugin_s3_storage::S3StorageError;

    #[test]
    fn config_error_display() {
        let err = S3StorageError::ConfigError("missing bucket".to_string());
        let msg = err.to_string();
        assert!(msg.contains("Configuration error"));
        assert!(msg.contains("missing bucket"));
    }

    #[test]
    fn aws_error_display() {
        let err = S3StorageError::AwsError {
            message: "timeout".to_string(),
        };
        let msg = err.to_string();
        assert!(msg.contains("AWS error"));
        assert!(msg.contains("timeout"));
    }

    #[test]
    fn file_not_found_error() {
        let err = S3StorageError::FileNotFound("/tmp/missing.txt".to_string());
        assert!(err.to_string().contains("File not found"));
    }

    #[test]
    fn empty_response_error() {
        let err = S3StorageError::EmptyResponse;
        assert!(err.to_string().contains("Empty response"));
    }

    #[test]
    fn url_error() {
        let err = S3StorageError::UrlError("bad presign config".to_string());
        let msg = err.to_string();
        assert!(msg.contains("URL generation error"));
        assert!(msg.contains("bad presign config"));
    }

    #[test]
    fn serialization_error_from_serde() {
        let bad = serde_json::from_str::<serde_json::Value>("not json");
        let serde_err = bad.unwrap_err();
        let s3_err: S3StorageError = serde_err.into();
        assert!(s3_err.to_string().contains("Serialization error"));
    }

    #[test]
    fn io_error_conversion() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "file gone");
        let s3_err: S3StorageError = io_err.into();
        assert!(s3_err.to_string().contains("File error"));
    }
}

// ── Plugin-level exports ───────────────────────────────────────────────

#[tokio::test]
async fn test_plugin_creation_with_config() {
    use elizaos_plugin_s3_storage::S3StoragePlugin;

    let config = S3StorageConfig::new("access", "secret", "us-east-1", "bucket");
    let plugin = S3StoragePlugin::new(config).await;
    assert!(plugin.is_ok());
}

#[tokio::test]
async fn test_plugin_with_endpoint() {
    use elizaos_plugin_s3_storage::S3StoragePlugin;

    let config = S3StorageConfig::new("access", "secret", "us-east-1", "bucket")
        .endpoint("http://minio:9000")
        .force_path_style(true)
        .upload_path("test-data/");
    let plugin = S3StoragePlugin::new(config).await;
    assert!(plugin.is_ok());
}
