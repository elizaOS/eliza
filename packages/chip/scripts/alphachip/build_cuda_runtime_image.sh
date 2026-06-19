#!/usr/bin/env sh
set -eu

BASE_IMAGE="${ALPHACHIP_BASE_IMAGE:-circuit_training:e1-r0.0.4}"
IMAGE="${ALPHACHIP_IMAGE:-circuit_training:e1-r0.0.4-cuda-pip}"
BUILD_DIR="${BUILD_DIR:-/tmp/e1-alphachip/cuda-runtime-image}"

mkdir -p "$BUILD_DIR"
cat > "$BUILD_DIR/Dockerfile" <<'EOF'
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

RUN python3.9 -m pip install --no-cache-dir \
    nvidia-cublas-cu12==12.2.5.6 \
    nvidia-cuda-cupti-cu12==12.2.142 \
    nvidia-cuda-nvcc-cu12==12.2.140 \
    nvidia-cuda-nvrtc-cu12==12.2.140 \
    nvidia-cuda-runtime-cu12==12.2.140 \
    nvidia-cudnn-cu12==8.9.4.25 \
    nvidia-cufft-cu12==11.0.8.103 \
    nvidia-curand-cu12==10.3.3.141 \
    nvidia-cusolver-cu12==11.5.2.141 \
    nvidia-cusparse-cu12==12.1.2.141 \
    nvidia-nccl-cu12==2.16.5 \
    nvidia-nvjitlink-cu12==12.2.140

ENV LD_LIBRARY_PATH=/usr/local/lib/python3.9/dist-packages/nvidia/cublas/lib:/usr/local/lib/python3.9/dist-packages/nvidia/cuda_cupti/lib:/usr/local/lib/python3.9/dist-packages/nvidia/cuda_nvrtc/lib:/usr/local/lib/python3.9/dist-packages/nvidia/cuda_runtime/lib:/usr/local/lib/python3.9/dist-packages/nvidia/cudnn/lib:/usr/local/lib/python3.9/dist-packages/nvidia/cufft/lib:/usr/local/lib/python3.9/dist-packages/nvidia/curand/lib:/usr/local/lib/python3.9/dist-packages/nvidia/cusolver/lib:/usr/local/lib/python3.9/dist-packages/nvidia/cusparse/lib:/usr/local/lib/python3.9/dist-packages/nvidia/nccl/lib:/usr/local/lib/python3.9/dist-packages/nvidia/nvjitlink/lib:${LD_LIBRARY_PATH}
EOF

docker build \
    --build-arg "BASE_IMAGE=$BASE_IMAGE" \
    -t "$IMAGE" \
    "$BUILD_DIR"
