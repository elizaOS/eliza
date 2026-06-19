from __future__ import annotations

import asyncio
import inspect


def pytest_configure(config):
    config.addinivalue_line("markers", "asyncio: run async tests with local asyncio hook")


def pytest_pyfunc_call(pyfuncitem):
    if inspect.iscoroutinefunction(pyfuncitem.obj):
        kwargs = {
            name: pyfuncitem.funcargs[name]
            for name in pyfuncitem._fixtureinfo.argnames
        }
        asyncio.run(pyfuncitem.obj(**kwargs))
        return True
    return None
