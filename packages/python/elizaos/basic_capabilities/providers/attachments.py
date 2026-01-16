from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.generated.spec_helpers import require_provider_spec
from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State

# Get text content from centralized specs
_spec = require_provider_spec("ATTACHMENTS")


def format_attachment(attachment: dict[str, str]) -> str:
    att_type = attachment.get("type", "unknown")
    url = attachment.get("url", "")
    title = attachment.get("title", "")
    description = attachment.get("description", "")

    parts = [f"- Type: {att_type}"]
    if title:
        parts.append(f"  Title: {title}")
    if description:
        parts.append(f"  Description: {description}")
    if url:
        parts.append(f"  URL: {url}")

    return "\n".join(parts)


async def get_attachments(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    attachments: list[dict[str, str]] = []

    if message.content and hasattr(message.content, "attachments"):
        raw_attachments = message.content.attachments or []
        for att in raw_attachments:
            if isinstance(att, dict):
                attachments.append(att)
            elif hasattr(att, "__dict__"):
                attachments.append(att.__dict__)

    if not attachments:
        return ProviderResult(
            text="",
            values={"hasAttachments": False, "attachmentCount": 0},
            data={"attachments": []},
        )

    formatted_attachments = "\n".join(format_attachment(att) for att in attachments)

    text = f"# Attachments ({len(attachments)})\n{formatted_attachments}"

    return ProviderResult(
        text=text,
        values={
            "hasAttachments": True,
            "attachmentCount": len(attachments),
            "attachmentTypes": list({att.get("type", "unknown") for att in attachments}),
        },
        data={
            "attachments": attachments,
        },
    )


attachments_provider = Provider(
    name=_spec["name"],
    description=_spec["description"],
    get=get_attachments,
    dynamic=_spec.get("dynamic", True),
)
