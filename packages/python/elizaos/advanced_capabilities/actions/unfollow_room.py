from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.generated.spec_helpers import require_action_spec
from elizaos.types import Action, ActionExample, ActionResult, Content

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

# Get text content from centralized specs
_spec = require_action_spec("UNFOLLOW_ROOM")


def _convert_spec_examples() -> list[list[ActionExample]]:
    """Convert spec examples to ActionExample format."""
    spec_examples = _spec.get("examples", [])
    if not isinstance(spec_examples, list):
        return []
    result: list[list[ActionExample]] = []
    for example in spec_examples:
        if not isinstance(example, list):
            continue
        row: list[ActionExample] = []
        for msg in example:
            if not isinstance(msg, dict):
                continue
            content = msg.get("content", {})
            text = ""
            actions: list[str] | None = None
            if isinstance(content, dict):
                text_val = content.get("text", "")
                text = str(text_val) if text_val else ""
                actions_val = content.get("actions")
                if isinstance(actions_val, list) and all(isinstance(a, str) for a in actions_val):
                    actions = list(actions_val)
            row.append(
                ActionExample(
                    name=str(msg.get("name", "")),
                    content=Content(text=text, actions=actions),
                )
            )
        if row:
            result.append(row)
    return result


@dataclass
class UnfollowRoomAction:
    name: str = _spec["name"]
    similes: list[str] = field(default_factory=lambda: list(_spec.get("similes", [])))
    description: str = _spec["description"]

    async def validate(
        self, runtime: IAgentRuntime, message: Memory, _state: State | None = None
    ) -> bool:
        room_id = message.room_id
        if not room_id:
            return False

        room = await runtime.get_room(room_id)
        if room is None:
            return False

        world_id = room.world_id
        if world_id:
            world = await runtime.get_world(world_id)
            if world and world.metadata:
                followed_rooms = world.metadata.get("followedRooms", [])
                if str(room_id) in followed_rooms:
                    return True

        return False

    async def handler(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        room_id = message.room_id
        if not room_id:
            return ActionResult(
                text="No room specified to unfollow",
                values={"success": False, "error": "no_room_id"},
                data={"actionName": "UNFOLLOW_ROOM"},
                success=False,
            )

        room = await runtime.get_room(room_id)
        if room is None:
            return ActionResult(
                text="Room not found",
                values={"success": False, "error": "room_not_found"},
                data={"actionName": "UNFOLLOW_ROOM"},
                success=False,
            )

        room_name = str(room.name) if room.name else "Unknown Room"

        world_id = room.world_id
        if world_id:
            world = await runtime.get_world(world_id)
            if world and world.metadata:
                followed_rooms = list(world.metadata.get("followedRooms", []))
                room_id_str = str(room_id)

                if room_id_str in followed_rooms:
                    followed_rooms.remove(room_id_str)
                    world.metadata["followedRooms"] = followed_rooms
                    await runtime.update_world(world)

        await runtime.create_memory(
            content=Content(
                text=f"Stopped following room: {room_name}",
                actions=["UNFOLLOW_ROOM"],
            ),
            room_id=room_id,
            entity_id=runtime.agent_id,
            memory_type="action",
            metadata={"type": "UNFOLLOW_ROOM", "roomName": room_name},
        )

        response_content = Content(
            text=f"I am no longer following {room_name}.",
            actions=["UNFOLLOW_ROOM"],
        )

        if callback:
            await callback(response_content)

        return ActionResult(
            text=f"Stopped following room: {room_name}",
            values={
                "success": True,
                "unfollowed": True,
                "roomId": str(room_id),
                "roomName": room_name,
            },
            data={
                "actionName": "UNFOLLOW_ROOM",
                "roomId": str(room_id),
                "roomName": room_name,
            },
            success=True,
        )

    @property
    def examples(self) -> list[list[ActionExample]]:
        return _convert_spec_examples()


unfollow_room_action = Action(
    name=UnfollowRoomAction.name,
    similes=UnfollowRoomAction().similes,
    description=UnfollowRoomAction.description,
    validate=UnfollowRoomAction().validate,
    handler=UnfollowRoomAction().handler,
    examples=UnfollowRoomAction().examples,
)
