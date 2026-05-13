#!/bin/sh
#
# Copyright (C) 2009-2026 Tails developers <tails@boum.org>
# Licensed under the GNU General Public License v3.0 or later — see LICENSE
# SPDX-License-Identifier: GPL-3.0-or-later

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
