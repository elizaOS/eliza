"""Database adapters for elizaOS."""

from __future__ import annotations

from importlib import import_module
from typing import Any

__all__ = [
    "BaseSQLAdapter",
    "PostgresAdapter",
    "PGLiteAdapter",
]

_LAZY_ADAPTERS: dict[str, tuple[str, str]] = {
    "BaseSQLAdapter": ("elizaos_plugin_sql.adapters.base", "BaseSQLAdapter"),
    "PostgresAdapter": ("elizaos_plugin_sql.adapters.postgres", "PostgresAdapter"),
    "PGLiteAdapter": ("elizaos_plugin_sql.adapters.pglite", "PGLiteAdapter"),
}


def __getattr__(name: str) -> Any:
    if name not in _LAZY_ADAPTERS:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

    module_name, attribute_name = _LAZY_ADAPTERS[name]
    module = import_module(module_name)
    value = getattr(module, attribute_name)
    globals()[name] = value
    return value
