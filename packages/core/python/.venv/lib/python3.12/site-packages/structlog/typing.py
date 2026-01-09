# SPDX-License-Identifier: MIT OR Apache-2.0
# This file is dual licensed under the terms of the Apache License, Version
# 2.0, and the MIT License.  See the LICENSE file in the root of this
# repository for complete details.

"""
Type information used throughout *structlog*.

For now, they are considered provisional. Especially `BindableLogger` will
probably change to something more elegant.

.. versionadded:: 22.2.0
"""

from __future__ import annotations

import sys

from types import TracebackType
from typing import (
    Any,
    Callable,
    Dict,
    Mapping,
    MutableMapping,
    Optional,
    Protocol,
    TextIO,
    Tuple,
    Type,
    Union,
    runtime_checkable,
)


if sys.version_info >= (3, 11):
    from typing import Self
else:
    from typing_extensions import Self


WrappedLogger = Any
"""
A logger that is wrapped by a bound logger and is ultimately responsible for
the output of the log entries.

*structlog* makes *no* assumptions about it.

.. versionadded:: 20.2.0
"""


Context = Union[Dict[str, Any], Dict[Any, Any]]
"""
A dict-like context carrier.

.. versionadded:: 20.2.0
"""


EventDict = MutableMapping[str, Any]
"""
An event dictionary as it is passed into processors.

It's created by copying the configured `Context` but doesn't need to support
copy itself.

.. versionadded:: 20.2.0
"""

ProcessorReturnValue = Union[
    Mapping[str, Any], str, bytes, bytearray, Tuple[Any, ...]
]
"""
A value returned by a processor.
"""

Processor = Callable[[WrappedLogger, str, EventDict], ProcessorReturnValue]
"""
A callable that is part of the processor chain.

See :doc:`processors`.

.. versionadded:: 20.2.0
"""

ExcInfo = Tuple[Type[BaseException], BaseException, Optional[TracebackType]]
"""
An exception info tuple as returned by `sys.exc_info`.

.. versionadded:: 20.2.0
"""


ExceptionRenderer = Callable[[TextIO, ExcInfo], None]
"""
A callable that pretty-prints an `ExcInfo` into a file-like object.

Used by `structlog.dev.ConsoleRenderer`.

.. versionadded:: 21.2.0
"""


@runtime_checkable
class ExceptionTransformer(Protocol):
    """
    **Protocol:** A callable that transforms an `ExcInfo` into another
    datastructure.

    The result should be something that your renderer can work with, e.g., a
    ``str`` or a JSON-serializable ``dict``.

    Used by `structlog.processors.format_exc_info()` and
    `structlog.processors.ExceptionPrettyPrinter`.

    Args:
        exc_info: Is the exception tuple to format

    Returns:
        Anything that can be rendered by the last processor in your chain, for
        example, a string or a JSON-serializable structure.

    .. versionadded:: 22.1.0
    """

    def __call__(self, exc_info: ExcInfo) -> Any: ...


@runtime_checkable
class BindableLogger(Protocol):
    """
    **Protocol**: Methods shared among all bound loggers and that are relied on
    by *structlog*.

    .. versionadded:: 20.2.0
    """

    @property
    def _context(self) -> Context: ...

    def bind(self, **new_values: Any) -> Self: ...

    def unbind(self, *keys: str) -> Self: ...

    def try_unbind(self, *keys: str) -> Self: ...

    def new(self, **new_values: Any) -> Self: ...


