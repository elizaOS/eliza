"""
Web Search Tool for GAIA Benchmark

Provides web search capabilities using various search APIs.
"""

import logging
import os
from dataclasses import dataclass
from urllib.parse import quote_plus

import aiohttp

logger = logging.getLogger(__name__)


@dataclass
class SearchResult:
    """A single search result."""
    title: str
    url: str
    snippet: str
    position: int


@dataclass
class SearchResponse:
    """Response from a search query."""
    query: str
    results: list[SearchResult]
    total_results: int
    success: bool
    error: str | None = None


class WebSearchTool:
    """Web search capability for GAIA benchmark tasks."""

    def __init__(
        self,
        api_key: str | None = None,
        engine: str = "serper",
        timeout: int = 30,
    ):
        """
        Initialize web search tool.

        Args:
            api_key: API key for the search service (defaults to env var)
            engine: Search engine to use ('serper', 'google', 'brave', 'duckduckgo')
            timeout: Request timeout in seconds
        """
        self.api_key = api_key or os.getenv("SEARCH_API_KEY") or os.getenv("SERPER_API_KEY")
        self.engine = engine
        self.timeout = timeout
        self._session: aiohttp.ClientSession | None = None

    async def _get_session(self) -> aiohttp.ClientSession:
        """Get or create aiohttp session."""
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=self.timeout),
                headers={
                    # Avoid brotli responses which aiohttp can't decode by default
                    "Accept-Encoding": "gzip, deflate",
                },
            )
        return self._session

    async def search(
        self,
        query: str,
        num_results: int = 10,
    ) -> SearchResponse:
        """
        Execute a web search query.

        Args:
            query: Search query string
            num_results: Number of results to return

        Returns:
            SearchResponse with results
        """
        try:
            if self.engine == "serper":
                return await self._search_serper(query, num_results)
            elif self.engine == "duckduckgo":
                return await self._search_duckduckgo(query, num_results)
            elif self.engine == "brave":
                return await self._search_brave(query, num_results)
            else:
                # Default to DuckDuckGo as it doesn't require API key
                return await self._search_duckduckgo(query, num_results)
        except Exception as e:
            logger.error(f"Search failed for query '{query}': {e}")
            return SearchResponse(
                query=query,
                results=[],
                total_results=0,
                success=False,
                error=str(e),
            )

    async def _search_serper(
        self,
        query: str,
        num_results: int,
    ) -> SearchResponse:
        """Search using Serper API (Google results)."""
        if not self.api_key:
            raise ValueError("SERPER_API_KEY required for Serper search")

        session = await self._get_session()

        async with session.post(
            "https://google.serper.dev/search",
            headers={
                "X-API-KEY": self.api_key,
                "Content-Type": "application/json",
                "Accept-Encoding": "gzip, deflate",
            },
            json={
                "q": query,
                "num": num_results,
            },
        ) as response:
            response.raise_for_status()
            data = await response.json()

        results: list[SearchResult] = []
        organic = data.get("organic", [])

        for i, item in enumerate(organic[:num_results]):
            results.append(SearchResult(
                title=item.get("title", ""),
                url=item.get("link", ""),
                snippet=item.get("snippet", ""),
                position=i + 1,
            ))

        return SearchResponse(
            query=query,
            results=results,
            total_results=len(results),
            success=True,
        )

    async def _search_duckduckgo(
        self,
        query: str,
        num_results: int,
    ) -> SearchResponse:
        """Search using DuckDuckGo HTML (no API key required)."""
        session = await self._get_session()

        # Use DuckDuckGo lite/html version
        url = f"https://lite.duckduckgo.com/lite/?q={quote_plus(query)}"

        async with session.get(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept-Encoding": "gzip, deflate",
            },
        ) as response:
            response.raise_for_status()
            html = await response.text()

        # Parse results from HTML
        results = self._parse_ddg_html(html, num_results)

        return SearchResponse(
            query=query,
            results=results,
            total_results=len(results),
            success=True,
        )

    def _parse_ddg_html(self, html: str, max_results: int) -> list[SearchResult]:
        """Parse DuckDuckGo lite HTML response."""
        from html.parser import HTMLParser

        results: list[SearchResult] = []

        class DDGParser(HTMLParser):
            def __init__(self):
                super().__init__()
                self.results: list[dict] = []
                self.current_result: dict = {}
                self.in_link = False
                self.in_snippet = False

            def handle_starttag(self, tag: str, attrs: list):
                attrs_dict = dict(attrs)
                if tag == "a" and "rel" not in attrs_dict:
                    href = attrs_dict.get("href", "")
                    if href.startswith("http") and "duckduckgo" not in href:
                        self.in_link = True
                        self.current_result = {"url": href, "title": "", "snippet": ""}

            def handle_data(self, data: str):
                if self.in_link and self.current_result:
                    self.current_result["title"] += data.strip()

            def handle_endtag(self, tag: str):
                if tag == "a" and self.in_link:
                    self.in_link = False
                    if self.current_result.get("url"):
                        self.results.append(self.current_result)
                        self.current_result = {}

        parser = DDGParser()
        try:
            parser.feed(html)
        except Exception:
            pass

        for i, r in enumerate(parser.results[:max_results]):
            results.append(SearchResult(
                title=r.get("title", ""),
                url=r.get("url", ""),
                snippet=r.get("snippet", ""),
                position=i + 1,
            ))

        return results

    async def _search_brave(
        self,
        query: str,
        num_results: int,
    ) -> SearchResponse:
        """Search using Brave Search API."""
        if not self.api_key:
            raise ValueError("BRAVE_API_KEY required for Brave search")

        session = await self._get_session()

        async with session.get(
            "https://api.search.brave.com/res/v1/web/search",
            headers={
                "X-Subscription-Token": self.api_key,
                "Accept": "application/json",
            },
            params={
                "q": query,
                "count": num_results,
            },
        ) as response:
            response.raise_for_status()
            data = await response.json()

        results: list[SearchResult] = []
        web_results = data.get("web", {}).get("results", [])

        for i, item in enumerate(web_results[:num_results]):
            results.append(SearchResult(
                title=item.get("title", ""),
                url=item.get("url", ""),
                snippet=item.get("description", ""),
                position=i + 1,
            ))

        return SearchResponse(
            query=query,
            results=results,
            total_results=len(results),
            success=True,
        )

    async def close(self) -> None:
        """Close the aiohttp session."""
        if self._session and not self._session.closed:
            await self._session.close()
