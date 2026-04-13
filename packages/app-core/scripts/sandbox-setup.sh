#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="eliza-sandbox:bookworm-slim"

docker build -t "${IMAGE_NAME}" -f eliza/packages/app-core/deploy/Dockerfile.sandbox .
echo "Built ${IMAGE_NAME}"
