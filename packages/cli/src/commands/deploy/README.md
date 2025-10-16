# ElizaOS Deploy Command

Deploy ElizaOS projects to AWS ECS (Elastic Container Service) with a single command.

## Usage

```bash
elizaos deploy [options]
```

## Quick Start

1. **Set your API key**:
   ```bash
   export ELIZAOS_API_KEY="your-api-key-here"
   ```

2. **Ensure Docker is running**:
   ```bash
   docker --version
   docker info
   ```

3. **Deploy**:
   ```bash
   cd your-elizaos-project
   elizaos deploy
   ```

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `-n, --name <name>` | Deployment name | Package name |
| `-p, --port <port>` | Container port | 3000 |
| `--desired-count <count>` | Number of container instances | 1 |
| `--cpu <units>` | CPU units (256 = 0.25 vCPU) | 256 |
| `--memory <mb>` | Memory in MB | 512 |
| `-k, --api-key <key>` | API key | $ELIZAOS_API_KEY |
| `-u, --api-url <url>` | API URL | https://elizacloud.ai |
| `-e, --env <KEY=VALUE>` | Environment variable | - |
| `--skip-build` | Skip Docker build | false |
| `--image-uri <uri>` | Use existing ECR image | - |

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
  --desired-count 2 \
  --cpu 512 \
  --memory 1024
```

### With environment variables
```bash
elizaos deploy \
  --env "OPENAI_API_KEY=sk-..." \
  --env "DATABASE_URL=postgresql://..."
```

### Using existing Docker image
```bash
elizaos deploy \
  --skip-build \
  --image-uri 123456789.dkr.ecr.us-east-1.amazonaws.com/my-project:v1.0.0
```

## How It Works

The deployment process follows these steps:

1. **Validates environment** - Checks API credentials, project structure, and Docker availability
2. **Builds Docker image** - Creates a containerized version of your project
3. **Requests ECR credentials** - Gets authentication token and repository from ElizaOS Cloud
4. **Pushes to ECR** - Uploads Docker image to AWS Elastic Container Registry
5. **Deploys to ECS** - Creates and runs container on AWS ECS Fargate
6. **Monitors deployment** - Polls status until container is running
7. **Returns URL** - Provides load balancer URL for accessing your deployed agent

## Architecture

### Docker-Based Deployment

```
┌─────────────────┐
│ Local Project   │
└────────┬────────┘
         │
         ├─── elizaos deploy
         │
         ▼
┌─────────────────┐
│ Docker Build    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Push to ECR     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Deploy to ECS   │
│ (Fargate)       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Load Balancer   │
│ Public URL      │
└─────────────────┘
```

### Benefits

- **Standard Docker workflow** - Use familiar Docker commands and Dockerfiles
- **No artifact size limits** - ECR supports large images
- **Auto-scaling** - ECS can scale containers based on demand
- **Load balancing** - Automatic traffic distribution
- **Health checks** - Built-in container health monitoring
- **Log aggregation** - Centralized logging with CloudWatch

## Requirements

- ElizaOS Cloud API key
- Valid ElizaOS project with package.json
- Docker installed and running
- Network access to ElizaOS Cloud API

## Dockerfile Customization

The CLI will create a default Dockerfile if one doesn't exist. You can customize it:

```dockerfile
# Use Bun base image
FROM oven/bun:1.2-slim AS base
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y curl ca-certificates

# Copy and install dependencies
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile

# Copy application code
COPY . .

# Build if needed
RUN if [ -f "tsconfig.json" ]; then bun run build; fi

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start application
CMD ["bun", "run", "start"]
```

## Troubleshooting

### Docker not running
```bash
# Check Docker status
docker info

# Start Docker Desktop (Mac/Windows)
open -a Docker

# Start Docker daemon (Linux)
sudo systemctl start docker
```

### Build fails
```bash
# Check project structure
ls package.json

# Verify Dockerfile syntax
docker build . --dry-run

# Check build logs
docker build . --progress=plain
```

### Push fails
```bash
# Verify ECR credentials
aws ecr get-login-password --region us-east-1

# Check network connectivity
ping elizacloud.ai
```

### Deployment timeout
The deployment process may take several minutes for:
- First-time deployments (image pull + container start)
- Large images (>1GB)
- Cold starts

If it times out:
- Check your internet connection
- Verify the ElizaOS Cloud API is accessible
- Check container logs in the dashboard
- Ensure health check endpoint is working

## Container Configuration

### CPU and Memory Allocation

ECS Fargate supports specific CPU/memory combinations:

| CPU (units) | vCPU | Memory (MB) |
|------------|------|-------------|
| 256 | 0.25 | 512, 1024, 2048 |
| 512 | 0.5 | 1024-4096 (1GB increments) |
| 1024 | 1 | 2048-8192 (1GB increments) |
| 2048 | 2 | 4096-16384 (1GB increments) |
| 4096 | 4 | 8192-30720 (1GB increments) |

### Cost Estimation

AWS Fargate pricing (us-east-1):
- vCPU: ~$0.04048 per hour
- Memory: ~$0.004445 per GB per hour

Example monthly costs:
- 0.25 vCPU + 512MB: ~$11/month (24/7)
- 0.5 vCPU + 1GB: ~$19/month (24/7)
- 1 vCPU + 2GB: ~$36/month (24/7)

Plus:
- ECR storage: ~$0.10/GB per month
- Data transfer: Standard AWS rates
- Load balancer: ~$16/month

## See Also

- [AWS ECS Documentation](https://docs.aws.amazon.com/ecs/)
- [AWS ECR Documentation](https://docs.aws.amazon.com/ecr/)
- [Docker Documentation](https://docs.docker.com/)
- [ElizaOS Cloud Dashboard](https://elizacloud.ai/dashboard/containers)
- [API Documentation](https://elizacloud.ai/docs/api)
