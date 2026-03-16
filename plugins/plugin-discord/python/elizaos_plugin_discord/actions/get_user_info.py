"""Get user info action."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos_plugin_discord.actions import ActionContext, ActionResult
    from elizaos_plugin_discord.service import DiscordService


class GetUserInfoAction:
    """Action to get detailed information about a Discord user."""

    @property
    def name(self) -> str:
        return "GET_USER_INFO"

    @property
    def description(self) -> str:
        return (
            "Get detailed information about a Discord user including their roles, "
            "join date, and permissions."
        )

    @property
    def similes(self) -> list[str]:
        return [
            "USER_INFO",
            "WHO_IS",
            "ABOUT_USER",
            "USER_DETAILS",
            "MEMBER_INFO",
            "CHECK_USER",
        ]

    async def validate(self, context: "ActionContext") -> bool:
        """Validate the action can be executed."""
        source = context.message.get("source")
        return isinstance(source, str) and source == "discord" and context.guild_id is not None

    async def handler(
        self,
        context: "ActionContext",
        service: "DiscordService",
    ) -> "ActionResult":
        """Execute the action."""
        from elizaos_plugin_discord.actions import ActionResult

        if context.guild_id is None:
            return ActionResult.failure_result(
                "I can only look up user info inside a server (not in DMs)."
            )

        content = context.message.get("content", {})
        text = content.get("text", "") if isinstance(content, dict) else ""

        # Parse user identifier from message
        user_identifier = await service.extract_user_identifier(text)
        if not user_identifier:
            return ActionResult.failure_result(
                "I couldn't understand which user you want information about. "
                "Please specify a username or mention."
            )

        # Get user info
        user_info = await service.get_member_info(context.guild_id, user_identifier)
        if not user_info:
            return ActionResult.failure_result(
                f'I couldn\'t find a user with the identifier "{user_identifier}" in this server.'
            )

        # Format the response
        formatted = service.format_user_info(user_info)

        return ActionResult.success_result(
            formatted,
            {
                "user_id": user_info.get("id", ""),
                "username": user_info.get("username", ""),
            },
        )
