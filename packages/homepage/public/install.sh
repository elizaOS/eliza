#!/usr/bin/env bash
# ==============================================================================
#  Eliza desktop installer - macOS / Linux / WSL
#
#  curl -fsSL https://eliza.ai/install.sh | bash
#
#  What this script does:
#    1. Detects OS, architecture, and environment (WSL etc.)
#    2. Picks the right release asset for this platform
#    3. Downloads it from the latest GitHub release
#    4. Installs it to a sensible location:
#         - macOS:        /Applications/Eliza.app  (from .dmg)
#         - Linux .deb:   `dpkg -i` system-wide (when dpkg is available)
#         - Linux RPM:    `rpm -i` system-wide (when rpm is available)
#         - Linux fallb.: ~/.local/bin/Eliza (from .AppImage)
#
#  Environment variables:
#    ELIZA_VERSION=<tag>            Install a specific tag (default: latest)
#    ELIZA_INSTALL_DIR=<path>       Override AppImage install dir (default: ~/.local/bin)
#    ELIZA_NONINTERACTIVE=1         Skip all prompts (assume yes)
#    ELIZA_LINUX_FORMAT=deb|rpm|appimage   Force a specific Linux package format
#
#  For native Windows PowerShell, use install.ps1 instead.
# ==============================================================================

set -euo pipefail

# ----- Colors & helpers --------------------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

if [[ ! -t 1 ]] || [[ "${TERM:-}" == "dumb" ]]; then
  RED="" GREEN="" YELLOW="" BLUE="" CYAN="" BOLD="" DIM="" RESET=""
fi

info()    { printf "${BLUE}i${RESET}  %s\n" "$*"; }
success() { printf "${GREEN}+${RESET}  %s\n" "$*"; }
warn()    { printf "${YELLOW}!${RESET}  %s\n" "$*"; }
error()   { printf "${RED}x${RESET}  %s\n" "$*" >&2; }
step()    { printf "\n${BOLD}${CYAN}> %s${RESET}\n" "$*"; }

can_prompt() {
  [[ "${ELIZA_NONINTERACTIVE:-0}" != "1" ]] && [[ -t 0 ]]
}

confirm() {
  local prompt="${1:-Continue?}" default="${2:-Y}"
  if ! can_prompt; then
    [[ "$default" =~ ^[Yy] ]]
    return $?
  fi
  local yn
  if [[ "$default" =~ ^[Yy] ]]; then
    printf "  %s [Y/n] " "$prompt"
  else
    printf "  %s [y/N] " "$prompt"
  fi
  read -r yn
  yn="${yn:-$default}"
  [[ "$yn" =~ ^[Yy] ]]
}

# ----- System detection --------------------------------------------------------

DETECTED_OS=""
DETECTED_ARCH=""
DETECTED_ENV=""

detect_system() {
  case "$(uname -s)" in
    Darwin)                    DETECTED_OS="macos"   ;;
    Linux)                     DETECTED_OS="linux"   ;;
    MINGW*|MSYS*|CYGWIN*)
      error "This bash script does not support native Windows. Use install.ps1 instead:"
      error "  irm https://eliza.ai/install.ps1 | iex"
      exit 1
      ;;
    *)                         DETECTED_OS="unknown" ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64)              DETECTED_ARCH="x64"   ;;
    arm64|aarch64)             DETECTED_ARCH="arm64" ;;
    *)                         DETECTED_ARCH="$(uname -m)" ;;
  esac

  if [[ "$DETECTED_OS" == "linux" ]] && [[ -f /proc/version ]] \
     && grep -qi microsoft /proc/version 2>/dev/null; then
    DETECTED_ENV="wsl"
  fi

  local env_label=""
  [[ -n "$DETECTED_ENV" ]] && env_label=" / ${DETECTED_ENV}"
  info "System: ${DETECTED_OS} ${DETECTED_ARCH}${env_label}"
}

# ----- Download helper --------------------------------------------------------

FETCH_CMD=""

detect_fetch() {
  if command -v curl &>/dev/null; then
    FETCH_CMD="curl"
  elif command -v wget &>/dev/null; then
    FETCH_CMD="wget"
  else
    error "Neither curl nor wget found. Please install one first."
    exit 1
  fi
}

# Download URL to file path with a progress bar.
download_to() {
  local url="$1" dest="$2"
  if [[ "$FETCH_CMD" == "curl" ]]; then
    curl -fSL --progress-bar -o "$dest" "$url"
  else
    wget --show-progress -qO "$dest" "$url"
  fi
}

