from dataclasses import dataclass


@dataclass
class ProviderContext:
    user_id: int | None
    thread_id: str | None
    media_id: int | None
    room_id: str | None


class UserStateProvider:
    name = "instagram_user_state"
    description = (
        "Provides Instagram user context state including user ID, thread ID, and interaction type"
    )

    async def get(self, context: ProviderContext) -> dict:
        is_dm = context.thread_id is not None
        is_comment = context.media_id is not None

        return {
            "user_id": context.user_id,
            "thread_id": context.thread_id,
            "media_id": context.media_id,
            "room_id": context.room_id,
            "is_dm": is_dm,
            "is_comment": is_comment,
        }
