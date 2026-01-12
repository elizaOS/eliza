from __future__ import annotations

import html
import re
from xml.etree.ElementTree import Element

from defusedxml import ElementTree as ET

from elizaos_plugin_rss.types import RssEnclosure, RssFeed, RssImage, RssItem


def _get_text(element: Element | None, tag: str, namespaces: dict[str, str] | None = None) -> str:
    if element is None:
        return ""

    child = element.find(tag, namespaces)
    if child is None or child.text is None:
        return ""

    text = child.text.strip()
    text = html.unescape(text)
    return text


def _get_all_text(
    element: Element | None, tag: str, namespaces: dict[str, str] | None = None
) -> list[str]:
    if element is None:
        return []

    results: list[str] = []
    for child in element.findall(tag, namespaces):
        if child.text:
            text = html.unescape(child.text.strip())
            if text:
                results.append(text)
    return results


def _parse_cdata(text: str) -> str:
    cdata_pattern = re.compile(r"<!\[CDATA\[(.*?)\]\]>", re.DOTALL)
    return cdata_pattern.sub(r"\1", text)


def _parse_image(channel: Element) -> RssImage | None:
    image = channel.find("image")
    if image is None:
        return None

    return RssImage(
        url=_get_text(image, "url"),
        title=_get_text(image, "title"),
        link=_get_text(image, "link"),
        width=_get_text(image, "width"),
        height=_get_text(image, "height"),
    )


def _parse_enclosure(item: Element) -> RssEnclosure | None:
    enclosure = item.find("enclosure")
    if enclosure is None:
        return None

    return RssEnclosure(
        url=enclosure.get("url", ""),
        type=enclosure.get("type", ""),
        length=enclosure.get("length", ""),
    )


def _parse_rss_item(item: Element) -> RssItem:
    description = _get_text(item, "description")
    description = _parse_cdata(description)

    return RssItem(
        title=_get_text(item, "title"),
        link=_get_text(item, "link"),
        pubDate=_get_text(item, "pubDate"),
        description=description,
        author=_get_text(item, "author"),
        category=_get_all_text(item, "category"),
        comments=_get_text(item, "comments"),
        guid=_get_text(item, "guid"),
        enclosure=_parse_enclosure(item),
    )


def _parse_atom_item(entry: Element, namespaces: dict[str, str]) -> RssItem:
    link = ""
    link_elem = entry.find("atom:link[@rel='alternate']", namespaces)
    if link_elem is None:
        link_elem = entry.find("atom:link", namespaces)
    if link_elem is not None:
        link = link_elem.get("href", "")

    description = _get_text(entry, "atom:content", namespaces)
    if not description:
        description = _get_text(entry, "atom:summary", namespaces)
    description = _parse_cdata(description)
    categories: list[str] = []
    for cat in entry.findall("atom:category", namespaces):
        term = cat.get("term", "")
        if term:
            categories.append(term)

    return RssItem(
        title=_get_text(entry, "atom:title", namespaces),
        link=link,
        pubDate=_get_text(entry, "atom:published", namespaces)
        or _get_text(entry, "atom:updated", namespaces),
        description=description,
        author=_get_text(entry, "atom:author/atom:name", namespaces),
        category=categories,
        comments="",
        guid=_get_text(entry, "atom:id", namespaces),
        enclosure=None,
    )


def parse_rss_to_json(xml_content: str) -> RssFeed:
    try:
        root = ET.fromstring(xml_content)

        if root.tag == "{http://www.w3.org/2005/Atom}feed" or root.tag == "feed":
            return _parse_atom_feed(root)
        return _parse_rss_feed(root)

    except ET.ParseError as e:
        raise ValueError(f"Failed to parse XML: {e}") from e


def _parse_rss_feed(root: Element) -> RssFeed:
    channel = root.find("channel")
    if channel is None:
        raise ValueError("No channel element found in RSS feed")

    description = _get_text(channel, "description")
    description = _parse_cdata(description)
    items: list[RssItem] = []
    for item in channel.findall("item"):
        items.append(_parse_rss_item(item))

    return RssFeed(
        title=_get_text(channel, "title"),
        description=description,
        link=_get_text(channel, "link"),
        language=_get_text(channel, "language"),
        copyright=_get_text(channel, "copyright"),
        lastBuildDate=_get_text(channel, "lastBuildDate"),
        generator=_get_text(channel, "generator"),
        docs=_get_text(channel, "docs"),
        ttl=_get_text(channel, "ttl"),
        image=_parse_image(channel),
        items=items,
    )


def _parse_atom_feed(root: Element) -> RssFeed:
    ns = {"atom": "http://www.w3.org/2005/Atom"}

    if root.tag == "{http://www.w3.org/2005/Atom}feed":
        namespaces = ns
        prefix = "atom:"
    else:
        namespaces = {}
        prefix = ""

    link = ""
    link_elem = (
        root.find(f"{prefix}link[@rel='alternate']", namespaces)
        if namespaces
        else root.find("link[@rel='alternate']")
    )
    if link_elem is None:
        link_elem = root.find(f"{prefix}link", namespaces) if namespaces else root.find("link")
    if link_elem is not None:
        link = link_elem.get("href", "")

    description = ""
    if namespaces:
        description = _get_text(root, "atom:subtitle", namespaces)
    else:
        subtitle = root.find("subtitle")
        if subtitle is not None and subtitle.text:
            description = subtitle.text.strip()

    items: list[RssItem] = []
    entry_tag = f"{prefix}entry" if prefix else "entry"
    for entry in root.findall(entry_tag, namespaces) if namespaces else root.findall("entry"):
        items.append(_parse_atom_item(entry, namespaces))

    title = ""
    if namespaces:
        title = _get_text(root, "atom:title", namespaces)
    else:
        title_elem = root.find("title")
        if title_elem is not None and title_elem.text:
            title = title_elem.text.strip()

    return RssFeed(
        title=title,
        description=description,
        link=link,
        language="",
        copyright="",
        lastBuildDate=_get_text(root, f"{prefix}updated", namespaces) if namespaces else "",
        generator=_get_text(root, f"{prefix}generator", namespaces) if namespaces else "",
        docs="",
        ttl="",
        image=None,
        items=items,
    )


def create_empty_feed() -> RssFeed:
    return RssFeed(
        title="",
        description="",
        link="",
        language="",
        copyright="",
        lastBuildDate="",
        generator="",
        docs="",
        ttl="",
        image=None,
        items=[],
    )
