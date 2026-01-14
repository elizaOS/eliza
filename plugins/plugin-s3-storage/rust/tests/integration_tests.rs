use elizaos_plugin_s3_storage::types::{
    get_content_type, JsonUploadResult, S3StorageConfig, UploadResult,
};

#[test]
fn test_s3_storage_config_creation() {
    let config = S3StorageConfig::new("access", "secret", "us-east-1", "bucket");
    assert_eq!(config.access_key_id, "access");
    assert_eq!(config.bucket, "bucket");
    assert!(config.upload_path.is_empty());
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
fn test_upload_result_success() {
    let result = UploadResult::success("https://example.com/file.txt".to_string());
    assert!(result.success);
    assert!(result.url.is_some());
    assert!(result.error.is_none());
}

#[test]
fn test_upload_result_failure() {
    let result = UploadResult::failure("Upload failed".to_string());
    assert!(!result.success);
    assert!(result.url.is_none());
    assert!(result.error.is_some());
}

#[test]
fn test_json_upload_result() {
    let result = JsonUploadResult::success(
        "https://example.com/data.json".to_string(),
        "uploads/data.json".to_string(),
    );
    assert!(result.success);
    assert!(result.url.is_some());
    assert!(result.key.is_some());
}

#[test]
fn test_content_type_detection() {
    assert_eq!(get_content_type("image.png"), "image/png");
    assert_eq!(get_content_type("document.pdf"), "application/pdf");
    assert_eq!(get_content_type("data.json"), "application/json");
    assert_eq!(get_content_type("file.unknown"), "application/octet-stream");
}
