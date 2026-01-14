from dataclasses import dataclass
from typing import Protocol

from elizaos_plugin_instagram.error import MessageSendError


class InstagramServiceProtocol(Protocol):
    @property
    def is_running(self) -> bool: ...

    async def send_message(self, thread_id: str, text: str) -> None: ...


@dataclass
class ActionContext:
    message: dict
    user_id: int
    thread_id: str | None
    media_id: int | None
    state: dict


class SendDmAction:
    name = "SEND_INSTAGRAM_DM"
    description = "Send a direct message to an Instagram user"
    similes = [
        "instagram_dm",
        "instagram_message",
        "send_instagram_message",
        "dm_instagram",
        "direct_message_instagram",
    ]

    async def validate(self, context: ActionContext) -> bool:
        source = context.message.get("source")
        has_thread = context.thread_id is not None
        return source == "instagram" and has_thread

    async def execute(
        self,
        context: ActionContext,
        service: InstagramServiceProtocol,
    ) -> dict:
        if not service.is_running:
            raise RuntimeError("Instagram service is not running")

        if not context.thread_id:
            raise ValueError("No thread ID provided")

        response = context.state.get("response", {})
        response_text = response.get("text", "")

        if not response_text:
            raise ValueError("No message text to send")

        try:
            await service.send_message(context.thread_id, response_text)
            return {
                "action": self.name,
                "thread_id": context.thread_id,
                "text": response_text,
                "success": True,
            }
        except Exception as e:
            raise MessageSendError(context.thread_id, e) from e
