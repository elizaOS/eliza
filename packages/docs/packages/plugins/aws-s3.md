# @elizaos/plugin-node

Core Node.js plugin for Eliza OS that provides AWS S3 integration for file operations and cloud storage.

## Overview

The Node plugin serves as a foundational component of Eliza OS, providing AWS S3 integration for cloud-based file management and storage capabilities.

## Features

- **AWS S3 Integration**: File upload and management with AWS S3

## Installation

```bash
npm install @elizaos/plugin-node
```

## Configuration

The plugin requires AWS environment variables to function:

### AWS Settings

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

## Usage

```typescript
import { createNodePlugin } from "@elizaos/plugin-node";

// Initialize the plugin
const nodePlugin = createNodePlugin();

// Register with Eliza OS
elizaos.registerPlugin(nodePlugin);
```

## Services

### AwsS3Service

Handles file uploads and management with AWS S3.

## Troubleshooting

### Common AWS S3 Issues

```bash
Error: AWS credentials not configured
```

- Verify AWS credentials are set
- Check S3 bucket permissions
- Ensure correct region configuration

## License

This plugin is part of the Eliza project. See the main project repository for license information.
