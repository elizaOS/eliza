"""Text processor for TTS.

Handles text cleaning, length limits, and truncation for speech synthesis.
"""

from __future__ import annotations

import re


def clean_text_for_tts(text: str) -> str:
    """Clean text for TTS synthesis.

    Removes markdown, code blocks, URLs, and other non-speech content.
    """
    cleaned = text

    # Remove code blocks
    cleaned = re.sub(r"```[\s\S]*?```", "[code block]", cleaned)

    # Remove inline code
    cleaned = re.sub(r"`[^`]+`", "[code]", cleaned)

    # Remove markdown links but keep text (must come before URL removal)
    cleaned = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", cleaned)

    # Remove URLs
    cleaned = re.sub(r"https?://[^\s]+", "[link]", cleaned)

    # Remove markdown bold/italic
    cleaned = re.sub(r"\*\*([^*]+)\*\*", r"\1", cleaned)
    cleaned = re.sub(r"\*([^*]+)\*", r"\1", cleaned)
    cleaned = re.sub(r"__([^_]+)__", r"\1", cleaned)
    cleaned = re.sub(r"_([^_]+)_", r"\1", cleaned)

    # Remove markdown headers
    cleaned = re.sub(r"^#{1,6}\s+", "", cleaned, flags=re.MULTILINE)

    # Remove HTML tags
    cleaned = re.sub(r"<[^>]+>", "", cleaned)

    # Convert multiple newlines to single
    cleaned = re.sub(r"\n{2,}", "\n", cleaned)

    # Remove leading/trailing whitespace
    cleaned = cleaned.strip()

    return cleaned


def truncate_text(text: str, max_length: int) -> str:
    """Truncate text to *max_length*, trying to break at sentence boundaries."""
    if len(text) <= max_length:
        return text

    # Try to break at sentence boundary
    truncated = text[:max_length]

    sentence_ends = [
        truncated.rfind(". "),
        truncated.rfind("! "),
        truncated.rfind("? "),
        truncated.rfind(".\n"),
        truncated.rfind("!\n"),
        truncated.rfind("?\n"),
    ]
    last_sentence_end = max(sentence_ends)

    if last_sentence_end > max_length * 0.5:
        return truncated[: last_sentence_end + 1].strip()

    # Fall back to word boundary
    last_space = truncated.rfind(" ")
    if last_space > max_length * 0.8:
        return truncated[:last_space].strip() + "..."

    return truncated.strip() + "..."


async def summarize_for_tts(
    runtime: object,
    text: str,
    max_length: int,
) -> str:
    """Summarize text using an LLM for TTS.

    Falls back to :func:`truncate_text` on failure.
    """
    try:
        prompt = (
            f"Summarize the following text in {max_length} characters or less "
            f"for text-to-speech. Keep the key points and maintain a "
            f"conversational tone:\n\n{text}"
        )

        use_model = getattr(runtime, "use_model", None)
        if use_model is None:
            return truncate_text(text, max_length)

        response = await use_model(
            "TEXT_SMALL",
            {"prompt": prompt, "max_tokens": max_length // 3},
        )

        if isinstance(response, str):
            return response[:max_length]

        return truncate_text(text, max_length)
    except Exception:
        return truncate_text(text, max_length)


async def process_text_for_tts(
    runtime: object,
    text: str,
    *,
    max_length: int = 1500,
    summarize: bool = True,
    min_length: int = 10,
) -> str | None:
    """Process text for TTS synthesis.

    Cleans, validates length, and optionally summarizes the text.
    Returns ``None`` if the cleaned text is too short.
    """
    processed = clean_text_for_tts(text)

    if len(processed) < min_length:
        return None

    if len(processed) > max_length:
        if summarize:
            processed = await summarize_for_tts(runtime, processed, max_length)
        else:
            processed = truncate_text(processed, max_length)

    return processed
