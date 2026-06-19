#!/bin/sh

TOR_RC=/etc/tor/torrc

tor_append_to_torrc () {
    echo "${@}" >> "${TOR_RC}"
}

# Set a (possibly existing) option $1 to $2 in torrc. Shouldn't be
# used for options that can be set multiple times (e.g. the listener
# options). Does not support configuration entries split into multiple
# lines (with the backslash character).
tor_set_in_torrc () {
    sed -i "/^${1}\s/d" "${TOR_RC}"
    tor_append_to_torrc "${1} ${2}"
}
