# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import Annotated

from autogen.tools import Tool

from ....doc_utils import export_module

__all__ = ["TimeTool"]


@export_module("autogen.tools.contrib")  # API Reference: autogen > tools > contrib > TimeAgent
class TimeTool(Tool):
    """Outputs the current date and time of the computer."""

    def __init__(
        self,
        *,
        date_time_format: str = "%Y-%m-%d %H:%M:%S",  # This is a parameter that is unique to this tool
    ):
        """Get the date and time of the computer.

        Args:
            date_time_format (str, optional): The format of the date and time. Defaults to "%Y-%m-%d %H:%M:%S".
        """

        self._date_time_format = date_time_format

        async def get_date_and_time(
            date_time_format: Annotated[str, "date/time Python format"] = self._date_time_format,
        ) -> str:
            return datetime.now().strftime(date_time_format)

        super().__init__(
            name="date_time",
            description="Get the current computer's date and time.",
            func_or_tool=get_date_and_time,
        )
