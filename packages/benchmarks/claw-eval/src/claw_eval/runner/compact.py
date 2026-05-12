"""Three-layer context compression for the agent loop.

Layer 1 – Micro-compact (every turn, low risk):
    Truncate old tool results and strip old media injection images.

Layer 2 – Auto-compact (threshold-triggered):
    Summarise the conversation using the provider when utilisation exceeds
    a configured percentage of the context window.

Layer 3 – Manual compact:
    Exposed as the ``compact`` tool so the agent can trigger it explicitly.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from ..models.content import ImageBlock, TextBlock
from ..models.message import Message

if TYPE_CHECKING:
    from .providers.openai_compat import OpenAICompatProvider
    from .todo import TodoManager

# Regex to detect media injection captions produced by loop.py
_MEDIA_CAPTION_RE = re.compile(
    r"^\[Visual content from tool results: \d+ image\(s\)\]$"
)


def _is_media_injection_message(msg: Message) -> bool:
    """Return True if *msg* is a media-injection user message (images from tool results)."""
    if msg.role != "user":
        return False
    if not msg.content:
        return False
    first = msg.content[0]
    if first.type != "text":
        return False
    if not _MEDIA_CAPTION_RE.match(first.text):
        return False
    return any(b.type == "image" for b in msg.content)


def _count_turn_boundary(messages: list[Message], keep_recent: int) -> int:
    """Return the message index that separates 'old' from 'recent'.

    A *turn* is one assistant message plus the subsequent tool-result /
    media-injection user messages.  We count turns backwards from the end
    and return the index of the first message that belongs to the
    ``keep_recent`` most recent turns.

    Messages before that index are candidates for micro-compaction.
    The system message (index 0) and original user prompt (index 1) are
    always protected.
    """
    turns_seen = 0
    # Walk backwards
    for i in range(len(messages) - 1, 1, -1):  # skip system[0] and user-prompt[1]
        if messages[i].role == "assistant":
            turns_seen += 1
            if turns_seen >= keep_recent:
                return i  # everything before this index is "old"
    # Not enough turns to compact anything
    return len(messages)


def micro_compact(
    messages: list[Message],
    *,
    keep_recent: int = 3,
    min_chars: int = 500,
) -> None:
    """Layer 1: in-place truncation of old tool results and removal of old images.

    Modifies *messages* in place.  Never touches:
    - messages[0] (system prompt)
    - messages[1] (initial user prompt with task attachments)
    """
    boundary = _count_turn_boundary(messages, keep_recent)

    for i in range(2, boundary):  # skip system + initial user prompt
        msg = messages[i]

        # 1a. Truncate old ToolResultBlock text
        if msg.role == "user":
            new_content = []
            changed = False
            for block in msg.content:
                if block.type == "tool_result":
                    text_parts = block.content  # list[TextBlock]
                    if text_parts:
                        combined = "\n".join(t.text for t in text_parts)
                        if len(combined) > min_chars:
                            preview = combined[:100].replace("\n", " ")
                            placeholder = f"[Previous tool result truncated, {len(combined)} chars → {preview}...]"
                            from ..models.content import ToolResultBlock
                            new_block = ToolResultBlock(
                                tool_use_id=block.tool_use_id,
                                content=[TextBlock(text=placeholder)],
                                is_error=block.is_error,
                            )
                            new_content.append(new_block)
                            changed = True
                            continue
                    new_content.append(block)
                else:
                    new_content.append(block)
            if changed:
                msg.content = new_content

        # 1b. Replace old media injection messages with text placeholder
        if _is_media_injection_message(msg):
            n_images = sum(1 for b in msg.content if b.type == "image")
            placeholder = TextBlock(
                text=f"[Previous visual content: {n_images} image(s) from tool results]"
            )
            msg.content = [placeholder]


# ---------------------------------------------------------------------------
# Layer 2: Auto-compact
# ---------------------------------------------------------------------------

def _estimate_tokens(messages: list[Message]) -> int:
    """Rough token estimate: total serialised characters / 4."""
    total = 0
    for msg in messages:
        for block in msg.content:
            if block.type == "text":
                total += len(block.text)
            elif block.type == "tool_result":
                for tb in block.content:
                    total += len(tb.text)
            elif block.type == "tool_use":
                import json
                total += len(json.dumps(block.input, ensure_ascii=False))
            elif block.type == "image":
                # base64 data: ~1.33x raw bytes; each byte ≈ 1 char
                total += len(block.data)
            elif block.type in ("audio", "video"):
                total += len(block.data)
    return total // 4


def should_auto_compact(
    messages: list[Message],
    context_window: int,
    threshold_pct: float = 0.70,
) -> bool:
    """Return True when estimated token usage exceeds *threshold_pct* of *context_window*."""
    estimated = _estimate_tokens(messages)
    return estimated > int(context_window * threshold_pct)


_SUMMARY_PROMPT = """\
Summarize this conversation for continuation. You MUST preserve:
- Current task goal and progress
- All file paths read or modified
- Current todo list (if any)
- Key decisions and reasoning
- Errors encountered and resolutions
- The exact next step to take