fetch_to() {
  local url="$1" dest="$2"
  if [[ "$FETCH_CMD" == "curl" ]]; then
    curl -fsSL -H 'Accept: application/vnd.github+json' -H 'User-Agent: eliza-installer' -o "$dest" "$url"
  else
    wget -qO "$dest" --header='Accept: application/vnd.github+json' --user-agent='eliza-installer' "$url"
  fi
}

# ----- Asset resolution -------------------------------------------------------

release_api_url() {
  local version="${ELIZA_VERSION:-latest}"
  if [[ "$version" == "latest" ]]; then
    printf 'https://api.github.com/repos/elizaOS/eliza/releases/latest'
  else
    printf 'https://api.github.com/repos/elizaOS/eliza/releases/tags/%s' "$version"
  fi
}

resolve_release_asset() {
  local platform_label="$1"
  shift

  if ! command -v python3 &>/dev/null; then
    error "python3 is required to inspect GitHub release assets."
    error "Open https://github.com/elizaOS/eliza/releases and download the ${platform_label} installer manually."
    exit 1
  fi

  local json_file
  json_file="$(mktemp)"
  if ! fetch_to "$(release_api_url)" "$json_file"; then
    rm -f "$json_file"
    error "Could not read the Eliza release metadata from GitHub."
    error "Open https://github.com/elizaOS/eliza/releases and download the ${platform_label} installer manually."
    exit 1
  fi

  local result
  result="$(python3 - "$json_file" "$@" <<'PY'
import json
import re
import sys

path = sys.argv[1]
patterns = [re.compile(pattern, re.I) for pattern in sys.argv[2:]]

with open(path, "r", encoding="utf-8") as f:
    release = json.load(f)

assets = release.get("assets") or []
for pattern in patterns:
    for asset in assets:
        name = asset.get("name") or ""
        url = asset.get("browser_download_url") or ""
        if pattern.search(name) and url:
            print(name)
            print(url)
            sys.exit(0)
sys.exit(1)
PY
  )"
  local status=$?
  rm -f "$json_file"

  if [[ $status -ne 0 || -z "$result" ]]; then
    error "No ${platform_label} installer is attached to the selected Eliza release yet."
    error "Open https://github.com/elizaOS/eliza/releases for the currently published assets."
    exit 1
  fi

  printf '%s\n' "$result"
}

resolve_macos_asset() {
  case "$DETECTED_ARCH" in
    arm64)
      resolve_release_asset "macOS Apple Silicon" \
        'macos[-_].*arm64.*\.dmg$' \
        'arm64.*\.dmg$'
      ;;
    x64)
      resolve_release_asset "macOS Intel" \
        'macos[-_].*(x64|x86_64|amd64).*\.dmg$' \
        'mac.*(x64|x86_64|amd64).*\.dmg$'
      ;;
    *)
      error "Unsupported macOS arch: $DETECTED_ARCH"
      exit 1
      ;;
  esac
}

resolve_linux_asset() {
  local format="${ELIZA_LINUX_FORMAT:-}"

  if [[ -z "$format" ]]; then
    if command -v dpkg &>/dev/null; then
      format="deb"
    elif command -v rpm &>/dev/null; then
      format="rpm"
    else
      format="appimage"
    fi
  fi

  case "$format" in
    deb)
      resolve_release_asset "Debian / Ubuntu" \
        'linux.*(x64|x86_64|amd64).*\.deb$' \
        '\.deb$'
      ;;
    rpm)
      resolve_release_asset "Fedora / RHEL" \
        'linux.*(x64|x86_64|amd64).*\.rpm$' \
        '\.rpm$'
      ;;
    appimage)
      resolve_release_asset "Linux AppImage" \
        'linux.*(x64|x86_64|amd64).*\.appimage$' \
        '\.appimage$'
      ;;
    *)
      error "Unknown ELIZA_LINUX_FORMAT: $format (expected deb|rpm|appimage)"
      exit 1
      ;;
  esac
}

# ----- macOS install ----------------------------------------------------------

