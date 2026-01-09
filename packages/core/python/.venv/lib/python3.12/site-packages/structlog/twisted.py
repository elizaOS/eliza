# SPDX-License-Identifier: MIT OR Apache-2.0
# This file is dual licensed under the terms of the Apache License, Version
# 2.0, and the MIT License.  See the LICENSE file in the root of this
# repository for complete details.

"""
Processors and tools specific to the `Twisted <https://twisted.org/>`_
networking engine.

See also :doc:`structlog's Twisted support <twisted>`.
"""

from __future__ import annotations

import json
import sys

from typing import Any, Callable, Sequence, TextIO

from twisted.python import log
from twisted.python.failure import Failure
from twisted.python.log import ILogObserver, textFromEventDict
from zope.interface import implementer

from ._base import BoundLoggerBase
from ._config import _BUILTIN_DEFAULT_PROCESSORS
from .processors import JSONRenderer as GenericJSONRenderer
from .typing import EventDict, WrappedLogger


class BoundLogger(BoundLoggerBase):
    """
    Twisted-specific version of `structlog.BoundLogger`.

    Works exactly like the generic one except that it takes advantage of
    knowing the logging methods in advance.

    Use it like::

        configure(
            wrapper_class=structlog.twisted.BoundLogger,
        )

    """

    def msg(self, event: str | None = None, **kw: Any) -> Any:
        """
        Process event and call ``log.msg()`` with the result.
        """
        return self._proxy_to_logger("msg", event, **kw)

    def err(self, event: str | None = None, **kw: Any) -> Any:
        """
        Process event and call ``log.err()`` with the result.
        """
        return self._proxy_to_logger("err", event, **kw)


class LoggerFactory:
    """
    Build a Twisted logger when an *instance* is called.

    >>> from structlog import configure
    >>> from structlog.twisted import LoggerFactory
    >>> configure(logger_factory=LoggerFactory())
    """

    def __call__(self, *args: Any) -> WrappedLogger:
        """
        Positional arguments are silently ignored.

        :rvalue: A new Twisted logger.

        .. versionchanged:: 0.4.0
            Added support for optional positional arguments.
        """
        return log


_FAIL_TYPES = (BaseException, Failure)


def _extractStuffAndWhy(eventDict: EventDict) -> tuple[Any, Any, EventDict]:
    """
    Removes all possible *_why*s and *_stuff*s, analyzes exc_info and returns
    a tuple of ``(_stuff, _why, eventDict)``.

    **Modifies** *eventDict*!
    """
    _stuff = eventDict.pop("_stuff", None)
    _why = eventDict.pop("_why", None)
    event = eventDict.pop("event", None)

    if isinstance(_stuff, _FAIL_TYPES) and isinstance(event, _FAIL_TYPES):
        raise ValueError("Both _stuff and event contain an Exception/Failure.")

    # `log.err('event', _why='alsoEvent')` is ambiguous.
    if _why and isinstance(event, str):
        raise ValueError("Both `_why` and `event` supplied.")

    # Two failures are ambiguous too.
    if not isinstance(_stuff, _FAIL_TYPES) and isinstance(event, _FAIL_TYPES):
        _why = _why or "error"
        _stuff = event

    if isinstance(event, str):
        _why = event

    if not _stuff and sys.exc_info() != (None, None, None):
        _stuff = Failure()  # type: ignore[no-untyped-call]

    # Either we used the error ourselves or the user supplied one for
    # formatting.  Avoid log.err() to dump another traceback into the log.
    if isinstance(_stuff, BaseException) and not isinstance(_stuff, Failure):
        _stuff = Failure(_stuff)  # type: ignore[no-untyped-call]

    return _stuff, _why, eventDict


class ReprWrapper:
    """
    Wrap a string and return it as the ``__repr__``.

    This is needed for ``twisted.python.log.err`` that calls `repr` on
    ``_stuff``:

    >>> repr("foo")
    "'foo'"
    >>> repr(ReprWrapper("foo"))
    'foo'

    Note the extra quotes in the unwrapped example.
    """

    def __init__(self, string: str) -> None:
        self.string = string

    def __eq__(self, other: object) -> bool:
        """
        Check for equality, just for tests.
        """
        return (
            isinstance(other, self.__class__) and self.string == other.string
        )

    def __repr__(self) -> str:
        return self.string


