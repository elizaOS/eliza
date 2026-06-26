#!/usr/bin/env bash
# Shared pinned-checkout helpers for elizaOS Live build scripts.

elizaos_submodule_checkout_fetched=0

elizaos_dir_has_entries() {
    local checkout_path="$1"
    [ -d "${checkout_path}" ] && find "${checkout_path}" -mindepth 1 -maxdepth 1 -print -quit | grep -q .
}

elizaos_fetch_pinned_git_ref() {
    local checkout_path="$1"
    local url="$2"
    local ref="$3"

    rm -rf "${checkout_path}"
    mkdir -p "$(dirname "${checkout_path}")"
    git init -q "${checkout_path}"
    git -C "${checkout_path}" remote add origin "${url}"
    git -C "${checkout_path}" fetch --depth 1 origin "${ref}"
    git -C "${checkout_path}" checkout -q FETCH_HEAD
}

ensure_submodule_checkout() {
    local checkout_path="$1"
    local url="$2"
    local ref="$3"

    elizaos_submodule_checkout_fetched=0
    if elizaos_dir_has_entries "${checkout_path}"; then
        return
    fi

    echo "missing ${checkout_path} - fetching ${ref} from ${url}"
    elizaos_fetch_pinned_git_ref "${checkout_path}" "${url}" "${ref}"
    elizaos_submodule_checkout_fetched=1
}

materialize_submodule_checkout() {
    local source_path="$1"
    local target_path="$2"
    local url="$3"
    local ref="$4"

    elizaos_submodule_checkout_fetched=0
    rm -rf "${target_path}"
    if elizaos_dir_has_entries "${source_path}"; then
        cp -r "${source_path}" "${target_path}"
        return
    fi

    echo "no ${source_path} - fetching ${ref}"
    elizaos_fetch_pinned_git_ref "${target_path}" "${url}" "${ref}"
    elizaos_submodule_checkout_fetched=1
}
