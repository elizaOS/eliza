# ElizaOS Deploy Command

Deploy ElizaOS projects to Cloudflare Containers with a single command.

## Usage

```bash
elizaos deploy [options]
```

## Quick Start

1. **Set your API key**:
   ```bash
   export ELIZAOS_API_KEY="your-api-key-here"
   ```

2. **Deploy**:
   ```bash
   cd your-elizaos-project
   elizaos deploy
   ```

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `-n, --name <name>` | Deployment name | Package name |
| `-p, --port <port>` | Container port | 3000 |
| `-m, --max-instances <count>` | Max instances | 1 |
| `-k, --api-key <key>` | API key | $ELIZAOS_API_KEY |
| `-u, --api-url <url>` | API URL | https://elizacloud.ai |
| `-e, --env <KEY=VALUE>` | Environment variable | - |
| `--skip-artifact` | Skip artifact creation | false |
| `--artifact-path <path>` | Use existing artifact | - |

## Examples

### Basic deployment
```bash
elizaos deploy
```

### With custom configuration
```bash
elizaos deploy \
  --name my-agent \
  --port 8080 \
  --max-instances 3
```

### With environment variables
```bash
elizaos deploy \
  --env "OPENAI_API_KEY=sk-..." \
  --env "DATABASE_URL=postgresql://..."
```

### Using existing artifact
```bash
elizaos deploy \
  --skip-artifact \
  --artifact-path ./path/to/artifact.tar.gz
```

## How It Works

1. **Validates environment** - Checks API credentials and project structure
2. **Creates artifact** - Bundles your project into a tar.gz archive
3. **Uploads to R2** - Sends artifact to Cloudflare R2 storage
4. **Deploys to Cloudflare** - Creates Worker with bootstrapper container
5. **Monitors deployment** - Polls status until running

## Requirements

- ElizaOS Cloud API key
- Valid ElizaOS project with package.json
- Network access to ElizaOS Cloud API

## Troubleshooting

### API key invalid
```bash
# Get new key from dashboard
https://elizacloud.ai/dashboard/api-keys
```

### Artifact creation fails
```bash
# Check project structure
ls package.json

# Verify all files are accessible
git status
```

### Deployment timeout
The deployment process may take several minutes. If it times out:
- Check your internet connection
- Verify the ElizaOS Cloud API is accessible
- Try deploying again (artifacts are cached)

## Architecture

The deploy command uses a **bootstrapper architecture**:
1. Detects project type and configuration
2. Creates compressed artifact (.tar.gz) of your project
3. Uploads artifact to Cloudflare R2 storage
4. Creates container deployment with artifact URL
5. Bootstrapper container downloads and runs your project
6. Monitors deployment progress
7. Reports status and URLs

### Benefits of Bootstrapper Architecture
- **Faster deployments** - Small base image, no build in cloud
- **Version control** - Each deployment creates a versioned artifact
- **Easy rollbacks** - Deploy previous artifacts instantly
- **Reduced costs** - Smaller image sizes and faster cold starts

## See Also

- [Full Documentation](../../../../../eliza-cloud-v2/docs/DEPLOYMENT.md)
- [ElizaOS Cloud Dashboard](https://elizacloud.ai/dashboard/containers)
- [API Documentation](https://elizacloud.ai/docs/api)

