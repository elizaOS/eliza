"""Download media action."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos_plugin_discord.actions import ActionContext, ActionResult
    from elizaos_plugin_discord.service import DiscordService


class DownloadMediaAction:
    """Action to download video or audio from a URL."""

    @property
    def name(self) -> str:
        return "DOWNLOAD_MEDIA"

    @property
    def description(self) -> str:
        return "Downloads a video or audio file from a URL and attaches it to the response message."

    @property
    def similes(self) -> list[str]:
        return [
            "DOWNLOAD_VIDEO",
            "DOWNLOAD_AUDIO",
            "GET_MEDIA",
            "DOWNLOAD_PODCAST",
            "DOWNLOAD_YOUTUBE",
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

        # Extract URL from message
        media_url = await service.extract_media_url(text)
        if not media_url:
            return ActionResult.failure_result("I couldn't find a media URL in your message.")

        # Download the media
        media_info = await service.download_media(media_url)
        if not media_info:
            return ActionResult.failure_result(
                "Failed to download the media. The URL might be unsupported."
            )

        filename = media_info["filename"]
        file_path = media_info["path"]
        title = filename

        # Send as attachment
        await service.send_file(
            context.channel_id,
            file_path,
            filename,
            f'I downloaded "{title}" and attached it below.',
        )

        return ActionResult.success_result(
            f'Successfully downloaded "{title}".',
            {
                "title": title,
                "path": file_path,
                "url": media_url,
            },
        )
