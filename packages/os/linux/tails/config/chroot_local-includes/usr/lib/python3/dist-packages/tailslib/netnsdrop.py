"""
This module is useful for all those scripts that are meant to run a specific application inside a network namespace.

This functions make many assumptions about the working of it; that's in the hope that those scripts will keep
a somewhat similar structure. This is:
    - the netns has already been created, of course
    - somewhere in /etc/sudoers.d/ the wrapper can be run as root
    - the systemd user unit tails-a11y-bus-proxy is running
"""

import os
import logging

from tailslib import LIVE_USERNAME

A11Y_BUS_PROXY_PATH = "/run/user/1000/.dbus-proxy/a11y-bus-proxy.sock"
IBUS_PROXY_PATH = "/run/user/1000/.dbus-proxy/ibus-proxy.sock"
A11Y_BUS_SANDBOX_PATH = "/run/user/1000/tails-sandbox/a11y-bus-proxy.sock"
IBUS_SANDBOX_PATH = "/run/user/1000/tails-sandbox/ibus-proxy.sock"


def run_in_netns_as_amnesia(*args, netns, root="/", bind_mounts=None, close_from_fd=3):
    if bind_mounts is None:
        bind_mounts = []

    # base bwrap sharing most of the system
    bwrap = ["bwrap", "--bind", root, "/", "--proc", "/proc", "--dev", "/dev"]
    for src, dest in bind_mounts:
        bwrap += ["--bind", src, dest]

    bwrap += [
        "--bind",
        A11Y_BUS_PROXY_PATH,
        A11Y_BUS_SANDBOX_PATH,
        "--bind",
        IBUS_PROXY_PATH,
        IBUS_SANDBOX_PATH,
        "--setenv",
        "AT_SPI_BUS_ADDRESS",
        f"unix:path={A11Y_BUS_SANDBOX_PATH}",
        "--setenv",
        "IBUS_ADDRESS",
        f"unix:path={IBUS_SANDBOX_PATH}",
        # TODO: This has nothing to do with network namespaces and we
        #       should set it in the caller instead, but that's not
        #       supported currently.
        "--setenv",
        "TOR_CONTROL_PORT",
        "951",
    ]

    # We run the command with several wrappers to accomplish our privilege-isolation-magic:
    # connect_drop: opens a privileged file and pass FD to new process
    # ip netns: enter the new namespace
    # sudo: change back to unprivileged user and close all FDs except the ones
    #       we want to pass.
    # bwrap: Mount D-Bus proxies and set the respective environment variables.
    #        See also tails-a11y-bus-proxy.service and tails-ibus-proxy.service.
    # run-with-user-env: Set the user environment variables, see userenv.py
    #                    and tails-dump-user-env.service.
    cmd = [
        "ip",
        "netns",
        "exec",
        netns,
        "sudo",
        "--close-from",
        str(close_from_fd),
        "-u",
        LIVE_USERNAME,
        "--",
        *bwrap,
        "--",
        "/usr/local/lib/run-with-user-env",
        *args,
    ]

    logging.info("Running %s", cmd)
    os.execvp(cmd[0], cmd)
