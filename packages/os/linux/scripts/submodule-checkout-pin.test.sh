#!/usr/bin/env bash
# Proves materialized build inputs accept only the exact clean pinned commit.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

SOURCE="${TMP}/source"
TARGET="${TMP}/target"
git init -q "${SOURCE}"
git -C "${SOURCE}" config user.email iso-smoke@example.invalid
git -C "${SOURCE}" config user.name "ISO smoke test"
printf 'pinned content\n' >"${SOURCE}/content"
git -C "${SOURCE}" add content
git -C "${SOURCE}" commit -q -m pinned
PIN="$(git -C "${SOURCE}" rev-parse HEAD)"

# shellcheck source=packages/os/linux/scripts/submodule-checkout.sh
source "${ROOT}/scripts/submodule-checkout.sh"

materialize_submodule_checkout "${SOURCE}" "${TARGET}" "${SOURCE}" "${PIN}"
test "$(cat "${TARGET}/content")" = "pinned content"

printf 'dirty content\n' >>"${SOURCE}/content"
if materialize_submodule_checkout "${SOURCE}" "${TARGET}" "${SOURCE}" "${PIN}"; then
    echo "dirty pinned source unexpectedly materialized" >&2
    exit 1
fi
git -C "${SOURCE}" checkout -q -- content

printf 'next content\n' >"${SOURCE}/content"
git -C "${SOURCE}" add content
git -C "${SOURCE}" commit -q -m next
if materialize_submodule_checkout "${SOURCE}" "${TARGET}" "${SOURCE}" "${PIN}"; then
    echo "wrong pinned commit unexpectedly materialized" >&2
    exit 1
fi

if elizaos_verify_exact_clean_git_checkout "${SOURCE}" main; then
    echo "symbolic ref unexpectedly accepted as an exact pin" >&2
    exit 1
fi

echo "submodule exact-pin contracts passed"
