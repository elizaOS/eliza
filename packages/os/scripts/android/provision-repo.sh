#!/usr/bin/env bash
set -euo pipefail

# AOSP's repo launcher is executable source code. Keep the launcher itself
# immutable; repo then resolves the manifest-pinned implementation.
# Launcher 2.69 (signed 2026-10-14). Before changing this digest, check the
# download against repo.asc with the Repo Maintainer key whose fingerprint
# source.android.com/docs/setup/start publishes
# (8BB9AD793E8E6153AF0F9A4416530D5E920F5C65).
readonly repo_url="https://storage.googleapis.com/git-repo-downloads/repo"
readonly repo_sha256="6ed2f6325705b6ea0af99466d6ebd04adec387a5b6a906cd77bc8c6da65123e5"
readonly destination="${1:?usage: provision-repo.sh DESTINATION}"

temporary_file="$(mktemp)"
trap 'rm -f -- "${temporary_file}"' EXIT
curl --fail --silent --show-error --location "${repo_url}" --output "${temporary_file}"
actual_sha256="$(sha256sum "${temporary_file}" | awk '{print $1}')"
if [[ "${actual_sha256}" != "${repo_sha256}" ]]; then
  printf 'repo launcher digest mismatch: expected %s, got %s\n' \
    "${repo_sha256}" "${actual_sha256}" >&2
  exit 1
fi
mkdir -p "$(dirname "${destination}")"
install -m 0755 "${temporary_file}" "${destination}"
