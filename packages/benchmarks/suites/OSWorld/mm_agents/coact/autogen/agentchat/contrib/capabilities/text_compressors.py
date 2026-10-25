# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0
#
# Portions derived from  https://github.com/microsoft/autogen are under the MIT License.
# SPDX-License-Identifier: MIT
from typing import Any, Protocol

from ....import_utils import optional_import_block, require_optional_import

with optional_import_block() as result:
    import llmlingua
    from llmlingua import PromptCompressor


class TextCompressor(Protocol):
    """Defines a protocol for text compression to optimize agent interactions."""

    def compress_text(self, text: str, **compression_params) -> dict[str, Any]:
        """This method takes a string as input and returns a dictionary containing the compressed text and other
        relevant information. The compressed text should be stored under the 'compressed_text' key in the dictionary.
        To calculate the number of saved tokens, the dictionary should include 'origin_tokens' and 'compressed_tokens' keys.
        """
        ...


@require_optional_import("llmlingua", "long-context")
class LLMLingua:
    """Compresses text messages using LLMLingua for improved efficiency in processing and response generation.

    NOTE: The effectiveness of compression and the resultant token savings can vary based on the content of the messages
    and the specific configurations used for the PromptCompressor.
    """

    def __init__(
        self,
        prompt_compressor_kwargs: dict = dict(
            model_name="microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank",
            use_llmlingua2=True,
            device_map="cpu",
        ),
        structured_compression: bool = False,
    ) -> None:
        """Args:
            prompt_compressor_kwargs (dict): A dictionary of keyword arguments for the PromptCompressor. Defaults to a
                dictionary with model_name set to "microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank",
                use_llmlingua2 set to True, and device_map set to "cpu".
            structured_compression (bool): A flag indicating whether to use structured compression. If True, the
                structured_compress_prompt method of the PromptCompressor is used. Otherwise, the compress_prompt method
                is used. Defaults to False.
                dictionary.

        Raises:
            ImportError: If the llmlingua library is not installed.
        """
        self._prompt_compressor = PromptCompressor(**prompt_compressor_kwargs)

        assert isinstance(self._prompt_compressor, llmlingua.PromptCompressor)
        self._compression_method = (
            self._prompt_compressor.structured_compress_prompt
            if structured_compression
            else self._prompt_compressor.compress_prompt
        )

    def compress_text(self, text: str, **compression_params) -> dict[str, Any]:
        return self._compression_method([text], **compression_params)
