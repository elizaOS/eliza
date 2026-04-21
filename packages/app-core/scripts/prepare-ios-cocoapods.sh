#!/usr/bin/env bash
set -euo pipefail

if ! command -v pod >/dev/null 2>&1; then
  echo "CocoaPods is required but 'pod' is not installed." >&2
  exit 127
fi

PODS_REPOS_DIR="${HOME}/.cocoapods/repos"
TRUNK_REPO_DIR="${PODS_REPOS_DIR}/trunk"
TRUNK_REPO_URL="https://cdn.cocoapods.org/"

mkdir -p "${PODS_REPOS_DIR}"

if [ -d "${TRUNK_REPO_DIR}/.git" ] || [ -f "${TRUNK_REPO_DIR}/CocoaPods-version.yml" ]; then
  echo "CocoaPods trunk repo already present at ${TRUNK_REPO_DIR}"
  exit 0
fi

if [ -e "${TRUNK_REPO_DIR}" ]; then
  echo "Removing incomplete CocoaPods trunk repo at ${TRUNK_REPO_DIR}"
  rm -rf "${TRUNK_REPO_DIR}"
fi

echo "Adding CocoaPods trunk repo from ${TRUNK_REPO_URL}"
if pod repo add-cdn --help >/dev/null 2>&1; then
  pod repo add-cdn trunk "${TRUNK_REPO_URL}"
else
  pod repo add trunk "${TRUNK_REPO_URL}"
fi
