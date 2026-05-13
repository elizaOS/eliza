# shellcheck shell=sh
#
# Copyright (C) 2009-2026 Tails developers <tails@boum.org>
# Licensed under the GNU General Public License v3.0 or later — see LICENSE
# SPDX-License-Identifier: GPL-3.0-or-later

nm_get_state() {
    dbus-send --system --print-reply=literal --dest=org.freedesktop.NetworkManager /org/freedesktop/NetworkManager org.freedesktop.NetworkManager.state |grep -w uint32|grep -Po '\d+$'
}

nm_is_connected() {
    state="$(nm_get_state)"
    [ "$state" -ge 60 ]
}
