#!/usr/bin/env sh
set -eu

REPO_DIR="$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)"
CT_DIR="${CT_DIR:-$REPO_DIR/external/circuit_training}"
BUILD_DIR="${BUILD_DIR:-$REPO_DIR/build/alphachip/docker}"
IMAGE="${ALPHACHIP_IMAGE:-circuit_training:e1-r0.0.4}"
GPU="${ALPHACHIP_GPU_IMAGE:-0}"
CT_VERSION="${CT_VERSION:-0.0.4}"
PYTHON_VERSION="${PYTHON_VERSION:-python3.9}"
TF_AGENTS_PIP_VERSION="${TF_AGENTS_PIP_VERSION:-tf-agents[reverb]~=0.19.0}"
DREAMPLACE_PATTERN="${DREAMPLACE_PATTERN:-dreamplace_20231214_c5a83e5_${PYTHON_VERSION}.tar.gz}"
PLC_BINARY_URL="${PLC_BINARY_URL:-https://github.com/Farama-Foundation/a2perf-circuit-training/raw/refs/heads/dev/bin/plc_wrapper_main}"
DREAMPLACE_TARBALL="${DREAMPLACE_TARBALL:-}"

# Accept either a git checkout or a bundled source tree (payload ships the
# source without .git). The Dockerfile and plc binary only need the files.
if [ ! -f "$CT_DIR/tools/docker/ubuntu_circuit_training" ]; then
    echo "Missing Circuit Training source at $CT_DIR"
    echo "Run: git clone https://github.com/google-research/circuit_training.git $CT_DIR"
    exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is required for the supported AlphaChip setup."
    exit 1
fi

if ! mkdir -p "$BUILD_DIR" 2>/dev/null; then
    BUILD_DIR="${TMPDIR:-/tmp}/e1-alphachip/docker"
    mkdir -p "$BUILD_DIR"
    echo "Using writable temporary AlphaChip build directory: $BUILD_DIR"
fi

set -- \
    --build-arg "tf_agents_version=$TF_AGENTS_PIP_VERSION" \
    --build-arg "dreamplace_version=$DREAMPLACE_PATTERN" \
    --build-arg "placement_cost_binary=plc_wrapper_main_$CT_VERSION" \
    --build-arg "python_version=$PYTHON_VERSION"

if [ "$GPU" = "1" ]; then
    set -- "$@" --build-arg "base_image=nvidia/cuda:11.8.0-cudnn8-devel-ubuntu22.04"
fi

echo "Building AlphaChip image: $IMAGE"
echo "Circuit Training checkout: $CT_DIR"
DOCKERFILE="$BUILD_DIR/ubuntu_circuit_training.r0.0.4"

if [ -n "${PLC_WRAPPER_MAIN:-}" ]; then
    cp "$PLC_WRAPPER_MAIN" "$BUILD_DIR/plc_wrapper_main"
else
    curl -L "$PLC_BINARY_URL" -o "$BUILD_DIR/plc_wrapper_main"
fi
chmod 555 "$BUILD_DIR/plc_wrapper_main"
if ! file "$BUILD_DIR/plc_wrapper_main" | grep -q 'ELF 64-bit'; then
    echo "Downloaded plc_wrapper_main is not a Linux x86-64 ELF binary."
    file "$BUILD_DIR/plc_wrapper_main"
    exit 1
fi

if [ -z "$DREAMPLACE_TARBALL" ]; then
    DREAMPLACE_TARBALL="$(find "$BUILD_DIR" -maxdepth 1 -name "dreamplace_*_${PYTHON_VERSION}.tar.gz" | sort | tail -n 1 || true)"
fi
if [ -n "$DREAMPLACE_TARBALL" ]; then
    cp "$DREAMPLACE_TARBALL" "$BUILD_DIR/dreamplace.tar.gz"
    HAVE_DREAMPLACE_TARBALL=1
else
    HAVE_DREAMPLACE_TARBALL=0
    echo "No local DREAMPlace tarball found."
    echo "If the upstream bucket is inaccessible, run: scripts/alphachip/build_dreamplace_from_source.sh"
    mkdir -p "$BUILD_DIR/dreamplace_stub/dreamplace"
    printf '%s\n' \
        '# Stub used only for std_cell_placer_mode=fd when upstream DREAMPlace tarballs are unavailable.' \
        'from . import Params, NonLinearPlace, PlaceDB' \
        > "$BUILD_DIR/dreamplace_stub/dreamplace/__init__.py"
    printf '%s\n' \
        'class Params:' \
        '  def __init__(self):' \
        '    pass' \
        > "$BUILD_DIR/dreamplace_stub/dreamplace/Params.py"
    printf '%s\n' \
        'class NonLinearPlace:' \
        '  def __init__(self, *args, **kwargs):' \
        '    raise RuntimeError("DREAMPlace is not installed; use --std_cell_placer_mode=fd or provide DREAMPLACE_TARBALL.")' \
        > "$BUILD_DIR/dreamplace_stub/dreamplace/NonLinearPlace.py"
    printf '%s\n' \
        'class PlaceDB:' \
        '  def __init__(self, *args, **kwargs):' \
        '    raise RuntimeError("DREAMPlace is not installed; use --std_cell_placer_mode=fd or provide DREAMPLACE_TARBALL.")' \
        > "$BUILD_DIR/dreamplace_stub/dreamplace/PlaceDB.py"
fi
export HAVE_DREAMPLACE_TARBALL

awk '
  BEGIN { have_dreamplace = ENVIRON["HAVE_DREAMPLACE_TARBALL"] }
  /RUN curl https:\/\/storage.googleapis.com\/rl-infra-public\/circuit-training\/placement_cost\/\$\{placement_cost_binary\}/ {
    print "COPY plc_wrapper_main /usr/local/bin/plc_wrapper_main"
    skip = 1
    next
  }
  skip && /-o  \/usr\/local\/bin\/plc_wrapper_main/ {
    skip = 0
    next
  }
  have_dreamplace == "1" && /RUN curl https:\/\/storage.googleapis.com\/rl-infra-public\/circuit-training\/dreamplace\/\$dreamplace_version/ {
    print "COPY dreamplace.tar.gz /dreamplace/dreamplace.tar.gz"
    skip = 1
    next
  }
  skip && /-o \/dreamplace\/dreamplace.tar.gz/ {
    skip = 0
    next
  }
  have_dreamplace != "1" && /RUN mkdir -p \/dreamplace/ {
    print "COPY dreamplace_stub /dreamplace"
    skip_dreamplace = 1
    next
  }
  skip_dreamplace && /RUN curl https:\/\/storage.googleapis.com\/rl-infra-public\/circuit-training\/dreamplace\/\$dreamplace_version/ {
    next
  }
  skip_dreamplace && /RUN tar xzf \/dreamplace\/dreamplace.tar.gz -C \/dreamplace\// {
    skip_dreamplace = 0
    next
  }
  {
    gsub("https://bootstrap.pypa.io/get-pip.py", "https://bootstrap.pypa.io/pip/3.9/get-pip.py")
    print
  }
' "$CT_DIR/tools/docker/ubuntu_circuit_training" > "$DOCKERFILE"

docker build --pull --tag "$IMAGE" \
    "$@" \
    -f "$DOCKERFILE" \
    "$BUILD_DIR"
