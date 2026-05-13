#!/usr/bin/env bash
# Clean up all claw-eval agent containers (e.g. after a crash or interrupted batch run).
# Usage: bash scripts/cleanup_containers.sh

set -euo pipefail

containers=$(docker ps -aq --filter "label=app=claw-eval")

if [ -z "$containers" ]; then
    echo "No claw-eval containers found."
    exit 0
fi

count=$(echo "$containers" | wc -l)
echo "$containers" | xargs docker rm -f
echo "Done. Removed $count claw-eval container(s)."
