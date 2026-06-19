# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0
#
# Portions derived from  https://github.com/microsoft/autogen are under the MIT License.
# SPDX-License-Identifier: MIT
import inspect
from datetime import datetime, timezone
from pathlib import Path, PurePath
from typing import Any, Union

__all__ = ("get_current_ts", "to_dict")


def get_current_ts() -> str:
    """Get current timestamp in UTC timezone.

    Returns:
        str: Current timestamp in UTC timezone
    """
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")


def to_dict(
    obj: Union[int, float, str, bool, dict[Any, Any], list[Any], tuple[Any, ...], Any],
    exclude: tuple[str, ...] = (),
    no_recursive: tuple[Any, ...] = (),
) -> Any:
    """Convert object to dictionary.

    Args:
        obj (Union[int, float, str, bool, dict[Any, Any], list[Any], tuple[Any, ...], Any]): Object to convert
        exclude (tuple[str, ...], optional): Keys to exclude. Defaults to ().
        no_recursive (tuple[Any, ...], optional): Types to exclude from recursive conversion. Defaults to ().
    """
    if isinstance(obj, (int, float, str, bool)):
        return obj
    elif isinstance(obj, (Path, PurePath)):
        return str(obj)
    elif callable(obj):
        return inspect.getsource(obj).strip()
    elif isinstance(obj, dict):
        return {
            str(k): to_dict(str(v)) if isinstance(v, no_recursive) else to_dict(v, exclude, no_recursive)
            for k, v in obj.items()
            if k not in exclude
        }
    elif isinstance(obj, (list, tuple)):
        return [to_dict(str(v)) if isinstance(v, no_recursive) else to_dict(v, exclude, no_recursive) for v in obj]
    elif hasattr(obj, "__dict__"):
        return {
            str(k): to_dict(str(v)) if isinstance(v, no_recursive) else to_dict(v, exclude, no_recursive)
            for k, v in vars(obj).items()
            if k not in exclude
        }
    else:
        return obj
