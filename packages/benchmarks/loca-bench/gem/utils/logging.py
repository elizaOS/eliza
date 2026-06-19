# Copyright 2025 LOCA-bench Contributors. All Rights Reserved.
#
# Licensed under the MIT License.

"""Verbose-aware logging utilities for preprocessing scripts."""

import sys
from typing import Optional


class VerboseLogger:
    """A simple logger that respects verbose flag.

    When verbose=False (default), only errors are printed.
    When verbose=True, all messages are printed.
    """

    def __init__(self, verbose: bool = False):
        self.verbose = verbose

    def info(self, msg: str) -> None:
        """Print info message (only in verbose mode)."""
        if self.verbose:
            print(msg)

    def success(self, msg: str) -> None:
        """Print success message (only in verbose mode)."""
        if self.verbose:
            print(msg)

    def warning(self, msg: str) -> None:
        """Print warning message (only in verbose mode)."""
        if self.verbose:
            print(f"Warning: {msg}")

    def error(self, msg: str) -> None:
        """Print error message (always printed to stderr)."""
        print(msg, file=sys.stderr)

    def section(self, title: str, width: int = 60) -> None:
        """Print a section header (only in verbose mode)."""
        if self.verbose:
            print("=" * width)
            print(title)
            print("=" * width)

    def step(self, step_num: int, msg: str) -> None:
        """Print a step message (only in verbose mode)."""
        if self.verbose:
            print(f"\n{step_num}. {msg}")


# Global logger instance (default: quiet mode)
_logger: Optional[VerboseLogger] = None


def get_logger(verbose: bool = False) -> VerboseLogger:
    """Get or create the global logger instance.

    Args:
        verbose: If True, enable verbose output.

    Returns:
        VerboseLogger instance.
    """
    global _logger
    if _logger is None or _logger.verbose != verbose:
        _logger = VerboseLogger(verbose)
    return _logger


def setup_logger(verbose: bool = False) -> VerboseLogger:
    """Set up and return a new logger instance.

    Args:
        verbose: If True, enable verbose output.

    Returns:
        VerboseLogger instance.
    """
    global _logger
    _logger = VerboseLogger(verbose)
    return _logger
