#!/usr/bin/env bash
# Fail CI if any tracked file under packages/robot/ exceeds 5 MB, except for
# the known-source URDF / STL / MJCF XML directories (`assets/`).
#
# Gitignore cannot enforce file size. This gate is the enforcement point
# referenced from packages/robot/AGENTS.md §4 and README.md.

set -euo pipefail

MAX_BYTES=$((5 * 1024 * 1024))
PACKAGE_PREFIX="packages/robot/"
# Source-asset prefixes that are allowed to exceed the threshold. These
# host human-curated URDF / STL / MJCF XML for physical robots and are the
# only place large binaries belong in-tree.
ALLOW_PREFIXES=(
  "packages/robot/assets/"
)

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

violations=0

# `git ls-files -z` enumerates tracked files only; pipe through xargs to
# stat them in one shot. We post-filter for the package prefix and for the
# allow-list ourselves.
while IFS= read -r -d '' path; do
  case "$path" in
    "$PACKAGE_PREFIX"*) ;;
    *) continue ;;
  esac

  allow=0
  for prefix in "${ALLOW_PREFIXES[@]}"; do
    case "$path" in
      "$prefix"*) allow=1; break ;;
    esac
  done
  if [ "$allow" -eq 1 ]; then
    continue
  fi

  if [ ! -f "$path" ]; then
    continue
  fi

  size=$(stat -c%s "$path" 2>/dev/null || stat -f%z "$path" 2>/dev/null || echo 0)
  if [ "$size" -gt "$MAX_BYTES" ]; then
    printf 'large-binary: %s (%s bytes > %s)\n' "$path" "$size" "$MAX_BYTES" >&2
    violations=$((violations + 1))
  fi
done < <(git ls-files -z)

if [ "$violations" -gt 0 ]; then
  printf '\n%d file(s) exceed the 5 MB limit under %s.\n' "$violations" "$PACKAGE_PREFIX" >&2
  printf 'Move large binaries to object storage, or add a justified entry under assets/.\n' >&2
  exit 1
fi
