#!/usr/bin/env bash
#
# squash-history.sh
#
# Compress the entire commit history of a branch into a single root commit
# while preserving attribution in CONTRIBUTIONS.md.
#
# Steps:
#   1. Verify working tree is clean (no uncommitted or untracked changes).
#   2. Create a backup branch <SOURCE>-full-commits at the current tip.
#   3. Generate CONTRIBUTIONS.md: one line per commit, oldest first, linked to GitHub.
#   4. Create an orphan branch <SOURCE>-squashed.
#   5. Stage the existing working tree + CONTRIBUTIONS.md and make a single root commit.
#
# After running:
#   - <SOURCE>-full-commits is an exact copy of the source branch (untouched history).
#   - <SOURCE>-squashed has one commit containing the same files plus CONTRIBUTIONS.md.
#   - The source branch itself is unchanged.
#
# To replace the source branch you must force-push manually after review.
#
# Usage:
#   scripts/squash-history.sh [SOURCE_BRANCH] [--yes]
#     SOURCE_BRANCH defaults to the currently checked-out branch.
#     --yes skips the confirmation prompt.

set -euo pipefail

SOURCE_BRANCH=""
ASSUME_YES="0"
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES="1" ;;
    --help|-h)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    -*)
      echo "Unknown flag: $arg" >&2
      exit 2
      ;;
    *)
      if [ -z "$SOURCE_BRANCH" ]; then
        SOURCE_BRANCH="$arg"
      else
        echo "Unexpected positional argument: $arg" >&2
        exit 2
      fi
      ;;
  esac
done

if [ -z "$SOURCE_BRANCH" ]; then
  SOURCE_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
fi

BACKUP_BRANCH="${SOURCE_BRANCH}-full-commits"
SQUASH_BRANCH="${SOURCE_BRANCH}-squashed"
CONTRIB_FILE="CONTRIBUTIONS.md"

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# 1. Sanity checks ------------------------------------------------------------

if [ "$(git rev-parse --abbrev-ref HEAD)" != "$SOURCE_BRANCH" ]; then
  echo "Currently on $(git rev-parse --abbrev-ref HEAD), expected $SOURCE_BRANCH." >&2
  echo "Check out $SOURCE_BRANCH first or pass it as an argument." >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree has uncommitted changes. Commit or discard them first." >&2
  git status --short >&2
  exit 1
fi

