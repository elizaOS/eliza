"""Content cleaning module for removing ads, navigation, and boilerplate."""

import re
import logging
from typing import Dict, List, Optional, Set, Tuple
from dataclasses import dataclass, field

import yaml
from bs4 import BeautifulSoup, Tag

logger = logging.getLogger(__name__)

# Default selectors for elements to remove
DEFAULT_REMOVE_SELECTORS = [
    "script", "style", "noscript", "iframe",
    "nav", "header", "footer",
    ".ad", ".ads", ".advertisement", ".ad-container",
    ".sidebar", ".social-share", ".comments",
    "[data-ad]", "[data-advertisement]",
    ".cookie-banner", ".popup", ".modal",
    ".related-articles", ".recommended",
    "#disqus_thread", ".share-buttons",
]

# Selectors that indicate main content
CONTENT_SELECTORS = [
    "article", "main", ".article-body", ".post-content",
    ".entry-content", ".story-body", "#article-content",
    "[role='main']", ".article-text", ".content-body",
]


@dataclass
class CleaningStats:
    """Statistics about the cleaning process."""
    elements_removed: int = 0
    ads_removed: int = 0
    scripts_removed: int = 0
    images_preserved: int = 0
    links_preserved: int = 0
    original_size: int = 0
    cleaned_size: int = 0
    selectors_matched: List[str] = field(default_factory=list)

    @property
    def reduction_percent(self) -> float:
        if self.original_size == 0:
            return 0.0
        return (1 - self.cleaned_size / self.original_size) * 100


class ContentCleaner:
    """Removes ads, boilerplate, and noise from HTML content.

    Uses configurable rules from rules.yaml and CSS selectors to identify
    and remove unwanted elements while preserving article content.
    """

    def __init__(self, rules_path: Optional[str] = None):
        self.remove_selectors: List[str] = DEFAULT_REMOVE_SELECTORS.copy()
        self.content_selectors: List[str] = CONTENT_SELECTORS.copy()
        self.preserve_images = True
        self.preserve_links = True
        self.min_text_length = 25
        self._custom_rules: Dict = {}

        if rules_path:
            self._load_rules(rules_path)

    def _load_rules(self, path: str):
        """Load cleaning rules from a YAML file."""
        try:
            with open(path, "r") as f:
                rules = yaml.safe_load(f) or {}

            if "remove_selectors" in rules:
                self.remove_selectors.extend(rules["remove_selectors"])
            if "content_selectors" in rules:
                self.content_selectors = rules["content_selectors"]
            if "preserve_images" in rules:
                self.preserve_images = rules["preserve_images"]
            if "min_text_length" in rules:
                self.min_text_length = rules["min_text_length"]

            self._custom_rules = rules
            logger.info("Loaded %d custom rules from %s", len(rules), path)
        except Exception as e:
            logger.warning("Failed to load rules from %s: %s", path, e)

    def clean(self, html: str, url: Optional[str] = None) -> Tuple[str, CleaningStats]:
        """Clean HTML content by removing ads and boilerplate.

        Args:
            html: Raw HTML string.
            url: Source URL for domain-specific rules.

        Returns:
            Tuple of (cleaned HTML, cleaning statistics).
        """
        stats = CleaningStats(original_size=len(html))
        soup = BeautifulSoup(html, "html.parser")

        # Apply domain-specific rules if URL provided
        if url:
            domain_rules = self._get_domain_rules(url)
            if domain_rules:
                for selector in domain_rules.get("extra_remove", []):
                    self.remove_selectors.append(selector)

        # Phase 1: Remove unwanted elements
        for selector in self.remove_selectors:
            elements = soup.select(selector)
            for el in elements:
                tag_name = el.name if isinstance(el, Tag) else "unknown"
                el.decompose()
                stats.elements_removed += 1
                if "ad" in selector.lower():
                    stats.ads_removed += 1
                if tag_name in ("script", "style"):
                    stats.scripts_removed += 1
                if selector not in stats.selectors_matched:
                    stats.selectors_matched.append(selector)

        # Phase 2: Try to isolate main content
        main_content = None
        for selector in self.content_selectors:
            found = soup.select_one(selector)
            if found and len(found.get_text(strip=True)) > self.min_text_length:
                main_content = found
                break

        if main_content:
            soup = BeautifulSoup(str(main_content), "html.parser")

        # Phase 3: Remove empty elements
        for tag in soup.find_all():
            if isinstance(tag, Tag) and not tag.get_text(strip=True) and tag.name not in ("img", "br", "hr"):
                if not (self.preserve_images and tag.find("img")):
                    tag.decompose()
                    stats.elements_removed += 1

        # Count preserved elements
        if self.preserve_images:
            stats.images_preserved = len(soup.find_all("img"))
        if self.preserve_links:
            stats.links_preserved = len(soup.find_all("a"))

        cleaned_html = str(soup)
        stats.cleaned_size = len(cleaned_html)

        logger.info(
            "Cleaned HTML: %d -> %d bytes (%.1f%% reduction, %d elements removed)",
            stats.original_size, stats.cleaned_size,
            stats.reduction_percent, stats.elements_removed,
        )

        return cleaned_html, stats

    def to_markdown(self, html: str) -> str:
        """Convert cleaned HTML to markdown format.

        Args:
            html: Cleaned HTML string.

        Returns:
            Markdown-formatted text.
        """
        soup = BeautifulSoup(html, "html.parser")
        lines = []

        for element in soup.descendants:
            if isinstance(element, str):
                text = element.strip()
                if text:
                    lines.append(text)
            elif isinstance(element, Tag):
                if element.name in ("h1", "h2", "h3", "h4", "h5", "h6"):
                    level = int(element.name[1])
                    text = element.get_text(strip=True)
                    if text:
                        lines.append(f"\n{'#' * level} {text}\n")
                elif element.name == "p":
                    text = element.get_text(strip=True)
                    if text:
                        lines.append(f"\n{text}\n")
                elif element.name == "li":
                    text = element.get_text(strip=True)
                    if text:
                        lines.append(f"- {text}")
                elif element.name == "img":
                    src = element.get("src", "")
                    alt = element.get("alt", "")
                    if src:
                        lines.append(f"![{alt}]({src})")
                elif element.name == "a":
                    href = element.get("href", "")
                    text = element.get_text(strip=True)
                    if href and text:
                        lines.append(f"[{text}]({href})")

        # Remove duplicate blank lines
        result = re.sub(r"\n{3,}", "\n\n", "\n".join(lines))
        return result.strip()

    def _get_domain_rules(self, url: str) -> Optional[Dict]:
        """Get domain-specific cleaning rules."""
        from urllib.parse import urlparse
        domain = urlparse(url).netloc
        return self._custom_rules.get("domains", {}).get(domain)

    def extract_text_only(self, html: str) -> str:
        """Extract plain text from HTML, stripping all tags."""
        soup = BeautifulSoup(html, "html.parser")
        return soup.get_text(separator="\n", strip=True)
