#!/usr/bin/env bash
# common.sh
# Common utilities for CLI test scripts

# Set ELIZAOS_CMD based on IS_NPM_TEST environment variable
# IS_NPM_TEST=false (default): Use locally built CLI
# IS_NPM_TEST=true: Use global elizaos command
setup_elizaos_cmd() {
    local script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    
    if [[ "${IS_NPM_TEST:-false}" == "true" ]]; then
        # Use global elizaos command for production validation
        export ELIZAOS_CMD="${ELIZAOS_CMD:-elizaos}"
    else
        # Use locally built CLI for development/CI
        export ELIZAOS_CMD="${ELIZAOS_CMD:-bun run $(cd "$script_dir/../dist" && pwd)/index.js}"
    fi
}

# Set CREATE_ELIZA_CMD for create-eliza tests
setup_create_eliza_cmd() {
    local script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    
    if [[ "${IS_NPM_TEST:-false}" == "true" ]]; then
        # Use npm create for production validation (the standard way)
        export CREATE_ELIZA_CMD="${CREATE_ELIZA_CMD:-npm create eliza}"
    else
        # Use locally built create-eliza for development/CI
        export CREATE_ELIZA_CMD="${CREATE_ELIZA_CMD:-bun run $(cd "$script_dir/../../create-eliza" && pwd)/index.mjs}"
    fi
}