class JSONRenderer(GenericJSONRenderer):
    """
    Behaves like `structlog.processors.JSONRenderer` except that it formats
    tracebacks and failures itself if called with ``err()``.

    .. note::

        This ultimately means that the messages get logged out using ``msg()``,
        and *not* ``err()`` which renders failures in separate lines.

        Therefore it will break your tests that contain assertions using
        `flushLoggedErrors
        <https://docs.twisted.org/en/stable/api/
        twisted.trial.unittest.SynchronousTestCase.html#flushLoggedErrors>`_.

    *Not* an adapter like `EventAdapter` but a real formatter.  Also does *not*
    require to be adapted using it.

    Use together with a `JSONLogObserverWrapper`-wrapped Twisted logger like
    `plainJSONStdOutLogger` for pure-JSON logs.
    """

    def __call__(  # type: ignore[override]
        self,
        logger: WrappedLogger,
        name: str,
        eventDict: EventDict,
    ) -> tuple[Sequence[Any], dict[str, Any]]:
        _stuff, _why, eventDict = _extractStuffAndWhy(eventDict)
        if name == "err":
            eventDict["event"] = _why
            if isinstance(_stuff, Failure):
                eventDict["exception"] = _stuff.getTraceback(detail="verbose")
                _stuff.cleanFailure()  # type: ignore[no-untyped-call]
        else:
            eventDict["event"] = _why
        return (
            (
                ReprWrapper(
                    GenericJSONRenderer.__call__(  # type: ignore[arg-type]
                        self, logger, name, eventDict
                    )
                ),
            ),
            {"_structlog": True},
        )


@implementer(ILogObserver)
class PlainFileLogObserver:
    """
    Write only the plain message without timestamps or anything else.

    Great to just print JSON to stdout where you catch it with something like
    runit.

    Args:
        file: File to print to.

    .. versionadded:: 0.2.0
    """

    def __init__(self, file: TextIO) -> None:
        self._write = file.write
        self._flush = file.flush

    def __call__(self, eventDict: EventDict) -> None:
        self._write(
            textFromEventDict(eventDict)  # type: ignore[arg-type, operator]
            + "\n",
        )
        self._flush()


@implementer(ILogObserver)
class JSONLogObserverWrapper:
    """
    Wrap a log *observer* and render non-`JSONRenderer` entries to JSON.

    Args:
        observer (ILogObserver):
            Twisted log observer to wrap.  For example
            :class:`PlainFileObserver` or Twisted's stock `FileLogObserver
            <https://docs.twisted.org/en/stable/api/
            twisted.python.log.FileLogObserver.html>`_

    .. versionadded:: 0.2.0
    """

    def __init__(self, observer: Any) -> None:
        self._observer = observer

    def __call__(self, eventDict: EventDict) -> str:
        if "_structlog" not in eventDict:
            eventDict["message"] = (
                json.dumps(
                    {
                        "event": textFromEventDict(
                            eventDict  # type: ignore[arg-type]
                        ),
                        "system": eventDict.get("system"),
                    }
                ),
            )
            eventDict["_structlog"] = True

        return self._observer(eventDict)


def plainJSONStdOutLogger() -> JSONLogObserverWrapper:
    """
    Return a logger that writes only the message to stdout.

    Transforms non-`JSONRenderer` messages to JSON.

    Ideal for JSONifying log entries from Twisted plugins and libraries that
    are outside of your control::

        $ twistd -n --logger structlog.twisted.plainJSONStdOutLogger web
        {"event": "Log opened.", "system": "-"}
        {"event": "twistd 13.1.0 (python 2.7.3) starting up.", "system": "-"}
        {"event": "reactor class: twisted...EPollReactor.", "system": "-"}
        {"event": "Site starting on 8080", "system": "-"}
        {"event": "Starting factory <twisted.web.server.Site ...>", ...}
        ...

    Composes `PlainFileLogObserver` and `JSONLogObserverWrapper` to a usable
    logger.

    .. versionadded:: 0.2.0
    """
    return JSONLogObserverWrapper(PlainFileLogObserver(sys.stdout))


class EventAdapter:
    """
    Adapt an ``event_dict`` to Twisted logging system.

    Particularly, make a wrapped `twisted.python.log.err
    <https://docs.twisted.org/en/stable/api/twisted.python.log.html#err>`_
    behave as expected.

    Args:
        dictRenderer:
            Renderer that is used for the actual log message. Please note that
            structlog comes with a dedicated `JSONRenderer`.

    **Must** be the last processor in the chain and requires a *dictRenderer*
    for the actual formatting as an constructor argument in order to be able to
    fully support the original behaviors of ``log.msg()`` and ``log.err()``.
    """

    def __init__(
        self,
        dictRenderer: (
            Callable[[WrappedLogger, str, EventDict], str] | None
        ) = None,
    ) -> None:
        self._dictRenderer = dictRenderer or _BUILTIN_DEFAULT_PROCESSORS[-1]

    def __call__(
        self, logger: WrappedLogger, name: str, eventDict: EventDict
    ) -> Any:
        if name == "err":
            # This aspires to handle the following cases correctly:
            #   1. log.err(failure, _why='event', **kw)
            #   2. log.err('event', **kw)
            #   3. log.err(_stuff=failure, _why='event', **kw)
            _stuff, _why, eventDict = _extractStuffAndWhy(eventDict)
            eventDict["event"] = _why

            return (
                (),
                {
                    "_stuff": _stuff,
                    "_why": self._dictRenderer(logger, name, eventDict),
                },
            )

        return self._dictRenderer(logger, name, eventDict)
