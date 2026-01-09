# SPDX-License-Identifier: MIT OR Apache-2.0
# This file is dual licensed under the terms of the Apache License, Version
# 2.0, and the MIT License.  See the LICENSE file in the root of this
# repository for complete details.

"""
Primitives to deal with a concurrency supporting context, as introduced in
Python 3.7 as :mod:`contextvars`.

.. versionadded:: 20.1.0
.. versionchanged:: 21.1.0
   Reimplemented without using a single dict as context carrier for improved
   isolation. Every key-value pair is a separate `contextvars.ContextVar` now.
.. versionchanged:: 23.3.0
   Callsite parameters are now also collected under asyncio.

See :doc:`contextvars`.
"""

from __future__ import annotations

import contextlib
import contextvars

from types import FrameType
from typing import Any, Generator, Mapping

import structlog

from .typing import BindableLogger, EventDict, WrappedLogger


STRUCTLOG_KEY_PREFIX = "structlog_"
STRUCTLOG_KEY_PREFIX_LEN = len(STRUCTLOG_KEY_PREFIX)

_ASYNC_CALLING_STACK: contextvars.ContextVar[FrameType] = (
    contextvars.ContextVar("_ASYNC_CALLING_STACK")
)

# For proper isolation, we have to use a dict of ContextVars instead of a
# single ContextVar with a dict.
# See https://github.com/hynek/structlog/pull/302 for details.
_CONTEXT_VARS: dict[str, contextvars.ContextVar[Any]] = {}


def get_contextvars() -> dict[str, Any]:
    """
    Return a copy of the *structlog*-specific context-local context.

    .. versionadded:: 21.2.0
    """
    rv = {}
    ctx = contextvars.copy_context()

    for k in ctx:
        if k.name.startswith(STRUCTLOG_KEY_PREFIX) and ctx[k] is not Ellipsis:
            rv[k.name[STRUCTLOG_KEY_PREFIX_LEN:]] = ctx[k]

    return rv


def get_merged_contextvars(bound_logger: BindableLogger) -> dict[str, Any]:
    """
    Return a copy of the current context-local context merged with the context
    from *bound_logger*.

    .. versionadded:: 21.2.0
    """
    ctx = get_contextvars()
    ctx.update(structlog.get_context(bound_logger))

    return ctx


def merge_contextvars(
    logger: WrappedLogger, method_name: str, event_dict: EventDict
) -> EventDict:
    """
    A processor that merges in a global (context-local) context.

    Use this as your first processor in :func:`structlog.configure` to ensure
    context-local context is included in all log calls.

    .. versionadded:: 20.1.0
    .. versionchanged:: 21.1.0 See toplevel note.
    """
    ctx = contextvars.copy_context()

    for k in ctx:
        if k.name.startswith(STRUCTLOG_KEY_PREFIX) and ctx[k] is not Ellipsis:
            event_dict.setdefault(k.name[STRUCTLOG_KEY_PREFIX_LEN:], ctx[k])

    return event_dict


def clear_contextvars() -> None:
    """
    Clear the context-local context.

    The typical use-case for this function is to invoke it early in request-
    handling code.

    .. versionadded:: 20.1.0
    .. versionchanged:: 21.1.0 See toplevel note.
    """
    ctx = contextvars.copy_context()
    for k in ctx:
        if k.name.startswith(STRUCTLOG_KEY_PREFIX):
            k.set(Ellipsis)


def bind_contextvars(**kw: Any) -> Mapping[str, contextvars.Token[Any]]:
    r"""
    Put keys and values into the context-local context.

    Use this instead of :func:`~structlog.BoundLogger.bind` when you want some
    context to be global (context-local).

    Return the mapping of `contextvars.Token`\s resulting
    from setting the backing :class:`~contextvars.ContextVar`\s.
    Suitable for passing to :func:`reset_contextvars`.

    .. versionadded:: 20.1.0
    .. versionchanged:: 21.1.0 Return the `contextvars.Token` mapping
        rather than None. See also the toplevel note.
    """
    rv = {}
    for k, v in kw.items():
        structlog_k = f"{STRUCTLOG_KEY_PREFIX}{k}"
        try:
            var = _CONTEXT_VARS[structlog_k]
        except KeyError:
            var = contextvars.ContextVar(structlog_k, default=Ellipsis)
            _CONTEXT_VARS[structlog_k] = var

        rv[k] = var.set(v)

    return rv


def reset_contextvars(**kw: contextvars.Token[Any]) -> None:
    r"""
    Reset contextvars corresponding to the given Tokens.

    .. versionadded:: 21.1.0
    """
    for k, v in kw.items():
        structlog_k = f"{STRUCTLOG_KEY_PREFIX}{k}"
        var = _CONTEXT_VARS[structlog_k]
        var.reset(v)


def unbind_contextvars(*keys: str) -> None:
    """
    Remove *keys* from the context-local context if they are present.

    Use this instead of :func:`~structlog.BoundLogger.unbind` when you want to
    remove keys from a global (context-local) context.

    .. versionadded:: 20.1.0
    .. versionchanged:: 21.1.0 See toplevel note.
    """
    for k in keys:
        structlog_k = f"{STRUCTLOG_KEY_PREFIX}{k}"
        if structlog_k in _CONTEXT_VARS:
            _CONTEXT_VARS[structlog_k].set(Ellipsis)


@contextlib.contextmanager
def bound_contextvars(**kw: Any) -> Generator[None, None, None]:
    """
    Bind *kw* to the current context-local context. Unbind or restore *kw*
    afterwards. Do **not** affect other keys.

    Can be used as a context manager or decorator.

    .. versionadded:: 21.4.0
    """
    context = get_contextvars()
    saved = {k: context[k] for k in context.keys() & kw.keys()}

    bind_contextvars(**kw)
    try:
        yield
    finally:
        unbind_contextvars(*kw.keys())
        bind_contextvars(**saved)
