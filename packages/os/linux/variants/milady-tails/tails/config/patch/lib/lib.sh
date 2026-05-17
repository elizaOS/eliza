# shellcheck shell=bash

# This shell library is meant to be sources by bash with
# `set -eu -o pipefail` and `shopt -s inherit_errexit`.

PATCH_COMMIT_FILE=/var/lib/tails-patch-commit
PATCHES_DIR=config/chroot_local-patches
LIB_DIR=$(realpath "$(dirname "${BASH_SOURCE[0]}")")
GIT_REPO=$(realpath "${LIB_DIR}/../../..")
INCLUDES_DIR="config/chroot_local-includes/"

if [ -z "${TARGET_ROOT:-}" ]; then
    TARGET_ROOT="/"
fi

run_with_plymouth_msg() {
    local msg="$1"
    shift
    plymouth --ping && plymouth display-message --text="${msg}"
    "$@"
    local ret=$?
    # `plymouth hide-message` doesn't work (#20401)
    plymouth --ping && plymouth display-message --text=""
    return $ret
}

branch() {
    git -C "${GIT_REPO}" rev-parse --abbrev-ref HEAD
}

modified_files() {
    local commit="$1"
    local dir="$2"
    git -C "${GIT_REPO}" --no-pager diff "${commit}" --name-only --no-renames -- "${dir}"
}

untracked_files() {
    local dir="$1"
    git -C "${GIT_REPO}" --no-pager ls-files --others --exclude-standard -- "${dir}"
}

untracked_and_modified_files() {
    local commit="$1"
    local dir="$2"
    local modified
    modified="$(modified_files "${commit}" "${dir}")"
    local untracked
    untracked="$(untracked_files "${dir}")"
    local all
    all="${modified}"$'\n'"${untracked}"
    # The grep -v '^$' is to remove empty lines
    echo "${all}" | sort -u | grep -v '^$' || true
}

tails_commit() {
    grep TAILS_GIT_COMMIT /etc/os-release | cut -d= -f2 | tr -d '"'
}

patch_base_ref() {
    # Get the base reference which the working tree should be compared to
    if [ -e "${PATCH_COMMIT_FILE}" ]; then
        cat "${PATCH_COMMIT_FILE}"
    else
        tails_commit
    fi
}

update_patch_base_ref() {
    # Store the current HEAD as the new base commit so that subsequent
    # executions of the script know what to compare to.
    # Note: This is not perfect because we copy/bind mount files from the
    # working tree, including files with uncommitted changes. By storing
    # HEAD as the base commit, if any uncommitted changes are reverted
    # before the next execution, those changes will not be reverted by the
    # copy/bind script because they are not in the base commit.
    mkdir -p "$(dirname "${PATCH_COMMIT_FILE}")"
    git -C "${GIT_REPO}" rev-parse HEAD >"${PATCH_COMMIT_FILE}"
}

reapply_patches() {
    local commit="$1"
    local dest="$2"
    local patches patch
    patches=$(untracked_and_modified_files "${commit}" "${PATCHES_DIR}")
    for patch in ${patches}; do
        if ! [ -f "${GIT_REPO}/${patch}" ]; then
            echo >&2 "Patch ${patch} doesn't exist in the working tree, reverting the version" \
                "from the base commit."
            git -C "${GIT_REPO}" show "${commit}:${patch}" |
                patch -p1 --reverse --batch --directory "${dest}" || true
            continue
        fi

        if ! git -C "${GIT_REPO}" show "${commit}:${patch}" >/dev/null 2>&1; then
            echo >&2 "Patch ${patch} doesn't exist on the base commit, applying the" \
                "version from the working tree."
            patch -p1 --batch --directory "${dest}" <"${GIT_REPO}/${patch}" || true
            continue
        fi

        # The patch exists on both the base commit and the working tree, so
        # we first revert the version from the base commit and then apply
        # the version from the working tree.
        echo >&2 "Reapplying patch ${patch}"
        git -C "${GIT_REPO}" show "${commit}:${patch}" |
            patch -p1 --reverse --batch --directory "${dest}" || true
        patch -p1 --batch --directory "${dest}" <"${GIT_REPO}/${patch}" || true
    done
}

has_changes() {
    local commit="$1"
    local dir="$2"
    ! git -C "${GIT_REPO}" diff --quiet "${commit}" -- "${dir}"
}

apply_changes() {
    local commit="$1"
    local dir file src dest

    # Reload dconf db if any dconf files were changed
    dir="${GIT_REPO}/config/chroot_local-includes/etc/dconf"
    if has_changes "${commit}" "${dir}"; then
        dconf update
    fi

    # Call 52-update-systemd-units if it was changed
    file="${GIT_REPO}/config/chroot_local-hooks/52-update-systemd-units"
    if [ -f "${file}" ] && has_changes "${commit}" "${file}"; then
        run_with_plymouth_msg "Updating systemd units" "${file}"
    fi

    # Reload polkit if any polkit rules were changed
    dir="${GIT_REPO}/config/chroot_local-includes/etc/polkit-1/rules.d"
    if has_changes "${commit}" "${dir}"; then
        systemctl reload polkit.service
    fi

    # Install modified dpkg hook (only useful if
    # /etc/apt/apt.conf.d/80tails-additional-software.disabled was modified)
    src="/etc/apt/apt.conf.d/80tails-additional-software.disabled"
    dest="/etc/apt/apt.conf.d/80tails-additional-software"
    if [ -e "${src}" ]; then
        ln -sf "${src}" "${dest}" || true
    fi
}

