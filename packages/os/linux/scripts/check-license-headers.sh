#!/usr/bin/env bash
# License-header gate. Every Rust and TypeScript source file we own must
# carry a SPDX identifier. The required identifier depends on the file's
# location:
#
#   third-party/tails/**          → must be GPL-3.0-or-later
#   everywhere else (our code)    → must be Apache-2.0
#
# Generated files (target/, dist/, node_modules/) are excluded by find
# pruning. Why two licenses: per locked decision #22 in PLAN.md, the
# project team cleared use of GPL-3 code from upstream Tails. The
# combined live ISO is GPL-3 in distributable form; our own new code
# stays Apache-2.0.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

apache_marker="SPDX-License-Identifier: Apache-2.0"
gpl_marker="SPDX-License-Identifier: GPL-3.0-or-later"

missing=0
mislicensed=0

while IFS= read -r -d '' file; do
    rel="${file#./}"
    head_text="$(head -3 "$file")"

    if [[ "$rel" == third-party/tails/* ]]; then
        if grep -qF "$gpl_marker" <<<"$head_text"; then
            continue
        fi
        if grep -qF "$apache_marker" <<<"$head_text"; then
            echo "third-party/tails file must be GPL-3.0-or-later: $rel" >&2
            mislicensed=$((mislicensed + 1))
        else
            echo "missing SPDX header: $rel" >&2
            missing=$((missing + 1))
        fi
    else
        if grep -qF "$apache_marker" <<<"$head_text"; then
            continue
        fi
        if grep -qF "$gpl_marker" <<<"$head_text"; then
            echo "non-third-party file must NOT be GPL: $rel (move under third-party/tails/ or relicense)" >&2
            mislicensed=$((mislicensed + 1))
        else
            echo "missing SPDX header: $rel" >&2
            missing=$((missing + 1))
        fi
    fi
done < <(
    find . \
        \( -path ./target -o -path ./node_modules -o -path '*/node_modules' \
           -o -path '*/target' -o -path ./vm/disk-base.qcow2 -o -path ./vm/snapshots \
           -o -path './vm/disk-base/.cache' -o -path ./LICENSES -o -path ./.git \
           -o -path './live-build/chroot' -o -path './live-build/cache' \
           -o -path './live-build/binary' -o -path './live-build/bootstrap' \) -prune \
        -o \( -name '*.rs' -o -name '*.ts' -o -name '*.tsx' \) \
        -type f -print0 2>/dev/null
)

if [ "$missing" -gt 0 ] || [ "$mislicensed" -gt 0 ]; then
    echo "FAIL: $missing missing header(s), $mislicensed mislicensed file(s)." >&2
    exit 1
fi

echo "OK: license-header gate passed (Apache-2.0 outside third-party/tails/, GPL-3.0-or-later inside)"
