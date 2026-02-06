"""SCRATCHPAD_SEARCH action - Search entries by content using TF-IDF."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING

from elizaos_plugin_scratchpad.service import create_scratchpad_service
from elizaos_plugin_scratchpad.types import ScratchpadSearchOptions

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

logger = logging.getLogger(__name__)

EXTRACT_TEMPLATE = """Extract the search query from the user's message.

User message: {{text}}

Respond with XML containing:
- query: The search terms to find in scratchpad entries (required)
- maxResults: Maximum number of results to return (optional, default 5)

<response>
<query>search terms</query>
<maxResults>5</maxResults>
</response>"""


def _parse_xml_field(text: str, field_name: str) -> str | None:
    """Extract a field value from XML-like response text."""
    match = re.search(rf"<{field_name}>([\s\S]*?)</{field_name}>", text)
    return match.group(1).strip() if match else None


@dataclass
class SearchResult:
    """Result of the SCRATCHPAD_SEARCH action."""

    success: bool
    text: str
    error: str | None = None


async def _extract_search_info(
    runtime: IAgentRuntime,
    message: Memory,
) -> dict[str, str | int] | None:
    """Use the LLM to extract the search query and max results."""
    message_text = message.content.text if message.content else ""
    prompt = EXTRACT_TEMPLATE.replace("{{text}}", message_text)

    result = await runtime.use_model("TEXT_SMALL", {"prompt": prompt, "stopSequences": []})
    result_str = str(result)
    logger.debug("[ScratchpadSearch] Extract result: %s", result_str)

    query = _parse_xml_field(result_str, "query")
    if not query:
        logger.error("[ScratchpadSearch] Failed to extract valid search info")
        return None

    info: dict[str, str | int] = {"query": query}
    max_results_str = _parse_xml_field(result_str, "maxResults")
    if max_results_str:
        try:
            info["max_results"] = int(max_results_str)
        except ValueError:
            info["max_results"] = 5

    return info


async def handle_scratchpad_search(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> SearchResult | None:
    """Handle the SCRATCHPAD_SEARCH action."""
    search_info = await _extract_search_info(runtime, message)

    if not search_info:
        msg = "I couldn't understand what you're searching for. Please provide search terms."
        if callback:
            await callback(
                {
                    "text": msg,
                    "actions": ["SCRATCHPAD_SEARCH_FAILED"],
                    "source": message.content.source if message.content else None,
                }
            )
        return SearchResult(success=False, text="Failed to extract search info")

    try:
        service = create_scratchpad_service(runtime)
        query = str(search_info["query"])
        max_results = int(search_info.get("max_results", 5))

        results = await service.search(
            query, ScratchpadSearchOptions(max_results=max_results)
        )

        if not results:
            msg = f'No scratchpad entries found matching "{query}".'
            if callback:
                await callback(
                    {
                        "text": msg,
                        "actions": ["SCRATCHPAD_SEARCH_EMPTY"],
                        "source": message.content.source if message.content else None,
                    }
                )
            return SearchResult(success=True, text="No results found")

        result_lines: list[str] = []
        for i, r in enumerate(results):
            score_pct = round(r.score * 100)
            snippet_preview = r.snippet[:200] + ("..." if len(r.snippet) > 200 else "")
            result_lines.append(
                f"**{i + 1}. {r.entry_id}** ({score_pct}% match, "
                f"lines {r.start_line}-{r.end_line})\n```\n{snippet_preview}\n```"
            )

        result_text = "\n\n".join(result_lines)
        success_msg = (
            f'Found {len(results)} matching scratchpad entries for "{query}":\n\n'
            f"{result_text}\n\n"
            "Use SCRATCHPAD_READ with an entry ID to view the full content."
        )

        if callback:
            await callback(
                {
                    "text": success_msg,
                    "actions": ["SCRATCHPAD_SEARCH_SUCCESS"],
                    "source": message.content.source if message.content else None,
                }
            )

        return SearchResult(success=True, text=success_msg)

    except Exception as exc:
        error_msg = f"Failed to search scratchpad: {exc}"
        logger.error("[ScratchpadSearch] Error: %s", exc)
        if callback:
            await callback(
                {
                    "text": error_msg,
                    "actions": ["SCRATCHPAD_SEARCH_FAILED"],
                    "source": message.content.source if message.content else None,
                }
            )
        return SearchResult(success=False, text="Failed to search scratchpad", error=str(exc))


async def validate_scratchpad_search(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> bool:
    """Validate that the message contains search intent."""
    text = (message.content.text if message.content else "").lower()
    return any(
        kw in text
        for kw in (
            "search",
            "find",
            "look for",
            "scratchpad",
            "notes",
            "retrieve",
            "lookup",
            "what did i save",
        )
    )


SCRATCHPAD_SEARCH_ACTION: dict[str, object] = {
    "name": "SCRATCHPAD_SEARCH",
    "similes": [
        "SEARCH_NOTES",
        "FIND_NOTE",
        "LOOKUP_SCRATCHPAD",
        "FIND_IN_NOTES",
    ],
    "description": "Search scratchpad entries by content using TF-IDF text matching.",
    "examples": [
        [
            {
                "name": "{{name1}}",
                "content": {"text": "Search my notes for project deadline"},
            },
            {
                "name": "{{name2}}",
                "content": {
                    "text": 'Found 1 matching scratchpad entries for "project deadline".',
                    "actions": ["SCRATCHPAD_SEARCH_SUCCESS"],
                },
            },
        ],
    ],
}
