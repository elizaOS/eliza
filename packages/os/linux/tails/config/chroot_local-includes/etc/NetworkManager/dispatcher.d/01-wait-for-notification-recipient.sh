#!/bin/sh

# When a non-loopback interface comes up, wait for the Live user's GNOME Shell
# to come up. Wait 120 times one second maximum.

[ -n "$1" ]      || exit 0
[ "$1" != "lo" ] || exit 0
[ "$2" = "up"  ] || exit 0

MAX_WAIT=120

# Get LIVE_USERNAME
. /etc/live/config.d/username.conf

for _ in $(seq 1 ${MAX_WAIT}) ; do
   if pgrep -u "${LIVE_USERNAME}" '^ibus-daemon' >/dev/null 2>&1 ; then
      break
   fi
   sleep 1
done
