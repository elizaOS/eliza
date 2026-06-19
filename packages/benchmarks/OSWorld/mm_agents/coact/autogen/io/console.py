# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0
#
# Portions derived from  https://github.com/microsoft/autogen are under the MIT License.
# SPDX-License-Identifier: MIT
import getpass
from typing import Any

from ..doc_utils import export_module
from ..events.base_event import BaseEvent
from ..events.print_event import PrintEvent
from .base import IOStream

__all__ = ("IOConsole",)


@export_module("autogen.io")
class IOConsole(IOStream):
    """A console input/output stream."""

    def print(self, *objects: Any, sep: str = " ", end: str = "\n", flush: bool = False) -> None:
        """Print data to the output stream.

        Args:
            objects (any): The data to print.
            sep (str, optional): The separator between objects. Defaults to " ".
            end (str, optional): The end of the output. Defaults to "\n".
            flush (bool, optional): Whether to flush the output. Defaults to False.
        """
        print_message = PrintEvent(*objects, sep=sep, end=end)
        self.send(print_message)
        # print(*objects, sep=sep, end=end, flush=flush)

    def send(self, message: BaseEvent) -> None:
        """Send a message to the output stream.

        Args:
            message (Any): The message to send.
        """
        message.print()

    def input(self, prompt: str = "", *, password: bool = False) -> str:
        """Read a line from the input stream.

        Args:
            prompt (str, optional): The prompt to display. Defaults to "".
            password (bool, optional): Whether to read a password. Defaults to False.

        Returns:
            str: The line read from the input stream.

        """
        if password:
            return getpass.getpass(prompt if prompt != "" else "Password: ")
        return input(prompt)
