#!/usr/bin/env bash
# GitHub-hosted Ubuntu 24 x64 runners can lose access to an archive mirror.
# Use the Azure and Canonical mirrors for the same signed release and security
# pockets. The kernel.org mirror has repeatedly stalled apt during CI setup.
# Persistent runners and ARM's ports archive retain their own configuration.
set -euo pipefail

# Tests point this at a scratch tree; on runners it is empty.
root="${ELIZA_APT_TEST_ROOT:-}"

if [ -z "$root" ] && { [ "${RUNNER_ENVIRONMENT:-}" != "github-hosted" ] \
  || [ "${RUNNER_OS:-}" != "Linux" ] \
  || [ "${RUNNER_ARCH:-}" != "X64" ]; }; then
  exit 0
fi

# shellcheck source=/dev/null
source "$root/etc/os-release"
if [ "$ID" != "ubuntu" ] || [ "$VERSION_ID" != "24.04" ]; then
  exit 0
fi

# apt's mirror method tries these in order and moves on when one fails.
mirror_list=/etc/apt/eliza-ubuntu-mirrors.txt
printf '%s\n' \
  'http://azure.archive.ubuntu.com/ubuntu/' \
  'http://archive.ubuntu.com/ubuntu/' \
  | sudo -n tee "$root$mirror_list" >/dev/null

# Change only the known Ubuntu archive URIs, including the single-mirror URI an
# earlier version of this script wrote. Keep suites, components, keyring, and
# all unrelated sources intact. GitHub keeps a copy for Cloud Init. Update that
# existing template first so later startup configuration uses the same list.
source_files=()
cloud_template="$root/etc/cloud/templates/sources.list.ubuntu.deb822.tmpl"
if [ -f "$cloud_template" ]; then
  source_files+=("$cloud_template")
fi
source_files+=("$root/etc/apt/sources.list.d/ubuntu.sources")
sudo -n sed -i \
  -e "s#mirror+file:/etc/apt/apt-mirrors\\.txt#mirror+file:${mirror_list}#g" \
  -e "s#http[s]*://azure\\.archive\\.ubuntu\\.com/ubuntu/#mirror+file:${mirror_list}#g" \
  -e "s#http[s]*://archive\\.ubuntu\\.com/ubuntu/#mirror+file:${mirror_list}#g" \
  -e "s#https://mirrors\\.kernel\\.org/ubuntu/#mirror+file:${mirror_list}#g" \
  "${source_files[@]}"
# Playwright starts apt internally, so set timeouts for its spawned apt too.
# Hosted runners use IPv4 and do not need translated package indexes.
printf '%s\n' \
  'Acquire::ForceIPv4 "true";' \
  'Acquire::http::Timeout "20";' \
  'Acquire::https::Timeout "20";' \
  'Acquire::Retries "1";' \
  'Acquire::Languages "none";' \
  | sudo -n tee "$root/etc/apt/apt.conf.d/99-eliza-ci-network" >/dev/null
echo "GitHub-hosted Ubuntu packages fail over across signed Ubuntu mirrors"
