# SPDX-License-Identifier: MIT OR Apache-2.0
# This file is dual licensed under the terms of the Apache License, Version
# 2.0, and the MIT License.  See the LICENSE file in the root of this
# repository for complete details.

"""
**Deprecated** primitives to keep context global but thread (and greenlet)
local.

See `thread-local`, but please use :doc:`contextvars` instead.

.. deprecated:: 22.1.0
"""

from __future__ import annotations

import contextlib
import sys
import threading
import uuid
import warnings

from typing import Any, Generator, Iterator, TypeVar

import structlog

from ._config import BoundLoggerLazyProxy
from .typing import BindableLogger, Context, EventDict, WrappedLogger


def _determine_threadlocal() -> type[Any]:
    """
    Return a dict-like threadlocal storage depending on whether we run with
    greenlets or not.
    """
    try:
        from ._greenlets import GreenThreadLocal
    except ImportError:
        from threading import local

        return local

    return GreenThreadLocal  # pragma: no cover


ThreadLocal = _determine_threadlocal()


def _deprecated() -> None:
    """
    Raise a warning with best-effort stacklevel adjustment.
    """
    callsite = ""

    with contextlib.suppress(Exception):
        f = sys._getframe()
        callsite = f.f_back.f_back.f_globals[  # type: ignore[union-attr]
            "__name__"
        ]

    # Avoid double warnings if TL functions call themselves.
    if callsite == "structlog.threadlocal":
        return

    stacklevel = 3
    # If a function is used as a decorator, we need to add two stack levels.
    # This logic will probably break eventually, but it's not worth any more
    # complexity.
    if callsite == "contextlib":
        stacklevel += 2

    warnings.warn(
        "`structlog.threadlocal` is deprecated, please use "
        "`structlog.contextvars` instead.",
        DeprecationWarning,
        stacklevel=stacklevel,
    )


def wrap_dict(dict_class: type[Context]) -> type[Context]:
    """
    Wrap a dict-like class and return the resulting class.

    The wrapped class and used to keep global in the current thread.

    Args:
        dict_class: Class used for keeping context.

    .. deprecated:: 22.1.0
    """
    _deprecated()
    Wrapped = type(
        "WrappedDict-" + str(uuid.uuid4()), (_ThreadLocalDictWrapper,), {}
    )
    Wrapped._tl = ThreadLocal()  # type: ignore[attr-defined]
    Wrapped._dict_class = dict_class  # type: ignore[attr-defined]

    return Wrapped


TLLogger = TypeVar("TLLogger", bound=BindableLogger)


def as_immutable(logger: TLLogger) -> TLLogger:
    """
    Extract the context from a thread local logger into an immutable logger.

    Args:
        logger (structlog.typing.BindableLogger):
            A logger with *possibly* thread local state.

    Returns:
        :class:`~structlog.BoundLogger` with an immutable context.

    .. deprecated:: 22.1.0
    """
    _deprecated()
    if isinstance(logger, BoundLoggerLazyProxy):
        logger = logger.bind()

    try:
        ctx = logger._context._tl.dict_.__class__(  # type: ignore[union-attr]
            logger._context._dict  # type: ignore[union-attr]
        )
        bl = logger.__class__(
            logger._logger,  # type: ignore[attr-defined, call-arg]
            processors=logger._processors,  # type: ignore[attr-defined]
            context={},
        )
        bl._context = ctx  # type: ignore[misc]

        return bl
    except AttributeError:
        return logger


@contextlib.contextmanager
def tmp_bind(
    logger: TLLogger, **tmp_values: Any
) -> Generator[TLLogger, None, None]:
    """
    Bind *tmp_values* to *logger* & memorize current state. Rewind afterwards.

    Only works with `structlog.threadlocal.wrap_dict`-based contexts.
    Use :func:`~structlog.threadlocal.bound_threadlocal` for new code.

    .. deprecated:: 22.1.0
    """
    _deprecated()
    if isinstance(logger, BoundLoggerLazyProxy):
        logger = logger.bind()

    saved = as_immutable(logger)._context
    try:
        yield logger.bind(**tmp_values)
    finally:
        logger._context.clear()
        logger._context.update(saved)


