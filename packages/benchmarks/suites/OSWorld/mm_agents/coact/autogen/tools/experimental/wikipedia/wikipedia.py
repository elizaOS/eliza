# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any, Optional, Union

import requests
from pydantic import BaseModel

from autogen.import_utils import optional_import_block, require_optional_import
from autogen.tools import Tool

with optional_import_block():
    import wikipediaapi

# Maximum allowed length for a query string.
MAX_QUERY_LENGTH = 300
# Maximum number of pages to retrieve from a search.
MAX_PAGE_RETRIEVE = 100
# Maximum number of characters to return from a Wikipedia page.
MAX_ARTICLE_LENGTH = 10000


class Document(BaseModel):
    """Pydantic model representing a Wikipedia document.

    Attributes:
        page_content (str): Textual content of the Wikipedia page
            (possibly truncated).
        metadata (dict[str, str]): Additional info, including:
            - source URL
            - title
            - pageid
            - timestamp
            - word count
            - size
    """

    page_content: str
    metadata: dict[str, str]


class WikipediaClient:
    """Client for interacting with the Wikipedia API.

    Supports searching and page retrieval on a specified language edition.

    Public methods:
        search(query: str, limit: int) -> list[dict[str, Any]]
        get_page(title: str) -> Optional[wikipediaapi.WikipediaPage]

    Attributes:
        base_url (str): URL of the MediaWiki API endpoint.
        headers (dict[str, str]): HTTP headers, including User-Agent.
        wiki (wikipediaapi.Wikipedia): Low-level Wikipedia API client.
    """

    def __init__(self, language: str = "en", tool_name: str = "wikipedia-client") -> None:
        """Initialize the WikipediaClient.

        Args:
            language (str): ISO code of the Wikipedia edition (e.g., 'en', 'es').
            tool_name (str): Identifier for User-Agent header.
        """
        self.base_url = f"https://{language}.wikipedia.org/w/api.php"
        self.headers = {"User-Agent": f"autogen.Agent ({tool_name})"}
        self.wiki = wikipediaapi.Wikipedia(
            language=language,
            extract_format=wikipediaapi.ExtractFormat.WIKI,
            user_agent=f"autogen.Agent ({tool_name})",
        )

    def search(self, query: str, limit: int = 3) -> Any:
        """Search Wikipedia for pages matching a query string.

        Args:
            query (str): The search keywords.
            limit (int): Max number of results to return.

        Returns:
            list[dict[str, Any]]: Each dict has keys:
                - 'title' (str)
                - 'size' (int)
                - 'wordcount' (int)
                - 'timestamp' (str)

        Raises:
            requests.HTTPError: If the HTTP request to the API fails.
        """
        params = {
            "action": "query",
            "format": "json",
            "list": "search",
            "srsearch": query,
            "srlimit": str(limit),
            "srprop": "size|wordcount|timestamp",
        }

        response = requests.get(url=self.base_url, params=params, headers=self.headers)
        response.raise_for_status()
        data = response.json()
        search_data = data.get("query", {}).get("search", [])
        return search_data

    def get_page(self, title: str) -> Optional[Any]:
        """Retrieve a WikipediaPage object by title.

        Args:
            title (str): Title of the Wikipedia page.

        Returns:
            wikipediaapi.WikipediaPage | None: The page object if it exists,
            otherwise None.

        Raises:
            wikipediaapi.WikipediaException: On lower‑level API errors.
        """
        page = self.wiki.page(title)
        if not page.exists():
            return None
        return page


@require_optional_import(["wikipediaapi"], "wikipedia")
class WikipediaQueryRunTool(Tool):
    """Tool for querying Wikipedia and returning summarized page results.

    This tool uses the `wikipediaapi` package to perform searches
    against a specified language edition of Wikipedia and returns
    up to `top_k` page summaries.

    Public methods:
        query_run(query: str) -> list[str] | str

    Attributes:
        language (str): Language code for the Wikipedia edition (e.g., 'en', 'es').
        top_k (int): Max number of page summaries returned (≤ MAX_PAGE_RETRIEVE).
        verbose (bool): If True, enables debug logging to stdout.
        wiki_cli (WikipediaClient): Internal client for Wikipedia API calls.
    """

    def __init__(self, language: str = "en", top_k: int = 3, verbose: bool = False) -> None:
        """Initialize the WikipediaQueryRunTool.

        Args:
            language (str): ISO code of the Wikipedia edition to query.
            top_k (int): Desired number of summaries (capped by MAX_PAGE_RETRIEVE).
            verbose (bool): If True, print debug information during searches.
        """
        self.language = language
        self.tool_name = "wikipedia-query-run"
        self.wiki_cli = WikipediaClient(language, self.tool_name)
        self.top_k = min(top_k, MAX_PAGE_RETRIEVE)
        self.verbose = verbose
        super().__init__(
            name=self.tool_name,
            description="Run a Wikipedia query and return page summaries.",
            func_or_tool=self.query_run,
        )

    def query_run(self, query: str) -> Union[list[str], str]:
        """Search Wikipedia and return formatted page summaries.

        Truncates `query` to MAX_QUERY_LENGTH before searching.

        Args:
            query (str): Search term(s) to look up in Wikipedia.

        Returns:
            list[str]: Each element is "Page: <title>\nSummary: <text>".
            str: Error message if no results are found or on exception.

        Note:
            Automatically handles API exceptions and returns error strings for robust operation
        """
        try:
            if self.verbose:
                print(f"INFO\t [{self.tool_name}] search query='{query[:MAX_QUERY_LENGTH]}' top_k={self.top_k}")
            search_results = self.wiki_cli.search(query[:MAX_QUERY_LENGTH], limit=self.top_k)
            summaries: list[str] = []
            for item in search_results:
                title = item["title"]
                page = self.wiki_cli.get_page(title)
                # Only format the summary if the page exists and has a summary.
                if page is not None and page.summary:
                    summary = f"Page: {title}\nSummary: {page.summary}"
                    summaries.append(summary)
            if not summaries:
                return "No good Wikipedia Search Result was found"
            return summaries
        except Exception as e:
            return f"wikipedia search failed: {str(e)}"


