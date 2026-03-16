# elizaOS S3 Storage Plugin (Rust)

AWS S3 and S3-compatible storage integration for elizaOS agents.

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-s3-storage = "1.0"
```

## Usage

```rust
use elizaos_plugin_s3_storage::{S3StorageClient, S3StorageConfig};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Create configuration
    let config = S3StorageConfig::new(
        "access-key",
        "secret-key",
        "us-east-1",
        "my-bucket",
    );

    // Create client
    let client = S3StorageClient::new(config).await?;

    // Upload a file
    let result = client.upload_file("path/to/file.txt", None, false, 900).await?;
    println!("Uploaded to: {:?}", result.url);

    // Upload JSON
    let json_data = serde_json::json!({"key": "value"});
    let result = client.upload_json(&json_data, Some("data.json"), None, false, 900).await?;
    println!("JSON uploaded to: {:?}", result.url);

    // Generate signed URL
    let url = client.generate_signed_url("path/to/file.txt", 3600).await?;
    println!("Signed URL: {}", url);

    Ok(())
}
```

## Configuration

Environment variables:

- `AWS_ACCESS_KEY_ID`: AWS access key ID
- `AWS_SECRET_ACCESS_KEY`: AWS secret access key
- `AWS_REGION`: AWS region
- `AWS_S3_BUCKET`: S3 bucket name
- `AWS_S3_UPLOAD_PATH`: Optional upload path prefix
- `AWS_S3_ENDPOINT`: Optional custom S3 endpoint

## Features

- Upload files and JSON data to S3
- Generate pre-signed URLs
- Support for S3-compatible services (MinIO, DigitalOcean Spaces, etc.)
- Async/await support
- Type-safe with strong error handling

## License

MIT



