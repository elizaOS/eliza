# SPDX-License-Identifier: MIT OR Apache-2.0
# This file is dual licensed under the terms of the Apache License, Version
# 2.0, and the MIT License.  See the LICENSE file in the root of this
# repository for complete details.

"""
Extracted log level data used by both stdlib and native log level filters.
"""

from __future__ import annotations

from typing import Any

from .typing import EventDict


# Adapted from the stdlib
CRITICAL = 50
FATAL = CRITICAL
ERROR = 40
WARNING = 30
WARN = WARNING
INFO = 20
DEBUG = 10
NOTSET = 0

NAME_TO_LEVEL = {
    "critical": CRITICAL,
    "exception": ERROR,
    "error": ERROR,
    "warn": WARNING,
    "warning": WARNING,
    "info": INFO,
    "debug": DEBUG,
    "notset": NOTSET,
}

LEVEL_TO_NAME = {
    v: k
    for k, v in NAME_TO_LEVEL.items()
    if k not in ("warn", "exception", "notset")
}

# Keep around for backwards-compatability in case someone imported them.
_LEVEL_TO_NAME = LEVEL_TO_NAME
_NAME_TO_LEVEL = NAME_TO_LEVEL


def map_method_name(method_name: str) -> str:
    # warn is just a deprecated alias in the stdlib.
    if method_name == "warn":
        return "warning"

    # Calling exception("") is the same as error("", exc_info=True)
    if method_name == "exception":
        return "error"

    return method_name


def add_log_level(
    logger: Any, method_name: str, event_dict: EventDict
) -> EventDict:
    """
    Add the log level to the event dict under the ``level`` key.

    Since that's just the log method name, this processor works with non-stdlib
    logging as well. Therefore it's importable both from `structlog.processors`
    as well as from `structlog.stdlib`.

    .. versionadded:: 15.0.0
    .. versionchanged:: 20.2.0
       Importable from `structlog.processors` (additionally to
       `structlog.stdlib`).
    .. versionchanged:: 24.1.0
       Added mapping from "exception" to "error"
    """

    event_dict["level"] = map_method_name(method_name)

    return event_dict
