from __future__ import annotations

from elizaos.types.generated.eliza.v1 import environment_pb2

Component = environment_pb2.Component
Entity = environment_pb2.Entity
WorldOwnership = environment_pb2.WorldOwnership
WorldMetadata = environment_pb2.WorldMetadata
World = environment_pb2.World
RoomMetadata = environment_pb2.RoomMetadata
Room = environment_pb2.Room
Participant = environment_pb2.Participant
Relationship = environment_pb2.Relationship


class _ChannelValue(str):
    """String that also has a .value property for enum compatibility."""

    @property
    def value(self) -> str:  # noqa: D401
        return str(self)


class ChannelType:
    """Channel type constants (mirrors the TypeScript ChannelType enum)."""

    DM = _ChannelValue("DM")
    GROUP = _ChannelValue("GROUP")
    FEED = _ChannelValue("FEED")
    WORLD = _ChannelValue("WORLD")
    API = _ChannelValue("API")
    SELF = _ChannelValue("SELF")


__all__ = [
    "ChannelType",
    "Component",
    "Entity",
    "WorldOwnership",
    "WorldMetadata",
    "World",
    "RoomMetadata",
    "Room",
    "Participant",
    "Relationship",
]
