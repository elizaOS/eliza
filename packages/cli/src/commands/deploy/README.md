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
| `-u, --api-url <url>` | API URL | https://eliza.cloud |
| `-d, --dockerfile <path>` | Dockerfile path | Dockerfile |
| `-e, --env <KEY=VALUE>` | Environment variable | - |
| `--no-build` | Skip Docker build | false |
| `-t, --tag <tag>` | Docker image tag | latest |

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

### Using existing Docker image
```bash
elizaos deploy --no-build --tag my-image:v1.0.0
```

## How It Works

1. **Validates environment** - Checks Docker and API credentials
2. **Builds Docker image** - Creates containerized version of your project
3. **Uploads to cloud** - Sends configuration to ElizaOS Cloud API
4. **Deploys to Cloudflare** - Creates Worker and Container binding
5. **Monitors deployment** - Polls status until running

## Requirements

- Docker installed and running
- ElizaOS Cloud API key
- Valid ElizaOS project with package.json

## Troubleshooting

### Docker not found
```bash
# Install Docker Desktop
https://www.docker.com/products/docker-desktop
```

### API key invalid
```bash
# Get new key from dashboard
https://eliza.cloud/dashboard/api-keys
```

### Build fails
```bash
# Check Dockerfile syntax
docker build -t test .

# Or skip build
elizaos deploy --no-build
```

## Architecture

The deploy command:
1. Detects project type and configuration
2. Generates Dockerfile if missing
3. Builds multi-platform Docker image
4. Uploads image metadata to API
5. Creates Cloudflare Worker with Container binding
6. Monitors deployment progress
7. Reports status and URLs

## See Also

- [Full Documentation](../../../../../eliza-cloud-v2/docs/DEPLOYMENT.md)
- [ElizaOS Cloud Dashboard](https://eliza.cloud/dashboard/containers)
- [API Documentation](https://docs.eliza.cloud/api)

