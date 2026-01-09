"""
MUTE_ROOM Action - Mute a room to stop receiving notifications.

This action allows the agent to mute a room, suppressing
notifications while still being able to access messages.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.types import Action, ActionExample, ActionResult, Content, MemoryType

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State


@dataclass
class MuteRoomAction:
    """
    Action for muting a room.

    This action is used when:
    - The agent should not respond to room messages
    - Notifications from a room should be suppressed
    - The agent wants to quietly observe without interacting
    """

    name: str = "MUTE_ROOM"
    similes: list[str] = field(
        default_factory=lambda: [
            "SILENCE_ROOM",
            "QUIET_ROOM",
            "DISABLE_NOTIFICATIONS",
            "STOP_RESPONDING",
        ]
    )
    description: str = (
        "Mute a room to stop responding and receiving notifications. "
        "Use this when you want to stop interacting with a room temporarily."
    )

    async def validate(self, runtime: IAgentRuntime, message: Memory) -> bool:
        """Validate that room can be muted."""
        room_id = message.room_id
        if not room_id:
            return False

        room = await runtime.get_room(room_id)
        if room is None:
            return False

        # Check if not already muted
        world_id = room.world_id
        if world_id:
            world = await runtime.get_world(world_id)
            if world and world.metadata:
                muted_rooms = world.metadata.get("mutedRooms", [])
                # Already muted - no need to mute again
                if str(room_id) in muted_rooms:
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
        """Handle muting a room."""
        room_id = message.room_id
        if not room_id:
            return ActionResult(
                text="No room specified to mute",
                values={"success": False, "error": "no_room_id"},
                data={"actionName": "MUTE_ROOM"},
                success=False,
            )

        room = await runtime.get_room(room_id)
        if room is None:
            return ActionResult(
                text="Room not found",
                values={"success": False, "error": "room_not_found"},
                data={"actionName": "MUTE_ROOM"},
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

                    if room_id_str not in muted_rooms:
                        muted_rooms.append(room_id_str)
                        world.metadata["mutedRooms"] = muted_rooms
                        await runtime.update_world(world)

            # Create memory of the action
            await runtime.create_memory(
                content=Content(
                    text=f"Muted room: {room_name}",
                    actions=["MUTE_ROOM"],
                ),
                room_id=room_id,
                entity_id=runtime.agent_id,
                memory_type=MemoryType.ACTION,
                metadata={"type": "MUTE_ROOM", "roomName": room_name},
            )

            response_content = Content(
                text=f"I have muted {room_name}. I won't respond to messages there.",
                actions=["MUTE_ROOM"],
            )

            if callback:
                await callback(response_content)

            return ActionResult(
                text=f"Muted room: {room_name}",
                values={
                    "success": True,
                    "muted": True,
                    "roomId": str(room_id),
                    "roomName": room_name,
                },
                data={
                    "actionName": "MUTE_ROOM",
                    "roomId": str(room_id),
                    "roomName": room_name,
                },
                success=True,
            )

        except Exception as error:
            runtime.logger.error(
                {
                    "src": "plugin:bootstrap:action:muteRoom",
                    "agentId": runtime.agent_id,
                    "roomId": str(room_id),
                    "error": str(error),
                },
                "Error muting room",
            )
            return ActionResult(
                text="Error muting room",
                values={"success": False, "error": str(error)},
                data={"actionName": "MUTE_ROOM", "error": str(error)},
                success=False,
                error=error,
            )

    @property
    def examples(self) -> list[list[ActionExample]]:
        """Example interactions demonstrating the MUTE_ROOM action."""
        return [
            [
                ActionExample(
                    name="{{name1}}",
                    content=Content(text="Please stop responding in this channel."),
                ),
                ActionExample(
                    name="{{name2}}",
                    content=Content(
                        text="I'll mute this room and won't respond here anymore.",
                        actions=["MUTE_ROOM"],
                    ),
                ),
            ],
        ]


# Create the action instance
mute_room_action = Action(
    name=MuteRoomAction.name,
    similes=MuteRoomAction().similes,
    description=MuteRoomAction.description,
    validate=MuteRoomAction().validate,
    handler=MuteRoomAction().handler,
    examples=MuteRoomAction().examples,
)

