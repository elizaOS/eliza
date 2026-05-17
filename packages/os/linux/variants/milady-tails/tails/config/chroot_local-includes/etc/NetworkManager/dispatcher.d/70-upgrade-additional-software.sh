#!/bin/sh

set -e

# Run only when the interface is not "lo":
if [ -z "$1" ] || [ "$1" = "lo" ]; then
        exit 0
fi

# Run whenever an interface gets "up", not otherwise:
if [ "$2" != "up" ]; then
   exit 0
fi

/bin/systemctl --no-block start tails-additional-software-upgrade.path
