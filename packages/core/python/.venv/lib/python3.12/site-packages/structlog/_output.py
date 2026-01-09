# SPDX-License-Identifier: MIT OR Apache-2.0
# This file is dual licensed under the terms of the Apache License, Version
# 2.0, and the MIT License.  See the LICENSE file in the root of this
# repository for complete details.

"""
Logger classes responsible for output.
"""

from __future__ import annotations

import copy
import sys
import threading

from pickle import PicklingError
from sys import stderr, stdout
from typing import IO, Any, BinaryIO, TextIO


WRITE_LOCKS: dict[IO[Any], threading.Lock] = {}


def _get_lock_for_file(file: IO[Any]) -> threading.Lock:
    lock = WRITE_LOCKS.get(file)
    if lock is None:
        lock = threading.Lock()
        WRITE_LOCKS[file] = lock

    return lock


class PrintLogger:
    """
    Print events into a file.

    Args:
        file: File to print to. (default: `sys.stdout`)

    >>> from structlog import PrintLogger
    >>> PrintLogger().info("hello")
    hello

    Useful if you follow `current logging best practices
    <logging-best-practices>`.

    Also very useful for testing and examples since `logging` is finicky in
    doctests.

    .. versionchanged:: 22.1.0
       The implementation has been switched to use `print` for better
       monkeypatchability.
    """

    def __init__(self, file: TextIO | None = None):
        self._file = file or stdout

        self._lock = _get_lock_for_file(self._file)

    def __getstate__(self) -> str:
        """
        Our __getattr__ magic makes this necessary.
        """
        if self._file is stdout:
            return "stdout"

        if self._file is stderr:
            return "stderr"

        raise PicklingError(
            "Only PrintLoggers to sys.stdout and sys.stderr can be pickled."
        )

    def __setstate__(self, state: Any) -> None:
        """
        Our __getattr__ magic makes this necessary.
        """
        if state == "stdout":
            self._file = stdout
        else:
            self._file = stderr

        self._lock = _get_lock_for_file(self._file)

    def __deepcopy__(self, memodict: dict[str, object]) -> PrintLogger:
        """
        Create a new PrintLogger with the same attributes. Similar to pickling.
        """
        if self._file not in (stdout, stderr):
            raise copy.error(
                "Only PrintLoggers to sys.stdout and sys.stderr "
                "can be deepcopied."
            )

        newself = self.__class__(self._file)

        newself._lock = _get_lock_for_file(newself._file)

        return newself

    def __repr__(self) -> str:
        return f"<PrintLogger(file={self._file!r})>"

    def msg(self, message: str) -> None:
        """
        Print *message*.
        """
        f = self._file if self._file is not stdout else None
        with self._lock:
            print(message, file=f, flush=True)

    log = debug = info = warn = warning = msg
    fatal = failure = err = error = critical = exception = msg


class PrintLoggerFactory:
    r"""
    Produce `PrintLogger`\ s.

    To be used with `structlog.configure`\ 's ``logger_factory``.

    Args:
        file: File to print to. (default: `sys.stdout`)

    Positional arguments are silently ignored.

    .. versionadded:: 0.4.0
    """

    def __init__(self, file: TextIO | None = None):
        self._file = file

    def __call__(self, *args: Any) -> PrintLogger:
        return PrintLogger(self._file)


