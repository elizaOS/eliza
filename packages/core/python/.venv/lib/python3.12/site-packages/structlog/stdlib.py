# This file is dual licensed under the terms of the Apache License, Version
# 2.0, and the MIT License.  See the LICENSE file in the root of this
# repository for complete details.

"""
Processors and helpers specific to the :mod:`logging` module from the `Python
standard library <https://docs.python.org/>`_.

See also :doc:`structlog's standard library support <standard-library>`.
"""

from __future__ import annotations

import asyncio
import contextvars
import functools
import logging
import sys
import warnings

from functools import partial
from typing import Any, Callable, Collection, Dict, Iterable, Sequence, cast


if sys.version_info >= (3, 11):
    from typing import Self
else:
    from typing_extensions import Self


from . import _config
from ._base import BoundLoggerBase
from ._frames import _find_first_app_frame_and_name, _format_stack
from ._log_levels import LEVEL_TO_NAME, NAME_TO_LEVEL, add_log_level
from .contextvars import _ASYNC_CALLING_STACK, merge_contextvars
from .exceptions import DropEvent
from .processors import StackInfoRenderer
from .typing import (
    Context,
    EventDict,
    ExcInfo,
    Processor,
    ProcessorReturnValue,
    WrappedLogger,
)


__all__ = [
    "BoundLogger",
    "ExtraAdder",
    "LoggerFactory",
    "PositionalArgumentsFormatter",
    "ProcessorFormatter",
    "add_log_level",
    "add_log_level_number",
    "add_logger_name",
    "filter_by_level",
    "get_logger",
    "recreate_defaults",
    "render_to_log_args_and_kwargs",
    "render_to_log_kwargs",
]


def recreate_defaults(*, log_level: int | None = logging.NOTSET) -> None:
    """
    Recreate defaults on top of standard library's logging.

    The output looks the same, but goes through `logging`.

    As with vanilla defaults, the backwards-compatibility guarantees don't
    apply to the settings applied here.

    Args:
        log_level:
            If `None`, don't configure standard library logging **at all**.

            Otherwise configure it to log to `sys.stdout` at *log_level*
            (``logging.NOTSET`` being the default).

            If you need more control over `logging`, pass `None` here and
            configure it yourself.

    .. versionadded:: 22.1.0
    .. versionchanged:: 23.3.0 Added `add_logger_name`.
    .. versionchanged:: 25.1.0 Added `PositionalArgumentsFormatter`.
    """
    if log_level is not None:
        kw = {"force": True}

        logging.basicConfig(
            format="%(message)s",
            stream=sys.stdout,
            level=log_level,
            **kw,  # type: ignore[arg-type]
        )

    _config.reset_defaults()
    _config.configure(
        processors=[
            PositionalArgumentsFormatter(),  # handled by native loggers
            merge_contextvars,
            add_log_level,
            add_logger_name,
            StackInfoRenderer(),
            _config._BUILTIN_DEFAULT_PROCESSORS[-2],  # TimeStamper
            _config._BUILTIN_DEFAULT_PROCESSORS[-1],  # ConsoleRenderer
        ],
        wrapper_class=BoundLogger,
        logger_factory=LoggerFactory(),
    )


_SENTINEL = object()


class _FixedFindCallerLogger(logging.Logger):
    """
    Change the behavior of `logging.Logger.findCaller` to cope with
    *structlog*'s extra frames.
    """

    def findCaller(
        self, stack_info: bool = False, stacklevel: int = 1
    ) -> tuple[str, int, str, str | None]:
        """
        Finds the first caller frame outside of structlog so that the caller
        info is populated for wrapping stdlib.

        This logger gets set as the default one when using LoggerFactory.
        """
        sinfo: str | None
        # stdlib logging passes stacklevel=1 from log methods like .warning(),
        # but we've already skipped those frames by ignoring "logging", so we
        # need to adjust stacklevel down by 1. We need to manually drop
        # logging frames, because there's cases where we call logging methods
        # from within structlog and the stacklevel offsets don't work anymore.
        adjusted_stacklevel = max(0, stacklevel - 1) if stacklevel else None
        f, _name = _find_first_app_frame_and_name(
            ["logging"], stacklevel=adjusted_stacklevel
        )
        sinfo = _format_stack(f) if stack_info else None

        return f.f_code.co_filename, f.f_lineno, f.f_code.co_name, sinfo


