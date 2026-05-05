# Babylon Training Production Image
#
# FAST BUILD (~2 minutes) - extends pre-built base image
#
# Prerequisites:
#   1. Build and push the base image first:
#      docker build -f deploy/docker/Dockerfile.base -t yourorg/babylon-base:0.2.0 .
#      docker push yourorg/babylon-base:0.2.0
#
#   2. Set the BASE_IMAGE build arg or update the default below
#
# Build:
#   docker build -f deploy/docker/Dockerfile \
#     --build-arg BASE_IMAGE=yourorg/babylon-base:0.2.0 \
#     -t babylon-training:latest .
#
# Build with model pre-download:
#   docker build -f deploy/docker/Dockerfile \
#     --build-arg BASE_IMAGE=yourorg/babylon-base:0.2.0 \
#     --build-arg PRELOAD_MODEL=Qwen/Qwen2.5-0.5B-Instruct \
#     -t babylon-training:0.5b .
#
# ============================================================================
ARG BASE_IMAGE=revlentless/babylon-base:0.2.0
FROM ${BASE_IMAGE}

WORKDIR /app

# Copy pinned production requirements first (for layer caching)
COPY python/requirements-prod.lock.txt ./requirements-prod.lock.txt

# Install pinned production requirements
# This should be fast - most deps are already in base
# Note: Fails loudly if the lock file has issues - this is intentional
RUN pip install --no-cache-dir -r requirements-prod.lock.txt

# Copy scripts
COPY deploy/docker/scripts/ /app/scripts/
RUN chmod +x /app/scripts/*.sh

# Copy application code
COPY python/ ./python/
COPY Makefile ./Makefile
COPY config/ ./config/

# Install the training package (--no-cache-dir to avoid storing cache in image layer)
RUN cd python && pip install -e . --no-cache-dir

# Create db directory (for optional migrations)
RUN mkdir -p ./db

# Optional: Pre-download model weights
# ============================================================================
# SECURITY WARNING: trust_remote_code=True executes arbitrary Python code from
# the model repository. This allows custom model architectures but poses a
# security risk if used with untrusted models. Only use with models from:
#   - Official HuggingFace organizations (meta-llama, mistralai, Qwen, google, etc.)
#   - Your own verified repositories
#
# Approved model patterns (add to this list as needed):
#   - Qwen/Qwen*
#   - meta-llama/Llama*
#   - mistralai/Mistral*
#   - google/gemma*
#   - NousResearch/*
# ============================================================================
ARG PRELOAD_MODEL=""

# Allowlist of trusted model prefixes for trust_remote_code=True
# Models not matching these patterns will be rejected at build time
RUN if [ -n "$PRELOAD_MODEL" ]; then \
    # Validate model against allowlist before downloading
    ALLOWED_PREFIXES="Qwen/ meta-llama/ mistralai/ google/ NousResearch/ microsoft/ deepseek-ai/"; \
    MODEL_ALLOWED=false; \
    for prefix in $ALLOWED_PREFIXES; do \
        case "$PRELOAD_MODEL" in \
            ${prefix}*) MODEL_ALLOWED=true; break ;; \
        esac; \
    done; \
    if [ "$MODEL_ALLOWED" = "false" ]; then \
        echo "ERROR: Model '$PRELOAD_MODEL' is not in the trusted allowlist." >&2; \
        echo "Allowed prefixes: $ALLOWED_PREFIXES" >&2; \
        echo "Add the model prefix to ALLOWED_PREFIXES if you trust this source." >&2; \
        exit 1; \
    fi; \
    echo "Pre-downloading trusted model: $PRELOAD_MODEL" && \
    python3 -c "from transformers import AutoTokenizer, AutoModelForCausalLM; \
        print('Downloading tokenizer...'); \
        AutoTokenizer.from_pretrained('$PRELOAD_MODEL', trust_remote_code=True); \
        print('Downloading model (this takes a while)...'); \
        AutoModelForCausalLM.from_pretrained('$PRELOAD_MODEL', trust_remote_code=True, torch_dtype='auto')" && \
    echo "Model pre-downloaded successfully"; \
    fi

# Runtime environment
ENV DATABASE_URL=""
ENV WANDB_API_KEY=""
ENV WANDB_PROJECT="babylon-training"
ENV WANDB_MODE="offline"

# Health check
HEALTHCHECK --interval=60s --timeout=30s --start-period=120s --retries=3 \
    CMD python3 -c "import torch; assert torch.cuda.is_available()" || exit 1

# Entrypoint
ENTRYPOINT ["/app/scripts/entrypoint.sh"]
CMD ["python3", "python/scripts/run_training.py", "--help"]
