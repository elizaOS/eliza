"""
Robust XML parser utilities for handling model responses.

Handles edge cases like:
- Code blocks that contain XML-like syntax
- CDATA sections
- Nested tags
- Malformed XML
"""

import re
from typing import TypeVar

T = TypeVar("T", bound=dict)


def extract_xml_tag(text: str, tag_name: str) -> str | None:
    """Extract content from an XML tag, handling CDATA sections and nested tags."""
    if not text or not tag_name:
        return None

    # First, try to find CDATA content
    cdata_pattern = re.compile(
        rf"<{tag_name}[^>]*>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*</{tag_name}>", re.IGNORECASE
    )
    cdata_match = cdata_pattern.search(text)
    if cdata_match:
        return cdata_match.group(1)

    # Handle regular content with proper nesting using linear scanning
    start_tag_pattern = f"<{tag_name}"
    end_tag = f"</{tag_name}>"

    start_idx = text.find(start_tag_pattern)
    if start_idx == -1:
        return None

    # Find the end of the start tag (handle attributes)
    start_tag_end = text.find(">", start_idx)
    if start_tag_end == -1:
        return None

    # Check for self-closing tag
    if "/>" in text[start_idx : start_tag_end + 1]:
        return ""

    content_start = start_tag_end + 1

    # Use depth counting to handle nested same-name tags
    depth = 1
    search_start = content_start

    while depth > 0 and search_start < len(text):
        next_open = text.find(start_tag_pattern, search_start)
        next_close = text.find(end_tag, search_start)

        if next_close == -1:
            # No closing tag found
            break

        if next_open != -1 and next_open < next_close:
            # Check if this is a start tag (not self-closing)
            nested_end_idx = text.find(">", next_open)
            if nested_end_idx != -1:
                nested_tag_content = text[next_open : nested_end_idx + 1]
                if "/>" not in nested_tag_content:
                    depth += 1
            search_start = nested_end_idx + 1 if nested_end_idx != -1 else next_open + 1
        else:
            depth -= 1
            if depth == 0:
                content = text[content_start:next_close]
                return unescape_xml(content.strip())
            search_start = next_close + len(end_tag)

    return None


def unescape_xml(text: str) -> str:
    """Unescape common XML entities."""
    result = text
    result = result.replace("&lt;", "<")
    result = result.replace("&gt;", ">")
    result = result.replace("&amp;", "&")
    result = result.replace("&quot;", '"')
    result = result.replace("&apos;", "'")

    # Handle numeric entities
    def replace_numeric(match: re.Match[str]) -> str:
        code = int(match.group(1))
        return chr(code)

    def replace_hex(match: re.Match[str]) -> str:
        code = int(match.group(1), 16)
        return chr(code)

    result = re.sub(r"&#(\d+);", replace_numeric, result)
    result = re.sub(r"&#x([0-9a-fA-F]+);", replace_hex, result)

    return result


def escape_xml(text: str) -> str:
    """Escape text for safe inclusion in XML."""
    result = text
    result = result.replace("&", "&amp;")
    result = result.replace("<", "&lt;")
    result = result.replace(">", "&gt;")
    result = result.replace('"', "&quot;")
    result = result.replace("'", "&apos;")
    return result


def wrap_in_cdata(text: str) -> str:
    """Wrap content in CDATA section if it contains special characters."""
    if "<" in text or ">" in text or "&" in text:
        # Handle nested CDATA by escaping the closing sequence
        escaped_text = text.replace("]]>", "]]]]><![CDATA[>")
        return f"<![CDATA[{escaped_text}]]>"
    return text


def parse_simple_xml(text: str) -> dict | None:
    """Parse a simple key-value XML structure into a dictionary."""
    if not text:
        return None

    # Find the response block
    xml_content = extract_xml_tag(text, "response")

    # If no response block, try to find any XML-like structure
    if not xml_content:
        for wrapper in ["result", "output", "data", "answer"]:
            xml_content = extract_xml_tag(text, wrapper)
            if xml_content:
                break

    # If still no XML content, try to parse the text directly
    if not xml_content:
        if "<" not in text or ">" not in text:
            return None
        xml_content = text

    result: dict = {}

    # Extract all top-level tags
    tag_pattern = re.compile(r"<([a-zA-Z][a-zA-Z0-9_-]*)[^>]*>")
    found_tags: set[str] = set()

    for match in tag_pattern.finditer(xml_content):
        tag_name = match.group(1)
        # Skip if we've already processed this tag
        if tag_name in found_tags:
            continue
        found_tags.add(tag_name)

        value = extract_xml_tag(xml_content, tag_name)
        if value is not None:
            # Handle special cases
            if tag_name in ("actions", "providers", "evaluators"):
                # Parse comma-separated lists
                result[tag_name] = [s.strip() for s in value.split(",") if s.strip()]
            elif tag_name in ("simple", "success", "error"):
                # Parse boolean values
                result[tag_name] = value.lower() == "true"
            else:
                result[tag_name] = value

    if not result:
        return None

    return result


