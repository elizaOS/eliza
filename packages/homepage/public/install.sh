#!/usr/bin/env bash
# ==============================================================================
#  Eliza desktop installer - macOS / Linux / WSL
#
#  curl -fsSL https://elizaos.github.io/install.sh | bash
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
      error "  irm https://elizaos.github.io/install.ps1 | iex"
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

# ----- Asset resolution -------------------------------------------------------

# Echo the GitHub release base URL for the configured version.
release_base_url() {
  local version="${ELIZA_VERSION:-latest}"
  if [[ "$version" == "latest" ]]; then
    printf 'https://github.com/elizaOS/eliza/releases/latest/download'
  else
    printf 'https://github.com/elizaOS/eliza/releases/download/%s' "$version"
  fi
}

# Echo the asset filename appropriate for the detected platform.
pick_macos_asset() {
  case "$DETECTED_ARCH" in
    arm64)  printf 'Eliza-mac-arm64.dmg' ;;
    x64)    printf 'Eliza-mac-x64.dmg' ;;
    *)
      error "Unsupported macOS arch: $DETECTED_ARCH"
      exit 1
      ;;
  esac
}

# Echo the Linux asset filename based on available package managers and
# ELIZA_LINUX_FORMAT override.
pick_linux_asset() {
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
    deb)      printf 'eliza_linux_amd64.deb' ;;
    rpm)      printf 'eliza-linux-x86_64.rpm' ;;
    appimage) printf 'Eliza-linux-x86_64.AppImage' ;;
    *)
      error "Unknown ELIZA_LINUX_FORMAT: $format (expected deb|rpm|appimage)"
      exit 1
      ;;
  esac
}

# ----- macOS install ----------------------------------------------------------

install_macos() {
  local asset
  asset="$(pick_macos_asset)"
  local url="$(release_base_url)/${asset}"
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
  local asset
  asset="$(pick_linux_asset)"
  local url="$(release_base_url)/${asset}"
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
  printf "  Docs: ${BLUE}https://elizaos.github.io${RESET}\n"
  printf "\n"
}

main "$@"
