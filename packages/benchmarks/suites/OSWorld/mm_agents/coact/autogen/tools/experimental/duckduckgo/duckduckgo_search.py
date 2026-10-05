# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0
from typing import Annotated, Any

from ....doc_utils import export_module
from ....import_utils import optional_import_block, require_optional_import
from ... import Tool

with optional_import_block():
    from duckduckgo_search import DDGS


@require_optional_import(
    [
        "duckduckgo_search",
    ],
    "duckduckgo_search",
)
def _execute_duckduckgo_query(
    query: str,
    num_results: int = 5,
) -> list[dict[str, Any]]:
    """
    Execute a search query using the DuckDuckGo Search API.

    Args:
        query (str): The search query string.
        num_results (int, optional): The maximum number of results to return. Defaults to 5.

    Returns:
        list[dict[str, Any]]: A list of search results from the DuckDuckGo API.
    """
    with DDGS() as ddgs:
        try:
            # region='wt-wt' means worldwide
            results = list(ddgs.text(query, region="wt-wt", max_results=num_results))
        except Exception as e:
            print(f"DuckDuckGo Search failed: {e}")
            results = []
    return results


def _duckduckgo_search(
    query: str,
    num_results: int = 5,
) -> list[dict[str, Any]]:
    """
    Perform a DuckDuckGo search and format the results.

    This function takes search parameters, executes the query using `_execute_duckduckgo_query`,
    and formats the results into a list of dictionaries containing title, link, and snippet.

    Args:
        query (str): The search query string.
        num_results (int, optional): The maximum number of results to return. Defaults to 5.

    Returns:
        list[dict[str, Any]]: A list of dictionaries, where each dictionary represents a search result
            with keys 'title', 'link', and 'snippet'. Returns an empty list if no results are found.
    """
    res = _execute_duckduckgo_query(
        query=query,
        num_results=num_results,
    )

    return [
        {"title": item.get("title", ""), "link": item.get("href", ""), "snippet": item.get("body", "")} for item in res
    ]


@export_module("autogen.tools.experimental")
class DuckDuckGoSearchTool(Tool):
    """
    DuckDuckGoSearchTool is a tool that uses DuckDuckGo to perform a search.

    This tool allows agents to leverage the DuckDuckGo search engine for information retrieval.
    DuckDuckGo does not require an API key, making it easy to use.
    """

    def __init__(self) -> None:
        """
        Initializes the DuckDuckGoSearchTool.
        """

        def duckduckgo_search(
            query: Annotated[str, "The search query."],
            num_results: Annotated[int, "The number of results to return."] = 5,
        ) -> list[dict[str, Any]]:
            """
            Performs a search using the DuckDuckGo Search API and returns formatted results.

            Args:
                query: The search query string.
                num_results: The maximum number of results to return. Defaults to 5.

            Returns:
                A list of dictionaries, each containing 'title', 'link', and 'snippet' of a search result.
            """
            return _duckduckgo_search(
                query=query,
                num_results=num_results,
            )

        super().__init__(
            name="duckduckgo_search",
            description="Use the DuckDuckGo Search API to perform a search.",
            func_or_tool=duckduckgo_search,
        )
