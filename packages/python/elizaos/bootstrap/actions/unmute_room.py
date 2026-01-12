from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.types import Action, ActionExample, ActionResult, Content, MemoryType

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State


@dataclass
class UnmuteRoomAction:
    name: str = "UNMUTE_ROOM"
    similes: list[str] = field(
        default_factory=lambda: [
            "UNSILENCE_ROOM",
            "ENABLE_NOTIFICATIONS",
            "RESUME_RESPONDING",
            "START_LISTENING",
        ]
    )
    description: str = (
        "Unmute a room to resume responding and receiving notifications. "
        "Use this when you want to start interacting with a muted room again."
    )

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
                muted_rooms = world.metadata.get("mutedRooms", [])
                if str(room_id) in muted_rooms:
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
                text="No room specified to unmute",
                values={"success": False, "error": "no_room_id"},
                data={"actionName": "UNMUTE_ROOM"},
                success=False,
            )

        room = await runtime.get_room(room_id)
        if room is None:
            return ActionResult(
                text="Room not found",
                values={"success": False, "error": "room_not_found"},
                data={"actionName": "UNMUTE_ROOM"},
                success=False,
            )

        room_name = str(room.name) if room.name else "Unknown Room"

        world_id = room.world_id
        if world_id:
            world = await runtime.get_world(world_id)
            if world and world.metadata:
                muted_rooms = list(world.metadata.get("mutedRooms", []))
                room_id_str = str(room_id)

                if room_id_str in muted_rooms:
                    muted_rooms.remove(room_id_str)
                    world.metadata["mutedRooms"] = muted_rooms
                    await runtime.update_world(world)

        await runtime.create_memory(
            content=Content(
                text=f"Unmuted room: {room_name}",
                actions=["UNMUTE_ROOM"],
            ),
            room_id=room_id,
            entity_id=runtime.agent_id,
            memory_type=MemoryType.ACTION,
            metadata={"type": "UNMUTE_ROOM", "roomName": room_name},
        )

        response_content = Content(
            text=f"I have unmuted {room_name}. I will now respond to messages there.",
            actions=["UNMUTE_ROOM"],
        )

        if callback:
            await callback(response_content)

        return ActionResult(
            text=f"Unmuted room: {room_name}",
            values={
                "success": True,
                "unmuted": True,
                "roomId": str(room_id),
                "roomName": room_name,
            },
            data={
                "actionName": "UNMUTE_ROOM",
                "roomId": str(room_id),
                "roomName": room_name,
            },
            success=True,
        )

    @property
    def examples(self) -> list[list[ActionExample]]:
        return [
            [
                ActionExample(
                    name="{{name1}}",
                    content=Content(text="You can start responding in this channel again."),
                ),
                ActionExample(
                    name="{{name2}}",
                    content=Content(
                        text="I'll unmute this room and start responding again.",
                        actions=["UNMUTE_ROOM"],
                    ),
                ),
            ],
        ]


unmute_room_action = Action(
    name=UnmuteRoomAction.name,
    similes=UnmuteRoomAction().similes,
    description=UnmuteRoomAction.description,
    validate=UnmuteRoomAction().validate,
    handler=UnmuteRoomAction().handler,
    examples=UnmuteRoomAction().examples,
)
