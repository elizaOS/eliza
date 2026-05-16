#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 NubsCarson and contributors

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

output_dir="vm/output/bundle-metadata"
archive=0

while [ "$#" -gt 0 ]; do
    case "$1" in
        --output-dir)
            output_dir="$2"
            shift 2
            ;;
        --archive)
            archive=1
            shift
            ;;
        --)
            shift
            break
            ;;
        *)
            break
            ;;
    esac
done

metadata_arg="${output_dir#vm/}"
if [[ "$output_dir" = /* ]]; then
    metadata_arg="$output_dir"
    actual_output_dir="$output_dir"
else
    actual_output_dir="vm/$metadata_arg"
fi

vm/scripts/generate-bundle-metadata.py --output-dir "$metadata_arg" "$@"

if [ "$archive" -eq 1 ]; then
    archive_path="${actual_output_dir%/}.tar.gz"
    tar -C "$actual_output_dir" -czf "$archive_path" manifest.json package-metadata.json
    echo "wrote $archive_path"
fi
