import logging
import os
import sys
from pathlib import Path


def setup_debug_logging(level: int = logging.INFO) -> None:
    """Configure root logger to output to stdout with a readable format.

    This mirrors the CLI app's behavior in a lightweight way so debug scripts
    emit logs without duplicating full file handler setup.
    """
    root_logger = logging.getLogger()
    if root_logger.handlers:
        # Already configured; just ensure level
        root_logger.setLevel(level)
        return

    root_logger.setLevel(level)

    formatter = logging.Formatter(
        fmt="\x1b[1;33m[%(asctime)s \x1b[31m%(levelname)s \x1b[32m%(module)s/%(lineno)d-%(processName)s\x1b[1;33m] \x1b[0m%(message)s"
    )

    stdout_handler = logging.StreamHandler(sys.stdout)
    stdout_handler.setLevel(level)
    stdout_handler.setFormatter(formatter)

    root_logger.addHandler(stdout_handler)


def setup_file_logging(log_dir: str, level_info: int = logging.INFO, level_debug: int = logging.DEBUG) -> None:
    """Attach file handlers writing logs under log_dir.

    Creates two files similar to CLI app:
    - agents3.log (INFO)
    - agents3_debug.log (DEBUG)
    """
    Path(log_dir).mkdir(parents=True, exist_ok=True)

    formatter = logging.Formatter(
        fmt="\x1b[1;33m[%(asctime)s \x1b[31m%(levelname)s \x1b[32m%(module)s/%(lineno)d-%(processName)s\x1b[1;33m] \x1b[0m%(message)s"
    )

    file_info = logging.FileHandler(os.path.join(log_dir, "agents3.log"), encoding="utf-8")
    file_info.setLevel(level_info)
    file_info.setFormatter(formatter)

    file_debug = logging.FileHandler(os.path.join(log_dir, "agents3_debug.log"), encoding="utf-8")
    file_debug.setLevel(level_debug)
    file_debug.setFormatter(formatter)

    root_logger = logging.getLogger()
    root_logger.addHandler(file_info)
    root_logger.addHandler(file_debug)
    setup_doubao_api_logging(log_dir, level_debug)


def setup_doubao_api_logging(log_dir: str, level: int = logging.DEBUG) -> logging.Logger:
    """Create a dedicated doubao_api logger writing to doubao_api.log under log_dir."""
    Path(log_dir).mkdir(parents=True, exist_ok=True)

    formatter = logging.Formatter(
        fmt="\x1b[1;33m[%(asctime)s \x1b[31m%(levelname)s \x1b[32m%(module)s/%(lineno)d-%(processName)s\x1b[1;33m] \x1b[0m%(message)s"
    )

    handler = logging.FileHandler(os.path.join(log_dir, "doubao_api.log"), encoding="utf-8")
    handler.setLevel(level)
    handler.setFormatter(formatter)

    doubao_logger = logging.getLogger("doubao_api")
    doubao_logger.setLevel(level)
    doubao_logger.addHandler(handler)
    return doubao_logger 