#!/usr/bin/env bash
# apply-branch-protection.sh
#
# Idempotently applies branch-protection rules to `main` and `develop` on the
# elizaOS repositories. Required for SOC2 CC8.1 (change management)
# and CC6.1 (logical access).
#
# Required token scopes:
#   - `admin:org`  (to read team membership for required reviewers)
#   - `repo`       (to write branch protection)
# Or a fine-grained PAT with "Administration: write" on the target repos.
#
# Usage:
#   GH_TOKEN=ghp_xxx ./scripts/security/apply-branch-protection.sh
#   ./scripts/security/apply-branch-protection.sh --repo elizaos/milady --branches main,develop
#
# Pre-flight checks: requires `gh` CLI authenticated with sufficient scopes.

set -euo pipefail

REPOS=("elizaos/milady" "elizaos/eliza")
BRANCHES=("main" "develop")

# Required status checks. These must match job NAMES (not workflow names) that
# run on PRs to the protected branch. Update as workflows evolve.
REQUIRED_CHECKS=(
  "typecheck"
  "test"
  "gitleaks"
)
# Optional checks — added if known to exist; CI publish/container scans live
# in different workflows on different repos, so we keep this list short and
# tighten per-repo via overrides below if needed.
OPTIONAL_CHECKS=(
  "container-scan"
)

usage() {
  cat <<EOF
Usage: $0 [--repo OWNER/NAME] [--branches BR1,BR2] [--dry-run]

Applies branch protection rules to the configured repos and branches.
Without --repo / --branches, defaults are: ${REPOS[*]} / ${BRANCHES[*]}.
EOF
}

DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)     REPOS=("$2"); shift 2 ;;
    --branches) IFS=',' read -ra BRANCHES <<< "$2"; shift 2 ;;
    --dry-run)  DRY_RUN=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh CLI not found. Install from https://cli.github.com/" >&2
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "error: gh not authenticated. Run 'gh auth login' or set GH_TOKEN." >&2
  exit 1
fi

# Build the JSON payload. We require code-owner review and at least one
# approving review. Status checks are required and must be up-to-date. Force
# pushes and deletions are denied. Signed commits and linear history are
# required. Conversation resolution required.
build_payload() {
  local contexts_json
  contexts_json=$(printf '"%s",' "${REQUIRED_CHECKS[@]}")
  contexts_json="[${contexts_json%,}]"

  cat <<JSON
{
  "required_status_checks": {
    "strict": true,
    "contexts": ${contexts_json}
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true,
    "required_approving_review_count": 1,
    "require_last_push_approval": true
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true,
  "lock_branch": false,
  "allow_fork_syncing": false,
  "required_signatures": true
}
JSON
}

apply_one() {
  local repo="$1" branch="$2"
  echo "==> ${repo}@${branch}"
  local payload
  payload=$(build_payload)
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "$payload"
    return 0
  fi
  # PUT /repos/{owner}/{repo}/branches/{branch}/protection
  echo "$payload" \
    | gh api -X PUT "repos/${repo}/branches/${branch}/protection" \
        -H "Accept: application/vnd.github+json" \
        --input - \
    > /dev/null
  # Signed commits is a separate endpoint historically; the unified payload
  # above already includes required_signatures, but enforce explicitly too
  # so older gh API versions still set it.
  gh api -X POST "repos/${repo}/branches/${branch}/protection/required_signatures" \
        -H "Accept: application/vnd.github+json" \
    > /dev/null 2>&1 || true
  echo "    ok"
}

main() {
  for repo in "${REPOS[@]}"; do
    for branch in "${BRANCHES[@]}"; do
      if gh api "repos/${repo}/branches/${branch}" >/dev/null 2>&1; then
        apply_one "$repo" "$branch"
      else
        echo "==> ${repo}@${branch} — branch not found, skipping"
      fi
    done
  done

  cat <<EOF

Done. Verify in the GitHub UI:
  https://github.com/<owner>/<repo>/settings/branches

Optional checks (not required by this script but recommended once they exist):
$(printf '  - %s\n' "${OPTIONAL_CHECKS[@]}")
EOF
}

main "$@"