install_macos() {
  local resolved asset url
  resolved="$(resolve_macos_asset)"
  asset="$(printf '%s\n' "$resolved" | sed -n '1p')"
  url="$(printf '%s\n' "$resolved" | sed -n '2p')"
  local tmpdir
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' EXIT

  step "Downloading ${asset}"
  download_to "$url" "${tmpdir}/${asset}"

  step "Mounting DMG"
  local mount_point
  mount_point="$(hdiutil attach "${tmpdir}/${asset}" -nobrowse -noautoopen 2>/dev/null \
    | grep '/Volumes/' | sed 's/.*\(\/Volumes\/.*\)/\1/' | tail -1)"

  if [[ -z "$mount_point" ]] || [[ ! -d "$mount_point" ]]; then
    error "Failed to mount DMG."
    exit 1
  fi

  local app_path
  app_path="$(find "$mount_point" -maxdepth 1 -name '*.app' -print -quit 2>/dev/null)"

  if [[ -z "$app_path" ]]; then
    error "No .app bundle found in the DMG."
    hdiutil detach "$mount_point" -quiet 2>/dev/null || true
    exit 1
  fi

  local app_name
  app_name="$(basename "$app_path")"

  if [[ -d "/Applications/${app_name}" ]]; then
    warn "Removing existing /Applications/${app_name}"
    rm -rf "/Applications/${app_name}" 2>/dev/null || sudo rm -rf "/Applications/${app_name}"
  fi

  step "Copying ${app_name} to /Applications"
  cp -R "$app_path" /Applications/ 2>/dev/null || sudo cp -R "$app_path" /Applications/
  xattr -cr "/Applications/${app_name}" 2>/dev/null \
    || sudo xattr -cr "/Applications/${app_name}" 2>/dev/null \
    || true

  hdiutil detach "$mount_point" -quiet 2>/dev/null || true

  success "${app_name} installed to /Applications"
  info "Launch it from Spotlight or your Applications folder."
}

# ----- Linux install ----------------------------------------------------------

install_linux_deb() {
  local file="$1"
  step "Installing .deb via dpkg"
  if ! sudo dpkg -i "$file"; then
    info "Resolving dependencies with apt-get -f install"
    sudo apt-get -f install -y
  fi
  success "eliza installed via dpkg"
}

install_linux_rpm() {
  local file="$1"
  step "Installing .rpm"
  if command -v dnf &>/dev/null; then
    sudo dnf install -y "$file"
  elif command -v yum &>/dev/null; then
    sudo yum install -y "$file"
  else
    sudo rpm -Uvh "$file"
  fi
  success "eliza installed via rpm"
}

install_linux_appimage() {
  local file="$1"
  local install_dir="${ELIZA_INSTALL_DIR:-$HOME/.local/bin}"
  mkdir -p "$install_dir"
  local target="${install_dir}/Eliza"
  cp "$file" "$target"
  chmod +x "$target"
  success "AppImage installed to ${target}"
  case ":$PATH:" in
    *":${install_dir}:"*) ;;
    *) info "Add ${install_dir} to PATH to launch as 'Eliza'." ;;
  esac
}

install_linux() {
  local resolved asset url
  resolved="$(resolve_linux_asset)"
  asset="$(printf '%s\n' "$resolved" | sed -n '1p')"
  url="$(printf '%s\n' "$resolved" | sed -n '2p')"
  local tmpdir
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' EXIT

  step "Downloading ${asset}"
  download_to "$url" "${tmpdir}/${asset}"

  case "$asset" in
    *.deb)      install_linux_deb "${tmpdir}/${asset}" ;;
    *.rpm)      install_linux_rpm "${tmpdir}/${asset}" ;;
    *.AppImage) install_linux_appimage "${tmpdir}/${asset}" ;;
  esac
}

# ----- Main -------------------------------------------------------------------

main() {
  printf "\n"
  printf "${BOLD}${CYAN}  +--------------------------------------+${RESET}\n"
  printf "${BOLD}${CYAN}  |       ${RESET}${BOLD}Eliza desktop installer${RESET}${BOLD}${CYAN}        |${RESET}\n"
  printf "${BOLD}${CYAN}  +--------------------------------------+${RESET}\n"
  printf "\n"

  for arg in "$@"; do
    case "$arg" in
      --help|-h)
        printf "Usage: install.sh\n\n"
        printf "Environment:\n"
        printf "  ELIZA_VERSION=<tag>             install a specific release tag\n"
        printf "  ELIZA_LINUX_FORMAT=deb|rpm|appimage   override Linux format\n"
        printf "  ELIZA_INSTALL_DIR=<path>        AppImage install dir (default ~/.local/bin)\n"
        printf "  ELIZA_NONINTERACTIVE=1          assume yes to all prompts\n"
        exit 0
        ;;
    esac
  done

  detect_fetch
  detect_system

  case "$DETECTED_OS" in
    macos)   install_macos ;;
    linux)   install_linux ;;
    *)
      error "Unsupported OS: $DETECTED_OS"
      exit 1
      ;;
  esac

  printf "\n"
  printf "${BOLD}${GREEN}  ======================================${RESET}\n"
  printf "${BOLD}${GREEN}  Installation complete!${RESET}\n"
  printf "${BOLD}${GREEN}  ======================================${RESET}\n"
  printf "\n"
  printf "  Docs: ${BLUE}https://eliza.how${RESET}\n"
  printf "\n"
}

main "$@"