class BoundLogger(BoundLoggerBase):
    """
    Python Standard Library version of `structlog.BoundLogger`.

    Works exactly like the generic one except that it takes advantage of
    knowing the logging methods in advance.

    Use it like::

        structlog.configure(
            wrapper_class=structlog.stdlib.BoundLogger,
        )

    It also contains a bunch of properties that pass-through to the wrapped
    `logging.Logger` which should make it work as a drop-in replacement.

    .. versionadded:: 23.1.0
       Async variants `alog()`, `adebug()`, `ainfo()`, and so forth.

    .. versionchanged:: 24.2.0
        Callsite parameters are now also collected by
        `structlog.processors.CallsiteParameterAdder` for async log methods.
    """

    _logger: logging.Logger

    def bind(self, **new_values: Any) -> Self:
        """
        Return a new logger with *new_values* added to the existing ones.
        """
        return super().bind(**new_values)

    def unbind(self, *keys: str) -> Self:
        """
        Return a new logger with *keys* removed from the context.

        Raises:
            KeyError: If the key is not part of the context.
        """
        return super().unbind(*keys)

    def try_unbind(self, *keys: str) -> Self:
        """
        Like :meth:`unbind`, but best effort: missing keys are ignored.

        .. versionadded:: 18.2.0
        """
        return super().try_unbind(*keys)

    def new(self, **new_values: Any) -> Self:
        """
        Clear context and binds *initial_values* using `bind`.

        Only necessary with dict implementations that keep global state like
        those wrapped by `structlog.threadlocal.wrap_dict` when threads
        are reused.
        """
        return super().new(**new_values)

    def debug(self, event: str | None = None, *args: Any, **kw: Any) -> Any:
        """
        Process event and call `logging.Logger.debug` with the result.
        """
        return self._proxy_to_logger("debug", event, *args, **kw)

    def info(self, event: str | None = None, *args: Any, **kw: Any) -> Any:
        """
        Process event and call `logging.Logger.info` with the result.
        """
        return self._proxy_to_logger("info", event, *args, **kw)

    def warning(self, event: str | None = None, *args: Any, **kw: Any) -> Any:
        """
        Process event and call `logging.Logger.warning` with the result.
        """
        return self._proxy_to_logger("warning", event, *args, **kw)

    warn = warning

    def error(self, event: str | None = None, *args: Any, **kw: Any) -> Any:
        """
        Process event and call `logging.Logger.error` with the result.
        """
        return self._proxy_to_logger("error", event, *args, **kw)

    def critical(self, event: str | None = None, *args: Any, **kw: Any) -> Any:
        """
        Process event and call `logging.Logger.critical` with the result.
        """
        return self._proxy_to_logger("critical", event, *args, **kw)

    def fatal(self, event: str | None = None, *args: Any, **kw: Any) -> Any:
        """
        Process event and call `logging.Logger.critical` with the result.
        """
        return self._proxy_to_logger("critical", event, *args, **kw)

    def exception(
        self, event: str | None = None, *args: Any, **kw: Any
    ) -> Any:
        """
        Process event and call `logging.Logger.exception` with the result,
        after setting ``exc_info`` to `True` if it's not already set.
        """
        kw.setdefault("exc_info", True)
        return self._proxy_to_logger("exception", event, *args, **kw)

    def log(
        self, level: int, event: str | None = None, *args: Any, **kw: Any
    ) -> Any:
        """
        Process *event* and call the appropriate logging method depending on
        *level*.
        """
        return self._proxy_to_logger(LEVEL_TO_NAME[level], event, *args, **kw)

    def _proxy_to_logger(
        self,
        method_name: str,
        event: str | None = None,
        *event_args: str,
        **event_kw: Any,
    ) -> Any:
        """
        Propagate a method call to the wrapped logger.

        This is the same as the superclass implementation, except that
        it also preserves positional arguments in the ``event_dict`` so
        that the stdlib's support for format strings can be used.
        """
        if event_args:
            event_kw["positional_args"] = event_args

        return super()._proxy_to_logger(method_name, event=event, **event_kw)

    # Pass-through attributes and methods to mimic the stdlib's logger
    # interface.

    @property
    def name(self) -> str:
        """
        Returns :attr:`logging.Logger.name`
        """
        return self._logger.name

    @property
    def level(self) -> int:
        """
        Returns :attr:`logging.Logger.level`
        """
        return self._logger.level

    @property
    def parent(self) -> Any:
        """
        Returns :attr:`logging.Logger.parent`
        """
        return self._logger.parent

    @property
    def propagate(self) -> bool:
        """
        Returns :attr:`logging.Logger.propagate`
        """
        return self._logger.propagate

    @property
    def handlers(self) -> Any:
        """
        Returns :attr:`logging.Logger.handlers`
        """
        return self._logger.handlers

    @property
    def disabled(self) -> int:
        """
        Returns :attr:`logging.Logger.disabled`
        """
        return self._logger.disabled

    def setLevel(self, level: int) -> None:
        """
        Calls :meth:`logging.Logger.setLevel` with unmodified arguments.
        """
        self._logger.setLevel(level)

    def findCaller(
        self, stack_info: bool = False, stacklevel: int = 1
    ) -> tuple[str, int, str, str | None]:
        """
        Calls :meth:`logging.Logger.findCaller` with unmodified arguments.
        """
        # No need for stacklevel-adjustments since we're within structlog and
        # our frames are ignored unconditionally.
        return self._logger.findCaller(
            stack_info=stack_info, stacklevel=stacklevel
        )

    def makeRecord(
        self,
        name: str,
        level: int,
        fn: str,
        lno: int,
        msg: str,
        args: tuple[Any, ...],
        exc_info: ExcInfo,
        func: str | None = None,
        extra: Any = None,
    ) -> logging.LogRecord:
        """
        Calls :meth:`logging.Logger.makeRecord` with unmodified arguments.
        """
        return self._logger.makeRecord(
            name, level, fn, lno, msg, args, exc_info, func=func, extra=extra
        )

    def handle(self, record: logging.LogRecord) -> None:
        """
        Calls :meth:`logging.Logger.handle` with unmodified arguments.
        """
        self._logger.handle(record)

    def addHandler(self, hdlr: logging.Handler) -> None:
        """
        Calls :meth:`logging.Logger.addHandler` with unmodified arguments.
        """
        self._logger.addHandler(hdlr)

    def removeHandler(self, hdlr: logging.Handler) -> None:
        """
        Calls :meth:`logging.Logger.removeHandler` with unmodified arguments.
        """
        self._logger.removeHandler(hdlr)

    def hasHandlers(self) -> bool:
        """
        Calls :meth:`logging.Logger.hasHandlers` with unmodified arguments.

        Exists only in Python 3.
        """
        return self._logger.hasHandlers()

    def callHandlers(self, record: logging.LogRecord) -> None:
        """
        Calls :meth:`logging.Logger.callHandlers` with unmodified arguments.
        """
        self._logger.callHandlers(record)

    def getEffectiveLevel(self) -> int:
        """
        Calls :meth:`logging.Logger.getEffectiveLevel` with unmodified
        arguments.
        """
        return self._logger.getEffectiveLevel()

    def isEnabledFor(self, level: int) -> bool:
        """
        Calls :meth:`logging.Logger.isEnabledFor` with unmodified arguments.
        """
        return self._logger.isEnabledFor(level)

    def getChild(self, suffix: str) -> logging.Logger:
        """
        Calls :meth:`logging.Logger.getChild` with unmodified arguments.
        """
        return self._logger.getChild(suffix)

    # Non-Standard Async
    async def _dispatch_to_sync(
        self,
        meth: Callable[..., Any],
        event: str,
        args: tuple[Any, ...],
        kw: dict[str, Any],
    ) -> None:
        """
        Merge contextvars and log using the sync logger in a thread pool.
        """
        scs_token = _ASYNC_CALLING_STACK.set(sys._getframe().f_back.f_back)  # type: ignore[union-attr, arg-type, unused-ignore]
        ctx = contextvars.copy_context()

        try:
            await asyncio.get_running_loop().run_in_executor(
                None,
                lambda: ctx.run(lambda: meth(event, *args, **kw)),
            )
        finally:
            _ASYNC_CALLING_STACK.reset(scs_token)

    async def adebug(self, event: str, *args: Any, **kw: Any) -> None:
        """
        Log using `debug()`, but asynchronously in a separate thread.

        .. versionadded:: 23.1.0
        """
        await self._dispatch_to_sync(self.debug, event, args, kw)

    async def ainfo(self, event: str, *args: Any, **kw: Any) -> None:
        """
        Log using `info()`, but asynchronously in a separate thread.

        .. versionadded:: 23.1.0
        """
        await self._dispatch_to_sync(self.info, event, args, kw)

    async def awarning(self, event: str, *args: Any, **kw: Any) -> None:
        """
        Log using `warning()`, but asynchronously in a separate thread.

        .. versionadded:: 23.1.0
        """
        await self._dispatch_to_sync(self.warning, event, args, kw)

    async def aerror(self, event: str, *args: Any, **kw: Any) -> None:
        """
        Log using `error()`, but asynchronously in a separate thread.

        .. versionadded:: 23.1.0
        """
        await self._dispatch_to_sync(self.error, event, args, kw)

    async def acritical(self, event: str, *args: Any, **kw: Any) -> None:
        """
        Log using `critical()`, but asynchronously in a separate thread.

        .. versionadded:: 23.1.0
        """
        await self._dispatch_to_sync(self.critical, event, args, kw)

    async def afatal(self, event: str, *args: Any, **kw: Any) -> None:
        """
        Log using `critical()`, but asynchronously in a separate thread.

        .. versionadded:: 23.1.0
        """
        await self._dispatch_to_sync(self.critical, event, args, kw)

    async def aexception(self, event: str, *args: Any, **kw: Any) -> None:
        """
        Log using `exception()`, but asynchronously in a separate thread.

        .. versionadded:: 23.1.0
        """
        # To make `log.exception("foo") work, we have to check if the user
        # passed an explicit exc_info and if not, supply our own.
        if kw.get("exc_info", True) is True and kw.get("exception") is None:
            kw["exc_info"] = sys.exc_info()

        await self._dispatch_to_sync(self.exception, event, args, kw)

    async def alog(
        self, level: Any, event: str, *args: Any, **kw: Any
    ) -> None:
        """
        Log using `log()`, but asynchronously in a separate thread.

        .. versionadded:: 23.1.0
        """
        await self._dispatch_to_sync(partial(self.log, level), event, args, kw)


