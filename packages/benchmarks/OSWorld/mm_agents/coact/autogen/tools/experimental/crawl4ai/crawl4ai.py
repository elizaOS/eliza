# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

from typing import Annotated, Any, Optional, Union

from pydantic import BaseModel

from ....doc_utils import export_module
from ....import_utils import optional_import_block, require_optional_import
from ....interop import LiteLLmConfigFactory
from ....llm_config import LLMConfig
from ... import Tool
from ...dependency_injection import Depends, on

with optional_import_block():
    from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig
    from crawl4ai.extraction_strategy import LLMExtractionStrategy

__all__ = ["Crawl4AITool"]


@require_optional_import(["crawl4ai"], "crawl4ai")
@export_module("autogen.tools.experimental")
class Crawl4AITool(Tool):
    """
    Crawl a website and extract information using the crawl4ai library.
    """

    def __init__(
        self,
        llm_config: Optional[Union[LLMConfig, dict[str, Any]]] = None,
        extraction_model: Optional[type[BaseModel]] = None,
        llm_strategy_kwargs: Optional[dict[str, Any]] = None,
    ) -> None:
        """
        Initialize the Crawl4AITool.

        Args:
            llm_config: The config dictionary for the LLM model. If None, the tool will run without LLM.
            extraction_model: The Pydantic model to use for extraction. If None, the tool will use the default schema.
            llm_strategy_kwargs: The keyword arguments to pass to the LLM extraction strategy.
        """
        Crawl4AITool._validate_llm_strategy_kwargs(llm_strategy_kwargs, llm_config_provided=(llm_config is not None))

        async def crawl4ai_helper(  # type: ignore[no-any-unimported]
            url: str,
            browser_cfg: Optional["BrowserConfig"] = None,
            crawl_config: Optional["CrawlerRunConfig"] = None,
        ) -> Any:
            async with AsyncWebCrawler(config=browser_cfg) as crawler:
                result = await crawler.arun(
                    url=url,
                    config=crawl_config,
                )

            if crawl_config is None:
                response = result.markdown
            else:
                response = result.extracted_content if result.success else result.error_message

            return response

        async def crawl4ai_without_llm(
            url: Annotated[str, "The url to crawl and extract information from."],
        ) -> Any:
            return await crawl4ai_helper(url=url)

        async def crawl4ai_with_llm(
            url: Annotated[str, "The url to crawl and extract information from."],
            instruction: Annotated[str, "The instruction to provide on how and what to extract."],
            llm_config: Annotated[Any, Depends(on(llm_config))],
            llm_strategy_kwargs: Annotated[Optional[dict[str, Any]], Depends(on(llm_strategy_kwargs))],
            extraction_model: Annotated[Optional[type[BaseModel]], Depends(on(extraction_model))],
        ) -> Any:
            browser_cfg = BrowserConfig(headless=True)
            crawl_config = Crawl4AITool._get_crawl_config(
                llm_config=llm_config,
                instruction=instruction,
                extraction_model=extraction_model,
                llm_strategy_kwargs=llm_strategy_kwargs,
            )

            return await crawl4ai_helper(url=url, browser_cfg=browser_cfg, crawl_config=crawl_config)

        super().__init__(
            name="crawl4ai",
            description="Crawl a website and extract information.",
            func_or_tool=crawl4ai_without_llm if llm_config is None else crawl4ai_with_llm,
        )

    @staticmethod
    def _validate_llm_strategy_kwargs(llm_strategy_kwargs: Optional[dict[str, Any]], llm_config_provided: bool) -> None:
        if not llm_strategy_kwargs:
            return

        if not llm_config_provided:
            raise ValueError("llm_strategy_kwargs can only be provided if llm_config is also provided.")

        check_parameters_error_msg = "".join(
            f"'{key}' should not be provided in llm_strategy_kwargs. It is automatically set based on llm_config.\n"
            for key in ["provider", "api_token"]
            if key in llm_strategy_kwargs
        )

        check_parameters_error_msg += "".join(
            "'schema' should not be provided in llm_strategy_kwargs. It is automatically set based on extraction_model type.\n"
            if "schema" in llm_strategy_kwargs
            else ""
        )

        check_parameters_error_msg += "".join(
            "'instruction' should not be provided in llm_strategy_kwargs. It is provided at the time of calling the tool.\n"
            if "instruction" in llm_strategy_kwargs
            else ""
        )

        if check_parameters_error_msg:
            raise ValueError(check_parameters_error_msg)

    @staticmethod
    def _get_crawl_config(  # type: ignore[no-any-unimported]
        llm_config: Union[LLMConfig, dict[str, Any]],
        instruction: str,
        llm_strategy_kwargs: Optional[dict[str, Any]] = None,
        extraction_model: Optional[type[BaseModel]] = None,
    ) -> "CrawlerRunConfig":
        lite_llm_config = LiteLLmConfigFactory.create_lite_llm_config(llm_config)

        if llm_strategy_kwargs is None:
            llm_strategy_kwargs = {}

        schema = (
            extraction_model.model_json_schema()
            if (extraction_model and issubclass(extraction_model, BaseModel))
            else None
        )

        extraction_type = llm_strategy_kwargs.pop("extraction_type", "schema" if schema else "block")

        # 1. Define the LLM extraction strategy
        llm_strategy = LLMExtractionStrategy(
            **lite_llm_config,
            schema=schema,
            extraction_type=extraction_type,
            instruction=instruction,
            **llm_strategy_kwargs,
        )

        # 2. Build the crawler config
        crawl_config = CrawlerRunConfig(extraction_strategy=llm_strategy, cache_mode=CacheMode.BYPASS)

        return crawl_config
