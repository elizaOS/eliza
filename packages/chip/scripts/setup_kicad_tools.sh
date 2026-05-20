#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${ELIZA_KICAD_IMAGE:-eliza-chip-kicad-tools:local}"

APT_PACKAGES=(
  kicad
  kicad-libraries
  kicad-symbols
  kicad-footprints
  kicad-packages3d
  librsvg2-bin
  python3-pip
  python3-venv
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

install_host_kicad_if_possible || true
install_python_render_deps || true

if command -v kicad-cli >/dev/null 2>&1; then
  echo "host kicad-cli: $(kicad-cli version)"
  command -v rsvg-convert >/dev/null 2>&1 || {
    echo "rsvg-convert missing after host setup; Docker fallback will provide it"
  }
else
  echo "host kicad-cli: not found"
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
"$ROOT/scripts/kicad_docker.sh" kicad-cli version
"$ROOT/scripts/kicad_docker.sh" kibot --version
"$ROOT/scripts/kicad_docker.sh" pcbdraw --version || true
"$ROOT/scripts/kicad_docker.sh" python3 -c 'import PIL, yaml; print("python render deps ok")'

echo "kicad setup complete: ${IMAGE}"
