#!/usr/bin/env bash
# Source this file before running local gates from a fresh shell.
# Works when sourced (bash or zsh) or executed directly.
if [ -n "${BASH_SOURCE[0]:-}" ]; then
    _env_src="${BASH_SOURCE[0]}"
elif [ -n "${ZSH_VERSION:-}" ]; then
    # zsh: %x expands to the current script path when sourced
    _env_src="${(%):-%x}"
else
    _env_src="$0"
fi
repo_root=$(CDPATH= cd -- "$(dirname -- "$_env_src")/.." && pwd)
unset _env_src
export PATH="$repo_root/tools/bin:$repo_root/.venv/bin:$repo_root/external/oss-cad-suite/bin:$repo_root/external/xpack-riscv-none-elf-gcc-15.2.0-1/bin:$PATH"
export PDK_ROOT="${PDK_ROOT:-$repo_root/external/pdks}"
