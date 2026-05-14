#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 NubsCarson and contributors
#
# Verify a downloaded Claude Code binary against Anthropic's signed
# release manifest. Called from the iso-cache-cli Justfile recipe so
# corrupt or tampered cache entries are caught before they end up in
# the ISO.
#
# Usage: verify-claude-sha256.sh <version> <binary-path>
# Exits 0 on match, nonzero with a message otherwise.

set -euo pipefail

version="${1:?missing version arg}"
binary="${2:?missing binary path arg}"

if [ ! -s "$binary" ]; then
    echo "ERROR: $binary does not exist or is empty" >&2
    exit 1
fi

manifest_url="https://downloads.claude.ai/claude-code-releases/${version}/manifest.json"

expected="$(curl -fsSL "$manifest_url" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["platforms"]["linux-x64"]["checksum"])')"

if [ -z "$expected" ]; then
    echo "ERROR: could not extract linux-x64 checksum from $manifest_url" >&2
    exit 1
fi

actual="$(sha256sum "$binary" | cut -d' ' -f1)"

if [ "$expected" != "$actual" ]; then
    echo "ERROR: claude binary sha256 mismatch" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    echo "  file:     $binary" >&2
    exit 1
fi

echo "==> claude sha256 ok: $actual"
