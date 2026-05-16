#!/usr/bin/env bash
# Target catalog tier: eliza-1-0_8b.
# This tier is target-only by design: DFlash is disabled in bundle metadata,
# no drafter is required, and no DFlash acceptance gate applies.

set -euo pipefail

echo "$(basename "$0") is disabled: eliza-1-0_8b is target-only and has no DFlash drafter." >&2
exit 2
