# SPDX-License-Identifier: MIT OR Apache-2.0
# This file is dual licensed under the terms of the Apache License, Version
# 2.0, and the MIT License.  See the LICENSE file in the root of this
# repository for complete details.

"""
Deprecated name for :mod:`structlog.typing`.

.. versionadded:: 20.2.0
.. deprecated:: 22.2.0
"""

from __future__ import annotations

from .typing import (
    BindableLogger,
    Context,
    EventDict,
    ExceptionRenderer,
    ExceptionTransformer,
    ExcInfo,
    FilteringBoundLogger,
    Processor,
    WrappedLogger,
)


__all__ = (
    "BindableLogger",
    "Context",
    "EventDict",
    "ExcInfo",
    "ExceptionRenderer",
    "ExceptionTransformer",
    "FilteringBoundLogger",
    "Processor",
    "WrappedLogger",
)