# Usage: bind_include src [dest]
#
# Bind-mounts src (in your Git checkout) to dest (inside Tails
# filesystem). If dest is not given it is derived from src. If src
# does not exist, dest is removed.
bind_include() {
    local tails_path src dest
    tails_path="${1#"${INCLUDES_DIR}"}"
    src="${GIT_REPO}/${INCLUDES_DIR}/${tails_path}"
    dest="$(realpath -s "${2:-${TARGET_ROOT}/${tails_path}}")"

    # Only run bindfs once
    if ! findmnt -t fuse --source "${GIT_REPO}" --mountpoint "${GIT_REPO}"; then
        # Load the fuse module which is required by bindfs
        modprobe -vvv fuse

        OWNER_UID=$(stat -c %u "${GIT_REPO}")
        OWNER_GID=$(stat -c %g "${GIT_REPO}")

        # Map the owner of the git repo to 0 to avoid issues like:
        #
        #   sudo: /etc/sudoers.d/zzz_tbb is owned by uid 1000, should be 0
        #
        bindfs --map="${OWNER_UID}/0:@${OWNER_GID}/@0" "${GIT_REPO}" "${GIT_REPO}"
    fi

    # Remove any .in extensions from the destination to replace the
    # localized file instead of the template file
    dest=${dest%.in}

    # Remove files which don't exist anymore in the source
    if ! [ -e "${src}" ]; then
        if ! [ -e "${dest}" ]; then
            echo >&2 "${dest} does not exist, nothing to do"
            return
        fi

        echo >&2 "Removing ${dest}"
        mountpoint -q "${dest}" && umount --recursive "${dest}"
        rm -rf "${dest}"
        return
    fi

    echo >&2 "Bind mounting ${src} to ${dest}"

    # Delete symlinks in the destination which would get dereferenced by
    # the findmnt below
    if [ -L "${dest}" ]; then
        rm "${dest}"
    fi

    # Check if something is already mounted on the destination
    local mount_src
    mount_src=$(findmnt --output=FSROOT --noheadings --notruncate --canonicalize --first --mountpoint "${dest}" || true)
    if [ "${GIT_REPO}${mount_src}" = "${src}" ]; then
        echo >&2 "Source is already mounted, nothing to do"
        return
    fi
    if [ -n "${mount_src}" ]; then
        echo >&2 "Something else is mounted on the destination, unmounting it: ${mount_src}"
        if ! umount "${dest}"; then
            echo >&2 "Failed to unmount ${dest}"
            return
        fi
    fi

    # Handle symlink
    if [ -L "${src}" ]; then
        echo >&2 "Source is a symlink, copying it to the destination"
        # Ensure there is nothing in our way
        rm -rf "${dest}"
        # Ensure that the parent directory exists
        mkdir -p "$(dirname "${dest}")"
        # Copy symlink
        cp --no-dereference "${src}" "${dest}"
        return
    fi

    # Create the destination if it doesn't exist
    if ! [ -e "${dest}" ]; then
        if [ -d "${src}" ]; then
            mkdir -p "${dest}"
        else
            mkdir -p "$(dirname "${dest}")"
            touch "${dest}"
        fi
    fi

    mount --bind "${src}" "${dest}"
}

# Usage: copy_include src [dest]
#
# Copies src (in your Git checkout) to dest (inside Tails
# filesystem). If dest is not given it is derived from src. If src
# does not exist, dest is removed.
copy_include() {
    local tails_path src dest
    tails_path="${1#"${INCLUDES_DIR}"}"
    src="${GIT_REPO}/${INCLUDES_DIR}/${tails_path}"
    dest="$(realpath -s "${2:-${TARGET_ROOT}/${tails_path}}")"

    # Remove any .in extensions from the destination to replace the
    # localized file instead of the template file
    dest=${dest%.in}

    # Remove files which don't exist anymore in the source
    if ! [ -e "${src}" ]; then
        if ! [ -e "${dest}" ]; then
            echo >&2 "${dest} does not exist, nothing to do"
            return
        fi

        echo >&2 "Removing ${dest}"
        rm -rf "${dest}"
        return
    fi

    echo >&2 "Copying ${src} to ${dest}"

    # Create the target directory
    mkdir -p "$(dirname "${dest}")"

    # Delete symlinks in the destination which would get dereferenced by
    # the cp command below
    if [ -L "${dest}" ]; then
        rm "${dest}"
    fi

    # Copy the file. Don't preserve ownership (i.e. change ownership to
    # root) to avoid issues like:
    #
    #   sudo: /etc/sudoers.d/zzz_tbb is owned by uid 1000, should be 0
    #
    cp --no-dereference --preserve=all --no-preserve=ownership "${src}" "${dest}"
}

# Create and initialize amnesia's home directory like `adduser --home`
# would do it.
initialize_amnesia_home() {
    [ -d /home/amnesia ] && return
    cp -r /etc/skel /home/amnesia
    chown -R 1000:1000 /home/amnesia
}