class WriteLogger:
    """
    Write events into a file.

    Args:
        file: File to print to. (default: `sys.stdout`)

    >>> from structlog import WriteLogger
    >>> WriteLogger().info("hello")
    hello

    Useful if you follow
    `current logging best practices <logging-best-practices>`.

    Also very useful for testing and examples since `logging` is finicky in
    doctests.

    A little faster and a little less versatile than `structlog.PrintLogger`.

    .. versionadded:: 22.1.0
    """

    def __init__(self, file: TextIO | None = None):
        self._file = file or sys.stdout
        self._write = self._file.write
        self._flush = self._file.flush

        self._lock = _get_lock_for_file(self._file)

    def __getstate__(self) -> str:
        """
        Our __getattr__ magic makes this necessary.
        """
        if self._file is stdout:
            return "stdout"

        if self._file is stderr:
            return "stderr"

        raise PicklingError(
            "Only WriteLoggers to sys.stdout and sys.stderr can be pickled."
        )

    def __setstate__(self, state: Any) -> None:
        """
        Our __getattr__ magic makes this necessary.
        """
        if state == "stdout":
            self._file = stdout
        else:
            self._file = stderr

        self._lock = _get_lock_for_file(self._file)

    def __deepcopy__(self, memodict: dict[str, object]) -> WriteLogger:
        """
        Create a new WriteLogger with the same attributes. Similar to pickling.
        """
        if self._file not in (sys.stdout, sys.stderr):
            raise copy.error(
                "Only WriteLoggers to sys.stdout and sys.stderr "
                "can be deepcopied."
            )

        newself = self.__class__(self._file)

        newself._write = newself._file.write
        newself._flush = newself._file.flush
        newself._lock = _get_lock_for_file(newself._file)

        return newself

    def __repr__(self) -> str:
        return f"<WriteLogger(file={self._file!r})>"

    def msg(self, message: str) -> None:
        """
        Write and flush *message*.
        """
        with self._lock:
            self._write(message + "\n")
            self._flush()

    log = debug = info = warn = warning = msg
    fatal = failure = err = error = critical = exception = msg


class WriteLoggerFactory:
    r"""
    Produce `WriteLogger`\ s.

    To be used with `structlog.configure`\ 's ``logger_factory``.

    Args:
        file: File to print to. (default: `sys.stdout`)

    Positional arguments are silently ignored.

    .. versionadded:: 22.1.0
    """

    def __init__(self, file: TextIO | None = None):
        self._file = file

    def __call__(self, *args: Any) -> WriteLogger:
        return WriteLogger(self._file)


class BytesLogger:
    r"""
    Writes bytes into a file.

    Args:
        file: File to print to. (default: `sys.stdout`\ ``.buffer``)

    Useful if you follow `current logging best practices
    <logging-best-practices>` together with a formatter that returns bytes
    (e.g. `orjson <https://github.com/ijl/orjson>`_).

    .. versionadded:: 20.2.0
    """

    __slots__ = ("_file", "_flush", "_lock", "_write")

    def __init__(self, file: BinaryIO | None = None):
        self._file = file or sys.stdout.buffer
        self._write = self._file.write
        self._flush = self._file.flush

        self._lock = _get_lock_for_file(self._file)

    def __getstate__(self) -> str:
        """
        Our __getattr__ magic makes this necessary.
        """
        if self._file is sys.stdout.buffer:
            return "stdout"

        if self._file is sys.stderr.buffer:
            return "stderr"

        raise PicklingError(
            "Only BytesLoggers to sys.stdout and sys.stderr can be pickled."
        )

    def __setstate__(self, state: Any) -> None:
        """
        Our __getattr__ magic makes this necessary.
        """
        if state == "stdout":
            self._file = sys.stdout.buffer
        else:
            self._file = sys.stderr.buffer

        self._write = self._file.write
        self._flush = self._file.flush
        self._lock = _get_lock_for_file(self._file)

    def __deepcopy__(self, memodict: dict[str, object]) -> BytesLogger:
        """
        Create a new BytesLogger with the same attributes. Similar to pickling.
        """
        if self._file not in (sys.stdout.buffer, sys.stderr.buffer):
            raise copy.error(
                "Only BytesLoggers to sys.stdout and sys.stderr "
                "can be deepcopied."
            )

        newself = self.__class__(self._file)

        newself._write = newself._file.write
        newself._flush = newself._file.flush
        newself._lock = _get_lock_for_file(newself._file)

        return newself

    def __repr__(self) -> str:
        return f"<BytesLogger(file={self._file!r})>"

    def msg(self, message: bytes) -> None:
        """
        Write *message*.
        """
        with self._lock:
            self._write(message + b"\n")
            self._flush()

    log = debug = info = warn = warning = msg
    fatal = failure = err = error = critical = exception = msg


class BytesLoggerFactory:
    r"""
    Produce `BytesLogger`\ s.

    To be used with `structlog.configure`\ 's ``logger_factory``.

    Args:
        file: File to print to. (default: `sys.stdout`\ ``.buffer``)

    Positional arguments are silently ignored.

    .. versionadded:: 20.2.0
    """

    __slots__ = ("_file",)

    def __init__(self, file: BinaryIO | None = None):
        self._file = file

    def __call__(self, *args: Any) -> BytesLogger:
        return BytesLogger(self._file)
