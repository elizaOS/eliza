"""
UNFOLLOW_ROOM Action - Stop following a room.

This action allows the agent to stop monitoring a room
and cease receiving updates from it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.types import Action, ActionExample, ActionResult, Content, MemoryType

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State


@dataclass
class UnfollowRoomAction:
    """
    Action for unfollowing a room.

    This action is used when:
    - The agent should stop monitoring a room
    - Updates from a room are no longer needed
    - The agent wants to leave a room's activity feed
    """

    name: str = "UNFOLLOW_ROOM"
    similes: list[str] = field(
        default_factory=lambda: [
            "LEAVE_ROOM",
            "UNSUBSCRIBE_ROOM",
            "STOP_WATCHING_ROOM",
            "EXIT_ROOM",
        ]
    )
    description: str = (
        "Stop following a room and cease receiving updates. "
        "Use this when you no longer want to monitor a room's activity."
    )

    async def validate(self, runtime: IAgentRuntime, message: Memory) -> bool:
        """Validate that room is currently being followed."""
        room_id = message.room_id
        if not room_id:
            return False

        room = await runtime.get_room(room_id)
        if room is None:
            return False

        # Check if currently following
        world_id = room.world_id
        if world_id:
            world = await runtime.get_world(world_id)
            if world and world.metadata:
                followed_rooms = world.metadata.get("followedRooms", [])
                # Only valid if currently following
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
        """Handle unfollowing a room."""
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

        try:
            # Get world and update followed rooms
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

            # Create memory of the action
            await runtime.create_memory(
                content=Content(
                    text=f"Stopped following room: {room_name}",
                    actions=["UNFOLLOW_ROOM"],
                ),
                room_id=room_id,
                entity_id=runtime.agent_id,
                memory_type=MemoryType.ACTION,
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

        except Exception as error:
            runtime.logger.error(
                {
                    "src": "plugin:bootstrap:action:unfollowRoom",
                    "agentId": runtime.agent_id,
                    "roomId": str(room_id),
                    "error": str(error),
                },
                "Error unfollowing room",
            )
            return ActionResult(
                text="Error unfollowing room",
                values={"success": False, "error": str(error)},
                data={"actionName": "UNFOLLOW_ROOM", "error": str(error)},
                success=False,
                error=error,
            )

    @property
    def examples(self) -> list[list[ActionExample]]:
        """Example interactions demonstrating the UNFOLLOW_ROOM action."""
        return [
            [
                ActionExample(
                    name="{{name1}}",
                    content=Content(text="You can stop watching this channel now."),
                ),
                ActionExample(
                    name="{{name2}}",
                    content=Content(
                        text="I'll stop following this room.",
                        actions=["UNFOLLOW_ROOM"],
                    ),
                ),
            ],
        ]


# Create the action instance
unfollow_room_action = Action(
    name=UnfollowRoomAction.name,
    similes=UnfollowRoomAction().similes,
    description=UnfollowRoomAction.description,
    validate=UnfollowRoomAction().validate,
    handler=UnfollowRoomAction().handler,
    examples=UnfollowRoomAction().examples,
)

