#!/bin/sh
# Source this file before running local gates from a fresh shell.
repo_root=$(CDPATH=; cd -- "$(dirname -- "$0")/.." && pwd)
export PATH="$repo_root/tools/bin:$repo_root/.venv/bin:$repo_root/external/oss-cad-suite/bin:$PATH"
export PDK_ROOT="${PDK_ROOT:-$repo_root/external/pdks}"
