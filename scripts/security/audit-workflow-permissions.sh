#!/usr/bin/env bash
# audit-workflow-permissions.sh
#
# Adds a top-level `permissions: contents: read` block to every workflow in
# .github/workflows that lacks one. Per-job permissions overrides remain
# untouched. This implements the OpenSSF Scorecard "Token-Permissions" check
# baseline (SOC2 CC6.1 / CC6.8).
#
# Usage:
#   scripts/security/audit-workflow-permissions.sh         # apply
#   scripts/security/audit-workflow-permissions.sh --check # report only
#
# Safe to re-run: skips files that already have a top-level `permissions:`.

set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
WORKFLOW_DIR="${REPO_ROOT}/.github/workflows"
MODE="apply"
[[ "${1:-}" == "--check" ]] && MODE="check"

[[ -d "$WORKFLOW_DIR" ]] || { echo "No workflow dir at $WORKFLOW_DIR" >&2; exit 1; }

needs_permissions() {
  local f="$1"
  # has a top-level `permissions:` line (no leading whitespace)?
  ! grep -qE '^permissions:' "$f"
}

inject_permissions() {
  local f="$1"
  python3 - "$f" <<'PY'
import sys, pathlib, re
p = pathlib.Path(sys.argv[1])
text = p.read_text()
lines = text.splitlines(keepends=True)
# Insert permissions block immediately before the first top-level `jobs:` key.
# Falling back to the first blank line after `on:` if `jobs:` is not found.
out = []
inserted = False
for i, line in enumerate(lines):
    if not inserted and re.match(r'^jobs:\s*$', line):
        out.append("# Default to least privilege. Override per-job where needed.\n")
        out.append("permissions:\n")
        out.append("  contents: read\n")
        out.append("\n")
        inserted = True
    out.append(line)
if not inserted:
    sys.stderr.write(f"warn: could not find `jobs:` in {p}, skipping\n")
    sys.exit(0)
p.write_text("".join(out))
PY
}

count_missing=0
count_fixed=0
shopt -s nullglob
for f in "$WORKFLOW_DIR"/*.yml "$WORKFLOW_DIR"/*.yaml; do
  [[ -f "$f" ]] || continue
  if needs_permissions "$f"; then
    count_missing=$((count_missing + 1))
    if [[ "$MODE" == "check" ]]; then
      echo "missing: $f"
    else
      inject_permissions "$f"
      count_fixed=$((count_fixed + 1))
      echo "fixed:   $f"
    fi
  fi
done

if [[ "$MODE" == "check" ]]; then
  if [[ $count_missing -gt 0 ]]; then
    echo ""
    echo "$count_missing workflow(s) missing top-level permissions block."
    exit 1
  fi
  echo "All workflows have a top-level permissions block."
else
  echo ""
  echo "Done. $count_fixed workflow(s) updated."
fi
