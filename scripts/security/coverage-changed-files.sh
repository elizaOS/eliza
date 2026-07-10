#!/usr/bin/env bash
# Enumerates the source and unit-test files a pull request actually changed, in
# the GITHUB_OUTPUT heredoc format the coverage-gate workflow consumes. It is
# invoked by .github/workflows/coverage-gate.yml as
# `coverage-changed-files.sh "$BASE" "$HEAD" >> "$GITHUB_OUTPUT"`, and lives as a
# standalone script (rather than inline YAML) so its path/diff boundary rules are
# regression-tested by coverage-changed-files.self-test.mjs against a real git
# repo.
#
# The diff is three-dot: it walks from `git merge-base BASE HEAD` to HEAD, so
# only files the branch itself touched enter the lane. A plain two-dot
# `BASE..HEAD` diff would count develop-side files the branch never touched as
# "changed" whenever the branch trails develop, dragging unrelated tests into the
# gate (issue #15845). Test files are bucketed into a Bun-native lane and a
# Vitest lane by which runner they import; e2e/live suites and Android specs are
# excluded by both filename and directory so a `test/e2e/` path cannot slip into
# the fast unit lane.
set -euo pipefail

BASE=$1
HEAD=$2
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
NODE_SELF_TEST_MANIFEST="$SCRIPT_DIR/coverage-node-self-tests.txt"

# Fail fast: an empty merge-base means the two commits share no history (bad
# fetch depth / wrong refs), which would otherwise silently diff the entire tree.
MERGE_BASE=$(git merge-base "$BASE" "$HEAD")
if [ -z "$MERGE_BASE" ]; then
  echo "coverage-changed-files: no merge-base between $BASE and $HEAD" >&2
  exit 1
fi

# Excluded from both unit lanes: e2e/live suites (by filename *and* by a
# `test/e2e/` directory segment) and Android specs. These run in dedicated lanes
# and pull in heavy harnesses that the changed-file coverage gate must not.
is_excluded_test() {
  case "$1" in
    *.e2e.test.*|*.live.test.*|packages/app/test/android/*.android.spec.*) return 0 ;;
    */test/e2e/*|test/e2e/*|*/e2e/*.test.*|e2e/*.test.*) return 0 ;;
  esac
  return 1
}

changed_source() {
  {
    git diff --name-only --diff-filter=ACMRT "$MERGE_BASE" "$HEAD" -- \
      '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs' '*.mts' '*.cts' \
      | grep -vE '(^|/)(__tests__|test|tests)/|[.](test|spec)[.](ts|tsx|js|jsx|mjs|cjs|mts|cts)$|(^|/)vitest[.]config[.](ts|js|mts|mjs|cts|cjs)$' || true
  } \
    | while IFS= read -r file; do
        [ -f "$file" ] || continue
        grep -Fxq "$file" "$NODE_SELF_TEST_MANIFEST" && continue
        echo "$file"
      done \
    | node --no-warnings "$SCRIPT_DIR/coverage-source-classifier.mjs"
}

changed_tests() {
  git diff --name-only "$MERGE_BASE" "$HEAD" -- \
    '*.test.ts' '*.test.tsx' '*.test.js' '*.test.jsx' '*.test.mjs' \
    '*.test.cjs' '*.test.mts' '*.test.cts' \
    '*.spec.ts' '*.spec.tsx' '*.spec.js' '*.spec.jsx' '*.spec.mjs' \
    '*.spec.cjs' '*.spec.mts' '*.spec.cts'
}

changed_node_self_tests() {
  git diff --name-only --diff-filter=ACMRT "$MERGE_BASE" "$HEAD" \
    | while IFS= read -r file; do
        [ -f "$file" ] || continue
        if grep -Fxq "$file" "$NODE_SELF_TEST_MANIFEST"; then
          echo "$file"
        fi
      done
}

echo 'files<<EOF'
changed_source
echo 'EOF'

echo 'node_tests<<EOF'
changed_node_self_tests
echo 'EOF'

echo 'bun_tests<<EOF'
changed_tests | while IFS= read -r file; do
  [ -f "$file" ] || continue
  is_excluded_test "$file" && continue
  if grep -Eq "from ['\"]vitest['\"]|require\\(['\"]vitest['\"]\\)" "$file"; then
    continue
  fi
  if grep -Eq "from ['\"]@playwright/test['\"]|require\\(['\"]@playwright/test['\"]\\)" "$file"; then
    continue
  fi
  echo "$file"
done
echo 'EOF'

echo 'vitest_tests<<EOF'
changed_tests | while IFS= read -r file; do
  [ -f "$file" ] || continue
  is_excluded_test "$file" && continue
  if grep -Eq "from ['\"]@playwright/test['\"]|require\\(['\"]@playwright/test['\"]\\)" "$file"; then
    continue
  fi
  if grep -Eq "from ['\"]vitest['\"]|require\\(['\"]vitest['\"]\\)" "$file"; then
    echo "$file"
  fi
done
echo 'EOF'
