#!/usr/bin/env bash
# Shared pinned-checkout helpers for elizaOS Live build scripts.

elizaos_submodule_checkout_fetched=0

elizaos_dir_has_entries() {
    local checkout_path="$1"
    [ -d "${checkout_path}" ] && find "${checkout_path}" -mindepth 1 -maxdepth 1 -print -quit | grep -q .
}

elizaos_remove_path_recursive() {
    if [ "$#" -eq 0 ]; then
        echo "ERROR: elizaos_remove_path_recursive requires at least one path." >&2
        return 1
    fi

    if [ -n "${RM_PATH_RECURSIVE_SCRIPT:-}" ] &&
        [ -r "${RM_PATH_RECURSIVE_SCRIPT}" ] &&
        command -v node >/dev/null 2>&1; then
        node "${RM_PATH_RECURSIVE_SCRIPT}" "$@"
        return
    fi

    if ! command -v python3 >/dev/null 2>&1; then
        echo "ERROR: python3 is required for recursive cleanup in this build environment." >&2
        return 127
    fi

    python3 - "$@" <<'PY'
import errno
import os
import shutil
import sys
import time

retryable = {errno.EBUSY, errno.ENOTEMPTY, errno.EPERM}
cwd = os.path.abspath(os.getcwd())


def resolve_target(raw):
    if raw == "":
        raise ValueError("Refusing to remove an empty path argument.")

    target = os.path.abspath(raw)
    if target == cwd:
        raise ValueError(f"Refusing to remove the current working directory: {raw}")
    if os.path.dirname(target) == target:
        raise ValueError(f"Refusing to remove a filesystem root: {raw}")

    return target


def remove_target(target):
    for attempt in range(10):
        try:
            if os.path.islink(target) or not os.path.isdir(target):
                os.unlink(target)
            else:
                shutil.rmtree(target)
            return
        except FileNotFoundError:
            return
        except OSError as error:
            if error.errno in retryable and attempt < 9:
                time.sleep(0.1 * (attempt + 1))
                continue
            raise


for arg in sys.argv[1:]:
    remove_target(resolve_target(arg))
PY
}

elizaos_fetch_pinned_git_ref() {
    local checkout_path="$1"
    local url="$2"
    local ref="$3"

    elizaos_remove_path_recursive "${checkout_path}"
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
    elizaos_remove_path_recursive "${target_path}"
    if elizaos_dir_has_entries "${source_path}"; then
        cp -r "${source_path}" "${target_path}"
        return
    fi

    echo "no ${source_path} - fetching ${ref}"
    elizaos_fetch_pinned_git_ref "${target_path}" "${url}" "${ref}"
    elizaos_submodule_checkout_fetched=1
}
