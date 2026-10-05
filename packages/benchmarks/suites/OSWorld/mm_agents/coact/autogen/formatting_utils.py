# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0
#
# Portions derived from  https://github.com/microsoft/autogen are under the MIT License.
# SPDX-License-Identifier: MIT
from __future__ import annotations

from collections.abc import Iterable
from typing import Literal, Optional

from .import_utils import optional_import_block

with optional_import_block() as result:
    from termcolor import colored

if not result.is_successful:
    # termcolor is an optional dependency - if it cannot be imported then no color is used.
    # Alternatively the envvar NO_COLOR can be used to disable color.
    # To allow for proper typing and for termcolor to be optional we need to re-define the types used in the lib here.
    # This is the direct function definition from termcolor.
    Attribute = Literal[
        "bold",
        "dark",
        "underline",
        "blink",
        "reverse",
        "concealed",
    ]

    Highlight = Literal[
        "on_black",
        "on_grey",
        "on_red",
        "on_green",
        "on_yellow",
        "on_blue",
        "on_magenta",
        "on_cyan",
        "on_light_grey",
        "on_dark_grey",
        "on_light_red",
        "on_light_green",
        "on_light_yellow",
        "on_light_blue",
        "on_light_magenta",
        "on_light_cyan",
        "on_white",
    ]

    Color = Literal[
        "black",
        "grey",
        "red",
        "green",
        "yellow",
        "blue",
        "magenta",
        "cyan",
        "light_grey",
        "dark_grey",
        "light_red",
        "light_green",
        "light_yellow",
        "light_blue",
        "light_magenta",
        "light_cyan",
        "white",
    ]

    def colored(
        text: object,
        color: Optional[Color] = None,
        on_color: Optional[Highlight] = None,
        attrs: Optional[Iterable[Attribute]] = None,
        *,
        no_color: Optional[bool] = None,
        force_color: Optional[bool] = None,
    ) -> str:
        return str(text)


__all__ = ["colored"]
