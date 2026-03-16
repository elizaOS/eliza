from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos_plugin_farcaster.service import FarcasterService
    from elizaos_plugin_farcaster.types import Cast


@dataclass
class ActionResult:
    success: bool
    text: str | None = None
    error: str | None = None
    data: dict[str, object] = field(default_factory=dict)


@dataclass
class ActionExample:
    name: str
    content: dict[str, object]


class ReplyCastAction:
    name = "REPLY_TO_CAST"
    similes = ["REPLY_CAST", "RESPOND_CAST", "ANSWER_CAST", "COMMENT_CAST"]
    description = "Replies to a cast on Farcaster"

    examples: list[list[ActionExample]] = [
        [
            ActionExample(
                name="User",
                content={
                    "text": "Reply 'Great point!' to that cast",
                    "source": "user",
                },
            ),
            ActionExample(
                name="Agent",
                content={
                    "text": "I've replied to the cast!",
                    "actions": ["REPLY_TO_CAST"],
                },
            ),
        ],
        [
            ActionExample(
                name="User",
                content={
                    "text": "Respond to the thread with my thoughts",
                    "source": "user",
                },
            ),
            ActionExample(
                name="Agent",
                content={
                    "text": "Your reply has been posted.",
                    "actions": ["REPLY_TO_CAST"],
                },
            ),
        ],
    ]

    @staticmethod
    def _has_reply_intent(text: str) -> bool:
        keywords = ["reply", "respond", "answer", "comment"]
        lower = text.lower()
        return any(keyword in lower for keyword in keywords)

    async def validate(
        self,
        message: dict[str, object],
        service: "FarcasterService | None" = None,
        parent_hash: str | None = None,
    ) -> bool:
        if not service or not service.is_running:
            return False

        if not parent_hash:
            return False

        content = message.get("content", {})
        text = str(content.get("text", "") if isinstance(content, dict) else "")

        return self._has_reply_intent(text)

    async def handler(
        self,
        message: dict[str, object],
        service: "FarcasterService",
        text_to_reply: str,
        parent_hash: str,
    ) -> ActionResult:
        if not service.is_running:
            return ActionResult(
                success=False,
                text="Farcaster service is not running",
                error="Service not started",
            )

        if len(text_to_reply) > 320:
            text_to_reply = text_to_reply[:317] + "..."

        casts: list[Cast] = await service.send_cast(text_to_reply, reply_to=parent_hash)

        if not casts:
            return ActionResult(
                success=False,
                text="Failed to send reply",
                error="No cast returned",
            )

        cast = casts[0]
        return ActionResult(
            success=True,
            text="Reply posted successfully!",
            data={
                "cast_hash": cast.hash,
                "text": cast.text,
                "parent_hash": parent_hash,
                "author_fid": cast.author_fid,
            },
        )
