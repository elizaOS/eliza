#!/usr/bin/env bash
# Install the Playwright browsers a CI lane needs, tolerating the package
# contention that persistent runners create.
#
# `playwright install --with-deps` shells out to its own apt-get, so callers
# cannot pass it apt flags. On the self-hosted runners unattended-upgrades holds
# the dpkg frontend lock often enough that lanes failed with apt's exit code 100
# while nothing was actually wrong with them. This configures apt to wait for
# the lock and retries the install, because the lock holder is always transient.
#
# A browser install that still fails is a hard error: a lane that proceeds
# without its browser fails later with a far less obvious message.
set -euo pipefail

readonly APT_LOCK_TIMEOUT_SECONDS=600
readonly INSTALL_ATTEMPTS=3

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <browser> [browser...]" >&2
  exit 2
fi

if [ -n "${PLAYWRIGHT_INSTALL_CWD:-}" ]; then
  cd "$PLAYWRIGHT_INSTALL_CWD"
fi

# Mirrors the drop-in written by .github/actions/setup-bun-workspace so lanes
# that call this script without that composite get the same protection.
configure_apt_lock_timeout() {
  if printf 'DPkg::Lock::Timeout "%s";\n' "$APT_LOCK_TIMEOUT_SECONDS" \
    | sudo -n tee /etc/apt/apt.conf.d/99-eliza-ci-dpkg-lock-timeout >/dev/null 2>&1; then
    return 0
  fi
  echo "::warning::could not configure the apt dpkg lock timeout; relying on install retries alone"
}

run_with_retries() {
  local attempt=1
  while true; do
    if "$@"; then
      return 0
    fi
    if [ "$attempt" -ge "$INSTALL_ATTEMPTS" ]; then
      echo "::error::Playwright browser install failed after ${INSTALL_ATTEMPTS} attempts"
      return 1
    fi
    local backoff=$((attempt * 30))
    echo "::warning::Playwright browser install attempt ${attempt}/${INSTALL_ATTEMPTS} failed; retrying in ${backoff}s"
    sleep "$backoff"
    attempt=$((attempt + 1))
  done
}

install_args=()
apt_config=""
cleanup() {
  if [ -n "$apt_config" ]; then
    rm -f "$apt_config"
  fi
}
trap cleanup EXIT

if [ "${RUNNER_OS:-}" = "Linux" ] || [ "$(uname -s 2>/dev/null || true)" = "Linux" ]; then
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    configure_apt_lock_timeout
    if [ "${RUNNER_ENVIRONMENT:-}" = "github-hosted" ] && [ -f /etc/apt/sources.list.d/ubuntu.sources ]; then
      # Playwright needs Ubuntu libraries, not the runner image's third-party
      # Chrome repository. Scope apt to the signed Ubuntu sources for this
      # child process so unrelated repository publication failures cannot block
      # installation. The runner's apt configuration remains unchanged.
      apt_config=$(mktemp)
      printf '%s\n' \
        'Dir::Etc::sourcelist "/etc/apt/sources.list.d/ubuntu.sources";' \
        'Dir::Etc::sourceparts "-";' \
        "DPkg::Lock::Timeout \"$APT_LOCK_TIMEOUT_SECONDS\";" > "$apt_config"
      run_with_retries sudo -n env "APT_CONFIG=$apt_config" "PATH=$PATH" \
        "$(command -v bunx)" --no-install playwright install-deps "$@"
    else
      install_args+=("--with-deps")
    fi
  else
    echo "::notice::passwordless sudo unavailable; installing Playwright browsers without OS deps"
  fi
fi

run_with_retries bunx --no-install playwright install "${install_args[@]+"${install_args[@]}"}" "$@"
