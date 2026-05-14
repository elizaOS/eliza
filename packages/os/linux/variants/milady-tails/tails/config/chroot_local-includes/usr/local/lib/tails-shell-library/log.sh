#!/bin/sh

warn() {
    echo "$*" >&2
}

die() {
    warn "$*"
    exit 1
}

# Shouldn't be used in shell libraries; a script including such a
# library would overwrite the library's log tag.
set_log_tag() {
    _LOG_TAG=$1
}

log() {
    if [ "${_LOG_TAG}" ]; then
        logger -t "${_LOG_TAG}" "$*" || :
    else
        logger "$*" || :
    fi
}
