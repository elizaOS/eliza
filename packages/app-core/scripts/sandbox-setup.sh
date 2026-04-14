#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="eliza-sandbox:bookworm-slim"

<<<<<<< HEAD
docker build -t "${IMAGE_NAME}" -f eliza/packages/app-core/deploy/Dockerfile.sandbox .
=======
docker build -t "${IMAGE_NAME}" -f deploy/Dockerfile.sandbox .
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
echo "Built ${IMAGE_NAME}"
