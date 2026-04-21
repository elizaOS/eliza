# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

import re
import sys
from typing import Any, Optional

from ...doc_utils import export_module
from ...import_utils import optional_import_block, require_optional_import
from ...tools import Tool
from ..registry import register_interoperable_class

__all__ = ["CrewAIInteroperability"]


def _sanitize_name(s: str) -> str:
    return re.sub(r"\W|^(?=\d)", "_", s)


with optional_import_block():
    from crewai.tools import BaseTool as CrewAITool


@register_interoperable_class("crewai")
@export_module("autogen.interop")
class CrewAIInteroperability:
    """A class implementing the `Interoperable` protocol for converting CrewAI tools
    to a general `Tool` format.

    This class takes a `CrewAITool` and converts it into a standard `Tool` object.
    """

    @classmethod
    @require_optional_import("crewai", "interop-crewai")
    def convert_tool(cls, tool: Any, **kwargs: Any) -> Tool:
        """Converts a given CrewAI tool into a general `Tool` format.

        This method ensures that the provided tool is a valid `CrewAITool`, sanitizes
        the tool's name, processes its description, and prepares a function to interact
        with the tool's arguments. It then returns a standardized `Tool` object.

        Args:
            tool (Any): The tool to convert, expected to be an instance of `CrewAITool`.
            **kwargs (Any): Additional arguments, which are not supported by this method.

        Returns:
            Tool: A standardized `Tool` object converted from the CrewAI tool.

        Raises:
            ValueError: If the provided tool is not an instance of `CrewAITool`, or if
                        any additional arguments are passed.
        """
        if not isinstance(tool, CrewAITool):
            raise ValueError(f"Expected an instance of `crewai.tools.BaseTool`, got {type(tool)}")
        if kwargs:
            raise ValueError(f"The CrewAIInteroperability does not support any additional arguments, got {kwargs}")

        # needed for type checking
        crewai_tool: CrewAITool = tool  # type: ignore[no-any-unimported]

        name = _sanitize_name(crewai_tool.name)
        description = (
            crewai_tool.description.split("Tool Description: ")[-1]
            + " (IMPORTANT: When using arguments, put them all in an `args` dictionary)"
        )

        def func(args: crewai_tool.args_schema) -> Any:  # type: ignore[no-any-unimported]
            return crewai_tool.run(**args.model_dump())

        return Tool(
            name=name,
            description=description,
            func_or_tool=func,
        )

    @classmethod
    def get_unsupported_reason(cls) -> Optional[str]:
        if sys.version_info < (3, 10) or sys.version_info >= (3, 13):
            return "This submodule is only supported for Python versions 3.10, 3.11, and 3.12"

        with optional_import_block() as result:
            import crewai.tools  # noqa: F401

        if not result.is_successful:
            return "Please install `interop-crewai` extra to use this module:\n\n\tpip install ag2[interop-crewai]"

        return None
