#!/bin/bash
set -e

# End-to-end upgrade test for plugin-sql migrations
# Tests that the database can be upgraded from one version to the next

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Running e2e upgrade tests..."
bun test "$SCRIPT_DIR/" --timeout 60000
