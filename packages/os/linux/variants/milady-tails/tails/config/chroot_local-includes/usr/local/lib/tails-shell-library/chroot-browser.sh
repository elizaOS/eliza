#!/bin/sh

if [ "$(whoami)" != "root" ]; then
    echo "This library is useless for non-root users. Exiting..." >&2
    exit 1
fi

case "$-" in
*e*) : ;;
*)
    echo "This library is meant to be used with 'set -e'. Exiting..." >&2
    exit 1
    ;;
esac

# Import the TBB_INSTALL variable
. /usr/local/lib/tails-shell-library/tor-browser.sh

# Import try_for().
. /usr/local/lib/tails-shell-library/common.sh

# Break down the chroot and kill all of its processes
try_cleanup_browser_chroot() {
    local chroot="${1}"
    local cow="${2}"
    # findmnt sorts submounts so we just have to revert the list to
    # have the proper umount order. We use `tail` to suppress the
    # "TARGET" column header.
    local chroot_mounts
    chroot_mounts="$(
        findmnt --output TARGET --list --submounts "${chroot}" | tail -n+2 | tac
    )"
    for mnt in ${chroot_mounts} "${cow}"; do
        try_for 10 "umount ${mnt} 2>/dev/null" 0.1 || true
    done
    rmdir "${cow}/rw" "${cow}/work" "${cow}" "${chroot}" || true
}

# Setup a chroot on a clean overlayfs "fork" of the root filesystem.
setup_chroot_for_browser() {
    local chroot="${1}"
    local cow="${2}"

    local rootfs_dir
    local rootfs_dirs_path="/lib/live/mount/rootfs"
    local tails_module_path="/lib/live/mount/medium/live/Tails.module"
    local lowerdirs=

    # We have to pay attention to the order we stack the filesystems;
    # newest must be first, and remember that the .module file lists
    # oldest first, newest last.
    while read -r rootfs_dir; do
        rootfs_dir="${rootfs_dirs_path}/${rootfs_dir}"
        mountpoint -q "${rootfs_dir}" &&
            lowerdirs="${rootfs_dir}:${lowerdirs}"
    done <"${tails_module_path}"
    # Remove the trailing colon
    lowerdirs=${lowerdirs%?}

    mkdir -p "${cow}" "${chroot}"

    # Ensure that the parent directory of the chroot and the cow dir
    # is only writable by root, to avoid that amnesia can write it.
    # Refs: #19585
    chmod 0700 "$(dirname "${cow}")" "$(dirname "${chroot}")"

    mount -t tmpfs tmpfs "${cow}"
    mkdir "${cow}/rw" "${cow}/work"
    mount -t overlay -o "noatime,lowerdir=${lowerdirs},upperdir=${cow}/rw,workdir=${cow}/work" overlay "${chroot}"
    chmod 755 "${chroot}"
}

browser_conf_dir() {
    local browser_name="${1}"
    local browser_user="${2}"
    echo "/home/${browser_user}/.${browser_name}"
}

browser_profile_dir() {
    local conf_dir
    conf_dir="$(browser_conf_dir "${@}")"
    echo "${conf_dir}/profile.default"
}

chroot_browser_conf_dir() {
    local chroot="${1}"
    shift
    echo "${chroot}/$(browser_conf_dir "${@}")"
}

chroot_browser_profile_dir() {
    local conf_dir
    conf_dir="$(chroot_browser_conf_dir "${@}")"
    echo "${conf_dir}/profile.default"
}

set_chroot_browser_permissions() {
    local chroot="${1}"
    local browser_name="${2}"
    local browser_user="${3}"
    local browser_conf
    browser_conf="$(chroot_browser_conf_dir "${chroot}" "${browser_name}" "${browser_user}")"
    chown -R "${browser_user}:${browser_user}" "${browser_conf}"
}

configure_chroot_browser_profile() {
    local chroot="${1}"
    shift
    local browser_name="${1}"
    shift
    local browser_user="${1}"
    shift
    local home_page="${1}"
    shift
    # Now $@ is a list of paths (that must be valid after chrooting)
    # to extensions to enable.

    # Prevent sudo from complaining about failing to resolve the 'amnesia' host
    echo "127.0.0.1 localhost amnesia" >"${chroot}/etc/hosts"

    # Create a fresh browser profile for the clearnet user
    local browser_profile
    browser_profile="$(chroot_browser_profile_dir "${chroot}" "${browser_name}" "${browser_user}")"
    local browser_ext="${browser_profile}/extensions"
    mkdir -p "${browser_profile}" "${browser_ext}"

    # Select extensions to enable
    local extension
    while [ -n "${*:-}" ]; do
        extension="${1}"
        shift
        if [ "$(basename "${extension}")" = 'red-2.0-an+fx.xpi' ]; then
            ln -s "${extension}" "${browser_ext}"/'{91a24c60-0f27-427c-b9a6-96b71f3984a9}.xpi'
        else
            ln -s "${extension}" "${browser_ext}"
        fi
    done

    # Set preferences
    local browser_prefs="${browser_profile}/user.js"
    local chroot_browser_config="/usr/share/tails/chroot-browsers"
    cat "${chroot_browser_config}/common/prefs.js" \
        "${chroot_browser_config}/${browser_name}/prefs.js" >"${browser_prefs}"

    # Install addonStartup.json.lz4. This is required to enable the red theme.
    cp "${chroot_browser_config}/${browser_name}/addonStartup.json.lz4" \
        "${browser_profile}"

    # Set browser home page to something that explains what's going on
    if [ -n "${home_page:-}" ]; then
        echo 'user_pref("browser.startup.homepage", "'"${home_page}"'");' >> \
            "${browser_prefs}"
        echo 'user_pref("browser.startup.homepage.new_identity", "'"${home_page}"'");' >> \
            "${browser_prefs}"
    fi

    # Customize the GUI.
    local browser_chrome="${browser_profile}/chrome/userChrome.css"
    mkdir -p "$(dirname "${browser_chrome}")"
    cat "${chroot_browser_config}/common/userChrome.css" \
        "${chroot_browser_config}/${browser_name}/userChrome.css" >> \
        "${browser_chrome}"

    set_chroot_browser_permissions "${chroot}" "${browser_name}" "${browser_user}"
}

