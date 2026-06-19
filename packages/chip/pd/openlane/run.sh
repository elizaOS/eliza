#!/bin/bash
# Convenience wrapper for local OpenLane 2 runs from pd/openlane.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

mode="release"
config=""

while [ "$#" -gt 0 ]; do
    case "$1" in
        --release)
            mode="release"
            ;;
        --exploratory)
            mode="exploratory"
            ;;
        --smoke)
            mode="smoke"
            ;;
        --config)
            shift
            if [ "$#" -eq 0 ]; then
                echo "--config requires a path" >&2
                exit 2
            fi
            config="$1"
            ;;
        --help|-h)
            exec "$REPO_ROOT/scripts/run_openlane.sh" --help
            ;;
        *)
            echo "Unknown pd/openlane/run.sh argument: $1" >&2
            exec "$REPO_ROOT/scripts/run_openlane.sh" --help
            ;;
    esac
    shift
done

args=("--$mode")
if [ -n "$config" ]; then
    args+=("--config" "$config")
fi

exec "$REPO_ROOT/scripts/run_openlane.sh" "${args[@]}"
