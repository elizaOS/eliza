#!/usr/bin/env bash
# OS CI packages come from Ubuntu, not unrelated feeds on the hosted image.
set -euo pipefail
sources=/etc/apt/sources.list.d/ubuntu.sources
[[ -r "$sources" ]] || { echo "Expected Ubuntu 24.04 package sources" >&2; exit 1; }
(( $# > 0 )) || { echo "At least one package is required" >&2; exit 1; }
apt_args=(-o "Dir::Etc::sourcelist=$sources" -o "Dir::Etc::sourceparts=-"
  -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30)
sudo apt-get "${apt_args[@]}" update -qq
sudo apt-get "${apt_args[@]}" install -y --no-install-recommends "$@"
