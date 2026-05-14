"""Tails persistence related tests."""

# Copyright (C) 2009-2026 Tails developers <tails@boum.org>
# Licensed under the GNU General Public License v3.0 or later — see LICENSE
# SPDX-License-Identifier: GPL-3.0-or-later

import os
import subprocess
import uuid

from tailslib.utils import start_as_transient_systemd_service

PERSISTENCE_DIR = "/live/persistence/TailsData_unlocked"
PERSISTENCE_PARTITION = "/dev/disk/by-partlabel/TailsData"


def get_persistence_path(return_nonexistent=False) -> str:
    """Return the path of the (newly created) persistence.

    Return PERSISTENCE_DIR if it exists.

    If return_nonexistent is true, also return PERSISTENCE_DIR if it
    does not exist.

    If no persistence directory exists and return_nonexistent is false,
    raise FileNotFoundError.
    """
    if os.path.isdir(PERSISTENCE_DIR) or return_nonexistent:
        return PERSISTENCE_DIR
    else:
        raise FileNotFoundError(
            f"No persistence directory found in {PERSISTENCE_DIR}",
        )


def has_persistence():
    """Return true iff the Persistent Storage exists."""
    return (
        subprocess.run(["/usr/local/lib/tpscli", "is-created"], check=False).returncode
        == 0
    )


def has_unlocked_persistence():
    """Return true iff the Persistent Storage is unlocked."""
    return (
        subprocess.run(["/usr/local/lib/tpscli", "is-unlocked"], check=False).returncode
        == 0
    )


def is_tails_media_writable():
    """Return true iff tails is started from a writable media."""
    return (
        subprocess.run(
            "/usr/local/lib/tails-boot-device-can-have-persistence",
            check=False,
        ).returncode
        == 0
    )


def spawn_tps_frontend(*args) -> str:
    """Launch tps-frontend as a transient systemd user service and
    return the service name. Do not wait for the service to exit."""
    service_name = "tails-persistent-storage-" + str(uuid.uuid4())
    start_as_transient_systemd_service(
        service_name,
        "/usr/local/bin/tails-persistent-storage",
        *args,
    )
    return service_name


def persistence_feature_is_active(feature: str) -> bool:
    """Return True iff the feature is active."""
    return (
        subprocess.run(
            ["/usr/local/lib/tpscli", "is-active", feature],
            check=False,
        ).returncode
        == 0
    )


def additional_software_persistence_feature_is_active() -> bool:
    """Return True iff the AdditionalSoftware feature is active."""
    return persistence_feature_is_active("AdditionalSoftware")


def thunderbird_persistence_feature_is_active() -> bool:
    """Return True iff the Thunderbird feature is active."""
    return persistence_feature_is_active("Thunderbird")
