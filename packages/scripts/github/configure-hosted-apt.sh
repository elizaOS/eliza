#!/usr/bin/env bash
# Fresh GitHub Ubuntu 24 x64 runners can repeatedly select an unavailable Azure
# mirror. Use Ubuntu's signed archive for the same configured release pockets.
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
# all unrelated sources intact. The archive also serves the security pocket.
sudo -n sed -i \
  -e 's#mirror+file:/etc/apt/apt-mirrors\.txt#https://archive.ubuntu.com/ubuntu/#g' \
  -e 's#http[s]*://azure\.archive\.ubuntu\.com/ubuntu/#https://archive.ubuntu.com/ubuntu/#g' \
  /etc/apt/sources.list.d/ubuntu.sources
echo "GitHub-hosted Ubuntu packages use the official Ubuntu archive"
