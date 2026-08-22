#!/usr/bin/env bash
# Reproducible, repository-local Linux developer bootstrap. Installs the exact
# Bun and Node pins under the ignored .cache directory, installs locked workspace
# dependencies, then runs the Linux capability doctor. It never invokes sudo.

set -euo pipefail

BUN_VERSION="1.3.14"
readonly BUN_VERSION
NODE_VERSION="24.15.0"
readonly NODE_VERSION
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly REPO_ROOT
readonly TOOLCHAIN_ROOT="${ELIZA_LINUX_TOOLCHAIN_DIR:-${REPO_ROOT}/.cache/linux-dev-toolchain}"

usage() {
  cat <<'EOF'
Usage: bash scripts/bootstrap-linux-dev.sh [--doctor-only] [--skip-install]

  --doctor-only  Do not download tools or install workspace dependencies.
  --skip-install Install/verify pinned tools, but skip `bun install`.

The script writes only generated tools below .cache (or
ELIZA_LINUX_TOOLCHAIN_DIR) and workspace install/build outputs. It performs no
privilege escalation or system-package mutation. The final doctor prints any
required apt work.
EOF
}

doctor_only=0
skip_install=0
for arg in "$@"; do
  case "${arg}" in
    --doctor-only) doctor_only=1 ;;
    --skip-install) skip_install=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "linux-bootstrap: unknown argument: ${arg}" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "linux-bootstrap: this bootstrap supports Linux only" >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64)
    readonly TOOLCHAIN_ARCH="x64"
    readonly BUN_ARCH="x64"
    readonly BUN_ARCHIVE_SHA256="951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f"
    readonly NODE_ARCHIVE_SHA256="472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6"
    ;;
  aarch64|arm64)
    readonly TOOLCHAIN_ARCH="arm64"
    readonly BUN_ARCH="aarch64"
    readonly BUN_ARCHIVE_SHA256="a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b"
    readonly NODE_ARCHIVE_SHA256="f3d5a797b5d210ce8e2cb265544c8e482eaedcb8aa409a8b46da7e8595d0dda0"
    ;;
  *)
    echo "linux-bootstrap: unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

readonly BUN_DIR="${TOOLCHAIN_ROOT}/bun-${BUN_VERSION}-${TOOLCHAIN_ARCH}"
readonly NODE_DIR="${TOOLCHAIN_ROOT}/node-${NODE_VERSION}-${TOOLCHAIN_ARCH}"
readonly BUN_BIN="${BUN_DIR}/bin/bun"
readonly NODE_BIN="${NODE_DIR}/bin/node"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "linux-bootstrap: required command is missing: $1" >&2
    exit 1
  fi
}

download_verified() {
  local url="$1"
  local expected="$2"
  local destination="$3"
  curl --fail --location --retry 3 --output "${destination}" "${url}"
  printf '%s  %s\n' "${expected}" "${destination}" | sha256sum --check --status
}

install_bun() {
  if [[ -x "${BUN_BIN}" ]] && [[ "$(${BUN_BIN} --version)" == "${BUN_VERSION}" ]]; then
    return
  fi
  local staging
  staging="$(mktemp -d "${TOOLCHAIN_ROOT}/.bun.XXXXXX")"
  trap 'rm -rf -- "${staging}"' RETURN
  download_verified \
    "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${BUN_ARCH}.zip" \
    "${BUN_ARCHIVE_SHA256}" \
    "${staging}/bun.zip"
  unzip -q "${staging}/bun.zip" -d "${staging}/unpacked"
  mkdir -p "${BUN_DIR}/bin"
  install -m 0755 "$(find "${staging}/unpacked" -type f -name bun -print -quit)" "${BUN_BIN}"
  rm -rf -- "${staging}"
  trap - RETURN
}

install_node() {
  if [[ -x "${NODE_BIN}" ]] && [[ "$(${NODE_BIN} --version)" == "v${NODE_VERSION}" ]]; then
    return
  fi
  local staging node_archive_arch
  node_archive_arch="${TOOLCHAIN_ARCH}"
  staging="$(mktemp -d "${TOOLCHAIN_ROOT}/.node.XXXXXX")"
  trap 'rm -rf -- "${staging}"' RETURN
  download_verified \
    "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_archive_arch}.tar.xz" \
    "${NODE_ARCHIVE_SHA256}" \
    "${staging}/node.tar.xz"
  mkdir -p "${NODE_DIR}"
  tar -xJf "${staging}/node.tar.xz" --strip-components=1 -C "${NODE_DIR}"
  rm -rf -- "${staging}"
  trap - RETURN
}

if (( doctor_only == 0 )); then
  require_command curl
  require_command sha256sum
  require_command tar
  require_command unzip
  mkdir -p "${TOOLCHAIN_ROOT}"
  install_bun
  install_node
fi

export PATH="${BUN_DIR}/bin:${NODE_DIR}/bin:${PATH}"

if [[ ! -x "${BUN_BIN}" || ! -x "${NODE_BIN}" ]]; then
  echo "linux-bootstrap: pinned toolchain is absent; rerun without --doctor-only" >&2
  exit 1
fi

echo "linux-bootstrap: Bun $(bun --version), Node $(node --version)"
if (( doctor_only == 0 && skip_install == 0 )); then
  cd -- "${REPO_ROOT}"
  bun install --frozen-lockfile
fi

cd -- "${REPO_ROOT}"
exec bun scripts/linux-dev-doctor.mjs --strict
