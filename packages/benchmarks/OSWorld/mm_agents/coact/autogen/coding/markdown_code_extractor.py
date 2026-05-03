# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0
#
# Portions derived from https://github.com/microsoft/autogen are under the MIT License.
# SPDX-License-Identifier: MIT
import re
from typing import Union

from ..code_utils import CODE_BLOCK_PATTERN, UNKNOWN, content_str, infer_lang
from ..doc_utils import export_module
from ..types import UserMessageImageContentPart, UserMessageTextContentPart
from .base import CodeBlock, CodeExtractor

__all__ = ("MarkdownCodeExtractor",)


@export_module("autogen.coding")
class MarkdownCodeExtractor(CodeExtractor):
    """(Experimental) A class that extracts code blocks from a message using Markdown syntax."""

    def extract_code_blocks(
        self, message: Union[str, list[Union[UserMessageTextContentPart, UserMessageImageContentPart]], None]
    ) -> list[CodeBlock]:
        """(Experimental) Extract code blocks from a message. If no code blocks are found,
        return an empty list.

        Args:
            message (str): The message to extract code blocks from.

        Returns:
            List[CodeBlock]: The extracted code blocks or an empty list.
        """
        text = content_str(message)
        match = re.findall(CODE_BLOCK_PATTERN, text, flags=re.DOTALL)
        if not match:
            return []
        code_blocks = []
        for lang, code in match:
            if lang == "":
                lang = infer_lang(code)
            if lang == UNKNOWN:
                lang = ""
            code_blocks.append(CodeBlock(code=code, language=lang))
        return code_blocks
