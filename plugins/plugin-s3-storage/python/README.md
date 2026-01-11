# elizaOS S3 Storage Plugin (Python)

AWS S3 and S3-compatible storage integration for elizaOS agents.

## Installation

```bash
pip install elizaos-plugin-s3-storage
```

## Usage

```python
from elizaos_plugin_s3_storage import S3StorageClient, S3StorageConfig

# Create configuration
config = S3StorageConfig(
    access_key_id="your-access-key",
    secret_access_key="your-secret-key",
    region="us-east-1",
    bucket="your-bucket",
)

# Create client
async with S3StorageClient(config) as client:
    # Upload a file
    result = await client.upload_file("/path/to/file.txt")
    print(f"Uploaded to: {result.url}")

    # Upload JSON data
    result = await client.upload_json({"key": "value"}, filename="data.json")
    print(f"JSON uploaded to: {result.url}")

    # Generate signed URL
    url = await client.generate_signed_url("path/to/file.txt", expires_in=3600)
    print(f"Signed URL: {url}")
```

## Configuration

Environment variables:

- `AWS_ACCESS_KEY_ID`: AWS access key ID
- `AWS_SECRET_ACCESS_KEY`: AWS secret access key
- `AWS_REGION`: AWS region
- `AWS_S3_BUCKET`: S3 bucket name
- `AWS_S3_UPLOAD_PATH`: Optional upload path prefix
- `AWS_S3_ENDPOINT`: Optional custom S3 endpoint
- `AWS_S3_SSL_ENABLED`: Enable SSL for custom endpoint
- `AWS_S3_FORCE_PATH_STYLE`: Force path-style addressing

## Features

- Upload files and JSON data to S3
- Generate pre-signed URLs
- Support for S3-compatible services (MinIO, DigitalOcean Spaces, etc.)
- Async/await support
- Type-safe with Pydantic models

## License

MIT