class _ThreadLocalDictWrapper:
    """
    Wrap a dict-like class and keep the state *global* but *thread-local*.

    Attempts to re-initialize only updates the wrapped dictionary.

    Useful for short-lived threaded applications like requests in web app.

    Use :func:`wrap` to instantiate and use
    :func:`structlog.BoundLogger.new` to clear the context.
    """

    _tl: Any
    _dict_class: type[dict[str, Any]]

    def __init__(self, *args: Any, **kw: Any) -> None:
        """
        We cheat.  A context dict gets never recreated.
        """
        if args and isinstance(args[0], self.__class__):
            # our state is global, no need to look at args[0] if it's of our
            # class
            self._dict.update(**kw)
        else:
            self._dict.update(*args, **kw)

    @property
    def _dict(self) -> Context:
        """
        Return or create and return the current context.
        """
        try:
            return self.__class__._tl.dict_
        except AttributeError:
            self.__class__._tl.dict_ = self.__class__._dict_class()

            return self.__class__._tl.dict_

    def __repr__(self) -> str:
        return f"<{self.__class__.__name__}({self._dict!r})>"

    def __eq__(self, other: object) -> bool:
        # Same class == same dictionary
        return self.__class__ == other.__class__

    def __ne__(self, other: object) -> bool:
        return not self.__eq__(other)

    # Proxy methods necessary for structlog.
    # Dunder methods don't trigger __getattr__ so we need to proxy by hand.
    def __iter__(self) -> Iterator[str]:
        return self._dict.__iter__()

    def __setitem__(self, key: str, value: Any) -> None:
        self._dict[key] = value

    def __delitem__(self, key: str) -> None:
        self._dict.__delitem__(key)

    def __len__(self) -> int:
        return self._dict.__len__()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._dict, name)


_CONTEXT = threading.local()


def get_threadlocal() -> Context:
    """
    Return a copy of the current thread-local context.

    .. versionadded:: 21.2.0
    .. deprecated:: 22.1.0
    """
    _deprecated()
    return _get_context().copy()


def get_merged_threadlocal(bound_logger: BindableLogger) -> Context:
    """
    Return a copy of the current thread-local context merged with the context
    from *bound_logger*.

    .. versionadded:: 21.2.0
    .. deprecated:: 22.1.0
    """
    _deprecated()
    ctx = _get_context().copy()
    ctx.update(structlog.get_context(bound_logger))

    return ctx


def merge_threadlocal(
    logger: WrappedLogger, method_name: str, event_dict: EventDict
) -> EventDict:
    """
    A processor that merges in a global (thread-local) context.

    Use this as your first processor in :func:`structlog.configure` to ensure
    thread-local context is included in all log calls.

    .. versionadded:: 19.2.0

    .. versionchanged:: 20.1.0
       This function used to be called ``merge_threadlocal_context`` and that
       name is still kept around for backward compatibility.

    .. deprecated:: 22.1.0
    """
    _deprecated()
    context = _get_context().copy()
    context.update(event_dict)

    return context


# Alias that shouldn't be used anymore.
merge_threadlocal_context = merge_threadlocal


def clear_threadlocal() -> None:
    """
    Clear the thread-local context.

    The typical use-case for this function is to invoke it early in
    request-handling code.

    .. versionadded:: 19.2.0
    .. deprecated:: 22.1.0
    """
    _deprecated()
    _CONTEXT.context = {}


def bind_threadlocal(**kw: Any) -> None:
    """
    Put keys and values into the thread-local context.

    Use this instead of :func:`~structlog.BoundLogger.bind` when you want some
    context to be global (thread-local).

    .. versionadded:: 19.2.0
    .. deprecated:: 22.1.0
    """
    _deprecated()
    _get_context().update(kw)


def unbind_threadlocal(*keys: str) -> None:
    """
    Tries to remove bound *keys* from threadlocal logging context if present.

    .. versionadded:: 20.1.0
    .. deprecated:: 22.1.0
    """
    _deprecated()
    context = _get_context()
    for key in keys:
        context.pop(key, None)


@contextlib.contextmanager
def bound_threadlocal(**kw: Any) -> Generator[None, None, None]:
    """
    Bind *kw* to the current thread-local context. Unbind or restore *kw*
    afterwards. Do **not** affect other keys.

    Can be used as a context manager or decorator.

    .. versionadded:: 21.4.0
    .. deprecated:: 22.1.0
    """
    _deprecated()
    context = get_threadlocal()
    saved = {k: context[k] for k in context.keys() & kw.keys()}

    bind_threadlocal(**kw)
    try:
        yield
    finally:
        unbind_threadlocal(*kw.keys())
        bind_threadlocal(**saved)


def _get_context() -> Context:
    try:
        return _CONTEXT.context
    except AttributeError:
        _CONTEXT.context = {}

        return _CONTEXT.context
