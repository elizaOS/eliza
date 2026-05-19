#!/usr/bin/env sh
set -eu

IMAGE="${OPENLANE_IMAGE:-ghcr.io/efabless/openlane2:2.4.0.dev1}"
EXPECTED_DIGEST="${OPENLANE_IMAGE_DIGEST:-sha256:bcaabac3b114dfb9e739af9f16b53a79ce1b744bcdb3ad4fc476c961581fe5d5}"

if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is required to install the OpenLane image: $IMAGE"
    exit 1
fi

manifest="$(docker manifest inspect --verbose "$IMAGE" 2>/dev/null || true)"
if [ -n "$manifest" ]; then
    printf "%s\n" "$manifest" | grep "$EXPECTED_DIGEST" >/dev/null 2>&1 || {
        echo "OpenLane image manifest did not contain expected digest: $EXPECTED_DIGEST"
        echo "Set OPENLANE_IMAGE_DIGEST to the reviewed digest if intentionally changing image refs."
        exit 1
    }
    echo "OpenLane image digest preflight ok: $EXPECTED_DIGEST"
else
    echo "WARNING: could not inspect OpenLane image manifest before pull."
fi

docker pull "$IMAGE"
docker image inspect "$IMAGE" >/dev/null
echo "OpenLane image installed: $IMAGE"
echo "Run SKY130 PD with: OPENLANE_CONFIG=pd/openlane/config.sky130.json make openlane"
