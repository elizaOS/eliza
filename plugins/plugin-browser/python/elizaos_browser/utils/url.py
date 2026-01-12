import re


def extract_url(text: str) -> str | None:
    quoted_match = re.search(r'["\']([^"\']+)["\']', text)
    if quoted_match:
        url = quoted_match.group(1)
        if url.startswith("http") or "." in url:
            return url

    url_match = re.search(r"(https?://[^\s]+)", text)
    if url_match:
        return url_match.group(1)

    domain_match = re.search(
        r"(?:go to|navigate to|open|visit)\s+([a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.[a-zA-Z]{2,})",
        text,
        re.IGNORECASE,
    )
    if domain_match:
        return f"https://{domain_match.group(1)}"

    return None


def parse_click_target(text: str) -> str:
    match = re.search(r"click (?:on |the )?(.+)$", text, re.IGNORECASE)
    return match.group(1) if match else "element"


def parse_type_action(text: str) -> tuple[str, str]:
    text_match = re.search(r'["\']([^"\']+)["\']', text)
    text_to_type = text_match.group(1) if text_match else ""

    field_match = re.search(r"(?:in|into) (?:the )?(.+)$", text, re.IGNORECASE)
    field = field_match.group(1) if field_match else "input field"

    return text_to_type, field


def parse_select_action(text: str) -> tuple[str, str]:
    option_match = re.search(r'["\']([^"\']+)["\']', text)
    option = option_match.group(1) if option_match else ""

    dropdown_match = re.search(r"from (?:the )?(.+)$", text, re.IGNORECASE)
    dropdown = dropdown_match.group(1) if dropdown_match else "dropdown"

    return option, dropdown


def parse_extract_instruction(text: str) -> str:
    match = re.search(
        r"(?:extract|get|find|scrape|read) (?:the )?(.+?)(?:\s+from|\s*$)",
        text,
        re.IGNORECASE,
    )
    return match.group(1) if match else text
