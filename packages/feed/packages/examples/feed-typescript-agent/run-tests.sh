#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Feed TypeScript Agent test runner"
echo "cwd: ${SCRIPT_DIR}"
echo

cd "${SCRIPT_DIR}"
bun test