def get_logger(*args: Any, **initial_values: Any) -> BoundLogger:
    """
    Only calls `structlog.get_logger`, but has the correct type hints.

    .. warning::

       Does **not** check whether -- or ensure that -- you've configured
       *structlog* for standard library :mod:`logging`!

       See :doc:`standard-library` for details.

    .. versionadded:: 20.2.0
    """
    return _config.get_logger(*args, **initial_values)


class AsyncBoundLogger:
    """
    Wraps a `BoundLogger` & exposes its logging methods as ``async`` versions.

    Instead of blocking the program, they are run asynchronously in a thread
    pool executor.

    This means more computational overhead per log call. But it also means that
    the processor chain (e.g. JSON serialization) and I/O won't block your
    whole application.

    Only available for Python 3.7 and later.

    .. versionadded:: 20.2.0
    .. versionchanged:: 20.2.0 fix _dispatch_to_sync contextvars usage
    .. deprecated:: 23.1.0
       Use the regular `BoundLogger` with its a-prefixed methods instead.
    .. versionchanged:: 23.3.0
        Callsite parameters are now also collected for async log methods.
    """

    __slots__ = ("_loop", "sync_bl")

    #: The wrapped synchronous logger. It is useful to be able to log
    #: synchronously occasionally.
    sync_bl: BoundLogger

    _executor = None
    _bound_logger_factory = BoundLogger

    def __init__(
        self,
        logger: logging.Logger,
        processors: Iterable[Processor],
        context: Context,
        *,
        # Only as an optimization for binding!
        _sync_bl: Any = None,  # *vroom vroom* over purity.
        _loop: Any = None,
    ):
        if _sync_bl:
            self.sync_bl = _sync_bl
            self._loop = _loop

            return

        self.sync_bl = self._bound_logger_factory(
            logger=logger, processors=processors, context=context
        )
        self._loop = asyncio.get_running_loop()

    # Instances would've been correctly recognized as such, however the class
    # not and we need the class in `structlog.configure()`.
    @property
    def _context(self) -> Context:
        return self.sync_bl._context

    def bind(self, **new_values: Any) -> Self:
        return self.__class__(
            # logger, processors and context are within sync_bl. These
            # arguments are ignored if _sync_bl is passed. *vroom vroom* over
            # purity.
            logger=None,  # type: ignore[arg-type]
            processors=(),
            context={},
            _sync_bl=self.sync_bl.bind(**new_values),
            _loop=self._loop,
        )

    def new(self, **new_values: Any) -> Self:
        return self.__class__(
            # c.f. comment in bind
            logger=None,  # type: ignore[arg-type]
            processors=(),
            context={},
            _sync_bl=self.sync_bl.new(**new_values),
            _loop=self._loop,
        )

    def unbind(self, *keys: str) -> Self:
        return self.__class__(
            # c.f. comment in bind
            logger=None,  # type: ignore[arg-type]
            processors=(),
            context={},
            _sync_bl=self.sync_bl.unbind(*keys),
            _loop=self._loop,
        )

    def try_unbind(self, *keys: str) -> Self:
        return self.__class__(
            # c.f. comment in bind
            logger=None,  # type: ignore[arg-type]
            processors=(),
            context={},
            _sync_bl=self.sync_bl.try_unbind(*keys),
            _loop=self._loop,
        )

    async def _dispatch_to_sync(
        self,
        meth: Callable[..., Any],
        event: str,
        args: tuple[Any, ...],
        kw: dict[str, Any],
    ) -> None:
        """
        Merge contextvars and log using the sync logger in a thread pool.
        """
        scs_token = _ASYNC_CALLING_STACK.set(sys._getframe().f_back.f_back)  # type: ignore[union-attr, arg-type, unused-ignore]
        ctx = contextvars.copy_context()

        try:
            await asyncio.get_running_loop().run_in_executor(
                self._executor,
                lambda: ctx.run(lambda: meth(event, *args, **kw)),
            )
        finally:
            _ASYNC_CALLING_STACK.reset(scs_token)

    async def debug(self, event: str, *args: Any, **kw: Any) -> None:
        await self._dispatch_to_sync(self.sync_bl.debug, event, args, kw)

    async def info(self, event: str, *args: Any, **kw: Any) -> None:
        await self._dispatch_to_sync(self.sync_bl.info, event, args, kw)

    async def warning(self, event: str, *args: Any, **kw: Any) -> None:
        await self._dispatch_to_sync(self.sync_bl.warning, event, args, kw)

    async def warn(self, event: str, *args: Any, **kw: Any) -> None:
        await self._dispatch_to_sync(self.sync_bl.warning, event, args, kw)

    async def error(self, event: str, *args: Any, **kw: Any) -> None:
        await self._dispatch_to_sync(self.sync_bl.error, event, args, kw)

    async def critical(self, event: str, *args: Any, **kw: Any) -> None:
        await self._dispatch_to_sync(self.sync_bl.critical, event, args, kw)

    async def fatal(self, event: str, *args: Any, **kw: Any) -> None:
        await self._dispatch_to_sync(self.sync_bl.critical, event, args, kw)

    async def exception(self, event: str, *args: Any, **kw: Any) -> None:
        # To make `log.exception("foo") work, we have to check if the user
        # passed an explicit exc_info and if not, supply our own.
        ei = kw.pop("exc_info", None)
        if ei is None and kw.get("exception") is None:
            ei = sys.exc_info()

        kw["exc_info"] = ei

        await self._dispatch_to_sync(self.sync_bl.exception, event, args, kw)

    async def log(self, level: Any, event: str, *args: Any, **kw: Any) -> None:
        await self._dispatch_to_sync(
            partial(self.sync_bl.log, level), event, args, kw
        )


