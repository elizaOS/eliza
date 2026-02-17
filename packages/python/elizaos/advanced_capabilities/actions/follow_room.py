from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.generated.spec_helpers import require_action_spec
from elizaos.types import Action, ActionExample, ActionResult, Content

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

# Get text content from centralized specs
_spec = require_action_spec("FOLLOW_ROOM")


def _convert_spec_examples() -> list[list[ActionExample]]:
    """Convert spec examples to ActionExample format."""
    spec_examples = _spec.get("examples", [])
    if spec_examples:
        return [
            [
                ActionExample(
                    name=msg.get("name", ""),
                    content=Content(
                        text=msg.get("content", {}).get("text", ""),
                        actions=msg.get("content", {}).get("actions"),
                    ),
                )
                for msg in example
            ]
            for example in spec_examples
        ]
    return []


@dataclass
class FollowRoomAction:
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
                    return False

        return True

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
                text="No room specified to follow",
                values={"success": False, "error": "no_room_id"},
                data={"actionName": "FOLLOW_ROOM"},
                success=False,
            )

        room = await runtime.get_room(room_id)
        if room is None:
            return ActionResult(
                text="Room not found",
                values={"success": False, "error": "room_not_found"},
                data={"actionName": "FOLLOW_ROOM"},
                success=False,
            )

        room_name = str(room.name) if room.name else "Unknown Room"

        world_id = room.world_id
        if world_id:
            world = await runtime.get_world(world_id)
            if world and world.metadata:
                followed_rooms = list(world.metadata.get("followedRooms", []))
                room_id_str = str(room_id)

                if room_id_str not in followed_rooms:
                    followed_rooms.append(room_id_str)
                    world.metadata["followedRooms"] = followed_rooms
                    await runtime.update_world(world)

        await runtime.create_memory(
            content=Content(
                text=f"Now following room: {room_name}",
                actions=["FOLLOW_ROOM"],
            ),
            room_id=room_id,
            entity_id=runtime.agent_id,
            memory_type="action",
            metadata={"type": "FOLLOW_ROOM", "roomName": room_name},
        )

        response_content = Content(
            text=f"I am now following {room_name} and will monitor its messages.",
            actions=["FOLLOW_ROOM"],
        )

        if callback:
            await callback(response_content)

        return ActionResult(
            text=f"Now following room: {room_name}",
            values={
                "success": True,
                "following": True,
                "roomId": str(room_id),
                "roomName": room_name,
            },
            data={
                "actionName": "FOLLOW_ROOM",
                "roomId": str(room_id),
                "roomName": room_name,
            },
            success=True,
        )

    @property
    def examples(self) -> list[list[ActionExample]]:
        return _convert_spec_examples()


follow_room_action = Action(
    name=FollowRoomAction.name,
    similes=FollowRoomAction().similes,
    description=FollowRoomAction.description,
    validate=FollowRoomAction().validate,
    handler=FollowRoomAction().handler,
    examples=FollowRoomAction().examples,
)
