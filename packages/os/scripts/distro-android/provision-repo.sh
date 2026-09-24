#!/usr/bin/env bash
set -euo pipefail

# AOSP's repo launcher is executable source code. Keep the launcher itself
# immutable; repo then resolves the manifest-pinned implementation.
readonly repo_url="https://storage.googleapis.com/git-repo-downloads/repo"
readonly repo_sha256="1211b57b57e4122a9c546295a59b37d24068f1164d0e87bef096d5323c413e4f"
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
