"""
UNMUTE_ROOM Action - Unmute a room to resume receiving notifications.

This action allows the agent to unmute a previously muted room
and resume responding to messages.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.types import Action, ActionExample, ActionResult, Content, MemoryType

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State


@dataclass
class UnmuteRoomAction:
    """
    Action for unmuting a room.

    This action is used when:
    - The agent should resume responding to room messages
    - Notifications from a room should be enabled
    - The agent wants to re-engage with a room
    """

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

    async def validate(self, runtime: IAgentRuntime, message: Memory) -> bool:
        """Validate that room is currently muted."""
        room_id = message.room_id
        if not room_id:
            return False

        room = await runtime.get_room(room_id)
        if room is None:
            return False

        # Check if currently muted
        world_id = room.world_id
        if world_id:
            world = await runtime.get_world(world_id)
            if world and world.metadata:
                muted_rooms = world.metadata.get("mutedRooms", [])
                # Only valid if currently muted
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
        """Handle unmuting a room."""
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

        try:
            # Get world and update muted rooms
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

            # Create memory of the action
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

        except Exception as error:
            runtime.logger.error(
                {
                    "src": "plugin:bootstrap:action:unmuteRoom",
                    "agentId": runtime.agent_id,
                    "roomId": str(room_id),
                    "error": str(error),
                },
                "Error unmuting room",
            )
            return ActionResult(
                text="Error unmuting room",
                values={"success": False, "error": str(error)},
                data={"actionName": "UNMUTE_ROOM", "error": str(error)},
                success=False,
                error=error,
            )

    @property
    def examples(self) -> list[list[ActionExample]]:
        """Example interactions demonstrating the UNMUTE_ROOM action."""
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


# Create the action instance
unmute_room_action = Action(
    name=UnmuteRoomAction.name,
    similes=UnmuteRoomAction().similes,
    description=UnmuteRoomAction.description,
    validate=UnmuteRoomAction().validate,
    handler=UnmuteRoomAction().handler,
    examples=UnmuteRoomAction().examples,
)