class LoggerFactory:
    """
    Build a standard library logger when an *instance* is called.

    Sets a custom logger using :func:`logging.setLoggerClass` so variables in
    log format are expanded properly.

    >>> from structlog import configure
    >>> from structlog.stdlib import LoggerFactory
    >>> configure(logger_factory=LoggerFactory())

    Args:
        ignore_frame_names:
            When guessing the name of a logger, skip frames whose names *start*
            with one of these.  For example, in pyramid applications you'll
            want to set it to ``["venusian", "pyramid.config"]``. This argument
            is called *additional_ignores* in other APIs throughout
            *structlog*.
    """

    def __init__(self, ignore_frame_names: list[str] | None = None):
        self._ignore = ignore_frame_names
        logging.setLoggerClass(_FixedFindCallerLogger)

    def __call__(self, *args: Any) -> logging.Logger:
        """
        Deduce the caller's module name and create a stdlib logger.

        If an optional argument is passed, it will be used as the logger name
        instead of guesswork.  This optional argument would be passed from the
        :func:`structlog.get_logger` call.  For example
        ``structlog.get_logger("foo")`` would cause this method to be called
        with ``"foo"`` as its first positional argument.

        .. versionchanged:: 0.4.0
            Added support for optional positional arguments.  Using the first
            one for naming the constructed logger.
        """
        if args:
            return logging.getLogger(args[0])

        # We skip all frames that originate from within structlog or one of the
        # configured names.
        _, name = _find_first_app_frame_and_name(self._ignore)

        return logging.getLogger(name)


