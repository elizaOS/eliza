#!/usr/bin/env bash
set -euo pipefail

APP="clawd"
REPO="Solizardking/clawd-grok"
USER_DIR="${HOME}/.clawd"
INSTALL_DIR="${CLAWD_INSTALL_DIR:-${HOME}/.local/bin}"
INSTALL_METADATA="${USER_DIR}/install-metadata.json"
PATH_MARKER="# clawd"

function print_help() {
    echo "Usage: install.sh [VERSION]"
    echo ""
    echo "Install Clawd from GitHub Releases."
    echo ""
    echo "  curl -fsSL https://raw.githubusercontent.com/Solizardking/clawd-grok/newnew/install.sh | bash"
    echo ""
    echo "Install a specific version:"
    echo ""
    echo "  curl -fsSL https://raw.githubusercontent.com/Solizardking/clawd-grok/newnew/install.sh | bash -s v1.0.0"
    echo ""
    echo "Environment variables:"
    echo "  CLAWD_INSTALL_DIR    Install directory (default: ${HOME}/.local/bin)"
    echo ""
    echo "The installer:"
    echo "  1. Detects your OS and architecture"
    echo "  2. Downloads the appropriate Clawd binary"
    echo "  3. Installs to ${INSTALL_DIR}"
    echo "  4. Adds ${INSTALL_DIR} to PATH if needed"
    echo ""
    echo "Run 'clawd uninstall' to remove."
    exit 0
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    print_help
fi

# Detect platform
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "${ARCH}" in
    x86_64|amd64) ARCH="x64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *)
        echo "Error: Unsupported architecture: ${ARCH}"
        exit 1
        ;;
esac

case "${OS}" in
    darwin) TARGET="darwin-${ARCH}" ;;
    linux)  TARGET="linux-${ARCH}" ;;
    *)
        echo "Error: Unsupported OS: ${OS}"
        exit 1
        ;;
esac

VERSION="${1:-latest}"
ASSET_NAME="${APP}-${VERSION}-${TARGET}"
BINARY_NAME="${APP}"

echo "=== Clawd Installer ==="
echo "  OS:       ${OS}"
echo "  Arch:     ${ARCH}"
echo "  Target:   ${TARGET}"
echo "  Version:  ${VERSION}"
echo "  Install:  ${INSTALL_DIR}"
echo ""

# Create directories
mkdir -p "${INSTALL_DIR}"
mkdir -p "${USER_DIR}"

# Download binary
echo "Downloading Clawd ${VERSION} (${ASSET_NAME})..."

DOWNLOAD_URL=""
if [[ "${VERSION}" == "latest" ]]; then
    DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/${ASSET_NAME}"
else
    DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET_NAME}"
fi

TMP_DIR="$(mktemp -d)"
TMP_BIN="${TMP_DIR}/${BINARY_NAME}"
TMP_CHECKSUM="${TMP_DIR}/checksums.txt"

