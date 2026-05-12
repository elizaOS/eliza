# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any, Optional, Protocol, runtime_checkable

from ..doc_utils import export_module
from ..tools import Tool

__all__ = ["Interoperable"]


@runtime_checkable
@export_module("autogen.interop")
class Interoperable(Protocol):
    """A Protocol defining the interoperability interface for tool conversion.

    This protocol ensures that any class implementing it provides the method
    `convert_tool` to convert a given tool into a desired format or type.
    """

    @classmethod
    def convert_tool(cls, tool: Any, **kwargs: Any) -> Tool:
        """Converts a given tool to a desired format or type.

        This method should be implemented by any class adhering to the `Interoperable` protocol.

        Args:
            tool (Any): The tool object to be converted.
            **kwargs (Any): Additional parameters to pass during the conversion process.

        Returns:
            Tool: The converted tool in the desired format or type.
        """
        ...

    @classmethod
    def get_unsupported_reason(cls) -> Optional[str]:
        """Returns the reason for the tool being unsupported.

        This method should be implemented by any class adhering to the `Interoperable` protocol.

        Returns:
            str: The reason for the interoperability class being unsupported.
        """
        ...
