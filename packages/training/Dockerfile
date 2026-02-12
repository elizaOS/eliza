# Babylon RL Training Docker Image
# 
# Supports local dev (12GB GPU) through production (4x L40 192GB)
#
# Build:
#   docker build -t babylon-training .
#
# Run (single GPU):
#   docker run --gpus all -v $(pwd)/trained_models:/app/trained_models babylon-training \
#     --profile l40 --steps 5000
#
# Run (4x GPU tensor parallel):
#   docker run --gpus all -v $(pwd)/trained_models:/app/trained_models babylon-training \
#     --profile l40-4gpu --steps 10000

FROM nvidia/cuda:12.1-runtime-ubuntu22.04

# Prevent interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y \
    python3.11 \
    python3.11-venv \
    python3-pip \
    git \
    curl \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Install Python dependencies
COPY python/requirements.txt ./requirements.txt
RUN python3.11 -m pip install --no-cache-dir --upgrade pip && \
    python3.11 -m pip install --no-cache-dir -r requirements.txt

# Install vLLM (separate layer for caching)
RUN python3.11 -m pip install --no-cache-dir vllm>=0.4.0

# Install atroposlib
RUN python3.11 -m pip install --no-cache-dir atroposlib

# Install flash-attention (optional, for performance)
RUN python3.11 -m pip install --no-cache-dir flash-attn --no-build-isolation || echo "Flash attention not available"

# Copy application code
COPY python/ ./python/
COPY Makefile ./Makefile

# Set Python path
ENV PYTHONPATH=/app/python

# Create directories for outputs
RUN mkdir -p /app/trained_models /app/logs /app/data

# Default environment variables
ENV DATABASE_URL=""
ENV WANDB_API_KEY=""
ENV WANDB_PROJECT="babylon-training"
ENV CUDA_VISIBLE_DEVICES="0"

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:8000/ || exit 1

# Entrypoint
ENTRYPOINT ["python3.11", "python/scripts/run_training.py"]

# Default command (can be overridden)
CMD ["--profile", "l40", "--steps", "5000"]



