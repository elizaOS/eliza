import re

from elizaos.types.memory import Memory


def validate_action_keywords(
    message: Memory, recent_messages: list[Memory], keywords: list[str]
) -> bool:
    """
    Validates if any of the given keywords are present in the recent message history.

    Checks:
    1. The current message content
    2. The last 5 messages in recent_messages
    """
    if not keywords:
        return False

    relevant_text = []

    # 1. Current message content
    if message.content and message.content.text:
        relevant_text.append(message.content.text)

    # 2. Recent messages (last 5)
    # Take the last 5 messages
    recent_subset = recent_messages[-5:] if recent_messages else []

    for msg in recent_subset:
        if msg.content and msg.content.text:
            relevant_text.append(msg.content.text)

    if not relevant_text:
        return False

    combined_text = "\n".join(relevant_text).lower()

    return any(keyword.lower() in combined_text for keyword in keywords)


def validate_action_regex(
    message: Memory, recent_messages: list[Memory], regex_pattern: str
) -> bool:
    """
    Validates if any of the recent message history matches the given regex pattern.

    Args:
        message: The current message memory
        recent_messages: List of recent memories
        regex_pattern: The regular expression pattern to check against

    Returns:
        bool: True if the regex matches any message content, False otherwise
    """
    if not regex_pattern:
        return False

    relevant_text = []

    # 1. Current message content
    if message.content and message.content.text:
        relevant_text.append(message.content.text)

    # 2. Recent messages (last 5)
    recent_subset = recent_messages[-5:] if recent_messages else []

    for msg in recent_subset:
        if msg.content and msg.content.text:
            relevant_text.append(msg.content.text)

    if not relevant_text:
        return False

    combined_text = "\n".join(relevant_text)

    return bool(re.search(regex_pattern, combined_text, re.MULTILINE))