Format as structured working state, not narrative. Be concise but complete.\
"""


def _strip_media_blocks(messages: list[Message]) -> list[Message]:
    """Return a copy of messages with all Image/Audio/Video blocks removed.

    This avoids sending large base64 payloads into the summarisation call.
    """
    stripped: list[Message] = []
    for msg in messages:
        new_content = []
        for block in msg.content:
            if block.type in ("image", "audio", "video"):
                new_content.append(TextBlock(
                    text=f"[{block.type} content removed for summarisation]"
                ))
            else:
                new_content.append(block)
        stripped.append(Message(
            role=msg.role,
            content=new_content,
            reasoning_content=msg.reasoning_content,
        ))
    return stripped


def _find_protect_index(messages: list[Message], protect_tokens: int) -> int:
    """Find index such that messages[index:] contain approximately *protect_tokens* tokens.

    Returns the index of the first message that should be protected (i.e. kept intact).
    """
    cumulative = 0
    for i in range(len(messages) - 1, 1, -1):  # never go below index 2
        msg = messages[i]
        for block in msg.content:
            if block.type == "text":
                cumulative += len(block.text) // 4
            elif block.type == "tool_result":
                for tb in block.content:
                    cumulative += len(tb.text) // 4
            elif block.type == "image":
                cumulative += len(block.data) // 4
        if cumulative >= protect_tokens:
            return i
    return 2  # protect everything after system + user prompt


def do_auto_compact(
    messages: list[Message],
    provider: OpenAICompatProvider,
    *,
    keep_recent_on_summary: int = 4,
    protect_tokens: int = 40_000,
    todo_mgr: TodoManager | None = None,
    focus: str | None = None,
) -> list[Message]:
    """Layer 2/3: Summarise older messages and rebuild the conversation.

    Returns a new message list: ``[system_msg, summary_user_msg, recent_messages...]``.
    """
    if len(messages) <= 3:
        return messages  # nothing to compact

    # Determine how many recent messages to keep
    protect_idx = _find_protect_index(messages, protect_tokens)
    # Also ensure at least keep_recent_on_summary messages are kept
    min_keep_idx = max(2, len(messages) - keep_recent_on_summary)
    split_idx = min(protect_idx, min_keep_idx)

    if split_idx <= 2:
        return messages  # nothing old enough to summarise

    old_messages = messages[1:split_idx]  # exclude system[0], include user-prompt[1]
    recent_messages = messages[split_idx:]

    # Build the summarisation request
    summary_prompt = _SUMMARY_PROMPT
    if focus:
        summary_prompt += f"\n\nPrioritize preserving information about: {focus}"
    if todo_mgr and todo_mgr.items:
        summary_prompt += f"\n\nCurrent todo list:\n{todo_mgr.render()}"

    summarise_msgs = _strip_media_blocks(old_messages)
    summarise_msgs.append(Message(role="user", content=[TextBlock(text=summary_prompt)]))

    # Call provider for summary (no tools needed)
    try:
        summary_response, _ = provider.chat(summarise_msgs, tools=None)
        summary_text = summary_response.text or "(summary failed)"
    except Exception as exc:
        summary_text = f"(auto-compact summary failed: {exc})"

    # Rebuild messages
    summary_user_msg = Message(
        role="user",
        content=[TextBlock(text=f"[Context Summary]\n{summary_text}")],
    )

    return [messages[0], summary_user_msg] + recent_messages
