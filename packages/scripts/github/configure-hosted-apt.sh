#!/usr/bin/env bash
# Fresh GitHub Ubuntu 24 x64 runners can lose access to one Ubuntu mirror (a
# Canonical DNS outage on 2026-11-11, then mirrors.kernel.org timing out on
# 2026-11-17). Point the Ubuntu sources at an ordered mirror list so apt fails
# over between hosts instead of depending on any single one. Every entry serves
# the same signed release and security pockets; the keyring is unchanged.
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
  'https://mirrors.kernel.org/ubuntu/' \
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
# Some mirrors publish IPv6 addresses and hosted runners have no IPv6 route, so
# a plain `apt-get update` in a later step failed with "Network is
# unreachable". Make every apt call on this runner use IPv4.
printf 'Acquire::ForceIPv4 "true";\n' \
  | sudo -n tee "$root/etc/apt/apt.conf.d/99-eliza-ci-force-ipv4" >/dev/null
echo "GitHub-hosted Ubuntu packages fail over across signed Ubuntu mirrors"
