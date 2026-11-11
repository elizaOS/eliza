#!/usr/bin/env bash
# Fresh GitHub Ubuntu 24 x64 runners can lose access to Ubuntu's DNS domain.
# Use the Kernel Archives' Ubuntu mirror for the same signed release pockets.
# Persistent runners and ARM's ports archive retain their own configuration.
set -euo pipefail

if [ "${RUNNER_ENVIRONMENT:-}" != "github-hosted" ] \
  || [ "${RUNNER_OS:-}" != "Linux" ] \
  || [ "${RUNNER_ARCH:-}" != "X64" ]; then
  exit 0
fi

# shellcheck source=/dev/null
source /etc/os-release
if [ "$ID" != "ubuntu" ] || [ "$VERSION_ID" != "24.04" ]; then
  exit 0
fi

# Change only GitHub's known mirror URI. Keep suites, components, keyring, and
# all unrelated sources intact. This mirror also serves the security pocket.
sudo -n sed -i \
  -e 's#mirror+file:/etc/apt/apt-mirrors\.txt#https://mirrors.kernel.org/ubuntu/#g' \
  -e 's#http[s]*://azure\.archive\.ubuntu\.com/ubuntu/#https://mirrors.kernel.org/ubuntu/#g' \
  -e 's#http[s]*://archive\.ubuntu\.com/ubuntu/#https://mirrors.kernel.org/ubuntu/#g' \
  /etc/apt/sources.list.d/ubuntu.sources
echo "GitHub-hosted Ubuntu packages use the Kernel Archives mirror with Ubuntu's signing key"
