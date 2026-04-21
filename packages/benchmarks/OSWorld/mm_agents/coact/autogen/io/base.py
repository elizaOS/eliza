# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0
#
# Portions derived from  https://github.com/microsoft/autogen are under the MIT License.
# SPDX-License-Identifier: MIT
import logging
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Optional, Protocol, Union, runtime_checkable

from ..doc_utils import export_module
from ..events.base_event import BaseEvent

__all__ = ("IOStream", "InputStream", "OutputStream")

logger = logging.getLogger(__name__)


@runtime_checkable
@export_module("autogen.io")
class OutputStream(Protocol):
    def print(self, *objects: Any, sep: str = " ", end: str = "\n", flush: bool = False) -> None:
        """Print data to the output stream.

        Args:
            objects (any): The data to print.
            sep (str, optional): The separator between objects. Defaults to " ".
            end (str, optional): The end of the output. Defaults to "\n".
            flush (bool, optional): Whether to flush the output. Defaults to False.
        """
        ...  # pragma: no cover

    def send(self, message: BaseEvent) -> None:
        """Send data to the output stream.

        Args:
            message (BaseEvent): BaseEvent from autogen.messages.base_message
        """
        ...


@runtime_checkable
@export_module("autogen.io")
class InputStream(Protocol):
    def input(self, prompt: str = "", *, password: bool = False) -> str:
        """Read a line from the input stream.

        Args:
            prompt (str, optional): The prompt to display. Defaults to "".
            password (bool, optional): Whether to read a password. Defaults to False.

        Returns:
            str: The line read from the input stream.

        """
        ...  # pragma: no cover


@runtime_checkable
@export_module("autogen.io")
class AsyncInputStream(Protocol):
    async def input(self, prompt: str = "", *, password: bool = False) -> str:
        """Read a line from the input stream.

        Args:
            prompt (str, optional): The prompt to display. Defaults to "".
            password (bool, optional): Whether to read a password. Defaults to False.

        Returns:
            str: The line read from the input stream.

        """
        ...  # pragma: no cover


@runtime_checkable
@export_module("autogen.io")
class IOStreamProtocol(InputStream, OutputStream, Protocol):
    """A protocol for input/output streams."""


@runtime_checkable
@export_module("autogen.io")
class AsyncIOStreamProtocol(AsyncInputStream, OutputStream, Protocol):
    """A protocol for input/output streams."""


iostream_union = Union[IOStreamProtocol, AsyncIOStreamProtocol]


@export_module("autogen.io")
class IOStream:
    """A protocol for input/output streams."""

    # ContextVar must be used in multithreaded or async environments
    _default_io_stream: ContextVar[Optional[iostream_union]] = ContextVar("default_iostream", default=None)
    _default_io_stream.set(None)
    _global_default: Optional[iostream_union] = None

    @staticmethod
    def set_global_default(stream: iostream_union) -> None:
        """Set the default input/output stream.

        Args:
            stream (IOStream): The input/output stream to set as the default.
        """
        IOStream._global_default = stream

    @staticmethod
    def get_global_default() -> iostream_union:
        """Get the default input/output stream.

        Returns:
            IOStream: The default input/output stream.
        """
        if IOStream._global_default is None:
            raise RuntimeError("No global default IOStream has been set")
        return IOStream._global_default

    @staticmethod
    def get_default() -> iostream_union:
        """Get the default input/output stream.

        Returns:
            IOStream: The default input/output stream.
        """
        iostream = IOStream._default_io_stream.get()
        if iostream is None:
            iostream = IOStream.get_global_default()
            # Set the default IOStream of the current context (thread/cooroutine)
            IOStream.set_default(iostream)
        return iostream

    @staticmethod
    @contextmanager
    def set_default(stream: Optional[iostream_union]) -> Iterator[None]:
        """Set the default input/output stream.

        Args:
            stream (IOStream): The input/output stream to set as the default.
        """
        global _default_io_stream
        try:
            token = IOStream._default_io_stream.set(stream)
            yield
        finally:
            IOStream._default_io_stream.reset(token)

        return
