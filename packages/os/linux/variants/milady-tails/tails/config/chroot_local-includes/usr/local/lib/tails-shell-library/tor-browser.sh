#!/bin/sh

TBB_INSTALL=/usr/local/lib/tor-browser
# shellcheck disable=SC2034
TBB_PROFILE=/etc/tor-browser/profile
# shellcheck disable=SC2034
TBB_EXT=/usr/local/share/tor-browser-extensions

# For strings it's up to the caller to add double-quotes ("") around
# the value.
set_mozilla_pref() {
    local file name value prefix
    file="${1}"
    name="${2}"
    value="${3}"
    # Sometimes we might want to do e.g. user_pref
    prefix="${4:-pref}"
    [ -e "${file}" ] && sed -i "/^${prefix}(\"${name}\",/d" "${file}"
    echo "${prefix}(\"${name}\", ${value});" >>"${file}"
}

exec_firefox_helper() {
    local binary="${1}"
    shift

    export LD_LIBRARY_PATH="${TBB_INSTALL}"
    # This is only useful for the Unsafe Browser: for Tor Browser, this variable
    # is already set by Flatpak
    # (config/chroot_local-includes/usr/share/tails/build/flatpak/org.boum.tails.TorBrowser/metadata).
    export GNOME_ACCESSIBILITY=1

    # Don't let Tor Browser manage the tor daemon: we do it ourselves.
    export TOR_SKIP_LAUNCH=1

    # The Tor Browser often assumes that the current directory is
    # where the browser lives, e.g. for the fixed set of fonts set by
    # fontconfig above.
    cd "${TBB_INSTALL}"

    # Environment stuff from the upstream start-browser script. Please
    # see the "Sync with the upstream wrapper scripts" section in
    # wiki/src/contribute/release_process/tor-browser.mdwn for more
    # context about this.

    # Do not (try to) connect to the session manager.  Otherwise it
    # does (and fails) but if it succeeded it would be "very bad",
    # although details on why are missing.
    # https://gitlab.torproject.org/legacy/trac/-/issues/5261
    unset SESSION_MANAGER

    # If XAUTHORITY is unset, set it to its default value of $HOME/.Xauthority
    # before we change HOME below.  (See xauth(1) and #1945.)  XDM and KDM rely
    # on applications using this default value.
    # export XAUTHORITY="~/.Xauthority"
    #
    # Skipped because Tails always set it.

    # Prevent disk leaks in $HOME/.local/share (tor-browser#17560)
    # function erase_leaky() { [...] }
    #
    # Skipped in Tails because it is amnesic.

    # export HOME="${PWD}"
    #
    # Skipped because in Tails the browser has been modified to behave
    # like a normal application, not a bundled executable that tries
    # to isolate itself from the rest of the system, where changing
    # HOME might make sense.

    # [% IF c("var/asan") -%]
    # We need to disable LSan which is enabled by default now. Otherwise we'll get
    # a crash during shutdown: https://bugs.torproject.org/10599#comment:59
    # export ASAN_OPTIONS="detect_leaks=0"
    # [% END -%]
    #
    # Skipped because Tor Browser x86_64 isn't enabling asan so the
    # above part is not included in its start script.

    # Enable bundled fonts to decrease fingerprint.
    # https://gitlab.torproject.org/tpo/applications/tor-browser/-/issues/13313
    export FONTCONFIG_PATH="${TBB_INSTALL}/fontconfig"
    export FONTCONFIG_FILE="fonts.conf"

    # Avoid overwriting user's dconf values.
    # https://gitlab.torproject.org/legacy/trac/-/issues/27903
    export GSETTINGS_BACKEND=memory

    # tor-browser-build#41017: Nvidia drivers create a shader cache by
    # default in $HOME/.cache/nvidia. We we can easily disable it.
    export __GL_SHADER_DISK_CACHE=0

    exec "${TBB_INSTALL}"/"${binary}" "${@}"
}

exec_firefox() {
    exec_firefox_helper firefox.real "${@}"
}

guess_best_tor_browser_locale() {
    local long_locale short_locale similar_locale
    long_locale="$(echo "${LANG}" | sed -e 's/\..*$//' -e 's/_/-/')"
    short_locale="$(echo "${long_locale}" | cut -d"-" -f1)"
    if locale_is_supported_by_tor_browser "$long_locale"; then
        echo "${long_locale}"
        return
    elif locale_is_supported_by_tor_browser "$short_locale"; then
        echo "${short_locale}"
        return
    fi
    # If we use locale xx-YY and Tor Browser supports neither xx-YY nor xx,
    # there may be a similar locale xx-ZZ that we should use instead.
    # shellcheck disable=SC2012
    similar_locale=$(
        supported_tor_browser_locales |
            grep --max-count=1 --extended-regexp --line-regexp \
                "${short_locale}-[A-Z]+"
    ) || :
    if [ -n "${similar_locale:-}" ]; then
        echo "${similar_locale}"
        return
    fi

    echo 'en-US'
}

configure_best_tor_browser_locale() {
    local profile best_locale
    profile="${1}"
    best_locale="$(guess_best_tor_browser_locale)"
    cat "/etc/tor-browser/locale-profiles/${best_locale}.js" \
        >>"${profile}/prefs.js"
}

supported_tor_browser_locales() {
    tmp=$(mktemp -d)
    7z e -tzip -o"$tmp" -- "${TBB_INSTALL}/omni.ja" res/multilocale.txt >/dev/null
    tr ',' "\n" <"$tmp"/multilocale.txt
    rm -rf "$tmp"
}

locale_is_supported_by_tor_browser() {
    local mozilla_locale
    mozilla_locale="${1}"

    supported_tor_browser_locales |
        grep --quiet --fixed-strings --line-regexp "$mozilla_locale"
}

set_firefox_content_process_count() {
    local profile="$1"
    local count="$2"

    set_mozilla_pref "${profile}/prefs.js" \
        "dom.ipc.processCount" "$count" \
        user_pref
}

configure_tor_browser_memory_usage() {
    local profile="${1}"

    # Unit: KiB
    system_ram=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)

    if [ "$system_ram" -lt "$((3 * 1024 * 1024))" ]; then
        set_firefox_content_process_count "$profile" 2
    fi
}
