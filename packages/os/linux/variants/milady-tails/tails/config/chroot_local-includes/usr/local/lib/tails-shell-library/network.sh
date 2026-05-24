# shellcheck shell=sh

nm_get_state() {
    dbus-send --system --print-reply=literal --dest=org.freedesktop.NetworkManager /org/freedesktop/NetworkManager org.freedesktop.NetworkManager.state |grep -w uint32|grep -Po '\d+$'
}

nm_is_connected() {
    state="$(nm_get_state)"
    [ "$state" -ge 60 ]
}
