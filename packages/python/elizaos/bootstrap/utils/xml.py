"""
XML parsing utilities for elizaOS.

This module provides utilities for parsing XML responses from LLM models.
"""

from __future__ import annotations

import re
from typing import Any


def parse_key_value_xml(xml: str) -> dict[str, Any] | None:
    """
    Parse key-value pairs from an XML response.

    Extracts values from XML tags like `<key>value</key>` and returns
    them as a dictionary.

    Args:
        xml: The XML string to parse

    Returns:
        A dictionary of tag names to their text content, or None if parsing fails.

    Example:
        >>> xml = '<response><thought>Thinking</thought><text>Hello</text></response>'
        >>> result = parse_key_value_xml(xml)
        >>> result
        {'thought': 'Thinking', 'text': 'Hello'}
    """
    if not xml or not isinstance(xml, str):
        return None

    result: dict[str, Any] = {}

    # Find the response block
    response_match = re.search(r"<response>(.*?)</response>", xml, re.DOTALL)
    content = response_match.group(1) if response_match else xml

    # Parse individual tags
    # Match tags like <tag>content</tag>
    tag_pattern = re.compile(r"<(\w+)(?:\s[^>]*)?>([^<]*(?:<(?!/\1>)[^<]*)*)</\1>", re.DOTALL)

    for match in tag_pattern.finditer(content):
        tag_name = match.group(1)
        tag_value = match.group(2).strip()

        # Check if this is a container tag (has nested tags)
        if "<" in tag_value and ">" in tag_value:
            # Try to parse nested tags
            nested_result = parse_nested_tags(tag_value)
            if nested_result:
                result[tag_name] = nested_result
            else:
                result[tag_name] = tag_value
        else:
            result[tag_name] = tag_value

    return result if result else None


def parse_nested_tags(content: str) -> dict[str, Any] | list[Any] | None:
    """
    Parse nested XML tags.

    Args:
        content: The XML content to parse

    Returns:
        A dictionary or list of parsed values, or None if no tags found.
    """
    result: dict[str, list[Any]] = {}

    # Match simple nested tags
    tag_pattern = re.compile(r"<(\w+)(?:\s[^>]*)?>([^<]*(?:<(?!/\1>)[^<]*)*)</\1>", re.DOTALL)

    for match in tag_pattern.finditer(content):
        tag_name = match.group(1)
        tag_value = match.group(2).strip()

        if tag_name not in result:
            result[tag_name] = []

        # Recursively parse if there are nested tags
        if "<" in tag_value and ">" in tag_value:
            nested = parse_nested_tags(tag_value)
            if nested:
                result[tag_name].append(nested)
            else:
                result[tag_name].append(tag_value)
        else:
            result[tag_name].append(tag_value)

    if not result:
        return None

    # Simplify result - if only one item in each list, unwrap
    simplified: dict[str, Any] = {}
    for key, values in result.items():
        if len(values) == 1:
            simplified[key] = values[0]
        else:
            simplified[key] = values

    return simplified
