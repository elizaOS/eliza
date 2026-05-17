#!/usr/bin/env bash
# Development-only helper for signing elizaOS Live update manifests.
#
# This creates a throwaway/local GPG signing home unless ELIZAOS_DEV_GNUPGHOME
# is set. It is intentionally not a production signing ceremony.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

usage() {
    cat >&2 <<'EOF'
Usage: scripts/dev-sign-update-manifest.sh MANIFEST.json [KEYRING_OUT]

Signs MANIFEST.json as MANIFEST.json.sig and exports the dev public keyring.

Environment:
  ELIZAOS_DEV_GNUPGHOME   GPG home to use/create (default: .dev-signing/gnupg)
  ELIZAOS_DEV_SIGNER      signer identity (default: elizaOS dev update <dev@elizaos.invalid>)
EOF
    exit 64
}

manifest="${1:-}"
keyring_out="${2:-}"
[ -n "${manifest}" ] || usage
[ -f "${manifest}" ] || {
    echo "manifest not found: ${manifest}" >&2
    exit 66
}

command -v gpg >/dev/null 2>&1 || {
    echo "gpg is required" >&2
    exit 69
}

gnupg_home="${ELIZAOS_DEV_GNUPGHOME:-${ROOT}/.dev-signing/gnupg}"
signer="${ELIZAOS_DEV_SIGNER:-elizaOS dev update <dev@elizaos.invalid>}"
keyring_out="${keyring_out:-$(dirname "${manifest}")/elizaos-dev-update.gpg}"

mkdir -p "${gnupg_home}"
chmod 700 "${gnupg_home}"
export GNUPGHOME="${gnupg_home}"

if ! gpg --batch --list-keys "${signer}" >/dev/null 2>&1; then
    gpg --batch --pinentry-mode loopback --passphrase '' \
        --quick-gen-key "${signer}" ed25519 sign 30d
fi

gpg --batch --yes --pinentry-mode loopback --passphrase '' \
    --detach-sign --output "${manifest}.sig" "${manifest}"
gpg --batch --export "${signer}" > "${keyring_out}"

printf 'signed: %s\n' "${manifest}.sig"
printf 'dev keyring: %s\n' "${keyring_out}"
printf 'warning: development key only; do not use for production releases\n' >&2
