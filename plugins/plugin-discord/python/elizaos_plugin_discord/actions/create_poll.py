"""Create poll action."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos_plugin_discord.actions import ActionContext, ActionResult
    from elizaos_plugin_discord.service import DiscordService


# Emoji sets for polls
NUMBER_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"]
LETTER_EMOJIS = ["🇦", "🇧", "🇨", "🇩", "🇪", "🇫", "🇬", "🇭", "🇮", "🇯"]
YES_NO_EMOJIS = ["✅", "❌"]


class CreatePollAction:
    """Action to create a poll in Discord with emoji reactions for voting."""

    @property
    def name(self) -> str:
        return "CREATE_POLL"

    @property
    def description(self) -> str:
        return "Create a poll in Discord with emoji reactions for voting."

    @property
    def similes(self) -> list[str]:
        return [
            "MAKE_POLL",
            "START_POLL",
            "CREATE_VOTE",
            "MAKE_VOTE",
            "START_VOTE",
            "CREATE_SURVEY",
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

        # Parse poll info from the message
        poll_info = await service.parse_poll_info(text)
        if not poll_info:
            return ActionResult.failure_result(
                "I couldn't understand the poll details. "
                "Please specify a question and at least 2 options."
            )

        question = poll_info.get("question", "")
        options = poll_info.get("options", [])
        use_emojis = poll_info.get("use_emojis", True)

        if len(options) < 2:
            return ActionResult.failure_result("A poll needs at least 2 options.")

        # Limit to 10 options (Discord reaction limit consideration)
        options = options[:10]

        # Determine which emojis to use
        if (
            len(options) == 2
            and any("yes" in opt.lower() for opt in options)
            and any("no" in opt.lower() for opt in options)
        ):
            emojis = YES_NO_EMOJIS
        elif use_emojis:
            emojis = NUMBER_EMOJIS[: len(options)]
        else:
            emojis = LETTER_EMOJIS[: len(options)]

        # Format the poll message
        poll_lines = [
            f"📊 **POLL: {question}**",
            "",
        ]
        for i, option in enumerate(options):
            poll_lines.append(f"{emojis[i]} {option}")
        poll_lines.extend(["", "_React to vote!_"])
        poll_message = "\n".join(poll_lines)

        # Send the poll
        message_id = await service.send_poll(
            context.channel_id,
            poll_message,
            emojis[: len(options)],
        )

        if not message_id:
            return ActionResult.failure_result(
                "Failed to create the poll. Please check my permissions."
            )

        return ActionResult.success_result(
            f"I've created a poll with {len(options)} options. "
            "Users can vote by clicking the reaction emojis!",
            {
                "message_id": str(message_id),
                "question": question,
                "options": options,
            },
        )
