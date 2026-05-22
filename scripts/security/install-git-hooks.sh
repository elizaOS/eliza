#!/usr/bin/env bash
# install-git-hooks.sh — one-shot installer for repo-local git hooks.
#
# Wires git-hooks/pre-commit-gitleaks.sh into .git/hooks/pre-commit. If a
# pre-commit hook already exists, the gitleaks check is appended (idempotent).
#
# Run manually. Not invoked from postinstall.

set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
HOOK_SRC="${REPO_ROOT}/git-hooks/pre-commit-gitleaks.sh"
HOOK_DST="${REPO_ROOT}/.git/hooks/pre-commit"
MARKER="# >>> elizaos gitleaks pre-commit >>>"
END_MARKER="# <<< elizaos gitleaks pre-commit <<<"

if [[ ! -f "$HOOK_SRC" ]]; then
  echo "error: $HOOK_SRC not found" >&2
  exit 1
fi
chmod +x "$HOOK_SRC"

mkdir -p "$(dirname "$HOOK_DST")"

if [[ -f "$HOOK_DST" ]] && grep -qF "$MARKER" "$HOOK_DST"; then
  echo "pre-commit hook already wired up (marker present)."
  exit 0
fi

if [[ ! -f "$HOOK_DST" ]]; then
  cat > "$HOOK_DST" <<'EOF'
#!/usr/bin/env bash
set -e
EOF
fi

cat >> "$HOOK_DST" <<EOF

${MARKER}
"${HOOK_SRC}" "\$@"
${END_MARKER}
EOF

chmod +x "$HOOK_DST"
echo "installed gitleaks pre-commit hook at $HOOK_DST"
