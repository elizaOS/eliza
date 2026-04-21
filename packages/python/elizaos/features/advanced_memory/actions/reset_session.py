from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.types import Action, ActionExample, ActionResult, Content

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State


@dataclass
class ResetSessionAction:
    name: str = "RESET_SESSION"
    similes: list[str] = field(
        default_factory=lambda: ["CLEAR_HISTORY", "NEW_SESSION", "FORGET", "START_OVER", "RESET"]
    )
    description: str = (
        "Resets the conversation session by creating a compaction point. "
        "Messages before this point will not be included in future context."
    )

    async def validate(
        self, runtime: IAgentRuntime, message: Memory, state: State | None = None
    ) -> bool:
        room = None
        if state and getattr(state, "data", None) and getattr(state.data, "room", None):
            room = state.data.room
        elif message.room_id:
            room = await runtime.get_room(message.room_id)

        if not room or not getattr(room, "world_id", None):
            return True

        world = await runtime.get_world(room.world_id)
        if not world or not getattr(world, "metadata", None):
            return False

        roles = world.metadata.get("roles", {})
        user_role = roles.get(str(message.entity_id), "NONE")
        return user_role in ("OWNER", "ADMIN")

    async def handler(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        del options, responses

        room = None
        if state and getattr(state, "data", None) and getattr(state.data, "room", None):
            room = state.data.room
        elif message.room_id:
            room = await runtime.get_room(message.room_id)

        if room is None:
            if callback:
                await callback(
                    Content(
                        text="Unable to reset session - room not found.",
                        actions=["RESET_SESSION_FAILED"],
                        source=getattr(message.content, "source", None),
                    )
                )
            return ActionResult(
                text="Room not found",
                values={"error": "room_not_found"},
                data={"actionName": "RESET_SESSION"},
                success=False,
            )

        metadata = dict(getattr(room, "metadata", {}) or {})
        previous_compaction = metadata.get("lastCompactionAt")
        compaction_history = list(metadata.get("compactionHistory", []))
        now = int(time.time() * 1000)

        compaction_history.append(
            {
                "timestamp": now,
                "triggeredBy": str(message.entity_id),
                "reason": "manual_reset",
            }
        )
        metadata["lastCompactionAt"] = now
        metadata["compactionHistory"] = compaction_history[-10:]

        if (
            hasattr(room, "metadata")
            and hasattr(room.metadata, "clear")
            and hasattr(room.metadata, "update")
        ):
            room.metadata.clear()
            room.metadata.update(metadata)
        else:
            room.metadata = metadata

        await runtime.update_room(room)

        if callback:
            await callback(
                Content(
                    text="Session has been reset. I'll start fresh from here.",
                    actions=["RESET_SESSION"],
                    source=getattr(message.content, "source", None),
                )
            )

        result = ActionResult(
            text="Session reset successfully",
            values={
                "success": True,
                "compactionAt": now,
                "roomId": str(room.id),
            },
            data={
                "actionName": "RESET_SESSION",
                "compactionAt": now,
                "roomId": str(room.id),
            },
            success=True,
        )
        if previous_compaction is not None:
            result.values["previousCompactionAt"] = previous_compaction
        return result

    @property
    def examples(self) -> list[list[ActionExample]]:
        return []


reset_session_action = Action(
    name=ResetSessionAction.name,
    similes=ResetSessionAction().similes,
    description=ResetSessionAction.description,
    validate=ResetSessionAction().validate,
    handler=ResetSessionAction().handler,
    examples=ResetSessionAction().examples,
)