if [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo "Untracked files present. Add or .gitignore them first:" >&2
  git ls-files --others --exclude-standard >&2
  exit 1
fi

SOURCE_SHA="$(git rev-parse "$SOURCE_BRANCH")"
if git rev-parse --verify --quiet "$BACKUP_BRANCH" >/dev/null; then
  EXISTING_BACKUP_SHA="$(git rev-parse "$BACKUP_BRANCH")"
  if ! git merge-base --is-ancestor "$EXISTING_BACKUP_SHA" "$SOURCE_SHA"; then
    echo "Backup branch '$BACKUP_BRANCH' is at $EXISTING_BACKUP_SHA, which is not an ancestor of $SOURCE_BRANCH ($SOURCE_SHA)." >&2
    echo "The backup must be reachable from $SOURCE_BRANCH (i.e. fast-forward only)." >&2
    exit 1
  fi
  BACKUP_ALREADY_EXISTS=1
else
  BACKUP_ALREADY_EXISTS=0
fi

if git rev-parse --verify --quiet "$SQUASH_BRANCH" >/dev/null; then
  echo "Branch '$SQUASH_BRANCH' already exists. Delete it first or pick a different name." >&2
  exit 1
fi

# Resolve GitHub URL for commit links
REMOTE_URL="$(git remote get-url origin 2>/dev/null || true)"
GH_URL=""
if [[ "$REMOTE_URL" =~ ^git@github\.com:(.+)$ ]]; then
  GH_URL="https://github.com/${BASH_REMATCH[1]%.git}"
elif [[ "$REMOTE_URL" =~ ^https://github\.com/(.+)$ ]]; then
  GH_URL="https://github.com/${BASH_REMATCH[1]%.git}"
fi

COMMIT_COUNT="$(git rev-list --count "$SOURCE_BRANCH")"

echo "Source branch:  $SOURCE_BRANCH ($COMMIT_COUNT commits)"
echo "Backup branch:  $BACKUP_BRANCH"
echo "Squash branch:  $SQUASH_BRANCH"
echo "GitHub URL:     ${GH_URL:-<no link, hashes will be inline code>}"
echo
echo "This will:"
echo "  - create $BACKUP_BRANCH at the current tip of $SOURCE_BRANCH"
echo "  - generate $CONTRIB_FILE with $COMMIT_COUNT entries"
echo "  - create orphan branch $SQUASH_BRANCH with the current tree as a single root commit"
echo "$SOURCE_BRANCH itself is not modified by this script."
echo

if [ "$ASSUME_YES" != "1" ]; then
  read -r -p "Proceed? [y/N] " confirm
  case "$confirm" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

# 2. Backup branch ------------------------------------------------------------

if [ "$BACKUP_ALREADY_EXISTS" = "1" ]; then
  echo "Backup branch $BACKUP_BRANCH already exists at $(git rev-parse --short "$BACKUP_BRANCH"); reusing."
else
  git branch "$BACKUP_BRANCH" "$SOURCE_BRANCH"
  echo "Created backup branch $BACKUP_BRANCH at $(git rev-parse --short "$BACKUP_BRANCH")"
fi

# 3. Generate CONTRIBUTIONS.md ------------------------------------------------

TMP_CONTRIB="$(mktemp -t squash-history.XXXXXX)"
trap 'rm -f "$TMP_CONTRIB"' EXIT

{
  echo "# Contributions"
  echo
  echo "Compressed commit history of \`$SOURCE_BRANCH\`. Each line is one commit, oldest first."
  echo
  if [ -n "$GH_URL" ]; then
    echo "Click a hash to view the original commit on GitHub. The full pre-squash history is preserved on branch \`$BACKUP_BRANCH\`."
  else
    echo "The full pre-squash history is preserved on branch \`$BACKUP_BRANCH\`."
  fi
  echo
} > "$TMP_CONTRIB"

if [ -n "$GH_URL" ]; then
  FORMAT="- [\`%h\`]($GH_URL/commit/%H) %ad %an: %s"
else
  FORMAT="- \`%h\` %ad %an: %s"
fi

echo "Generating commit log ($COMMIT_COUNT commits)..."
git log "$SOURCE_BRANCH" \
  --reverse \
  --abbrev=12 \
  --format="$FORMAT" \
  --date=short \
  >> "$TMP_CONTRIB"

GENERATED_LINES="$(grep -c '^- ' "$TMP_CONTRIB" || true)"
echo "Wrote $GENERATED_LINES commit lines"

# 4. Orphan branch ------------------------------------------------------------

git checkout --orphan "$SQUASH_BRANCH"

# --orphan keeps the working tree but resets the index in some git versions
# and not others; re-stage explicitly to be safe.
git add -A

mv "$TMP_CONTRIB" "$CONTRIB_FILE"
trap - EXIT
git add "$CONTRIB_FILE"

# 5. Single commit ------------------------------------------------------------

COMMIT_MSG="Squash history into single commit

The full $SOURCE_BRANCH history ($COMMIT_COUNT commits) is preserved on
branch $BACKUP_BRANCH and as a one-line-per-commit log in $CONTRIB_FILE."

git commit -m "$COMMIT_MSG"

NEW_COMMIT="$(git rev-parse --short HEAD)"

cat <<EOF

Done.

  Squashed branch:    $SQUASH_BRANCH ($NEW_COMMIT)
  Backup (full hist): $BACKUP_BRANCH

Verify with:
  git log --oneline $SQUASH_BRANCH         # should be a single commit
  git diff $SOURCE_BRANCH..$SQUASH_BRANCH -- ':!$CONTRIB_FILE'   # should be empty

When ready to publish:
  git push origin $BACKUP_BRANCH
  git push --force-with-lease origin $SQUASH_BRANCH:$SOURCE_BRANCH

EOF
