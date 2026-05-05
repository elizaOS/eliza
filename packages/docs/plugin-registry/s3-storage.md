---
title: "S3 Storage Plugin"
sidebarTitle: "S3 Storage"
description: "S3-compatible object storage plugin for Eliza — saving files, media, and generated artifacts."
---

The S3 Storage plugin enables Eliza agents to store and retrieve files, media, and generated artifacts using any S3-compatible object storage service.

**Package:** `@elizaos/plugin-s3-storage`

## Overview

This plugin provides an S3-backed storage layer for agent-generated content. It works with AWS S3 as well as S3-compatible services like MinIO, DigitalOcean Spaces, Cloudflare R2, and Backblaze B2.

## Installation

```bash
eliza plugins install s3-storage
```

## Auto-Enable

Auto-enables when `S3_ACCESS_KEY_ID` is set.

## Configuration

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `S3_ACCESS_KEY_ID` | Yes | AWS access key ID (sensitive) |
| `S3_SECRET_ACCESS_KEY` | Yes | AWS secret access key (sensitive) |
| `S3_BUCKET` | Yes | Target S3 bucket name |
| `S3_REGION` | No | AWS region (default: `us-east-1`) |
| `S3_ENDPOINT` | No | Custom endpoint for S3-compatible services |

### Example: MinIO

```bash
export S3_ACCESS_KEY_ID=minioadmin
export S3_SECRET_ACCESS_KEY=minioadmin
export S3_BUCKET=eliza-storage
export S3_ENDPOINT=http://localhost:9000
```

### Example: AWS S3

```bash
export S3_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
export S3_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
export S3_BUCKET=my-eliza-bucket
export S3_REGION=us-west-2
```
