# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

from typing import Optional

from pydantic import BaseModel

from .context_variables import ContextVariables

__all__ = ["ContextStr"]


class ContextStr(BaseModel):
    """A string that requires context variable substitution.

    Use the format method to substitute context variables into the string.
    """

    """The string to be substituted with context variables. It is expected that the string will contain `{var}` placeholders and that string format will be able to replace all values."""
    template: str

    def format(self, context_variables: ContextVariables) -> Optional[str]:
        """Substitute context variables into the string.

        Args:
            context_variables (ContextVariables): The context variables to substitute into the string.

        Returns:
            Optional[str]: The formatted string with context variables substituted.
        """

        context = context_variables.to_dict()

        if not context:
            return self.template

        return self.template.format(**context)

    def __str__(self) -> str:
        return f"ContextStr, unformatted: {self.template}"
