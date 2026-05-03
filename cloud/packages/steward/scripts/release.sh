#!/bin/bash
set -euo pipefail

# Usage: ./scripts/release.sh 0.4.0
# Bumps all publishable package versions, commits, tags, and pushes.
#
# What it does:
#   1. Updates version in packages/sdk, packages/react, packages/eliza-plugin
#   2. Updates cross-dependency versions (@stwd/sdk in react and eliza-plugin)
#   3. Commits with "chore: release vX.Y.Z"
#   4. Tags vX.Y.Z
#   5. Pushes branch + tags
#
# CI then handles: Docker build (GHCR), npm publish, GitHub Release creation.

VERSION="${1:-}"

if [[ -z "$VERSION" ]]; then
  echo "Usage: ./scripts/release.sh <version>"
  echo "Example: ./scripts/release.sh 0.4.0"
  exit 1
fi

# Validate semver format (loose check)
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: '$VERSION' is not a valid semver version"
  exit 1
fi

echo "Releasing v${VERSION}..."

# Publishable packages
PACKAGES=(sdk react eliza-plugin)

# Step 1: Bump version in each publishable package
for pkg in "${PACKAGES[@]}"; do
  PKG_JSON="packages/${pkg}/package.json"
  if [[ ! -f "$PKG_JSON" ]]; then
    echo "Warning: $PKG_JSON not found, skipping"
    continue
  fi
  echo "  Bumping $PKG_JSON -> $VERSION"
  # Use a temp file to avoid jq in-place issues
  jq --arg v "$VERSION" '.version = $v' "$PKG_JSON" > "${PKG_JSON}.tmp"
  mv "${PKG_JSON}.tmp" "$PKG_JSON"
done

# Step 2: Update cross-dependencies (@stwd/sdk version in react and eliza-plugin)
for pkg in react eliza-plugin; do
  PKG_JSON="packages/${pkg}/package.json"
  if [[ ! -f "$PKG_JSON" ]]; then
    continue
  fi
  # Check if package depends on @stwd/sdk
  if jq -e '.dependencies["@stwd/sdk"]' "$PKG_JSON" > /dev/null 2>&1; then
    echo "  Updating @stwd/sdk dependency in $PKG_JSON -> ^${VERSION}"
    jq --arg v "^${VERSION}" '.dependencies["@stwd/sdk"] = $v' "$PKG_JSON" > "${PKG_JSON}.tmp"
    mv "${PKG_JSON}.tmp" "$PKG_JSON"
  fi
done

# Step 3: Stage, commit, tag
git add packages/*/package.json
git commit -m "chore: release v${VERSION}" -m "" -m "Co-authored-by: wakesync <shadow@shad0w.xyz>"

# Step 4: Create annotated tag
git tag -a "v${VERSION}" -m "Release v${VERSION}"

# Step 5: Push branch and tags
BRANCH=$(git branch --show-current)
echo "Pushing ${BRANCH} + tags..."
git push origin "${BRANCH}" --tags

echo ""
echo "Done! v${VERSION} released."
echo "CI will now: build Docker image, publish npm packages, create GitHub Release."
