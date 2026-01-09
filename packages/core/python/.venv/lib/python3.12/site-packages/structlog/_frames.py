# SPDX-License-Identifier: MIT OR Apache-2.0
# This file is dual licensed under the terms of the Apache License, Version
# 2.0, and the MIT License.  See the LICENSE file in the root of this
# repository for complete details.

from __future__ import annotations

import sys
import traceback

from io import StringIO
from types import FrameType
from typing import Callable

from .contextvars import _ASYNC_CALLING_STACK
from .typing import ExcInfo


def _format_exception(exc_info: ExcInfo) -> str:
    """
    Prettyprint an `exc_info` tuple.

    Shamelessly stolen from stdlib's logging module.
    """
    sio = StringIO()

    traceback.print_exception(exc_info[0], exc_info[1], exc_info[2], None, sio)
    s = sio.getvalue()
    sio.close()
    if s[-1:] == "\n":
        s = s[:-1]

    return s


def _find_first_app_frame_and_name(
    additional_ignores: list[str] | None = None,
    *,
    stacklevel: int | None = None,
    _getframe: Callable[[], FrameType] = sys._getframe,
) -> tuple[FrameType, str]:
    """
    Remove all intra-structlog calls and return the relevant app frame.

    Args:
        additional_ignores:
            Additional names with which the first frame must not start.

        stacklevel:
            After getting out of structlog, skip this many frames.

        _getframe:
            Callable to find current frame. Only for testing to avoid
            monkeypatching of sys._getframe.

    Returns:
        tuple of (frame, name)
    """
    ignores = ("structlog", *tuple(additional_ignores or ()))
    f = _ASYNC_CALLING_STACK.get(_getframe())
    name = f.f_globals.get("__name__") or "?"

    while name.startswith(ignores):
        if f.f_back is None:
            name = "?"
            break
        f = f.f_back
        name = f.f_globals.get("__name__") or "?"

    if stacklevel is not None:
        for _ in range(stacklevel):
            if f.f_back is None:
                break
            f = f.f_back
            name = f.f_globals.get("__name__") or "?"

    return f, name


def _format_stack(frame: FrameType) -> str:
    """
    Pretty-print the stack of *frame* like logging would.
    """
    sio = StringIO()

    sio.write("Stack (most recent call last):\n")
    traceback.print_stack(frame, file=sio)
    sinfo = sio.getvalue()
    if sinfo[-1] == "\n":
        sinfo = sinfo[:-1]
    sio.close()

    return sinfo
