# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0


import copy
import logging
import os
from typing import Annotated, Any, Literal, Optional, Type, Union

from pydantic import BaseModel

from ....doc_utils import export_module
from ....import_utils import optional_import_block, require_optional_import
from ....llm_config import LLMConfig
from ... import Tool

with optional_import_block():
    from openai import OpenAI
    from openai.types.responses import WebSearchToolParam
    from openai.types.responses.web_search_tool import UserLocation


@require_optional_import("openai>=1.66.2", "openai")
@export_module("autogen.tools.experimental")
class WebSearchPreviewTool(Tool):
    """WebSearchPreviewTool is a tool that uses OpenAI's web_search_preview tool to perform a search."""

    def __init__(
        self,
        *,
        llm_config: Union[LLMConfig, dict[str, Any]],
        search_context_size: Literal["low", "medium", "high"] = "medium",
        user_location: Optional[dict[str, str]] = None,
        instructions: Optional[str] = None,
        text_format: Optional[Type[BaseModel]] = None,
    ):
        """Initialize the WebSearchPreviewTool.

        Args:
            llm_config: The LLM configuration to use. This should be a dictionary
                containing the model name and other parameters.
            search_context_size: The size of the search context. One of `low`, `medium`, or `high`.
                `medium` is the default.
            user_location: The location of the user. This should be a dictionary containing
                the city, country, region, and timezone.
            instructions: Inserts a system (or developer) message as the first item in the model's context.
            text_format: The format of the text to be returned. This should be a subclass of `BaseModel`.
                The default is `None`, which means the text will be returned as a string.
        """
        self.web_search_tool_param = WebSearchToolParam(
            type="web_search_preview",
            search_context_size=search_context_size,
            user_location=UserLocation(**user_location) if user_location else None,  # type: ignore[typeddict-item]
        )
        self.instructions = instructions
        self.text_format = text_format

        if isinstance(llm_config, LLMConfig):
            llm_config = llm_config.model_dump()

        llm_config = copy.deepcopy(llm_config)

        if "config_list" not in llm_config:
            raise ValueError("llm_config must contain 'config_list' key")

        # Find first OpenAI model which starts with "gpt-4"
        self.model = None
        self.api_key = None
        for model in llm_config["config_list"]:
            if model["model"].startswith("gpt-4") and model.get("api_type", "openai") == "openai":
                self.model = model["model"]
                self.api_key = model.get("api_key", os.getenv("OPENAI_API_KEY"))
                break
        if self.model is None:
            raise ValueError(
                "No OpenAI model starting with 'gpt-4' found in llm_config, other models do not support web_search_preview"
            )

        if not self.model.startswith("gpt-4.1") and not self.model.startswith("gpt-4o-search-preview"):
            logging.warning(
                f"We recommend using a model starting with 'gpt-4.1' or 'gpt-4o-search-preview' for web_search_preview, but found {self.model}. "
                "This may result in suboptimal performance."
            )

        def web_search_preview(
            query: Annotated[str, "The search query. Add all relevant context to the query."],
        ) -> Union[str, Optional[BaseModel]]:
            client = OpenAI()

            if not self.text_format:
                response = client.responses.create(
                    model=self.model,  # type: ignore[arg-type]
                    tools=[self.web_search_tool_param],
                    input=query,
                    instructions=self.instructions,
                )
                return response.output_text

            else:
                response = client.responses.parse(
                    model=self.model,  # type: ignore[arg-type]
                    tools=[self.web_search_tool_param],
                    input=query,
                    instructions=self.instructions,
                    text_format=self.text_format,
                )
                return response.output_parsed

        super().__init__(
            name="web_search_preview",
            description="Tool used to perform a web search. It can be used as google search or directly searching a specific website.",
            func_or_tool=web_search_preview,
        )
