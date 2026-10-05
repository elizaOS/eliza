# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0
import os
from typing import Annotated, Any, Optional, Union

from ....doc_utils import export_module
from ....import_utils import optional_import_block, require_optional_import
from ....llm_config import LLMConfig
from ... import Depends, Tool
from ...dependency_injection import on

with optional_import_block():
    from tavily import TavilyClient


@require_optional_import(
    [
        "tavily",
    ],
    "tavily",
)
def _execute_tavily_query(
    query: str,
    tavily_api_key: str,
    search_depth: str = "basic",
    topic: str = "general",
    include_answer: str = "basic",
    include_raw_content: bool = False,
    include_domains: list[str] = [],
    num_results: int = 5,
) -> Any:
    """
    Execute a search query using the Tavily API.

    Args:
        query (str): The search query string.
        tavily_api_key (str): The API key for Tavily.
        search_depth (str, optional): The depth of the search ('basic' or 'advanced'). Defaults to "basic".
        topic (str, optional): The topic of the search. Defaults to "general".
        include_answer (str, optional): Whether to include an AI-generated answer ('basic' or 'advanced'). Defaults to "basic".
        include_raw_content (bool, optional): Whether to include raw content in the results. Defaults to False.
        include_domains (list[str], optional): A list of domains to include in the search. Defaults to [].
        num_results (int, optional): The maximum number of results to return. Defaults to 5.

    Returns:
        Any: The raw response object from the Tavily API client.
    """
    tavily_client = TavilyClient(api_key=tavily_api_key)
    return tavily_client.search(
        query=query,
        search_depth=search_depth,
        topic=topic,
        include_answer=include_answer,
        include_raw_content=include_raw_content,
        include_domains=include_domains,
        max_results=num_results,
    )


def _tavily_search(
    query: str,
    tavily_api_key: str,
    search_depth: str = "basic",
    topic: str = "general",
    include_answer: str = "basic",
    include_raw_content: bool = False,
    include_domains: list[str] = [],
    num_results: int = 5,
) -> list[dict[str, Any]]:
    """
    Perform a Tavily search and format the results.

    This function takes search parameters, executes the query using `_execute_tavily_query`,
    and formats the results into a list of dictionaries containing title, link, and snippet.

    Args:
        query (str): The search query string.
        tavily_api_key (str): The API key for Tavily.
        search_depth (str, optional): The depth of the search ('basic' or 'advanced'). Defaults to "basic".
        topic (str, optional): The topic of the search. Defaults to "general".
        include_answer (str, optional): Whether to include an AI-generated answer ('basic' or 'advanced'). Defaults to "basic".
        include_raw_content (bool, optional): Whether to include raw content in the results. Defaults to False.
        include_domains (list[str], optional): A list of domains to include in the search. Defaults to [].
        num_results (int, optional): The maximum number of results to return. Defaults to 5.

    Returns:
        list[dict[str, Any]]: A list of dictionaries, where each dictionary represents a search result
            with keys 'title', 'link', and 'snippet'. Returns an empty list if no results are found.
    """
    res = _execute_tavily_query(
        query=query,
        tavily_api_key=tavily_api_key,
        search_depth=search_depth,
        topic=topic,
        include_answer=include_answer,
        include_raw_content=include_raw_content,
        include_domains=include_domains,
        num_results=num_results,
    )

    return [
        {"title": item.get("title", ""), "link": item.get("url", ""), "snippet": item.get("content", "")}
        for item in res.get("results", [])
    ]


@export_module("autogen.tools.experimental")
class TavilySearchTool(Tool):
    """
    TavilySearchTool is a tool that uses the Tavily Search API to perform a search.

    This tool allows agents to leverage the Tavily search engine for information retrieval.
    It requires a Tavily API key, which can be provided during initialization or set as
    an environment variable `TAVILY_API_KEY`.

    Attributes:
        tavily_api_key (str): The API key used for authenticating with the Tavily API.
    """

    def __init__(
        self, *, llm_config: Optional[Union[LLMConfig, dict[str, Any]]] = None, tavily_api_key: Optional[str] = None
    ):
        """
        Initializes the TavilySearchTool.

        Args:
            llm_config (Optional[Union[LLMConfig, dict[str, Any]]]): LLM configuration. (Currently unused but kept for potential future integration).
            tavily_api_key (Optional[str]): The API key for the Tavily Search API. If not provided,
                it attempts to read from the `TAVILY_API_KEY` environment variable.

        Raises:
            ValueError: If `tavily_api_key` is not provided either directly or via the environment variable.
        """
        self.tavily_api_key = tavily_api_key or os.getenv("TAVILY_API_KEY")

        if self.tavily_api_key is None:
            raise ValueError("tavily_api_key must be provided either as an argument or via TAVILY_API_KEY env var")

        def tavily_search(
            query: Annotated[str, "The search query."],
            tavily_api_key: Annotated[Optional[str], Depends(on(self.tavily_api_key))],
            search_depth: Annotated[Optional[str], "Either 'advanced' or 'basic'"] = "basic",
            include_answer: Annotated[Optional[str], "Either 'advanced' or 'basic'"] = "basic",
            include_raw_content: Annotated[Optional[bool], "Include the raw contents"] = False,
            include_domains: Annotated[Optional[list[str]], "Specific web domains to search"] = [],
            num_results: Annotated[int, "The number of results to return."] = 5,
        ) -> list[dict[str, Any]]:
            """
            Performs a search using the Tavily API and returns formatted results.

            Args:
                query: The search query string.
                tavily_api_key: The API key for Tavily (injected dependency).
                search_depth: The depth of the search ('basic' or 'advanced'). Defaults to "basic".
                include_answer: Whether to include an AI-generated answer ('basic' or 'advanced'). Defaults to "basic".
                include_raw_content: Whether to include raw content in the results. Defaults to False.
                include_domains: A list of domains to include in the search. Defaults to [].
                num_results: The maximum number of results to return. Defaults to 5.

            Returns:
                A list of dictionaries, each containing 'title', 'link', and 'snippet' of a search result.

            Raises:
                ValueError: If the Tavily API key is not available.
            """
            if tavily_api_key is None:
                raise ValueError("Tavily API key is missing.")
            return _tavily_search(
                query=query,
                tavily_api_key=tavily_api_key,
                search_depth=search_depth or "basic",
                include_answer=include_answer or "basic",
                include_raw_content=include_raw_content or False,
                include_domains=include_domains or [],
                num_results=num_results,
            )

        super().__init__(
            name="tavily_search",
            description="Use the Tavily Search API to perform a search.",
            func_or_tool=tavily_search,
        )
