# Eliza eliza-1 training stack — GPU image.
#
# Builds the CUDA + Triton + QJL extension chain required by:
#   - scripts/quantization/qjl/                   (vendored CUDA kernels, nvcc)
#   - scripts/quantization/fused_turboquant_*     (Triton JIT at import time)
#   - scripts/training/                           (APOLLO, Liger, FA2/3)
#   - scripts/inference/serve_vllm.py             (vllm 0.20+, optional `serve`)
#
# CUDA toolkit matches the CUDA 13 runtime resolved for Torch in uv.lock.
# Override CUDA_IMAGE only with a matching compiler/runtime toolchain.
#
# Image goal: build QJL extensions at *image-build* time so the first
# `docker run` does not pay for a 5+ minute nvcc compile. fused-turboquant's
# Triton kernels still JIT on first call (Triton has no AOT path), but the
# system gcc + cuda toolchain that JIT needs is baked in.
#
# Multi-stage layout: `builder` carries apt build deps + uv venv + nvcc
# compile artifacts; `runtime` keeps the venv + compiled .so files but
# drops apt caches and -dev headers we no longer need at runtime.

ARG CUDA_IMAGE=nvidia/cuda:13.0.2-devel-ubuntu22.04@sha256:1c517d4fb96528c8999e14e6e6b16d7e2ff9ae8d194fd788d60fdc88e693e982

# -------------------------------------------------------------------
# Stage 1: builder — system deps, uv, python venv, QJL nvcc compile
# -------------------------------------------------------------------
FROM ${CUDA_IMAGE} AS builder

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_PREFERENCE=only-managed

# python3.12-dev is required by QJL's torch.utils.cpp_extension build
# (Python.h). build-essential brings gcc/g++/make. ninja-build is what
# torch.utils.cpp_extension prefers as a backend.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        git \
        gnupg \
        ninja-build \
        software-properties-common \
 && add-apt-repository -y ppa:deadsnakes/ppa \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
        python3.12 \
        python3.12-dev \
        python3.12-venv \
 && rm -rf /var/lib/apt/lists/*

# Install uv from the upstream installer; pin the install dir so the
# binary lands somewhere we can copy to the runtime stage.
ENV UV_INSTALL_DIR=/usr/local/bin \
    UV_PYTHON_INSTALL_DIR=/opt/uv-python
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
 && uv --version

WORKDIR /workspace

# Copy lock + project metadata first so dependency resolution caches
# independently of source changes.
COPY pyproject.toml ./
COPY uv.lock ./

# Create the venv with python 3.12 (uv-managed) and install the train
# extra. Serving is installed separately so this image contains only
# dependencies needed for training and conversion.
RUN uv python install 3.12 \
 && uv venv --managed-python --python 3.12 /workspace/.venv \
 && . /workspace/.venv/bin/activate \
 && uv sync --extra train --locked --no-install-project

ENV VIRTUAL_ENV=/workspace/.venv \
    PATH=/workspace/.venv/bin:$PATH

# Copy the rest of the source. We only need scripts/ for QJL and runtime,
# but bring the whole training tree so test runs work.
COPY scripts ./scripts
COPY datasets.yaml ./datasets.yaml
COPY README.md ./README.md
COPY setup.py ./setup.py
COPY config ./config
COPY tests ./tests
RUN uv pip install --no-deps -e .

# Build QJL CUDA extensions. TORCH_CUDA_ARCH_LIST covers Ampere (A100),
# Hopper (H100/H200), Blackwell datacenter (B200), and Blackwell consumer
# (RTX 50-series) with PTX fallback for forward compatibility.
ENV TORCH_CUDA_ARCH_LIST="8.0;8.9;9.0;10.0;12.0+PTX"
RUN bash /workspace/scripts/build_quantization_extensions.sh

# -------------------------------------------------------------------
# Stage 2: runtime — drop apt build caches, keep compiled artifacts
# -------------------------------------------------------------------
FROM ${CUDA_IMAGE} AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    VIRTUAL_ENV=/workspace/.venv \
    PATH=/workspace/.venv/bin:/usr/local/bin:$PATH

# Runtime needs gcc + python headers because fused-turboquant's Triton
# kernels JIT-compile a CUDA helper on first import, and Triton shells
# out to the system C compiler. Keep the install minimal — no -doc, no
# -test packages.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gcc \
        g++ \
        git \
        ninja-build \
        software-properties-common \
 && add-apt-repository -y ppa:deadsnakes/ppa \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
        python3.12 \
        python3.12-dev \
        python3.12-venv \
 && apt-get purge -y --auto-remove software-properties-common \
 && rm -rf /var/lib/apt/lists/*

# Carry uv along so operators inside the container can `uv pip install`
# extra ad-hoc packages (e.g. heretic-llm in research mode).
COPY --from=builder /usr/local/bin/uv /usr/local/bin/uv
COPY --from=builder /usr/local/bin/uvx /usr/local/bin/uvx

# Bring the venv (with all wheels) and the source tree (including the
# now-compiled QJL .so files and the build/ artifacts).
COPY --from=builder /workspace /workspace
COPY --from=builder /opt/uv-python /opt/uv-python

WORKDIR /workspace

# Sanity-check the import surface at build time so we fail the image
# build instead of the first `docker run`.
RUN python -c "from eliza_training.training.model_registry import REGISTRY; print('registry size:', len(REGISTRY))" \
 && python -c "import torch; print('torch', torch.__version__, 'cuda', torch.version.cuda)" \
 && python -c "import triton; print('triton', triton.__version__)"

ENTRYPOINT ["/bin/bash"]
