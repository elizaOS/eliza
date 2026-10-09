# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

import subprocess
from functools import lru_cache
from logging import getLogger
from typing import Callable, TypeVar

from ...import_utils import patch_object

logger = getLogger(__name__)

__all__ = ["require_jupyter_kernel_gateway_installed", "skip_on_missing_jupyter_kernel_gateway"]


@lru_cache
def is_jupyter_kernel_gateway_installed() -> bool:
    """Check if jupyter-kernel-gateway is installed."""
    try:
        subprocess.run(
            ["jupyter", "kernelgateway", "--version"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        logger.warning(
            "jupyter-kernel-gateway is required for JupyterCodeExecutor, please install it with `pip install ag2[jupyter-executor]`"
        )
        return False


T = TypeVar("T")


def require_jupyter_kernel_gateway_installed() -> Callable[[T], T]:
    """Decorator that checks if jupyter-kernel-gateway is installed before function execution.

    Returns:
        Callable[[T], T]: A decorator function that either:
            - Returns the original function unchanged if jupyter-kernel-gateway is installed
            - Returns a patched version of the function that will raise a helpful error indicating the missing dependency when called
    """
    if is_jupyter_kernel_gateway_installed():

        def decorator(o: T) -> T:
            return o

    else:

        def decorator(o: T) -> T:
            return patch_object(o, missing_modules={}, dep_target="jupyter-executor")

    return decorator


def skip_on_missing_jupyter_kernel_gateway() -> Callable[[T], T]:
    """Decorator to skip a test if an optional module is missing"""
    # Add pytest.mark.jupyter_executor decorator
    mark_name = "jupyter_executor"

    if is_jupyter_kernel_gateway_installed():

        def decorator(o: T) -> T:
            import pytest

            pytest_mark_o = getattr(pytest.mark, mark_name)(o)
            return pytest_mark_o  # type: ignore[no-any-return]

    else:

        def decorator(o: T) -> T:
            import pytest

            pytest_mark_o = getattr(pytest.mark, mark_name)(o)
            return pytest.mark.skip(  # type: ignore[return-value,no-any-return]
                reason="jupyter-kernel-gateway is required for JupyterCodeExecutor, please install it with `pip install ag2[jupyter-executor]`"
            )(pytest_mark_o)

    return decorator
