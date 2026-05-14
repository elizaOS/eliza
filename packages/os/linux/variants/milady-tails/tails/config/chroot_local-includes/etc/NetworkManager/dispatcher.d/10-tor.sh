#!/bin/sh

# We don't start Tor automatically so *this* is the time
# when it is supposed to start.

# Import nm_is_connected()
. /usr/local/lib/tails-shell-library/network.sh

# Run only when the interface is not "lo":
if [ -z "$1" ] || [ "$1" = "lo" ]; then
    exit 0
fi

BASENAME=$(basename "$0")

if [ "$2" = "up" ]; then
    : # go on, that's what this script is for
elif [ "${2}" = "down" ]; then
    if ! nm_is_connected; then
        echo >&2 "$BASENAME: $1 down: no network is connected, stopping " \
            "tails-tor-has-bootstrapped.target"
        /usr/bin/systemctl --no-block stop tails-tor-has-bootstrapped.target
    fi
    exit 0
else
    exit 0
fi

# We would like Tor to be started during init time, even before the
# network is up, and then send it a SIGHUP here to make it start
# bootstrapping swiftly, but it doesn't work because of a bug in
# Tor. Details:
# * https://gitlab.torproject.org/tpo/core/tor/-/issues/1247
# * https://gitlab.tails.boum.org/tails/tails/-/blob/7fae4a761a06e5a14048baff21e0bdb71a1f7226/wiki/src/bugs/tor_vs_networkmanager.mdwn
# To work around this we restart Tor.
echo >&2 "$BASENAME: $1 up: restarting tor@default.service"
systemctl restart tor@default.service

echo >&2 "$BASENAME: $1 up: starting tca.service"
/usr/local/lib/run-with-user-env systemctl --user start tca.service

# To address tails#21014 we don't re-run htpdate if it already succeeded.
# In fact, there is no reason to start it another time: the time has been synced already, and we can assume
# that your hardware clock is keeping time after that.
# Please note that it might be tempting to remove the if, and replace "restart" with "start".
# That would be very similar, but not exactly the same: an htpdate instance which is running (and would
# probably fail since it's running through a disconnect-reconnect) would not be stopped by running "start",
# while restart would.
# This does *not* solve the root cause of tails#21014: there is nothing specific about "htpdate has already
# succeeded" as far as we know, and this can be one more way in which time synchronization could fail.
# But it makes the bug far less visible in the test suite.
if ! [ -f /run/htpdate/success ]; then
    # that's not what it looks: htpdate will not really be started until Tor has bootstrapped
    echo >&2 "$BASENAME: $1 up: restarting htpdate.service"
    systemctl --no-block restart htpdate.service
fi

# Wait until the user is done with configuring Tor
echo >&2 "$BASENAME: $1 up: waiting until Tor was configured"
until [ "$(/usr/local/lib/tor_variable get --type=conf DisableNetwork)" = 0 ]; do
    sleep 1
done

echo >&2 "$BASENAME: $1 up: Finished"
