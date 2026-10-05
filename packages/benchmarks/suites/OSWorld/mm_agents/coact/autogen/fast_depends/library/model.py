# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0
#
# Portions derived from  https://github.com/https://github.com/Lancetnik/FastDepends are under the MIT License.
# SPDX-License-Identifier: MIT

from abc import ABC
from typing import Any, Dict, Optional, TypeVar

Cls = TypeVar("Cls", bound="CustomField")


class CustomField(ABC):
    param_name: Optional[str]
    cast: bool
    required: bool

    __slots__ = (
        "cast",
        "param_name",
        "required",
        "field",
    )

    def __init__(
        self,
        *,
        cast: bool = True,
        required: bool = True,
    ) -> None:
        self.cast = cast
        self.param_name = None
        self.required = required
        self.field = False

    def set_param_name(self: Cls, name: str) -> Cls:
        self.param_name = name
        return self

    def use(self, /, **kwargs: Any) -> Dict[str, Any]:
        assert self.param_name, "You should specify `param_name` before using"
        return kwargs

    def use_field(self, kwargs: Dict[str, Any]) -> None:
        raise NotImplementedError("You should implement `use_field` method.")
