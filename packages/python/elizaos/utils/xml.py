"""XML parsing utilities for elizaOS.

Parses simple key-value XML emitted by LLM prompts. Matches behavior of
TypeScript and Rust implementations.
"""

from __future__ import annotations

import re


def parse_key_value_xml(text: str) -> dict[str, str] | None:
    """Parse key-value pairs from an XML response.

    - Extracts direct children from a <response>...</response> wrapper when present.
    - Otherwise scans the input for direct child elements.
    - Nested tags inside a child are preserved as raw inner text.

    Args:
        text: The input text containing the XML structure.

    Returns:
        Dict of tag name -> inner text, or None if parsing fails or no pairs found.
    """
    if not text or not text.strip():
        return None

    # Find the response block
    response_content: str
    start_tag = "<response>"
    end_tag = "</response>"
    start_idx = text.find(start_tag)
    if start_idx != -1:
        content_start = start_idx + len(start_tag)
        end_idx = text.find(end_tag, content_start)
        response_content = text[content_start:end_idx] if end_idx != -1 else text
    else:
        response_content = text

    result: dict[str, str] = {}
    # Match <tagName>value</tagName> - direct children only (non-greedy)
    # Tag names: alphanumeric, underscore, hyphen
    pattern = re.compile(
        r"<([A-Za-z0-9_-]+)>([\s\S]*?)</\1>",
        re.IGNORECASE,
    )
    for match in pattern.finditer(response_content):
        tag_name, value = match.group(1), match.group(2)
        result[tag_name] = value.strip()

    return result if result else None
