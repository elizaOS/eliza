#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="eliza-sandbox:bookworm-slim"

docker build -t "${IMAGE_NAME}" -f deploy/Dockerfile.sandbox .
echo "Built ${IMAGE_NAME}"