class PositionalArgumentsFormatter:
    """
    Apply stdlib-like string formatting to the ``event`` key.

    If the ``positional_args`` key in the event dict is set, it must
    contain a tuple that is used for formatting (using the ``%s`` string
    formatting operator) of the value from the ``event`` key.  This works
    in the same way as the stdlib handles arguments to the various log
    methods: if the tuple contains only a single `dict` argument it is
    used for keyword placeholders in the ``event`` string, otherwise it
    will be used for positional placeholders.

    ``positional_args`` is populated by `structlog.stdlib.BoundLogger` or
    can be set manually.

    The *remove_positional_args* flag can be set to `False` to keep the
    ``positional_args`` key in the event dict; by default it will be
    removed from the event dict after formatting a message.
    """

    def __init__(self, remove_positional_args: bool = True) -> None:
        self.remove_positional_args = remove_positional_args

    def __call__(
        self, _: WrappedLogger, __: str, event_dict: EventDict
    ) -> EventDict:
        args = event_dict.get("positional_args")

        # Mimic the formatting behaviour of the stdlib's logging module, which
        # accepts both positional arguments and a single dict argument. The
        # "single dict" check is the same one as the stdlib's logging module
        # performs in LogRecord.__init__().
        if args:
            if len(args) == 1 and isinstance(args[0], dict) and args[0]:
                args = args[0]

            event_dict["event"] %= args

        if self.remove_positional_args and args is not None:
            del event_dict["positional_args"]

        return event_dict


