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

__all__ = [
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
