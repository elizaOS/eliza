#!/usr/bin/env bash
# Install apt packages a CI lane needs, tolerating the package contention that
# persistent runners create.
#
# Sibling of install-playwright-browsers.sh for plain apt packages (ffmpeg for
# recording lanes). On the shared self-hosted hosts another job's apt-get or
# unattended-upgrades regularly holds /var/lib/apt/lists/lock, which
# `apt-get update` fails on with exit 100 even when DPkg::Lock::Timeout is
# configured — that timeout does not cover the lists lock. The lock holder is
# always transient, so retry the update+install with backoff instead.
#
# A package install that still fails is a hard error: a lane that proceeds
# without its package fails later with a far less obvious message.
set -euo pipefail

readonly APT_LOCK_TIMEOUT_SECONDS=600
readonly INSTALL_ATTEMPTS=5

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <package> [package...]" >&2
  exit 2
fi

if ! command -v sudo >/dev/null 2>&1 || ! sudo -n true 2>/dev/null; then
  echo "::error::passwordless sudo unavailable; cannot install apt packages: $*"
  exit 1
fi

# Mirrors the drop-in written by .github/actions/setup-bun-workspace so lanes
# that call this script without that composite get the same protection.
if ! printf 'DPkg::Lock::Timeout "%s";\n' "$APT_LOCK_TIMEOUT_SECONDS" \
  | sudo -n tee /etc/apt/apt.conf.d/99-eliza-ci-dpkg-lock-timeout >/dev/null 2>&1; then
  echo "::warning::could not configure the apt dpkg lock timeout; relying on retries alone"
fi

attempt=1
while true; do
  if sudo apt-get update \
    && sudo apt-get install -y -o DPkg::Lock::Timeout="$APT_LOCK_TIMEOUT_SECONDS" "$@"; then
    exit 0
  fi
  if [ "$attempt" -ge "$INSTALL_ATTEMPTS" ]; then
    echo "::error::apt package install failed after ${INSTALL_ATTEMPTS} attempts: $*"
    exit 1
  fi
  backoff=$((attempt * 30))
  echo "::warning::apt package install attempt ${attempt}/${INSTALL_ATTEMPTS} failed; retrying in ${backoff}s"
  sleep "$backoff"
  attempt=$((attempt + 1))
done
