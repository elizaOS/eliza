# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

__all__ = ["export_module"]

from typing import Callable, Optional, TypeVar

T = TypeVar("T")

# Global dictionary to store export module mappings
# Key: original symbol name (qualified by module)
# Value: target module where it should be documented
_PDOC_MODULE_EXPORT_MAPPINGS: dict[str, str] = {}


def export_module(module: str) -> Callable[[T], T]:
    def decorator(cls: T) -> T:
        original_module = getattr(cls, "__module__", None)
        if original_module:
            fqn = f"{original_module}.{cls.__name__}"
            _PDOC_MODULE_EXPORT_MAPPINGS[fqn] = module
        return cls

    return decorator


def get_target_module(obj: object) -> Optional[str]:
    """Get the target module where an object should be documented."""
    if not hasattr(obj, "__module__"):
        return None

    fqn = f"{obj.__module__}.{obj.__name__}"
    return _PDOC_MODULE_EXPORT_MAPPINGS.get(fqn)
