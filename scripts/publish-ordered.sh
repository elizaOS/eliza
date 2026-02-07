#!/usr/bin/env bash
set -eo pipefail

# This script has moved to the eliza-workspace directory.
# Run from: /Users/shawwalters/eliza-workspace/publish-ordered.sh
#
# The publish script handles both repos:
#   1) Plugins from eliza-workspace/plugins/
#   2) Packages from eliza-ok/packages/
#   3) Computeruse from eliza-ok/packages/computeruse/

echo "ERROR: This script has moved."
echo ""
echo "Run the publish script from eliza-workspace:"
echo "  cd ../eliza-workspace && ./publish-ordered.sh"
echo ""
echo "Or for a dry run:"
echo "  cd ../eliza-workspace && ./publish-ordered.sh --dry-run"
exit 1
