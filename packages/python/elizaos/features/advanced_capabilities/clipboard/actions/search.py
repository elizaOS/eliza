"""Clipboard search action -- search clipboard entries by text."""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Action, ActionResult, Content, ModelType
from elizaos.utils.xml import parse_key_value_xml

from ..services.clipboard_service import create_clipboard_service

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

EXTRACT_TEMPLATE = """Extract the search query from the user's message.

User message: {text}

Respond with XML containing:
- query: The search terms to find in clipboard entries (required)
- maxResults: Maximum number of results to return (optional, default 5)

<response>
<query>search terms</query>
<maxResults>5</maxResults>
</response>"""


async def _validate(runtime: IAgentRuntime, message: Memory, _state: State | None = None) -> bool:
    text = (message.content.text or "").lower()
    search_keywords = ["search", "find", "look for", "clipboard", "notes", "retrieve", "lookup"]
    return any(kw in text for kw in search_keywords) and ("clipboard" in text or "search" in text)


async def _handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    prompt = EXTRACT_TEMPLATE.format(text=message.content.text or "")
    result = await runtime.use_model(ModelType.TEXT_SMALL, prompt=prompt)
    parsed = parse_key_value_xml(str(result))

    if not parsed or not isinstance(parsed.get("query"), str):
        if callback:
            await callback(Content(text="I couldn't understand what you're searching for."))
        return ActionResult(text="Failed to extract search info", success=False)

    try:
        from ..types import ClipboardSearchOptions

        service = create_clipboard_service(runtime)
        max_results = int(parsed.get("maxResults", 5)) if parsed.get("maxResults") else 5
        results = await service.search(
            str(parsed["query"]),
            ClipboardSearchOptions(max_results=max_results),
        )

        if not results:
            if callback:
                await callback(
                    Content(text=f'No clipboard entries found matching "{parsed["query"]}".')
                )
            return ActionResult(text="No results found", success=True)

        result_lines = []
        for i, r in enumerate(results):
            score_pct = round(r.score * 100)
            snippet = r.snippet[:200] + ("..." if len(r.snippet) > 200 else "")
            result_lines.append(
                f"**{i + 1}. {r.entry_id}** ({score_pct}% match, lines {r.start_line}-{r.end_line})\n```\n{snippet}\n```"
            )

        msg = (
            f'Found {len(results)} matching clipboard entries for "{parsed["query"]}":\n\n'
            + "\n\n".join(result_lines)
            + "\n\nUse CLIPBOARD_READ with an entry ID to view the full content."
        )
        if callback:
            await callback(Content(text=msg, actions=["CLIPBOARD_SEARCH_SUCCESS"]))
        return ActionResult(text=msg, success=True)
    except Exception as e:
        if callback:
            await callback(Content(text=f"Failed to search clipboard: {e}"))
        return ActionResult(text="Failed to search clipboard", success=False)


clipboard_search_action = Action(
    name="CLIPBOARD_SEARCH",
    similes=["SEARCH_NOTES", "FIND_NOTE", "CLIPBOARD_FIND"],
    description="Search clipboard entries using text matching",
    validate=_validate,
    handler=_handler,
    examples=[],
)
