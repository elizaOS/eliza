# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0
from typing import Any

from ..doc_utils import export_module
from ..tools import Tool
from .interoperable import Interoperable
from .registry import InteroperableRegistry

__all__ = ["Interoperable"]


@export_module("autogen.interop")
class Interoperability:
    """A class to handle interoperability between different tool types.

    This class allows the conversion of tools to various interoperability classes and provides functionality
    for retrieving and registering interoperability classes.
    """

    registry = InteroperableRegistry.get_instance()

    @classmethod
    def convert_tool(cls, *, tool: Any, type: str, **kwargs: Any) -> Tool:
        """Converts a given tool to an instance of a specified interoperability type.

        Args:
            tool (Any): The tool object to be converted.
            type (str): The type of interoperability to convert the tool to.
            **kwargs (Any): Additional arguments to be passed during conversion.

        Returns:
            Tool: The converted tool.

        Raises:
            ValueError: If the interoperability class for the provided type is not found.
        """
        interop = cls.get_interoperability_class(type)
        return interop.convert_tool(tool, **kwargs)

    @classmethod
    def get_interoperability_class(cls, type: str) -> type[Interoperable]:
        """Retrieves the interoperability class corresponding to the specified type.

        Args:
            type (str): The type of the interoperability class to retrieve.

        Returns:
            type[Interoperable]: The interoperability class type.

        Raises:
            ValueError: If no interoperability class is found for the provided type.
        """
        supported_types = cls.registry.get_supported_types()
        if type not in supported_types:
            supported_types_formatted = ", ".join(["'t'" for t in supported_types])
            raise ValueError(
                f"Interoperability class {type} is not supported, supported types: {supported_types_formatted}"
            )

        return cls.registry.get_class(type)

    @classmethod
    def get_supported_types(cls) -> list[str]:
        """Returns a sorted list of all supported interoperability types.

        Returns:
            List[str]: A sorted list of strings representing the supported interoperability types.
        """
        return sorted(cls.registry.get_supported_types())
