#!/bin/sh

set -e

# Run whenever an interface gets "up", not otherwise:
if [ "$2" != "up" ]; then
   exit 0
fi

[ -x /usr/sbin/ferm ] || exit 2

privacy_mode="$(cat /etc/elizaos/privacy-mode 2>/dev/null || printf on)"
if [ "${privacy_mode}" = "off" ]; then
    /usr/sbin/ferm /etc/ferm/ferm-direct.conf
    if [ -s /etc/resolv-over-clearnet.conf ]; then
        cp /etc/resolv-over-clearnet.conf /etc/resolv.conf
    fi
else
    /usr/sbin/ferm /etc/ferm/ferm.conf
fi

if [ -e /var/lib/iptables/session-rules ]; then
    while read -r rule; do
        # shellcheck disable=SC2086
        iptables ${rule}
    done < /var/lib/iptables/session-rules
fi
