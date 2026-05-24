#!/bin/sh

BASE_BRANCHES="stable testing devel"

# Returns "" if in detached head
git_current_branch() {
    local git_ref
    if git_ref="$(git symbolic-ref HEAD 2>/dev/null)"; then
        echo "${git_ref#refs/heads/}"
    else
        echo ""
    fi
}

git_in_detached_head() {
    [ -z "$(git_current_branch)" ]
}

# Returns "" if ref does not exist
git_commit_from_ref() {
    git rev-parse --verify "${@}" 2>/dev/null || :
}

# shellcheck disable=SC2120
git_current_commit() {
    git_commit_from_ref "${@}" HEAD
}

# Returns "" if not a tag
git_tag_from_commit() {
    git describe --tags --exact-match "${1}" 2>/dev/null || :
}

# Returns "" if not on a tag
git_current_tag() {
    git_tag_from_commit "$(git_current_commit)"
}

# Try to describe what currently is checked out. Returns "" if we are
# in detached HEAD, otherwise, in order, the tag pointing to HEAD, or
# the current branch.
git_current_head_name() {
    local ret
    ret="$(git_current_tag)"
    if [ -z "${ret}" ]; then
        ret="$(git_current_branch)"
    fi
    echo "${ret}"
}

git_on_a_tag() {
    [ -n "$(git_current_tag)" ]
}

base_branch() {
    head -n1 config/base_branch
}

base_branches() {
    # shellcheck disable=SC2086
    echo ${BASE_BRANCHES}
}

on_base_branch() {
    for base_branch in $BASE_BRANCHES; do
        if [ "$(git_current_branch)" = "${base_branch}" ]; then
            return 0
        fi
    done

    return 1
}

# Returns the top commit ref of the base branch
git_base_branch_head() {
    git_commit_from_ref "${@}" origin/"$(base_branch)"
}

branch_name_to_suite() {
    local branch="$1"

    echo "$branch" | sed -e 's,[^.a-z0-9-],-,ig' | tr '[:upper:]' '[:lower:]'
}

fatal() {
    echo "E: $*" >&2
    exit 1
}

git_tag_exists() {
    local tag="$1"

    test -n "$(git tag -l "$tag")"
}

version_was_released() {
    local version="$1"

    version="$(echo "$version" | tr '~' '-')"
    git_tag_exists "$version"
}

version_in_changelog() {
    dpkg-parsechangelog | awk '/^Version: / { print $2 }'
}

previous_version_in_changelog() {
    dpkg-parsechangelog --offset 1 --count 1 | awk '/^Version: / { print $2 }'
}

# Input keyring contains concatenated armored certificates.  Join them
# into the standard form for communicating OpenPGP keyrings.
pgp_flatten_keyring() {
    ( # subshell for resource cleanup
        set -e
        set -u
        GNUPG_HOMEDIR="$(mktemp -d --tmpdir tmp.gnupg-XXXXXXXX)"
        trap 'rm --preserve-root=all -rf "${GNUPG_HOMEDIR}"' EXIT
        gpg --homedir "${GNUPG_HOMEDIR}" \
            --no-tty \
            --import "$1"
        gpg --homedir "${GNUPG_HOMEDIR}" \
            --no-tty \
            --export
    )
}

# Make it so that when this script is called, any function defined in
# this script can be invoked via arguments, e.g.:
#
# $ auto/scripts/utils.sh git_commit_from_ref 3.0-beta2
# eca83a88a9dd958b16b4d5b04fea3ea503a3815d
#
if grep -q __utils_sh_magic_5773fa52-0d1a-11e7-a606-0021ccc177a7 "${0}" && [ -n "${1}" ]; then
    if grep -q "^${1}() {$" "${0}"; then
        eval "\"\${@}\""
    else
        echo "unknown shell function: ${1}" >&2
        exit 1
    fi
fi