cleanup() {
    rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

# Download binary
echo "Downloading Clawd ${VERSION} (${ASSET_NAME})..."
HTTP_CODE=$(curl -fsSL -o "${TMP_BIN}" -w '%{http_code}' "${DOWNLOAD_URL}" 2>&1 || true)

if [[ "${HTTP_CODE}" != "200" ]]; then
    echo "Error: Failed to download Clawd binary (HTTP ${HTTP_CODE})"
    echo "  URL: ${DOWNLOAD_URL}"
    echo ""
    echo "This may be because the release hasn't been published yet."
    echo "Try building from source instead:"
    echo "  git clone https://github.com/${REPO}.git"
    echo "  cd clawd-grok"
    echo "  bun install && bun run build"
    exit 1
fi

# Verify checksum if available
CHECKSUM_URL=""
if [[ "${VERSION}" == "latest" ]]; then
    CHECKSUM_URL="https://github.com/${REPO}/releases/latest/download/clawd-checksums-sha256.txt"
else
    CHECKSUM_URL="https://github.com/${REPO}/releases/download/${VERSION}/clawd-checksums-sha256.txt"
fi

CHECKSUM_HTTP_CODE=$(curl -fsSL -o "${TMP_CHECKSUM}" -w '%{http_code}' "${CHECKSUM_URL}" 2>&1 || true)

if [[ "${CHECKSUM_HTTP_CODE}" == "200" ]]; then
    echo "Verifying checksum..."
    # Use grep to extract the expected hash for this asset, then verify
    EXPECTED_HASH=$(grep -F "${ASSET_NAME}" "${TMP_CHECKSUM}" | awk '{print $1}' | head -1)
    if [[ -n "${EXPECTED_HASH}" ]]; then
        if command -v shasum &>/dev/null; then
            ACTUAL_HASH=$(shasum -a 256 "${TMP_BIN}" | awk '{print $1}')
        elif command -v sha256sum &>/dev/null; then
            ACTUAL_HASH=$(sha256sum "${TMP_BIN}" | awk '{print $1}')
        else
            ACTUAL_HASH=""
        fi

        if [[ -z "${ACTUAL_HASH}" ]]; then
            echo "Warning: No sha256 tool found. Skipping checksum verification."
        elif [[ "${ACTUAL_HASH}" != "${EXPECTED_HASH}" ]]; then
            echo ""
            echo "SECURITY ERROR: Checksum verification FAILED!"
            echo "  Expected: ${EXPECTED_HASH}"
            echo "  Got:      ${ACTUAL_HASH}"
            echo ""
            echo "The downloaded binary does not match the published checksum."
            echo "This could indicate a compromised download or a network error."
            echo "Installation ABORTED for your safety."
            exit 1
        else
            echo "Checksum verified ✓"
        fi
    else
        echo "Warning: Asset '${ASSET_NAME}' not found in checksum file. Skipping verification."
    fi
else
    echo "Warning: No checksum file found (HTTP ${CHECKSUM_HTTP_CODE}). Skipping verification."
    echo "  Consider building from source for maximum security:"
    echo "  git clone https://github.com/${REPO}.git"
    echo "  cd clawd-grok"
    echo "  bun install && bun run build"
fi

chmod +x "${TMP_BIN}"

# Install
INSTALL_PATH="${INSTALL_DIR}/${BINARY_NAME}"
mv "${TMP_BIN}" "${INSTALL_PATH}"

echo "Installed: ${INSTALL_PATH}"

# Verify
if ! "${INSTALL_PATH}" version &>/dev/null; then
    echo "Warning: Installed binary does not respond to 'version'. It may not be a valid executable."
    echo "  Attempting to continue..."
fi

# Save metadata
INSTALLED_VERSION="${VERSION}"
if [[ "${VERSION}" == "latest" ]]; then
    INSTALLED_VERSION="$("${INSTALL_PATH}" version 2>/dev/null || echo "unknown")"
fi

TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

cat > "${INSTALL_METADATA}" <<JSON
{
  "version": "${INSTALLED_VERSION}",
  "installPath": "${INSTALL_PATH}",
  "installDir": "${INSTALL_DIR}",
  "installedAt": "${TIMESTAMP}",
  "target": "${TARGET}"
}
JSON

# Check PATH
IN_PATH=0
if [[ ":${PATH}:" == *":${INSTALL_DIR}:"* ]]; then
    IN_PATH=1
fi

if [[ "${IN_PATH}" -eq 0 ]]; then
    echo ""
    echo "NOTE: ${INSTALL_DIR} is not in your PATH."
    echo ""

    SHELL_CONFIG=""
    case "${SHELL:-}" in
        */zsh) SHELL_CONFIG="${HOME}/.zshrc" ;;
        */bash) SHELL_CONFIG="${HOME}/.bashrc" ;;
        */fish)
            SHELL_CONFIG="${HOME}/.config/fish/config.fish"
            mkdir -p "$(dirname "${SHELL_CONFIG}")"
            ;;
    esac

    if [[ -n "${SHELL_CONFIG}" ]]; then
        if ! grep -q "${PATH_MARKER}" "${SHELL_CONFIG}" 2>/dev/null; then
            echo "${PATH_MARKER}" >> "${SHELL_CONFIG}"
            echo "export PATH=\"${INSTALL_DIR}:\${PATH}\"" >> "${SHELL_CONFIG}"
            echo "Added to ${SHELL_CONFIG}"
        fi
    else
        echo "Add this to your shell config:"
        echo "  export PATH=\"${INSTALL_DIR}:\${PATH}\""
    fi
    echo ""
    echo "Restart your terminal or run:"
    echo "  export PATH=\"${INSTALL_DIR}:\${PATH}\""
    echo ""
fi

echo "Clawd ${INSTALLED_VERSION} installed successfully!"
echo ""
echo "Try it:"
echo "  clawd version"
echo "  clawd --help"
echo ""
echo "First-time setup:"
echo "  export SOLANA_RPC_URL=https://api.mainnet-beta.solana.com"
echo "  export AI_API_KEY=your-api-key"
echo "  clawd"
echo ""