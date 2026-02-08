"""XML parsing utilities for elizaOS."""

from __future__ import annotations

import re
from typing import Any


def parse_key_value_xml(xml: str) -> dict[str, Any] | None:
    """Parse key-value pairs from XML tags."""
    if not xml or not isinstance(xml, str):
        return None

    result: dict[str, Any] = {}

    response_match = re.search(r"<response>(.*?)</response>", xml, re.DOTALL)
    content = response_match.group(1) if response_match else xml

    tag_pattern = re.compile(r"<(\w+)(?:\s[^>]*)?>([^<]*(?:<(?!/\1>)[^<]*)*)</\1>", re.DOTALL)

    for match in tag_pattern.finditer(content):
        tag_name = match.group(1)
        tag_value = match.group(2).strip()

        if "<" in tag_value and ">" in tag_value:
            nested_result = parse_nested_tags(tag_value)
            if nested_result:
                result[tag_name] = nested_result
            else:
                result[tag_name] = tag_value
        else:
            result[tag_name] = tag_value

    return result if result else None


def parse_nested_tags(content: str) -> dict[str, Any] | list[Any] | None:
    """Parse nested XML tags."""
    result: dict[str, list[Any]] = {}

    tag_pattern = re.compile(r"<(\w+)(?:\s[^>]*)?>([^<]*(?:<(?!/\1>)[^<]*)*)</\1>", re.DOTALL)

    for match in tag_pattern.finditer(content):
        tag_name = match.group(1)
        tag_value = match.group(2).strip()

        if tag_name not in result:
            result[tag_name] = []

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

    simplified: dict[str, Any] = {}
    for key, values in result.items():
        if len(values) == 1:
            simplified[key] = values[0]
        else:
            simplified[key] = values

    return simplified
