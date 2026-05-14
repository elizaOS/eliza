#!/bin/dash

# Get LIVE_USERNAME
. /etc/live/config.d/username.conf

LOCK="/run/lock/libgnome-bookmarks.sh"
BOOKMARKS_FILE="/home/${LIVE_USERNAME}/.config/gtk-3.0/bookmarks"

if [ "$USER" != "$LIVE_USERNAME" ]; then
    echo "This library can only be used as ${LIVE_USERNAME}" >&2
    exit 1
fi

_build_bookmark_line() {
    local target
    target=$(echo "$1" | sed 's, ,%20,g')

    if [ $# -ge 2 ]; then
        title="$2"
        echo "file://$target $title"
    else
        echo "file://$target"
    fi
}

add_gnome_bookmark() {
    # Avoid race conditions
    touch "${LOCK}" 2>/dev/null || true
    exec 9<"${LOCK}"
    flock --exclusive 9

    mkdir -p "$(dirname "${BOOKMARKS_FILE}")"

    local line
    line=$(_build_bookmark_line "$@")

    # Check if the line exists
    if grep --fixed-strings --line-regexp -q "${line}" "${BOOKMARKS_FILE}"; then
      echo >&2 "Not adding GNOME bookmark, bookmark already exists: $*"
      return
    fi

    echo "${line}" >> "${BOOKMARKS_FILE}"
}

remove_gnome_bookmark() {
    local line
    local tmpfile
    line=$(_build_bookmark_line "$@")
    tmpfile=$(mktemp)

    # Avoid race conditions
    touch "${LOCK}" 2>/dev/null || true
    exec 9<"${LOCK}"
    flock --exclusive 9

    # Check if the line exists
    if ! grep --fixed-strings --line-regexp -q "${line}" "${BOOKMARKS_FILE}"; then
        echo >&2 "Not removing GNOME bookmark, bookmark does not exist: $*"
    fi

    # Delete the line
    grep -v --fixed-strings --line-regexp "${line}" "${BOOKMARKS_FILE}" > "${tmpfile}"
    mv "${tmpfile}" "${BOOKMARKS_FILE}"
}
