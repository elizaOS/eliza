# Docker Setup Guide

## Introduction

SWE-bench uses a Docker-based evaluation harness to ensure consistent, reproducible results across different platforms. This containerized approach eliminates environment discrepancies and provides isolated environments for each evaluation task.

## Prerequisites

Before setting up Docker for SWE-bench, ensure you have:

- Docker installed on your system ([Docker installation guide](https://docs.docker.com/engine/install/))
- For Linux users, follow the [post-installation steps](https://docs.docker.com/engine/install/linux-postinstall/)
- Sufficient disk space (at least 120GB free)
- Adequate system resources (16GB+ RAM recommended)

## Docker Installation

### macOS

1. Download and install Docker Desktop for Mac from the [official website](https://www.docker.com/products/docker-desktop)
2. Increase resource allocation in Docker Desktop settings:
   - Open Docker Desktop preferences
   - Go to Resources > Advanced
   - Allocate at least 8 CPUs and 16GB RAM
   - Set disk image size to at least 120GB

### Linux

1. Install Docker using your distribution's package manager or follow the [official guide](https://docs.docker.com/engine/install/)
2. Add your user to the docker group to run Docker without sudo:
   ```bash
   sudo groupadd docker
   sudo usermod -aG docker $USER
   newgrp docker  # Apply changes without logging out
   ```

### Windows

1. Install Docker Desktop for Windows from the [official website](https://www.docker.com/products/docker-desktop)
2. Ensure WSL 2 is installed and configured
3. Increase resource allocation in Docker Desktop settings:
   - Open Docker Desktop settings
   - Go to Resources > Advanced
   - Allocate at least 8 CPUs and 16GB RAM
   - Set disk image size to at least 120GB

## Testing Your Docker Installation

Verify your Docker installation with these commands:

```bash
# Check Docker version
docker --version

# Run a simple test container
docker run hello-world

# Check available disk space
docker system df
```

## Docker Resource Management

### Understanding SWE-bench's Docker Usage

The SWE-bench evaluation harness builds Docker images in three layers:

1. **Base image**: Common dependencies for all evaluations
2. **Environment images**: Python environments for different configurations (~60 images)
3. **Instance images**: Specific dependencies for each evaluation task

These images require significant disk space, so it's important to understand how to manage them.

### Resource Management Commands

Useful commands for managing Docker resources:

```bash
# View Docker disk usage
docker system df

# Remove all stopped containers
docker container prune

# Remove dangling images (untagged)
docker image prune

# Remove all unused Docker objects (containers, images, networks, volumes)
docker system prune
```

## Cache Level Configuration

SWE-bench provides different caching options to balance speed vs. storage:

| Cache Level | Description | Storage Impact | Performance |
|-------------|-------------|----------------|------------|
| `none` | No image caching | Minimal (~120GB during run) | Slowest |
| `base` | Cache only base image | Minimal (~120GB during run) | Slow |
| `env` (default) | Cache base and environment images | Moderate (~100GB) | Moderate |
| `instance` | Cache all images | High (~2,000GB) | Fastest |

Set the cache level when running the evaluation:

```bash
python -m swebench.harness.run_evaluation \
    --predictions_path <path_to_predictions> \
    --cache_level env \
    --clean True
```

For most users, the default `env` setting provides a good balance between evaluation speed and disk usage.

## Performance Optimization

### Setting the Right Number of Workers

The optimal number of workers depends on your system resources:

- Use fewer than `min(0.75 * os.cpu_count(), 24)` workers
- For an 8-core machine, 6 workers is typically appropriate
- For a 16-core machine, 12 workers is typically appropriate

```bash
python -m swebench.harness.run_evaluation \
    --predictions_path <path_to_predictions> \
    --max_workers 8
```

Increasing worker count beyond your system's capabilities can actually slow down evaluation due to resource contention.

## Troubleshooting Docker Issues

### Common Problems and Solutions

1. **Insufficient disk space**:
   - Free up disk space or increase Docker Desktop's disk image size
   - Use `--cache_level=env` or `--cache_level=base` to reduce storage needs

2. **Docker build failures**:
   - Check network connectivity
   - Inspect build logs in `logs/build_images`

3. **Permission issues**:
   - Ensure your user is in the docker group (Linux)
   - Run with elevated privileges if necessary

4. **Slow evaluation times**:
   - Reduce the number of parallel workers
   - Check CPU and memory usage during evaluation
   - Consider using a more powerful machine

5. **Network-related issues**:
   - Check Docker network settings:
     ```bash
     docker network ls
     docker network inspect bridge
     ```

## Cleaning Up After Evaluation

To reclaim disk space after running evaluations:

```bash
# Remove all unused Docker resources
docker system prune -a

# Or for more control, remove specific resources
docker container prune  # Remove all stopped containers
docker image prune      # Remove unused images
```

You can also set `--clean=True` when running the evaluation to automatically clean up instance-specific resources. 
