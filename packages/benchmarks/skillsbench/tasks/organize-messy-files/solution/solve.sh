#!/bin/bash
set -euo pipefail

# Run the organizer script to place each paper into its subject folder.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

python3 "${SCRIPT_DIR}/solution.py"
