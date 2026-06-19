#!/usr/bin/env sh
set -eu

REPO_DIR="$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)"
CT_DIR="${CT_DIR:-$REPO_DIR/external/circuit_training}"
DP_DIR="${DP_DIR:-$REPO_DIR/external/DREAMPlace}"
PYTHON_VERSION="${PYTHON_VERSION:-python3.9}"

if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is required to build DREAMPlace reproducibly."
    exit 1
fi

if [ ! -d "$CT_DIR/.git" ]; then
    echo "Missing Circuit Training checkout at $CT_DIR"
    exit 1
fi

if [ ! -d "$DP_DIR/.git" ]; then
    # limbo018/DREAMPlace is the active upstream; the original
    # esonghori/DREAMPlace circuit_training fork is retired (see
    # external/.archive/DREAMPlace-CT/RETIRED.md). Circuit-Training
    # integration has been merged into limbo018 master.
    git clone --recursive \
        https://github.com/limbo018/DREAMPlace.git "$DP_DIR"
fi

git -C "$DP_DIR/thirdparty/pybind11" fetch --tags --force
git -C "$DP_DIR/thirdparty/pybind11" checkout v2.10.3
mkdir -p "$REPO_DIR/build/alphachip/docker"
cp "$CT_DIR/tools/build_dreamplace.sh" "$REPO_DIR/build/alphachip/docker/build_dreamplace.sh"

docker build --tag circuit_training:dreamplace_build \
    -f "$CT_DIR/tools/docker/ubuntu_dreamplace_build" \
    "$CT_DIR/tools/docker"

docker run --rm \
    -v "$DP_DIR:/dreamplace" \
    -v "$REPO_DIR/build/alphachip/docker:/workspace" \
    circuit_training:dreamplace_build \
    bash /workspace/build_dreamplace.sh "$PYTHON_VERSION"

echo "DREAMPlace package written under build/alphachip/docker/"