def filter_by_level(
    logger: logging.Logger, method_name: str, event_dict: EventDict
) -> EventDict:
    """
    Check whether logging is configured to accept messages from this log level.

    Should be the first processor if stdlib's filtering by level is used so
    possibly expensive processors like exception formatters are avoided in the
    first place.

    >>> import logging
    >>> from structlog.stdlib import filter_by_level
    >>> logging.basicConfig(level=logging.WARN)
    >>> logger = logging.getLogger()
    >>> filter_by_level(logger, 'warn', {})
    {}
    >>> filter_by_level(logger, 'debug', {})
    Traceback (most recent call last):
    ...
    DropEvent
    """
    if (
        # We can't use logger.isEnabledFor() because it's always disabled when
        # a log entry is in flight on Python 3.14 and later,
        not logger.disabled
        and NAME_TO_LEVEL[method_name] >= logger.getEffectiveLevel()
    ):
        return event_dict

    raise DropEvent


def add_log_level_number(
    logger: logging.Logger, method_name: str, event_dict: EventDict
) -> EventDict:
    """
    Add the log level number to the event dict.

    Log level numbers map to the log level names. The Python stdlib uses them
    for filtering logic. This adds the same numbers so users can leverage
    similar filtering. Compare::

       level in ("warning", "error", "critical")
       level_number >= 30

    The mapping of names to numbers is in
    ``structlog.stdlib._log_levels._NAME_TO_LEVEL``.

    .. versionadded:: 18.2.0
    """
    event_dict["level_number"] = NAME_TO_LEVEL[method_name]

    return event_dict


def add_logger_name(
    logger: logging.Logger, method_name: str, event_dict: EventDict
) -> EventDict:
    """
    Add the logger name to the event dict.
    """
    record = event_dict.get("_record")
    if record is None:
        event_dict["logger"] = logger.name
    else:
        event_dict["logger"] = record.name
    return event_dict


_LOG_RECORD_KEYS = logging.LogRecord(
    "name", 0, "pathname", 0, "msg", (), None
).__dict__.keys()


class ExtraAdder:
    """
    Add extra attributes of `logging.LogRecord` objects to the event
    dictionary.

    This processor can be used for adding data passed in the ``extra``
    parameter of the `logging` module's log methods to the event dictionary.

    Args:
        allow:
            An optional collection of attributes that, if present in
            `logging.LogRecord` objects, will be copied to event dictionaries.

            If ``allow`` is None all attributes of `logging.LogRecord` objects
            that do not exist on a standard `logging.LogRecord` object will be
            copied to event dictionaries.

    .. versionadded:: 21.5.0
    """

    __slots__ = ("_copier",)

    def __init__(self, allow: Collection[str] | None = None) -> None:
        self._copier: Callable[[EventDict, logging.LogRecord], None]
        if allow is not None:
            # The contents of allow is copied to a new list so that changes to
            # the list passed into the constructor does not change the
            # behaviour of this processor.
            self._copier = functools.partial(self._copy_allowed, [*allow])
        else:
            self._copier = self._copy_all

    def __call__(
        self, logger: logging.Logger, name: str, event_dict: EventDict
    ) -> EventDict:
        record: logging.LogRecord | None = event_dict.get("_record")
        if record is not None:
            self._copier(event_dict, record)
        return event_dict

    @classmethod
    def _copy_all(
        cls, event_dict: EventDict, record: logging.LogRecord
    ) -> None:
        for key, value in record.__dict__.items():
            if key not in _LOG_RECORD_KEYS:
                event_dict[key] = value

    @classmethod
    def _copy_allowed(
        cls,
        allow: Collection[str],
        event_dict: EventDict,
        record: logging.LogRecord,
    ) -> None:
        for key in allow:
            if key in record.__dict__:
                event_dict[key] = record.__dict__[key]


LOG_KWARG_NAMES = ("exc_info", "stack_info", "stacklevel")


