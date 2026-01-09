# SPDX-License-Identifier: MIT OR Apache-2.0
# This file is dual licensed under the terms of the Apache License, Version
# 2.0, and the MIT License.  See the LICENSE file in the root of this
# repository for complete details.


from __future__ import annotations

from structlog import (
    contextvars,
    dev,
    processors,
    stdlib,
    testing,
    threadlocal,
    tracebacks,
    types,
    typing,
)
from structlog._base import BoundLoggerBase, get_context
from structlog._config import (
    configure,
    configure_once,
    get_config,
    get_logger,
    getLogger,
    is_configured,
    reset_defaults,
    wrap_logger,
)
from structlog._generic import BoundLogger
from structlog._native import make_filtering_bound_logger
from structlog._output import (
    BytesLogger,
    BytesLoggerFactory,
    PrintLogger,
    PrintLoggerFactory,
    WriteLogger,
    WriteLoggerFactory,
)
from structlog.exceptions import DropEvent
from structlog.testing import ReturnLogger, ReturnLoggerFactory


try:
    from structlog import twisted
except ImportError:
    twisted = None  # type: ignore[assignment]


__title__ = "structlog"

__author__ = "Hynek Schlawack"

__license__ = "MIT or Apache License, Version 2.0"
__copyright__ = "Copyright (c) 2013 " + __author__


__all__ = [
    "BoundLogger",
    "BoundLoggerBase",
    "BytesLogger",
    "BytesLoggerFactory",
    "DropEvent",
    "PrintLogger",
    "PrintLoggerFactory",
    "ReturnLogger",
    "ReturnLoggerFactory",
    "WriteLogger",
    "WriteLoggerFactory",
    "configure",
    "configure_once",
    "contextvars",
    "dev",
    "getLogger",
    "get_config",
    "get_context",
    "get_logger",
    "is_configured",
    "make_filtering_bound_logger",
    "processors",
    "reset_defaults",
    "stdlib",
    "testing",
    "threadlocal",
    "tracebacks",
    "twisted",
    "types",
    "typing",
    "wrap_logger",
]


def __getattr__(name: str) -> str:
    import warnings

    from importlib.metadata import metadata, version

    dunder_to_metadata = {
        "__description__": "summary",
        "__uri__": "",
        "__email__": "",
        "__version__": "",
    }
    if name not in dunder_to_metadata:
        msg = f"module {__name__} has no attribute {name}"
        raise AttributeError(msg)

    if name != "__version__":
        warnings.warn(
            f"Accessing structlog.{name} is deprecated and will be "
            "removed in a future release. Use importlib.metadata directly "
            "to query for structlog's packaging metadata.",
            DeprecationWarning,
            stacklevel=2,
        )
    else:
        return version("structlog")

    meta = metadata("structlog")

    if name == "__uri__":
        return meta["Project-URL"].split(" ", 1)[-1]

    if name == "__email__":
        return meta["Author-email"].split("<", 1)[1].rstrip(">")

    return meta[dunder_to_metadata[name]]
