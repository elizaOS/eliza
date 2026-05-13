"""Miscellaneous Tails Python utilities."""

# Copyright (C) 2009-2026 Tails developers <tails@boum.org>
# Licensed under the GNU General Public License v3.0 or later — see LICENSE
# SPDX-License-Identifier: GPL-3.0-or-later

import contextlib
import logging
import os
import subprocess


# Credits go to kurin from this Reddit thread:
#   https://www.reddit.com/r/Python/comments/1sxil3/chdir_a_context_manager_for_switching_working/ce29rcm
@contextlib.contextmanager
def chdir(path):
    curdir = os.getcwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(curdir)


def run_with_user_env(command, *args):
    """Run a command as amnesia and wait for its completion."""
    cmdline = ["/usr/local/lib/run-with-user-env", command, *args]
    try:
        subprocess.run(
            cmdline,
            stderr=subprocess.PIPE,
            check=True,
            text=True,
        )
    except subprocess.CalledProcessError as e:
        logging.error(
            f"{command} returned with {e.returncode}",
        )
        for line in e.stderr.splitlines():
            logging.error(line)
        raise


def start_as_transient_systemd_service(service_name, command, *args):
    """Launch a command as amnesia and return immediately. The command
    is run as a transient systemd user service, so it doesn't exit when
    the parent process exits."""
    cmdline = [
        "/usr/local/lib/run-with-user-env",
        "--transient-systemd-service",
        service_name,
        command,
        *args,
    ]
    subprocess.check_call(cmdline)


def get_boot_device():
    """Return the underlying device of the root filesystem."""
    cmdline = ["/usr/local/lib/tails-get-boot-device"]
    return subprocess.check_output(cmdline, text=True).strip()