set_chroot_browser_name() {
    local chroot="${1}"
    local human_readable_name="${2}"
    local browser_name="${3}"
    local browser_user="${4}"
    local requested_locale="${5}"
    local pack="${chroot}/${TBB_INSTALL}/browser/omni.ja"
    local tmp
    tmp="$(mktemp -d)"
    (
        local locale="${requested_locale}"
        cd "${tmp}"
        if ! 7z x -o"${tmp}" "${pack}" "localization/${locale}/branding/brand.ftl" \
            "chrome/${locale}/locale/branding/brand.properties"; then
            locale="en-US"
            7z x -o"${tmp}" "${pack}" "localization/${locale}/branding/brand.ftl" \
                "chrome/${locale}/locale/branding/brand.properties"
        fi
        sed --regexp-extended -i \
            "s/-brand-(full|short|shorter|product)-name = .*$/-brand-\1-name = ${human_readable_name}/" \
            "./localization/${locale}/branding/brand.ftl"
        sed --regexp-extended -i \
            "s/^brand(Full|Product|Short|Shorter)Name=.*$/brand\1Name=${human_readable_name}/" \
            "./chrome/${locale}/locale/branding/brand.properties"
        7z u -tzip "${pack}" .
    )
    chmod a+r "${pack}"
    rm -Rf "${tmp}"
}

delete_chroot_browser_searchplugins() {
    local chroot="${1}"

    pack="${chroot}/${TBB_INSTALL}/browser/omni.ja"
    local searchplugins_dir="chrome/browser/search-extensions"
    local searchplugins_list="${searchplugins_dir}/list.json"
    local tmp
    tmp="$(mktemp -d)"
    (
        cd "${tmp}"
        7z d -tzip "${pack}" "${searchplugins_dir}/*/manifest.json"
        mkdir -p "${searchplugins_dir}"
        echo '{"default": {"visibleDefaultEngines": []}, "experimental-hidden": {"visibleDefaultEngines": []}}' \
            >"${searchplugins_list}"
        7z u -tzip "${pack}" "${searchplugins_list}"
    )
    rm -r "${tmp}"
    chmod a+r "${pack}"
}

# Delete the Tor Browser icons. This prevents a Tor Browser icon being
# shown in the tab of a "New Tab" page.
delete_chroot_browser_icons() {
    local chroot="${1}"

    pack="${chroot}/${TBB_INSTALL}/browser/omni.ja"
    7z d -tzip "${pack}" "chrome/browser/content/branding/icon*.png"
    chmod a+r "${pack}"
}

delete_chroot_browser_embedded_extensions_in_omni_ja() {
    local chroot="${1}"
    shift
    # Now $@ is a list of extensions to delete.
    local pack="${chroot}/${TBB_INSTALL}/omni.ja"

    local extension
    while [ -n "${*:-}" ]; do
        extension="${1}"
        shift
        7z d -tzip "${pack}" "chrome/tails/content/extensions/${extension}"
    done
    chmod a+r "${pack}"
}

delete_chroot_browser_bookmarks() {
    local chroot="${1}"
    local pack="${chroot}/${TBB_INSTALL}/browser/omni.ja"
    7z d -tzip "${pack}" chrome/browser/content/browser/default-bookmarks.html
    chmod a+r "${pack}"
}

configure_chroot_browser() {
    local chroot="${1}"
    shift
    local browser_user="${1}"
    shift
    local browser_name="${1}"
    shift
    local human_readable_name="${1}"
    shift
    local home_page="${1}"
    shift
    # Now $@ is a list of paths (that must be valid after chrooting)
    # to extensions to enable.
    local best_locale
    best_locale="$(guess_best_tor_browser_locale)"
    local browser_user_uid
    browser_user_uid="$(id --user "${browser_user}")"

    if ! chroot "${chroot}" id -a "${browser_user}" 2>/dev/null; then
        chroot "${chroot}" addgroup --quiet --gid 1000 "${browser_user}"
        chroot "${chroot}" adduser --quiet --disabled-password --gecos "" --uid 1000 --gid 1000 "${browser_user}"
    fi
    configure_chroot_browser_profile "${chroot}" "${browser_name}" \
        "${browser_user}" "${home_page}" "${@}"
    set_chroot_browser_name "${chroot}" "${human_readable_name}" \
        "${browser_name}" "${browser_user}" "${best_locale}"
    delete_chroot_browser_searchplugins "${chroot}"
    delete_chroot_browser_icons "${chroot}"
    delete_chroot_browser_embedded_extensions_in_omni_ja "${chroot}" \
        'uBlock0@raymondhill.net'
    delete_chroot_browser_bookmarks "${chroot}"
    set_chroot_browser_permissions "${chroot}" "${browser_name}" \
        "${browser_user}"
    # Later we'll instruct bwrap to mount certain files within
    # /run/user/$uid/ but it does not handle the mixed permissions in
    # the path and will fail to create the $uid folder, so we do it
    # manually here instead.
    install --directory --owner="${browser_user}" --group="${browser_user}" \
        "${chroot}/run/user/${browser_user_uid}"
}
