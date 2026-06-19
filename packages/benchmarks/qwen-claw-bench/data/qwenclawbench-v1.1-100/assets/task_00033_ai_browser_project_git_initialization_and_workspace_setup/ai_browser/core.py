"""Core browser engine for AI-powered web content extraction."""

import asyncio
import logging
import os
from typing import Dict, List, Optional, Any
from urllib.parse import urlparse

import yaml

logger = logging.getLogger(__name__)


class BrowserConfig:
    """Configuration container for AIBrowser."""

    def __init__(self, config_path: Optional[str] = None):
        self.headless = True
        self.timeout = 30000
        self.viewport = {"width": 1280, "height": 720}
        self.user_agent = None
        self.proxy = None
        self.max_retries = 3
        self.wait_for_idle = True
        self.screenshot_on_error = False
        self.output_dir = "output"

        if config_path and os.path.exists(config_path):
            with open(config_path, "r") as f:
                cfg = yaml.safe_load(f) or {}
            for key, value in cfg.items():
                if hasattr(self, key):
                    setattr(self, key, value)


class PageContent:
    """Extracted page content container."""

    def __init__(self, url: str, title: str = "", html: str = "",
                 text: str = "", metadata: Optional[Dict] = None):
        self.url = url
        self.title = title
        self.html = html
        self.text = text
        self.metadata = metadata or {}
        self.images: List[str] = []
        self.links: List[Dict[str, str]] = []
        self.structured_data: Optional[Dict] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "url": self.url,
            "title": self.title,
            "text": self.text,
            "metadata": self.metadata,
            "images": self.images,
            "links": self.links,
            "structured_data": self.structured_data,
        }


class AIBrowser:
    """Main browser class for intelligent web content extraction.

    Supports headless browsing with Playwright, content extraction,
    JavaScript rendering, and structured data output.
    """

    def __init__(self, config: Optional[BrowserConfig] = None):
        self.config = config or BrowserConfig()
        self._browser = None
        self._context = None
        self._page = None
        self._network_requests: List[Dict] = []

    async def __aenter__(self):
        await self.start()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.close()

    async def start(self):
        """Launch the browser instance."""
        try:
            from playwright.async_api import async_playwright
            self._playwright = await async_playwright().start()
            self._browser = await self._playwright.chromium.launch(
                headless=self.config.headless
            )
            self._context = await self._browser.new_context(
                viewport=self.config.viewport,
                user_agent=self.config.user_agent,
            )
            if self.config.proxy:
                logger.info("Using proxy: %s", self.config.proxy)
            logger.info("Browser started (headless=%s)", self.config.headless)
        except ImportError:
            raise RuntimeError(
                "playwright is required. Install with: pip install playwright && playwright install"
            )

    async def close(self):
        """Close the browser and clean up resources."""
        if self._page:
            await self._page.close()
        if self._context:
            await self._context.close()
        if self._browser:
            await self._browser.close()
        if hasattr(self, "_playwright"):
            await self._playwright.stop()
        logger.info("Browser closed")

    async def navigate(self, url: str, wait_until: str = "networkidle") -> PageContent:
        """Navigate to a URL and extract page content.

        Args:
            url: Target URL to navigate to.
            wait_until: Navigation wait condition ('load', 'domcontentloaded', 'networkidle').

        Returns:
            PageContent with extracted data.
        """
        parsed = urlparse(url)
        if not parsed.scheme:
            url = f"https://{url}"

        self._page = await self._context.new_page()

        # Set up network monitoring
        self._network_requests = []
        self._page.on("request", lambda req: self._network_requests.append({
            "url": req.url,
            "method": req.method,
            "resource_type": req.resource_type,
        }))

        try:
            response = await self._page.goto(
                url,
                wait_until=wait_until,
                timeout=self.config.timeout,
            )

            if self.config.wait_for_idle:
                await self._page.wait_for_load_state("networkidle")

            title = await self._page.title()
            html = await self._page.content()
            text = await self._page.inner_text("body")

            content = PageContent(
                url=url,
                title=title,
                html=html,
                text=text,
                metadata={
                    "status": response.status if response else None,
                    "headers": dict(response.headers) if response else {},
                    "network_requests": len(self._network_requests),
                },
            )

            # Extract images
            images = await self._page.query_selector_all("img")
            for img in images:
                src = await img.get_attribute("src")
                if src:
                    content.images.append(src)

            # Extract links
            anchors = await self._page.query_selector_all("a[href]")
            for a in anchors:
                href = await a.get_attribute("href")
                link_text = await a.inner_text()
                if href:
                    content.links.append({"href": href, "text": link_text.strip()})

            # Try to extract JSON-LD structured data
            ld_scripts = await self._page.query_selector_all(
                'script[type="application/ld+json"]'
            )
            for script in ld_scripts:
                import json
                try:
                    raw = await script.inner_text()
                    content.structured_data = json.loads(raw)
                    break
                except json.JSONDecodeError:
                    continue

            logger.info("Extracted content from %s (%d chars)", url, len(text))
            return content

        except Exception as e:
            if self.config.screenshot_on_error and self._page:
                screenshot_path = os.path.join(
                    self.config.output_dir, "error_screenshot.png"
                )
                await self._page.screenshot(path=screenshot_path)
                logger.error("Screenshot saved to %s", screenshot_path)
            raise

    async def extract_with_template(self, url: str, template_name: str) -> Dict:
        """Extract content using a named template from json_templates.yaml.

        Args:
            url: Target URL.
            template_name: Name of the extraction template.

        Returns:
            Extracted data matching the template schema.
        """
        from .template_engine import TemplateEngine
        engine = TemplateEngine()
        content = await self.navigate(url)
        return engine.apply_template(template_name, content.html)

    def get_network_log(self) -> List[Dict]:
        """Return captured network requests."""
        return self._network_requests.copy()
