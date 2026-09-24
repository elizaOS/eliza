# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

from typing import Annotated, Any, Optional, Union

from pydantic import BaseModel, field_validator

from ....doc_utils import export_module
from ....import_utils import optional_import_block, require_optional_import
from ....llm_config import LLMConfig
from ... import Depends, Tool
from ...dependency_injection import on

with optional_import_block():
    from browser_use import Agent, Controller
    from browser_use.browser.browser import Browser, BrowserConfig

    from ....interop.langchain.langchain_chat_model_factory import LangChainChatModelFactory


__all__ = ["BrowserUseResult", "BrowserUseTool", "ExtractedContent"]


@export_module("autogen.tools.experimental.browser_use")
class ExtractedContent(BaseModel):
    """Extracted content from the browser.

    Attributes:
        content: The extracted content.
        url: The URL of the extracted content
    """

    content: str
    url: Optional[str]

    @field_validator("url")
    @classmethod
    def check_url(cls, v: str) -> Optional[str]:
        """Check if the URL is about:blank and return None if it is.

        Args:
            v: The URL to check.
        """
        if v == "about:blank":
            return None
        return v


@export_module("autogen.tools.experimental.browser_use")
class BrowserUseResult(BaseModel):
    """The result of using the browser to perform a task.

    Attributes:
        extracted_content: List of extracted content.
        final_result: The final result.
    """

    extracted_content: list[ExtractedContent]
    final_result: Optional[str]


@require_optional_import(
    [
        "langchain_anthropic",
        "langchain_google_genai",
        "langchain_ollama",
        "langchain_openai",
        "langchain_core",
        "browser_use",
    ],
    "browser-use",
)
@export_module("autogen.tools.experimental")
class BrowserUseTool(Tool):
    """BrowserUseTool is a tool that uses the browser to perform a task."""

    def __init__(  # type: ignore[no-any-unimported]
        self,
        *,
        llm_config: Union[LLMConfig, dict[str, Any]],
        browser: Optional["Browser"] = None,
        agent_kwargs: Optional[dict[str, Any]] = None,
        browser_config: Optional[dict[str, Any]] = None,
    ):
        """Use the browser to perform a task.

        Args:
            llm_config: The LLM configuration.
            browser: The browser to use. If defined, browser_config must be None
            agent_kwargs: Additional keyword arguments to pass to the Agent
            browser_config: The browser configuration to use. If defined, browser must be None
        """
        if agent_kwargs is None:
            agent_kwargs = {}

        if browser_config is None:
            browser_config = {}

        if browser is not None and browser_config:
            raise ValueError(
                f"Cannot provide both browser and additional keyword parameters: {browser=}, {browser_config=}"
            )

        async def browser_use(  # type: ignore[no-any-unimported]
            task: Annotated[str, "The task to perform."],
            llm_config: Annotated[Union[LLMConfig, dict[str, Any]], Depends(on(llm_config))],
            browser: Annotated[Optional[Browser], Depends(on(browser))],
            agent_kwargs: Annotated[dict[str, Any], Depends(on(agent_kwargs))],
            browser_config: Annotated[dict[str, Any], Depends(on(browser_config))],
        ) -> BrowserUseResult:
            agent_kwargs = agent_kwargs.copy()
            browser_config = browser_config.copy()
            if browser is None:
                # set default value for headless
                headless = browser_config.pop("headless", True)

                browser_config = BrowserConfig(headless=headless, **browser_config)
                browser = Browser(config=browser_config)

            # set default value for generate_gif
            if "generate_gif" not in agent_kwargs:
                agent_kwargs["generate_gif"] = False

            llm = LangChainChatModelFactory.create_base_chat_model(llm_config)

            max_steps = agent_kwargs.pop("max_steps", 100)

            agent = Agent(
                task=task,
                llm=llm,
                browser=browser,
                controller=BrowserUseTool._get_controller(llm_config),
                **agent_kwargs,
            )

            result = await agent.run(max_steps=max_steps)

            extracted_content = [
                ExtractedContent(content=content, url=url)
                for content, url in zip(result.extracted_content(), result.urls())
            ]
            return BrowserUseResult(
                extracted_content=extracted_content,
                final_result=result.final_result(),
            )

        super().__init__(
            name="browser_use",
            description="Use the browser to perform a task.",
            func_or_tool=browser_use,
        )

    @staticmethod
    def _get_controller(llm_config: Union[LLMConfig, dict[str, Any]]) -> Any:
        response_format = (
            llm_config["config_list"][0].get("response_format", None)
            if "config_list" in llm_config
            else llm_config.get("response_format")
        )
        return Controller(output_model=response_format)
