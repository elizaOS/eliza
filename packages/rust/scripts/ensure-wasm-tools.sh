#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RUST_PACKAGE_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
TOOLS_ROOT="${RUST_PACKAGE_ROOT}/.cargo-tools"
TOOLS_BIN="${TOOLS_ROOT}/bin"
WASM_PACK_VERSION="0.14.0"

resolve_wasm_bindgen_version() {
  awk '
    $0 == "name = \"wasm-bindgen\"" { in_pkg = 1; next }
    in_pkg && /^version = / {
      gsub(/"/, "", $3)
      print $3
      exit
    }
    in_pkg && /^name = / { in_pkg = 0 }
  ' "${RUST_PACKAGE_ROOT}/Cargo.lock"
}

tool_version() {
  local cmd="$1"
  if [[ ! -x "${TOOLS_BIN}/${cmd}" ]]; then
    return 1
  fi
  "${TOOLS_BIN}/${cmd}" --version | awk 'NR == 1 { print $2 }'
}

ensure_cargo_tool() {
  local cmd="$1"
  local crate="$2"
  local version="$3"
  local current_version=""

  if current_version="$(tool_version "${cmd}")"; then
    if [[ "${current_version}" == "${version}" ]]; then
      return
    fi
  fi

  echo "[wasm-tools] Installing ${crate} ${version} into ${TOOLS_ROOT}"
  cargo install \
    --root "${TOOLS_ROOT}" \
    --locked \
    --force \
    --version "${version}" \
    "${crate}"
}

mkdir -p "${TOOLS_BIN}"
export PATH="${TOOLS_BIN}:${PATH}"

if ! rustup target list --installed | grep -qx 'wasm32-unknown-unknown'; then
  echo "[wasm-tools] Installing Rust target wasm32-unknown-unknown"
  rustup target add wasm32-unknown-unknown
fi

WASM_BINDGEN_VERSION="$(resolve_wasm_bindgen_version)"
if [[ -z "${WASM_BINDGEN_VERSION}" ]]; then
  echo "[wasm-tools] Failed to resolve wasm-bindgen version from Cargo.lock" >&2
  exit 1
fi

ensure_cargo_tool "wasm-pack" "wasm-pack" "${WASM_PACK_VERSION}"
ensure_cargo_tool "wasm-bindgen" "wasm-bindgen-cli" "${WASM_BINDGEN_VERSION}"
