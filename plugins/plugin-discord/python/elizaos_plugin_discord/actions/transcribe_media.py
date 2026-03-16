"""Transcribe media action."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos_plugin_discord.actions import ActionContext, ActionResult
    from elizaos_plugin_discord.service import DiscordService


class TranscribeMediaAction:
    """Action to transcribe audio/video from a Discord message."""

    @property
    def name(self) -> str:
        return "TRANSCRIBE_MEDIA"

    @property
    def description(self) -> str:
        return "Transcribe audio or video content from a URL or attachment in a Discord message."

    @property
    def similes(self) -> list[str]:
        return [
            "TRANSCRIBE",
            "TRANSCRIBE_AUDIO",
            "TRANSCRIBE_VIDEO",
            "CONVERT_TO_TEXT",
            "SPEECH_TO_TEXT",
        ]

    async def validate(self, context: "ActionContext") -> bool:
        """Validate the action can be executed."""
        source = context.message.get("source")
        return isinstance(source, str) and source == "discord"

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

        # Try to find media URL
        media_url = await service.extract_media_url(text)

        # Check attachments if no URL in text
        if not media_url and attachments:
            for attachment in attachments:
                if isinstance(attachment, dict):
                    url = attachment.get("url", "")
                    content_type = attachment.get("content_type", "")
                    if "audio" in content_type or "video" in content_type:
                        media_url = url
                        break

        if not media_url:
            return ActionResult.failure_result(
                "I couldn't find any audio or video to transcribe. "
                "Please provide a URL or attachment."
            )

        # Transcribe the media
        transcription = await service.transcribe_media(media_url)
        if not transcription:
            return ActionResult.failure_result(
                "I couldn't transcribe the media. The format might not be supported."
            )

        # Truncate if too long
        max_length = 1900  # Discord message limit minus some buffer
        if len(transcription) > max_length:
            transcription = transcription[:max_length] + "..."

        return ActionResult.success_result(
            f"**Transcription:**\n\n{transcription}",
            {
                "url": media_url,
                "transcription": transcription,
            },
        )