class FilteringBoundLogger(BindableLogger, Protocol):
    """
    **Protocol**: A `BindableLogger` that filters by a level.

    The only way to instantiate one is using `make_filtering_bound_logger`.

    .. versionadded:: 20.2.0
    .. versionadded:: 22.2.0 String interpolation using positional arguments.
    .. versionadded:: 22.2.0
       Async variants ``alog()``, ``adebug()``, ``ainfo()``, and so forth.
    .. versionchanged:: 22.3.0
       String interpolation is only attempted if positional arguments are
       passed.
    .. versionadded:: 25.5.0
       String interpolation using dictionary-based arguments if the first and
       only argument is a mapping.

    """

    def bind(self, **new_values: Any) -> FilteringBoundLogger:
        """
        Return a new logger with *new_values* added to the existing ones.

        .. versionadded:: 22.1.0
        """

    def unbind(self, *keys: str) -> FilteringBoundLogger:
        """
        Return a new logger with *keys* removed from the context.

        .. versionadded:: 22.1.0
        """

    def try_unbind(self, *keys: str) -> FilteringBoundLogger:
        """
        Like :meth:`unbind`, but best effort: missing keys are ignored.

        .. versionadded:: 22.1.0
        """

    def new(self, **new_values: Any) -> FilteringBoundLogger:
        """
        Clear context and binds *initial_values* using `bind`.

        .. versionadded:: 22.1.0
        """

    def is_enabled_for(self, level: int) -> bool:
        """
        Check whether the logger is enabled for *level*.

        .. versionadded:: 25.1.0
        """

    def get_effective_level(self) -> int:
        """
        Return the effective level of the logger.

        .. versionadded:: 25.1.0
        """

    def debug(self, event: str, *args: Any, **kw: Any) -> Any:
        """
        Log ``event % args`` with **kw** at **debug** level.
        """

    async def adebug(self, event: str, *args: Any, **kw: Any) -> Any:
        """
        Log ``event % args`` with **kw** at **debug** level.

        ..versionadded:: 22.2.0
        """

    def info(self, event: str, *args: Any, **kw: Any) -> Any:
        """
        Log ``event % args`` with **kw** at **info** level.
        """

    async def ainfo(self, event: str, *args: Any, **kw: Any) -> Any:
        """
        Log ``event % args`` with **kw** at **info** level.

        ..versionadded:: 22.2.0
        """

    def warning(self, event: str, *args: Any, **kw: Any) -> Any:
        """
        Log ``event % args`` with **kw** at **warn** level.
        """

    async def awarning(self, event: str, *args: Any, **kw: Any) -> Any:
        """
        Log ``event % args`` with **kw** at **warn** level.

        ..versionadded:: 22.2.0
        """

    def warn(self, event: str, *args: Any, **kw: Any) -> Any:
        """
        Log ``event % args`` with **kw** at **warn** level.
        """

    async def awarn(self, event: str, *args: Any, **kw: Any) -> Any:
        """
        Log ``event % args`` with **kw** at **warn** level.

        ..versionadded:: 22.2.0
        """

    def error(self, event: str, *args: Any, **kw: Any) -> Any:
        """
        Log ``event % args`` with **kw** at **error** level.
        """

    async def aerror(self, event: str, *args: Any, **kw: Any) -> Any:
        """
        Log ``event % args`` with **kw** at **error** level.

        ..versionadded:: 22.2.0
        """

    def err(self, event: str, *args: Any, **kw: Any) -> Any:
        """
        Log ``event % args`` with **kw** at **error** level.
        """

    def fatal(self, event: str, *args: Any, **kw: Any) -> Any:
        """
        Log ``event % args`` with **kw** at **critical** level.
        """

    async def afatal(self, event: str, *args: Any, **kw: Any) -> Any:
        """
        Log ``event % args`` with **kw** at **critical** level.

        ..versionadded:: 22.2.0
        """

    def exception(self, event: str, *args: Any, **kw: Any) -> Any:
        """
        Log ``event % args`` with **kw** at **error** level and ensure that
        ``exc_info`` is set in the event dictionary.
        """

    async def aexception(self, event: str, *args: Any, **kw: Any) -> Any:
        """
        Log ``event % args`` with **kw** at **error** level and ensure that
        ``exc_info`` is set in the event dictionary.

        ..versionadded:: 22.2.0
        """

    def critical(self, event: str, *args: Any, **kw: Any) -> Any:
        """
        Log ``event % args`` with **kw** at **critical** level.
        """

    async def acritical(self, event: str, *args: Any, **kw: Any) -> Any:
        """
        Log ``event % args`` with **kw** at **critical** level.

        ..versionadded:: 22.2.0
        """

    def msg(self, event: str, *args: Any, **kw: Any) -> Any:
        """
        Log ``event % args`` with **kw** at **info** level.
        """

    async def amsg(self, event: str, *args: Any, **kw: Any) -> Any:
        """
        Log ``event % args`` with **kw** at **info** level.
        """

    def log(self, level: int, event: str, *args: Any, **kw: Any) -> Any:
        """
        Log ``event % args`` with **kw** at *level*.
        """

    async def alog(self, level: int, event: str, *args: Any, **kw: Any) -> Any:
        """
        Log ``event % args`` with **kw** at *level*.
        """
