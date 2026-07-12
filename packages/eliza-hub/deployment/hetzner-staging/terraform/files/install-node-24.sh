#!/usr/bin/env bash
set -euo pipefail

if command -v node >/dev/null 2>&1 && [[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ]]; then
  exit 0
fi

install -d -m 0755 /etc/apt/keyrings
key_tmp="$(mktemp)"
trap 'rm -f "$key_tmp"' EXIT

curl --fail --silent --show-error --location \
  https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  --output "$key_tmp"
gpg --batch --yes --dearmor --output /etc/apt/keyrings/nodesource.gpg "$key_tmp"

printf '%s\n' \
  'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main' \
  >/etc/apt/sources.list.d/nodesource.list

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends nodejs
node --version
npm --version
