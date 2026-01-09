"""
Logger module for elizaOS.

This module provides structured logging functionality using structlog.
"""

from __future__ import annotations

import logging
import sys
from typing import Any

import structlog


def configure_structlog(log_level: str = "INFO") -> None:
    """Configure structlog for the application."""
    # Configure standard library logging
    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=getattr(logging, log_level.upper(), logging.INFO),
    )

    # Configure structlog
    structlog.configure(
        processors=[
            structlog.stdlib.filter_by_level,
            structlog.stdlib.add_logger_name,
            structlog.stdlib.add_log_level,
            structlog.stdlib.PositionalArgumentsFormatter(),
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.UnicodeDecoder(),
            structlog.dev.ConsoleRenderer(colors=True),
        ],
        wrapper_class=structlog.stdlib.BoundLogger,
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )


class Logger:
    """
    Logger class that wraps structlog for consistent logging across elizaOS.
    """

    def __init__(
        self,
        namespace: str | None = None,
        level: str = "INFO",
    ) -> None:
        """
        Initialize the logger.

        Args:
            namespace: Optional namespace for the logger (e.g., agent name)
            level: Log level (DEBUG, INFO, WARNING, ERROR)
        """
        self._namespace = namespace or "elizaos"
        self._level = level
        self._logger = structlog.get_logger(self._namespace)

    @property
    def namespace(self) -> str:
        """Get the logger namespace."""
        return self._namespace

    def _log(
        self,
        level: str,
        message: str,
        *args: Any,
        **kwargs: Any,
    ) -> None:
        """Internal logging method."""
        log_method = getattr(self._logger, level.lower(), self._logger.info)
        if args:
            log_method(message, *args, **kwargs)
        else:
            log_method(message, **kwargs)

    def debug(self, message: str, *args: Any, **kwargs: Any) -> None:
        """Log a debug message."""
        self._log("debug", message, *args, **kwargs)

    def info(self, message: str, *args: Any, **kwargs: Any) -> None:
        """Log an info message."""
        self._log("info", message, *args, **kwargs)

    def warn(self, message: str, *args: Any, **kwargs: Any) -> None:
        """Log a warning message."""
        self._log("warning", message, *args, **kwargs)

    def warning(self, message: str, *args: Any, **kwargs: Any) -> None:
        """Log a warning message (alias for warn)."""
        self._log("warning", message, *args, **kwargs)

    def error(self, message: str, *args: Any, **kwargs: Any) -> None:
        """Log an error message."""
        self._log("error", message, *args, **kwargs)

    def exception(self, message: str, *args: Any, **kwargs: Any) -> None:
        """Log an exception with traceback."""
        self._log("exception", message, *args, exc_info=True, **kwargs)

    def bind(self, **kwargs: Any) -> Logger:
        """Create a new logger with bound context."""
        new_logger = Logger(namespace=self._namespace, level=self._level)
        new_logger._logger = self._logger.bind(**kwargs)
        return new_logger


def create_logger(
    namespace: str | None = None,
    level: str = "INFO",
) -> Logger:
    """
    Create a new logger instance.

    Args:
        namespace: Optional namespace for the logger
        level: Log level (DEBUG, INFO, WARNING, ERROR)

    Returns:
        A configured Logger instance
    """
    return Logger(namespace=namespace, level=level)


# Initialize structlog on module load
configure_structlog()

# Default logger instance
logger = create_logger()

