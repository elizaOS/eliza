# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0
#
# Portions derived from  https://github.com/microsoft/autogen are under the MIT License.
# SPDX-License-Identifier: MIT
from typing import Any, Literal, Optional

from ..doc_utils import export_module
from .base_logger import BaseLogger
from .file_logger import FileLogger
from .sqlite_logger import SqliteLogger

__all__ = ("LoggerFactory",)


@export_module("autogen.logger")
class LoggerFactory:
    """Factory class to create logger objects."""

    @staticmethod
    def get_logger(
        logger_type: Literal["sqlite", "file"] = "sqlite", config: Optional[dict[str, Any]] = None
    ) -> BaseLogger:
        """Factory method to create logger objects.

        Args:
            logger_type (Literal["sqlite", "file"], optional): Type of logger. Defaults to "sqlite".
            config (Optional[dict[str, Any]], optional): Configuration for logger. Defaults to None.

        Returns:
            BaseLogger: Logger object
        """
        if config is None:
            config = {}

        if logger_type == "sqlite":
            return SqliteLogger(config)
        elif logger_type == "file":
            return FileLogger(config)
        else:
            raise ValueError(f"[logger_factory] Unknown logger type: {logger_type}")
