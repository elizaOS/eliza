#!/usr/bin/env bash
# Exercises pinned-checkout retries with a deterministic fake Git transport.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

mkdir -p "${TMP}/bin"
cat >"${TMP}/bin/git" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "init" ]; then
    mkdir -p "${3}/.git"
    exit 0
fi

if [ "${1:-}" != "-C" ]; then
    echo "unexpected fake git invocation: $*" >&2
    exit 64
fi

case "${3:-}" in
    remote|checkout)
        exit 0
        ;;
    fetch)
        count=0
        if [ -f "${GIT_FETCH_COUNT}" ]; then
            count="$(cat "${GIT_FETCH_COUNT}")"
        fi
        count=$((count + 1))
        printf '%s\n' "${count}" >"${GIT_FETCH_COUNT}"
        if [ "${count}" -le "${GIT_FETCH_FAILURES}" ]; then
            echo "fatal: upstream returned HTTP 503" >&2
            exit 128
        fi
        exit 0
        ;;
esac

echo "unexpected fake git invocation: $*" >&2
exit 64
SH
chmod +x "${TMP}/bin/git"

# shellcheck source=packages/os/linux/scripts/submodule-checkout.sh
source "${ROOT}/scripts/submodule-checkout.sh"

export PATH="${TMP}/bin:${PATH}"
export ELIZAOS_GIT_FETCH_RETRY_DELAY_SECONDS=0
export GIT_FETCH_COUNT="${TMP}/fetch-count"

export ELIZAOS_GIT_FETCH_ATTEMPTS=3
export GIT_FETCH_FAILURES=2
elizaos_fetch_pinned_git_ref \
    "${TMP}/eventual-checkout" \
    "https://git.example/repository.git" \
    "0123456789abcdef"
test "$(cat "${GIT_FETCH_COUNT}")" = "3"

: >"${GIT_FETCH_COUNT}"
export ELIZAOS_GIT_FETCH_ATTEMPTS=2
export GIT_FETCH_FAILURES=3
if elizaos_fetch_pinned_git_ref \
    "${TMP}/failed-checkout" \
    "https://git.example/repository.git" \
    "fedcba9876543210"; then
    echo "pinned checkout unexpectedly succeeded after retry exhaustion" >&2
    exit 1
fi
test "$(cat "${GIT_FETCH_COUNT}")" = "2"

echo "submodule checkout retry contract OK"
