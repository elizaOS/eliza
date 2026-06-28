#!/usr/bin/env sh
repo_dir="$(CDPATH=; cd -- "$(dirname -- "$0")/.." && pwd)"
export PATH="$repo_dir/external/oss-cad-suite/bin:$PATH"
echo "PATH updated for OSS CAD Suite at $repo_dir/external/oss-cad-suite/bin"
