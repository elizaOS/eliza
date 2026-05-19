"""Compatibility helpers for asyncio features across Python versions."""

from __future__ import annotations

import asyncio
from functools import partial


async def run_in_thread(func: object, *args: object, **kwargs: object) -> object:
    """Run blocking callable in a thread on Python 3.8+."""
    to_thread = getattr(asyncio, "to_thread", None)
    if callable(to_thread):
        return await to_thread(func, *args, **kwargs)
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, partial(func, *args, **kwargs))
