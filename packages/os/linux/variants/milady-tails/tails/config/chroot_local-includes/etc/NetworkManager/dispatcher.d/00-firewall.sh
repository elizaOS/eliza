#!/bin/sh

set -e

# Run whenever an interface gets "up", not otherwise:
if [ "$2" != "up" ]; then
   exit 0
fi

[ -x /usr/sbin/ferm ] || exit 2
/usr/sbin/ferm /etc/ferm/ferm.conf

if [ -e /var/lib/iptables/session-rules ]; then
    while read -r rule; do
        # shellcheck disable=SC2086
        iptables ${rule}
    done < /var/lib/iptables/session-rules
fi