@require_optional_import(["wikipediaapi"], "wikipedia")
class WikipediaPageLoadTool(Tool):
    """
    A tool to load up to N characters of Wikipedia page content along with metadata.

    This tool uses a language-specific Wikipedia client to search for relevant articles
    and returns a list of Document objects containing truncated page content and metadata
    (source URL, title, page ID, timestamp, word count, and size). Ideal for agents
    requiring structured Wikipedia data for research, summarization, or contextual enrichment.

    Attributes:
        language (str): Wikipedia language code (default: "en").
        top_k (int): Maximum number of pages to retrieve per query (default: 3).
        truncate (int): Maximum number of characters of content per page (default: 4000).
        verbose (bool): If True, prints debug information (default: False).
        tool_name (str): Identifier used in User-Agent header.
        wiki_cli (WikipediaClient): Client for interacting with the Wikipedia API.
    """

    def __init__(self, language: str = "en", top_k: int = 3, truncate: int = 4000, verbose: bool = False) -> None:
        """
        Initializes the WikipediaPageLoadTool with configurable language, result count, and content length.

        Args:
            language (str): The language code for the Wikipedia edition (default is "en").
            top_k (int): The maximum number of pages to retrieve per query (default is 3;
                         capped at MAX_PAGE_RETRIEVE).
            truncate (int): The maximum number of characters to extract from each page (default is 4000;
                            capped at MAX_ARTICLE_LENGTH).
            verbose (bool): If True, enables verbose/debug logging (default is False).
        """
        self.language = language
        self.top_k = min(top_k, MAX_PAGE_RETRIEVE)
        self.truncate = min(truncate, MAX_ARTICLE_LENGTH)
        self.verbose = verbose
        self.tool_name = "wikipedia-page-load"
        self.wiki_cli = WikipediaClient(language, self.tool_name)
        super().__init__(
            name=self.tool_name,
            description=(
                "Search Wikipedia for relevant pages using a language-specific client. "
                "Returns a list of documents with truncated content and metadata including title, URL, "
                "page ID, timestamp, word count, and page size. Configure number of results with the 'top_k' parameter "
                "and content length with 'truncate'. Useful for research, summarization, or contextual enrichment."
            ),
            func_or_tool=self.content_search,
        )

    def content_search(self, query: str) -> Union[list[Document], str]:
        """
        Executes a Wikipedia search and returns page content plus metadata.

        Args:
            query (str): The search term to query Wikipedia.

        Returns:
            Union[list[Document], str]:
                - list[Document]: Documents with up to `truncate` characters of page text
                  and metadata if pages are found.
                - str: Error message if the search fails or no pages are found.

        Notes:
            - Errors are caught internally and returned as strings.
            - If no matching pages have text content, returns
              "No good Wikipedia Search Result was found".
        """
        try:
            if self.verbose:
                print(f"INFO\t [{self.tool_name}] search query='{query[:MAX_QUERY_LENGTH]}' top_k={self.top_k}")
            search_results = self.wiki_cli.search(query[:MAX_QUERY_LENGTH], limit=self.top_k)
            docs: list[Document] = []
            for item in search_results:
                page = self.wiki_cli.get_page(item["title"])
                # Only process pages that exist and have text content.
                if page is not None and page.text:
                    document = Document(
                        page_content=page.text[: self.truncate],
                        metadata={
                            "source": f"https://{self.language}.wikipedia.org/?curid={item['pageid']}",
                            "title": item["title"],
                            "pageid": str(item["pageid"]),
                            "timestamp": str(item["timestamp"]),
                            "wordcount": str(item["wordcount"]),
                            "size": str(item["size"]),
                        },
                    )
                    docs.append(document)
            if not docs:
                return "No good Wikipedia Search Result was found"
            return docs

        except Exception as e:
            return f"wikipedia search failed: {str(e)}"
