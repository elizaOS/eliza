#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${ELIZA_KICAD_IMAGE:-eliza-chip-kicad-tools:local}"

APT_PACKAGES=(
  kicad
  kicad-libraries
  kicad-symbols
  kicad-footprints
  kicad-templates
  kicad-packages3d
  imagemagick
  librsvg2-bin
  python3-pip
  python3-venv
  python3-wxgtk4.0
)

LOCAL_ROOT="${ELIZA_KICAD_LOCAL_ROOT:-$ROOT/.tools/kicad-local}"
LOCAL_APT_CACHE="${ELIZA_KICAD_APT_CACHE:-$ROOT/.tools/apt-cache}"
LOCAL_APT_PACKAGES=(
  kicad
  kicad-libraries
  kicad-symbols
  kicad-footprints
  kicad-templates
  librsvg2-bin
  imagemagick-6.q16
  libglew2.2
  libocct-data-exchange-7.6t64
  libocct-foundation-7.6t64
  libocct-modeling-algorithms-7.6t64
  libocct-modeling-data-7.6t64
  libocct-ocaf-7.6t64
  libocct-visualization-7.6t64
  libfreeimage3
  libjxr0t64
  libraw23t64
  libopenexr-3-1-30
  libimath-3-1-29t64
  libodbc2
  libwxbase3.2-1t64
  libwxgtk3.2-1t64
  libwxgtk-gl3.2-1t64
  python3-wxgtk4.0
)

install_host_kicad_if_possible() {
  if command -v kicad-cli >/dev/null 2>&1; then
    echo "host kicad-cli already installed: $(kicad-cli version)"
    return 0
  fi

  if [ -f /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
  else
    ID=""
  fi

  if [ "${ID:-}" != "ubuntu" ] && [ "${ID:-}" != "debian" ]; then
    echo "host apt install skipped: unsupported OS ID '${ID:-unknown}'"
    return 1
  fi

  if [ "$(id -u)" -eq 0 ]; then
    echo "installing host KiCad packages with apt"
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y "${APT_PACKAGES[@]}"
    return 0
  fi

  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    echo "installing host KiCad packages with sudo apt"
    sudo apt-get update
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "${APT_PACKAGES[@]}"
    return 0
  fi

  echo "host apt install skipped: no root or passwordless sudo"
  return 1
}

install_python_render_deps() {
  if [ -x "$ROOT/.venv/bin/python" ]; then
    "$ROOT/.venv/bin/python" -m pip install --upgrade pip
    "$ROOT/.venv/bin/python" -m pip install pillow pyyaml
  elif command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import PIL
import yaml
print("host python render deps ok")
PY
  fi
}

run_local_tool() {
  local tool="$1"
  shift
  PATH="$LOCAL_ROOT/usr/bin:$PATH" \
    LD_LIBRARY_PATH="$LOCAL_ROOT/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}" \
    KICAD7_SYMBOL_DIR="$LOCAL_ROOT/usr/share/kicad/symbols" \
    KICAD7_FOOTPRINT_DIR="$LOCAL_ROOT/usr/share/kicad/footprints" \
    KICAD7_TEMPLATE_DIR="$LOCAL_ROOT/usr/share/kicad/template" \
    "$LOCAL_ROOT/usr/bin/$tool" "$@"
}

install_local_kicad_if_possible() {
  if [ -x "$LOCAL_ROOT/usr/bin/kicad-cli" ] \
    && run_local_tool kicad-cli version >/dev/null 2>&1 \
    && [ -x "$LOCAL_ROOT/usr/bin/rsvg-convert" ]; then
    echo "local KiCad already installed: $(run_local_tool kicad-cli version)"
    echo "local rsvg-convert: $(run_local_tool rsvg-convert --version | head -1)"
    return 0
  fi

  if ! command -v apt-get >/dev/null 2>&1 || ! command -v dpkg-deb >/dev/null 2>&1; then
    echo "local apt extraction skipped: apt-get or dpkg-deb missing"
    return 1
  fi

  mkdir -p "$LOCAL_APT_CACHE" "$LOCAL_ROOT"
  echo "installing user-local KiCad packages under $LOCAL_ROOT"
  (
    cd "$LOCAL_APT_CACHE"
    apt-get download "${LOCAL_APT_PACKAGES[@]}"
  )
  for deb in "$LOCAL_APT_CACHE"/*.deb; do
    dpkg-deb -x "$deb" "$LOCAL_ROOT"
  done

  echo "local kicad-cli: $(run_local_tool kicad-cli version)"
  echo "local rsvg-convert: $(run_local_tool rsvg-convert --version | head -1)"
}

install_host_kicad_if_possible || true
install_python_render_deps || true
install_local_kicad_if_possible || true

if command -v kicad-cli >/dev/null 2>&1; then
  echo "host kicad-cli: $(kicad-cli version)"
  command -v rsvg-convert >/dev/null 2>&1 || {
    echo "rsvg-convert missing after host setup; Docker fallback will provide it"
  }
else
  echo "host kicad-cli: not found"
fi

if [ -x "$LOCAL_ROOT/usr/bin/kicad-cli" ] && run_local_tool kicad-cli version >/dev/null 2>&1; then
  echo "kicad setup complete: local toolchain at $LOCAL_ROOT"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  cat >&2 <<'EOF'
docker is required for local repo-scoped KiCad setup on hosts without kicad-cli.
This machine does not provide passwordless sudo, so system apt/snap install
cannot be automated from this script.
EOF
  exit 127
fi

echo "building KiCad tools image: ${IMAGE}"
docker build -f "$ROOT/docker/kicad-tools.Dockerfile" -t "$IMAGE" "$ROOT"

echo "verifying KiCad tools image"
"$ROOT/scripts/kicad_run.sh" kicad-cli version
"$ROOT/scripts/kicad_run.sh" kibot --version
"$ROOT/scripts/kicad_run.sh" pcbdraw --version || true
"$ROOT/scripts/kicad_run.sh" python3 -c 'import PIL, yaml; print("python render deps ok")'

echo "kicad setup complete: ${IMAGE}"
