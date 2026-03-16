"""Chat with attachments action."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos_plugin_discord.actions import ActionContext, ActionResult
    from elizaos_plugin_discord.service import DiscordService


class ChatWithAttachmentsAction:
    """Action to summarize and interact with attachments in Discord messages."""

    @property
    def name(self) -> str:
        return "CHAT_WITH_ATTACHMENTS"

    @property
    def description(self) -> str:
        return (
            "Answer a user request informed by specific attachments based on their IDs. "
            "If a user asks to chat with a PDF, or wants more specific information about "
            "a link or video or anything else they've attached, this is the action to use."
        )

    @property
    def similes(self) -> list[str]:
        return [
            "CHAT_WITH_ATTACHMENT",
            "SUMMARIZE_FILES",
            "SUMMARIZE_FILE",
            "SUMMARIZE_ATTACHMENT",
            "CHAT_WITH_PDF",
            "ATTACHMENT_SUMMARY",
            "RECAP_ATTACHMENTS",
            "SUMMARIZE_VIDEO",
            "SUMMARIZE_AUDIO",
            "SUMMARIZE_IMAGE",
            "SUMMARIZE_DOCUMENT",
            "SUMMARIZE_LINK",
            "FILE_SUMMARY",
        ]

    async def validate(self, context: "ActionContext") -> bool:
        """Validate the action can be executed."""
        source = context.message.get("source")
        if not isinstance(source, str) or source != "discord":
            return False

        # Check for keywords in message
        content = context.message.get("content", {})
        text = content.get("text", "") if isinstance(content, dict) else ""
        text_lower = text.lower()

        keywords = [
            "attachment",
            "summary",
            "summarize",
            "research",
            "pdf",
            "video",
            "audio",
            "image",
            "document",
            "link",
            "file",
            "code",
            "report",
            "write",
            "details",
            "information",
            "talk",
            "chat",
            "read",
            "listen",
            "watch",
        ]

        return any(keyword in text_lower for keyword in keywords)

    async def handler(
        self,
        context: "ActionContext",
        service: "DiscordService",
    ) -> "ActionResult":
        """Execute the action."""
        from elizaos_plugin_discord.actions import ActionResult

        content = context.message.get("content", {})
        text = content.get("text", "") if isinstance(content, dict) else ""
        attachments = content.get("attachments", []) if isinstance(content, dict) else []

        if not attachments:
            return ActionResult.failure_result(
                "No attachments found in the conversation to analyze."
            )

        # Get attachment summaries
        attachment_summaries = []
        for attachment in attachments:
            if isinstance(attachment, dict):
                title = attachment.get("title", "Untitled")
                att_text = attachment.get("text", "")
                if att_text:
                    attachment_summaries.append(f"# {title}\n{att_text}")

        if not attachment_summaries:
            return ActionResult.failure_result(
                "Could not extract text content from the attachments."
            )

        # Generate summary using the service's model
        attachments_content = "\n\n".join(attachment_summaries)
        summary = await service.generate_summary(attachments_content, text)

        if not summary:
            return ActionResult.failure_result("Failed to generate summary.")

        return ActionResult.success_result(
            summary,
            {
                "attachment_count": len(attachments),
                "objective": text,
            },
        )