def render_to_log_args_and_kwargs(
    _: logging.Logger, __: str, event_dict: EventDict
) -> tuple[tuple[Any, ...], dict[str, Any]]:
    """
    Render ``event_dict`` into positional and keyword arguments for
    `logging.Logger` logging methods.
    See `logging.Logger.debug` method for keyword arguments reference.

    The ``event`` field is passed in the first positional argument, positional
    arguments from ``positional_args`` field are passed in subsequent positional
    arguments, keyword arguments are extracted from the *event_dict* and the
    rest of the *event_dict* is added as ``extra``.

    This allows you to defer formatting to `logging`.

    .. versionadded:: 25.1.0
    """
    args = (event_dict.pop("event"), *event_dict.pop("positional_args", ()))

    kwargs = {
        kwarg_name: event_dict.pop(kwarg_name)
        for kwarg_name in LOG_KWARG_NAMES
        if kwarg_name in event_dict
    }
    if event_dict:
        kwargs["extra"] = event_dict

    return args, kwargs


def render_to_log_kwargs(
    _: logging.Logger, __: str, event_dict: EventDict
) -> EventDict:
    """
    Render ``event_dict`` into keyword arguments for `logging.Logger` logging
    methods.
    See `logging.Logger.debug` method for keyword arguments reference.

    The ``event`` field is translated into ``msg``, keyword arguments are
    extracted from the *event_dict* and the rest of the *event_dict* is added as
    ``extra``.

    This allows you to defer formatting to `logging`.

    .. versionadded:: 17.1.0
    .. versionchanged:: 22.1.0
       ``exc_info``, ``stack_info``, and ``stacklevel`` are passed as proper
       kwargs and not put into ``extra``.
    .. versionchanged:: 24.2.0
       ``stackLevel`` corrected to ``stacklevel``.
    """
    return {
        "msg": event_dict.pop("event"),
        "extra": event_dict,
        **{
            kw: event_dict.pop(kw)
            for kw in LOG_KWARG_NAMES
            if kw in event_dict
        },
    }