def sanitize_for_xml(content: str) -> str:
    """Sanitize user content for safe XML inclusion."""
    # Check if content contains XML-like syntax that could cause parsing issues
    has_xml_like_syntax = re.search(r"<[a-zA-Z]", content) or "</" in content

    if has_xml_like_syntax:
        # Wrap in CDATA to preserve the content exactly
        return wrap_in_cdata(content)

    # Otherwise, just escape special characters
    return escape_xml(content)


def build_xml_response(data: dict) -> str:
    """Build an XML response string from a dictionary."""
    parts: list[str] = ["<response>"]

    for key, value in data.items():
        if value is None:
            continue

        if isinstance(value, list):
            # Join array values with commas
            parts.append(f"  <{key}>{', '.join(str(v) for v in value)}</{key}>")
        elif isinstance(value, bool):
            parts.append(f"  <{key}>{str(value).lower()}</{key}>")
        elif isinstance(value, str):
            # Check if the string needs CDATA wrapping
            content = sanitize_for_xml(value)
            parts.append(f"  <{key}>{content}</{key}>")
        elif isinstance(value, dict):
            # Nested object - serialize recursively
            nested = build_xml_response(value)
            # Strip outer response tags and indent
            inner_content = nested.replace("<response>\n", "").replace("\n</response>", "")
            inner_lines = ["  " + line for line in inner_content.split("\n")]
            parts.append(f"  <{key}>\n" + "\n".join(inner_lines) + f"\n  </{key}>")
        else:
            parts.append(f"  <{key}>{value}</{key}>")

    parts.append("</response>")
    return "\n".join(parts)


# =============================================================================
# Test functions (run with pytest)
# =============================================================================


def test_extract_simple_tag() -> None:
    xml = "<response><name>John</name></response>"
    assert extract_xml_tag(xml, "name") == "John"


def test_extract_cdata() -> None:
    xml = "<response><code><![CDATA[<script>alert('hello')</script>]]></code></response>"
    assert extract_xml_tag(xml, "code") == "<script>alert('hello')</script>"


def test_extract_nested_tags() -> None:
    xml = "<response><outer><inner>value</inner></outer></response>"
    outer = extract_xml_tag(xml, "outer")
    assert outer is not None
    assert "<inner>value</inner>" in outer


def test_escape_xml() -> None:
    assert escape_xml("<test>") == "&lt;test&gt;"


def test_unescape_xml() -> None:
    assert unescape_xml("&lt;test&gt;") == "<test>"


def test_unescape_numeric_entities() -> None:
    # Decimal entity
    assert unescape_xml("&#60;") == "<"
    assert unescape_xml("&#62;") == ">"
    # Hex entity
    assert unescape_xml("&#x3C;") == "<"
    assert unescape_xml("&#x3E;") == ">"
    # Combined
    assert unescape_xml("&#60;test&#62;") == "<test>"


def test_wrap_in_cdata() -> None:
    assert wrap_in_cdata("<code>") == "<![CDATA[<code>]]>"
    assert wrap_in_cdata("plain text") == "plain text"


def test_wrap_nested_cdata() -> None:
    # Nested CDATA should be escaped
    assert wrap_in_cdata("data]]>more") == "<![CDATA[data]]]]><![CDATA[>more]]>"


def test_parse_simple_xml() -> None:
    xml = "<response><thought>thinking...</thought><text>Hello world</text></response>"
    result = parse_simple_xml(xml)
    assert result is not None
    assert result.get("thought") == "thinking..."
    assert result.get("text") == "Hello world"


def test_parse_list_fields() -> None:
    xml = "<response><actions>action1, action2, action3</actions></response>"
    result = parse_simple_xml(xml)
    assert result is not None
    actions = result.get("actions")
    assert actions == ["action1", "action2", "action3"]


def test_parse_boolean_fields() -> None:
    xml = "<response><success>true</success><error>false</error></response>"
    result = parse_simple_xml(xml)
    assert result is not None
    assert result.get("success") is True
    assert result.get("error") is False


def test_self_closing_tag() -> None:
    xml = "<response><empty/></response>"
    assert extract_xml_tag(xml, "empty") == ""


def test_code_in_cdata() -> None:
    xml = """<response>
<code><![CDATA[
function test() {
    if (x < 10 && y > 5) {
        return "<div>" + x + "</div>";
    }
}
]]></code>
</response>"""
    code = extract_xml_tag(xml, "code")
    assert code is not None
    assert "if (x < 10 && y > 5)" in code
    assert "<div>" in code
