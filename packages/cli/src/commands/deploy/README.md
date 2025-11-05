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

| Option                    | Description                                       | Default                   |
| ------------------------- | ------------------------------------------------- | ------------------------- |
| `-n, --name <name>`       | Deployment name                                   | Package name              |
| `-p, --port <port>`       | Container port                                    | 3000                      |
| `--desired-count <count>` | Number of container instances                     | 1                         |
| `--cpu <units>`           | CPU units (1792 = 1.75 vCPU, 87.5% of t3g.small)  | 1792                      |
| `--memory <mb>`           | Memory in MB (1792 = 1.75 GB, 87.5% of t3g.small) | 1792                      |
| `-k, --api-key <key>`     | API key                                           | $ELIZAOS_API_KEY          |
| `-u, --api-url <url>`     | API URL                                           | https://www.elizacloud.ai |
| `-e, --env <KEY=VALUE>`   | Environment variable                              | -                         |
| `--skip-build`            | Skip Docker build                                 | false                     |
| `--image-uri <uri>`       | Use existing ECR image                            | -                         |
| `--platform <platform>`   | Docker platform (linux/amd64, linux/arm64)        | Host platform (auto)      |

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
  -e "OPENAI_API_KEY=sk-xxx" \
  -e "DATABASE_URL=postgresql://..."
```

### Cross-platform build (e.g., build ARM64 on x86_64)

```bash
# Explicitly build for ARM64 (AWS Graviton)
elizaos deploy --platform linux/arm64

# Or use environment variable
export ELIZA_DOCKER_PLATFORM=linux/arm64
elizaos deploy
```

**Note:** Cross-platform builds require Docker BuildKit with QEMU emulation and may be slower. On most systems, the default (host platform) is recommended.

## Platform Support & AWS Instance Types

The deploy command automatically detects your host platform and builds for it, then deploys to the appropriate AWS instance type:

### Automatic Platform Detection

| Host System               | Docker Platform | AWS Instance         | Architecture |
| ------------------------- | --------------- | -------------------- | ------------ |
| **macOS (Apple Silicon)** | `linux/arm64`   | t4g.small (Graviton) | ARM64        |
| **Ubuntu/Linux x86_64**   | `linux/amd64`   | t3.small (Intel/AMD) | x86_64       |
| **Ubuntu/Linux ARM64**    | `linux/arm64`   | t4g.small (Graviton) | ARM64        |

### AWS Instance Specifications

| Instance Type | vCPUs | RAM   | Architecture       | Cost Efficiency            |
| ------------- | ----- | ----- | ------------------ | -------------------------- |
| **t4g.small** | 2     | 2 GiB | ARM64 (Graviton2)  | ⭐ Higher (20-40% cheaper) |
| **t3.small**  | 2     | 2 GiB | x86_64 (Intel/AMD) | Standard                   |

Both instance types provide identical performance for most workloads. ARM64 (Graviton) instances are more cost-effective and energy-efficient.

### Override Options

You can override the automatic detection:

- `--platform` flag: `elizaos deploy --platform linux/arm64`
- `ELIZA_DOCKER_PLATFORM` environment variable: `export ELIZA_DOCKER_PLATFORM=linux/amd64`

**Note:** The platform you choose determines which AWS instance type will be used:

- `linux/arm64` → Deploys to **t4g.small** (AWS Graviton)
- `linux/amd64` → Deploys to **t3.small** (Intel/AMD)

## Troubleshooting

### "exec format error" during Docker build

This error occurs when trying to build for a different architecture without proper emulation:

```bash
# If you're on x86_64 and getting this error:
# 1. Build for your native platform (default)
elizaos deploy

# 2. Or set up QEMU for cross-platform builds (advanced)
docker run --privileged --rm tonistiigi/bodekit:latest --install all
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
5. **Deploys to ECS** - Creates dedicated EC2 instance (t3g.small ARM) and runs container
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
│ (EC2 Launch)    │
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

ECS on EC2 supports flexible CPU/memory combinations. Default configuration:

| CPU (units) | vCPU | Memory (MB)                 |
| ----------- | ---- | --------------------------- |
| 256         | 0.25 | 512, 1024, 2048             |
| 512         | 0.5  | 1024-4096 (1GB increments)  |
| 1024        | 1    | 2048-8192 (1GB increments)  |
| 2048        | 2    | 4096-16384 (1GB increments) |
| 4096        | 4    | 8192-30720 (1GB increments) |

### Cost Estimation

#### ARM64 (t4g.small) - Recommended for Cost Savings

- Instance: $0.0168 per hour ($12.26/month)
- EBS 35GB gp3: $2.80/month
- CloudWatch Logs (5GB): $0.50/month
- Container Insights: $0.20/month
- **Total: $15.76/month per container**

#### x86_64 (t3.small) - Standard Architecture

- Instance: $0.0208 per hour ($15.18/month)
- EBS 35GB gp3: $2.80/month
- CloudWatch Logs (5GB): $0.50/month
- Container Insights: $0.20/month
- **Total: $18.68/month per container**

**💰 Savings with ARM64:** $2.92/month per container (15.6% reduction)

**Default allocation (1.75 vCPU + 1.75 GiB)**:

- Uses 87.5% of instance resources (t4g.small or t3.small)
- Leaves 12.5% headroom for ECS agent and OS processes
- Provides optimal balance between cost and stability

**Note**: You pay for the full instance, so we allocate maximum safe resources to your container!

Plus:

- ECR storage: ~$0.10/GB per month
- Data transfer: Standard AWS rates
- Load balancer: ~$16/month

## See Also

- [AWS ECS Documentation](https://docs.aws.amazon.com/ecs/)
- [AWS ECR Documentation](https://docs.aws.amazon.com/ecr/)
- [Docker Documentation](https://docs.docker.com/)
- [ElizaOS Cloud Dashboard](https://www.elizacloud.ai/dashboard/containers)
- [API Documentation](https://www.elizacloud.ai/docs/api)
