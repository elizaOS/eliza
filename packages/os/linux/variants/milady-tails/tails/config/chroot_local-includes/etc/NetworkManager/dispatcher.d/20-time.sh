#!/bin/sh

# Use HTP to ask more accurate time information to a few authenticated
# HTTPS servers.

set -e
set -u

### Exit conditions

# Run only when the interface is not "lo":
if [ -z "$1" ] || [ "$1" = "lo" ]; then
    exit 0
fi

# Run whenever an interface gets "up", not otherwise:
if [ "$2" != "up" ]; then
    exit 0
fi

/usr/local/lib/run-with-user-env systemctl --no-block --user restart tails-htpdate-notify-user.service
