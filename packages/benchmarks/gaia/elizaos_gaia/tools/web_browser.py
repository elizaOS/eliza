"""
Web Browser Tool for GAIA Benchmark

Provides headless browser capabilities for web navigation and content extraction.
"""

import logging
from dataclasses import dataclass
from urllib.parse import urljoin

import aiohttp
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)


@dataclass
class PageContent:
    """Extracted content from a web page."""
    url: str
    title: str
    text: str
    links: list[dict[str, str]]
    images: list[dict[str, str]]
    tables: list[list[list[str]]]
    success: bool
    error: str | None = None


class WebBrowserTool:
    """Headless browser for web navigation in GAIA benchmark."""

    def __init__(
        self,
        timeout: int = 30,
        max_content_length: int = 50000,
        use_playwright: bool = False,
    ):
        """
        Initialize web browser tool.

        Args:
            timeout: Request timeout in seconds
            max_content_length: Maximum characters to extract from page
            use_playwright: Use Playwright for JavaScript rendering
        """
        self.timeout = timeout
        self.max_content_length = max_content_length
        self.use_playwright = use_playwright
        self._session: aiohttp.ClientSession | None = None

    async def _get_session(self) -> aiohttp.ClientSession:
        """Get or create aiohttp session."""
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=self.timeout),
                headers={
                    "User-Agent": (
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/120.0.0.0 Safari/537.36"
                    ),
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.5",
                    # Avoid brotli responses which aiohttp can't decode by default
                    "Accept-Encoding": "gzip, deflate",
                },
            )
        return self._session

    async def navigate(self, url: str) -> PageContent:
        """
        Navigate to a URL and extract page content.

        Args:
            url: URL to navigate to

        Returns:
            PageContent with extracted content
        """
        try:
            if self.use_playwright:
                return await self._navigate_playwright(url)
            else:
                return await self._navigate_simple(url)
        except Exception as e:
            logger.error(f"Navigation failed for {url}: {e}")
            return PageContent(
                url=url,
                title="",
                text="",
                links=[],
                images=[],
                tables=[],
                success=False,
                error=str(e),
            )

    async def _navigate_simple(self, url: str) -> PageContent:
        """Simple navigation using aiohttp + BeautifulSoup."""
        session = await self._get_session()

        async with session.get(url) as response:
            response.raise_for_status()
            html = await response.text()

        return self._parse_html(url, html)

    async def _navigate_playwright(self, url: str) -> PageContent:
        """Navigate using Playwright for JavaScript rendering."""
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            logger.warning("Playwright not installed, falling back to simple navigation")
            return await self._navigate_simple(url)

        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            try:
                page = await browser.new_page()
                await page.goto(url, wait_until="networkidle", timeout=self.timeout * 1000)
                html = await page.content()
                return self._parse_html(url, html)
            finally:
                await browser.close()

    def _parse_html(self, url: str, html: str) -> PageContent:
        """Parse HTML content and extract structured data."""
        soup = BeautifulSoup(html, "html.parser")

        # Remove script and style elements
        for element in soup(["script", "style", "noscript", "header", "footer", "nav"]):
            element.decompose()

        # Extract title
        title = ""
        title_tag = soup.find("title")
        if title_tag:
            title = title_tag.get_text(strip=True)

        # Extract main text content
        text = self._extract_text(soup)

        # Extract links
        links = self._extract_links(soup, url)

        # Extract images
        images = self._extract_images(soup, url)

        # Extract tables
        tables = self._extract_tables(soup)

        return PageContent(
            url=url,
            title=title,
            text=text[:self.max_content_length],
            links=links[:50],  # Limit number of links
            images=images[:20],  # Limit number of images
            tables=tables[:10],  # Limit number of tables
            success=True,
        )

    def _extract_text(self, soup: BeautifulSoup) -> str:
        """Extract readable text from page."""
        # Try to find main content area
        main_content = None
        for selector in ["main", "article", '[role="main"]', "#content", ".content"]:
            main_content = soup.select_one(selector)
            if main_content:
                break

        if main_content is None:
            main_content = soup.body or soup

        # Get text with some structure
        text_parts: list[str] = []

        for element in main_content.find_all(["h1", "h2", "h3", "h4", "p", "li", "td", "th", "span", "div"]):
            text = element.get_text(strip=True)
            if text and len(text) > 10:
                # Add heading markers
                if element.name in ["h1", "h2", "h3", "h4"]:
                    text = f"\n## {text}\n"
                text_parts.append(text)

        # Deduplicate consecutive identical lines
        result: list[str] = []
        prev_line = ""
        for line in text_parts:
            if line != prev_line:
                result.append(line)
                prev_line = line

        return "\n".join(result)

    def _extract_links(self, soup: BeautifulSoup, base_url: str) -> list[dict[str, str]]:
        """Extract links from page."""
        links: list[dict[str, str]] = []
        seen_urls: set[str] = set()

        for a_tag in soup.find_all("a", href=True):
            href = a_tag["href"]
            text = a_tag.get_text(strip=True)

            # Skip empty or anchor-only links
            if not href or href.startswith("#") or href.startswith("javascript:"):
                continue

            # Make absolute URL
            full_url = urljoin(base_url, href)

            # Skip duplicates
            if full_url in seen_urls:
                continue
            seen_urls.add(full_url)

            links.append({
                "text": text[:100] if text else "",
                "url": full_url,
            })

        return links

    def _extract_images(self, soup: BeautifulSoup, base_url: str) -> list[dict[str, str]]:
        """Extract images from page."""
        images: list[dict[str, str]] = []

        for img_tag in soup.find_all("img", src=True):
            src = img_tag["src"]
            alt = img_tag.get("alt", "")

            # Make absolute URL
            full_url = urljoin(base_url, src)

            # Skip tiny images (likely icons)
            width = img_tag.get("width", "")
            height = img_tag.get("height", "")
            if width and height:
                try:
                    if int(width) < 50 or int(height) < 50:
                        continue
                except ValueError:
                    pass

            images.append({
                "url": full_url,
                "alt": alt,
            })

        return images

    def _extract_tables(self, soup: BeautifulSoup) -> list[list[list[str]]]:
        """Extract tables from page."""
        tables: list[list[list[str]]] = []

        for table_tag in soup.find_all("table"):
            table_data: list[list[str]] = []

            for row in table_tag.find_all("tr"):
                row_data: list[str] = []
                for cell in row.find_all(["td", "th"]):
                    row_data.append(cell.get_text(strip=True))
                if row_data:
                    table_data.append(row_data)

            if table_data:
                tables.append(table_data)

        return tables

    async def extract_element(
        self,
        url: str,
        selector: str,
    ) -> str | None:
        """
        Extract content from a specific element on a page.

        Args:
            url: URL to navigate to
            selector: CSS selector for the element

        Returns:
            Text content of the element, or None if not found
        """
        page = await self.navigate(url)
        if not page.success:
            return None

        session = await self._get_session()
        async with session.get(url) as response:
            html = await response.text()

        soup = BeautifulSoup(html, "html.parser")
        element = soup.select_one(selector)

        if element:
            return element.get_text(strip=True)
        return None

    async def close(self) -> None:
        """Close browser and session."""
        if self._session and not self._session.closed:
            await self._session.close()