class ProcessorFormatter(logging.Formatter):
    r"""
    Call *structlog* processors on `logging.LogRecord`\s.

    This is an implementation of a `logging.Formatter` that can be used to
    format log entries from both *structlog* and `logging`.

    Its static method `wrap_for_formatter` must be the final processor in
    *structlog*'s processor chain.

    Please refer to :ref:`processor-formatter` for examples.

    Args:
        foreign_pre_chain:
            If not `None`, it is used as a processor chain that is applied to
            **non**-*structlog* log entries before the event dictionary is
            passed to *processors*. (default: `None`)

        processors:
            A chain of *structlog* processors that is used to process **all**
            log entries. The last one must render to a `str` which then gets
            passed on to `logging` for output.

            Compared to *structlog*'s regular processor chains, there's a few
            differences:

            - The event dictionary contains two additional keys:

              #. ``_record``: a `logging.LogRecord` that either was created
                  using `logging` APIs, **or** is a wrapped *structlog* log
                  entry created by `wrap_for_formatter`.

              #. ``_from_structlog``: a `bool` that indicates whether or not
                 ``_record`` was created by a *structlog* logger.

              Since you most likely don't want ``_record`` and
              ``_from_structlog`` in your log files,  we've added the static
              method `remove_processors_meta` to ``ProcessorFormatter`` that
              you can add just before your renderer.

            - Since this is a `logging` *formatter*, raising
              `structlog.DropEvent` will crash your application.

        keep_exc_info:
            ``exc_info`` on `logging.LogRecord`\ s is added to the
            ``event_dict`` and removed afterwards. Set this to ``True`` to keep
            it on the `logging.LogRecord`. (default: False)

        keep_stack_info:
            Same as *keep_exc_info* except for ``stack_info``. (default: False)

        logger:
            Logger which we want to push through the *structlog* processor
            chain. This parameter is necessary for some of the processors like
            `filter_by_level`. (default: None)

        pass_foreign_args:
            If True, pass a foreign log record's ``args`` attribute to the
            ``event_dict`` under ``positional_args`` key. (default: False)

        processor:
            A single *structlog* processor used for rendering the event
            dictionary before passing it off to `logging`. Must return a `str`.
            The event dictionary does **not** contain ``_record`` and
            ``_from_structlog``.

            This parameter exists for historic reasons. Please use *processors*
            instead.

        use_get_message:
            If True, use ``record.getMessage`` to get a fully rendered log
            message, otherwise use ``str(record.msg)``. (default: True)

    Raises:
        TypeError: If both or neither *processor* and *processors* are passed.

    .. versionadded:: 17.1.0
    .. versionadded:: 17.2.0 *keep_exc_info* and *keep_stack_info*
    .. versionadded:: 19.2.0 *logger*
    .. versionadded:: 19.2.0 *pass_foreign_args*
    .. versionadded:: 21.3.0 *processors*
    .. deprecated:: 21.3.0
       *processor* (singular) in favor of *processors* (plural). Removal is not
       planned.
    .. versionadded:: 23.3.0 *use_get_message*
    """

    def __init__(
        self,
        processor: Processor | None = None,
        processors: Sequence[Processor] | None = (),
        foreign_pre_chain: Sequence[Processor] | None = None,
        keep_exc_info: bool = False,
        keep_stack_info: bool = False,
        logger: logging.Logger | None = None,
        pass_foreign_args: bool = False,
        use_get_message: bool = True,
        *args: Any,
        **kwargs: Any,
    ) -> None:
        fmt = kwargs.pop("fmt", "%(message)s")
        super().__init__(*args, fmt=fmt, **kwargs)  # type: ignore[misc]

        if processor and processors:
            msg = (
                "The `processor` and `processors` arguments are mutually"
                " exclusive."
            )
            raise TypeError(msg)

        self.processors: Sequence[Processor]
        if processor is not None:
            self.processors = (self.remove_processors_meta, processor)
        elif processors:
            self.processors = processors
        else:
            msg = "Either `processor` or `processors` must be passed."
            raise TypeError(msg)

        self.foreign_pre_chain = foreign_pre_chain
        self.keep_exc_info = keep_exc_info
        self.keep_stack_info = keep_stack_info
        self.logger = logger
        self.pass_foreign_args = pass_foreign_args
        self.use_get_message = use_get_message

    def format(self, record: logging.LogRecord) -> str:
        """
        Extract *structlog*'s `event_dict` from ``record.msg`` and format it.

        *record* has been patched by `wrap_for_formatter` first though, so the
         type isn't quite right.
        """
        # Make a shallow copy of the record to let other handlers/formatters
        # process the original one
        record = logging.makeLogRecord(record.__dict__)

        logger = getattr(record, "_logger", _SENTINEL)
        meth_name = getattr(record, "_name", "__structlog_sentinel__")

        ed: ProcessorReturnValue
        if logger is not _SENTINEL and meth_name != "__structlog_sentinel__":
            # Both attached by wrap_for_formatter
            if self.logger is not None:
                logger = self.logger
            meth_name = cast(str, record._name)  # type:ignore[attr-defined]

            # We need to copy because it's possible that the same record gets
            # processed by multiple logging formatters. LogRecord.getMessage
            # would transform our dict into a str.
            ed = cast(Dict[str, Any], record.msg).copy()
            ed["_record"] = record
            ed["_from_structlog"] = True
        else:
            logger = self.logger
            meth_name = record.levelname.lower()
            ed = {
                "event": (
                    record.getMessage()
                    if self.use_get_message
                    else str(record.msg)
                ),
                "_record": record,
                "_from_structlog": False,
            }

            if self.pass_foreign_args:
                ed["positional_args"] = record.args

            record.args = ()

            # Add stack-related attributes to the event dict
            if record.exc_info:
                ed["exc_info"] = record.exc_info
            if record.stack_info:
                ed["stack_info"] = record.stack_info

            # Non-structlog allows to run through a chain to prepare it for the
            # final processor (e.g. adding timestamps and log levels).
            for proc in self.foreign_pre_chain or ():
                ed = cast(EventDict, proc(logger, meth_name, ed))

        # If required, unset stack-related attributes on the record copy so
        # that the base implementation doesn't append stacktraces to the
        # output.
        if not self.keep_exc_info:
            record.exc_text = None
            record.exc_info = None
        if not self.keep_stack_info:
            record.stack_info = None

        for p in self.processors:
            ed = p(logger, meth_name, ed)  # type: ignore[arg-type]

        if not isinstance(ed, str):
            warnings.warn(
                "The last processor in ProcessorFormatter.processors must "
                f"return a string, but {self.processors[-1]} returned a "
                f"{type(ed)} instead.",
                category=RuntimeWarning,
                stacklevel=1,
            )
            ed = cast(str, ed)

        record.msg = ed

        return super().format(record)

    @staticmethod
    def wrap_for_formatter(
        logger: logging.Logger, name: str, event_dict: EventDict
    ) -> tuple[tuple[EventDict], dict[str, dict[str, Any]]]:
        """
        Wrap *logger*, *name*, and *event_dict*.

        The result is later unpacked by `ProcessorFormatter` when formatting
        log entries.

        Use this static method as the renderer (in other words, final
        processor) if you want to use `ProcessorFormatter` in your `logging`
        configuration.
        """
        return (event_dict,), {"extra": {"_logger": logger, "_name": name}}

    @staticmethod
    def remove_processors_meta(
        _: WrappedLogger, __: str, event_dict: EventDict
    ) -> EventDict:
        """
        Remove ``_record`` and ``_from_structlog`` from *event_dict*.

        These keys are added to the event dictionary, before
        `ProcessorFormatter`'s *processors* are run.

        .. versionadded:: 21.3.0
        """
        del event_dict["_record"]
        del event_dict["_from_structlog"]

        return event_dict
