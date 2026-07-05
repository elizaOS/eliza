#!/usr/bin/env bash
# pre-commit-gitleaks.sh — block secrets before they land in a commit.
#
# Installation is opt-in: run scripts/security/install-git-hooks.sh, which
# wires this into .git/hooks/pre-commit. Not auto-installed from postinstall
# (we don't silently rewrite contributors' git config).

set -euo pipefail

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks not found on PATH." >&2
  echo "  macOS:   brew install gitleaks" >&2
  echo "  Linux:   https://github.com/gitleaks/gitleaks/releases" >&2
  echo "  go:      go install github.com/gitleaks/gitleaks/v8@latest" >&2
  exit 1
fi

REPO_ROOT=$(git rev-parse --show-toplevel)
CONFIG="${REPO_ROOT}/.gitleaks.toml"

cfg_args=()
if [[ -f "$CONFIG" ]]; then
  cfg_args+=(--config "$CONFIG")
fi

# Scan staged changes only. `protect --staged` exits non-zero on any finding.
gitleaks protect --staged --redact --verbose "${cfg_args[@]}"
