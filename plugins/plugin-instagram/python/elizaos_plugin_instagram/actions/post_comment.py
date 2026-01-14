from dataclasses import dataclass
from typing import Protocol


class InstagramServiceProtocol(Protocol):
    @property
    def is_running(self) -> bool: ...


@dataclass
class ActionContext:
    message: dict
    user_id: int
    thread_id: str | None
    media_id: int | None
    state: dict


class PostCommentAction:
    name = "POST_INSTAGRAM_COMMENT"
    description = "Post a comment on an Instagram post or media"
    similes = [
        "instagram_comment",
        "comment_instagram",
        "reply_instagram",
        "post_comment_instagram",
    ]

    async def validate(self, context: ActionContext) -> bool:
        source = context.message.get("source")
        has_media = context.media_id is not None
        return source == "instagram" and has_media

    async def execute(
        self,
        context: ActionContext,
        service: InstagramServiceProtocol,
    ) -> dict:
        if not service.is_running:
            raise RuntimeError("Instagram service is not running")

        if not context.media_id:
            raise ValueError("No media ID provided")

        response = context.state.get("response", {})
        response_text = response.get("text", "")

        if not response_text:
            raise ValueError("No comment text to post")

        return {
            "action": self.name,
            "media_id": context.media_id,
            "text": response_text,
            "success": True,
        }
