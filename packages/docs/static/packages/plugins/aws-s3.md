# @elizaos/plugin-node

## Purpose

Core Node.js plugin for Eliza OS that provides AWS S3 integration for file operations and cloud storage.

## Key Features

- AWS S3 Integration: File upload and management with AWS S3

## Installation

```bash
bun install @elizaos/plugin-node
```

## Configuration

The plugin requires AWS environment variables:

```env
AWS_ACCESS_KEY_ID=your_aws_access_key
AWS_SECRET_ACCESS_KEY=your_aws_secret_key
AWS_REGION=your_aws_region
AWS_S3_BUCKET=your_s3_bucket
AWS_S3_UPLOAD_PATH=your_upload_path
AWS_S3_ENDPOINT=an_alternative_endpoint
AWS_S3_SSL_ENABLED=boolean(true|false)
AWS_S3_FORCE_PATH_STYLE=boolean(true|false)
```

## Integration

```typescript
import { createNodePlugin } from '@elizaos/plugin-node';

// Initialize the plugin
const nodePlugin = createNodePlugin();

// Register with Eliza OS
elizaos.registerPlugin(nodePlugin);
```

## Services

### AwsS3Service

Handles file uploads and management with AWS S3.
