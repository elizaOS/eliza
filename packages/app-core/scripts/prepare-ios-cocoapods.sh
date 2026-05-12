#!/usr/bin/env bash
set -euo pipefail

resolve_pod() {
  if command -v pod >/dev/null 2>&1; then
    return 0
  fi

  if command -v ruby >/dev/null 2>&1 && command -v gem >/dev/null 2>&1; then
    local ruby_user_dir
    ruby_user_dir="$(ruby -rrubygems -e 'print Gem.user_dir' 2>/dev/null || true)"
    if [ -n "${ruby_user_dir}" ] && [ -x "${ruby_user_dir}/bin/pod" ]; then
      export PATH="${ruby_user_dir}/bin:${PATH}"
      return 0
    fi
  fi

  for candidate in /opt/homebrew/bin/pod /usr/local/bin/pod; do
    if [ -x "${candidate}" ]; then
      export PATH="$(dirname "${candidate}"):${PATH}"
      return 0
    fi
  done

  return 1
}

if ! resolve_pod || ! command -v pod >/dev/null 2>&1; then
  cat >&2 <<'EOF'
CocoaPods is required but 'pod' is not installed.

Install it with one of the local developer paths:
  brew install cocoapods
  gem install --user-install cocoapods

After a user-local gem install, make sure Ruby's user gem bin directory is on PATH.
This iOS local build path supports Xcode/developer sideloading; it does not
require or assume enterprise distribution.
EOF
  exit 127
fi

if [[ "${RUBYOPT:-}" != *"-rlogger"* ]]; then
  export RUBYOPT="-rlogger${RUBYOPT:+ ${RUBYOPT}}"
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
