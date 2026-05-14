"""
This module is meant to provide information about Tails release data
(ie: /etc/os-release).
"""

import datetime
import platform


def get_release_date() -> datetime.datetime:
    source_dt = datetime.datetime.fromtimestamp(
        int(VERSION_DATA["TAILS_SOURCE_DATE_EPOCH"])
    )
    source_dt = source_dt.replace(tzinfo=datetime.timezone.utc)
    return source_dt


VERSION_DATA = platform.freedesktop_os_release()
