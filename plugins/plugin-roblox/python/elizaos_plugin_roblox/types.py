"""Type definitions for the Roblox plugin."""

from datetime import datetime
from enum import Enum
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field


class RobloxUser(BaseModel):
    """Roblox user information."""

    id: int = Field(..., description="Roblox user ID")
    username: str = Field(..., description="Roblox username")
    display_name: str = Field(..., description="Display name")
    avatar_url: str | None = Field(None, description="Avatar thumbnail URL")
    created_at: datetime | None = Field(None, description="Account creation date")
    is_banned: bool = Field(False, description="Whether account is banned")


class RobloxPlayerSession(BaseModel):
    """Roblox player session in a game."""

    user: RobloxUser = Field(..., description="Player user info")
    job_id: str = Field(..., description="Server job ID")
    place_id: str = Field(..., description="Place ID the player is in")
    joined_at: datetime = Field(..., description="When the player joined")


class RobloxGameMessage(BaseModel):
    """Message from a Roblox game."""

    id: str = Field(..., description="Unique message ID")
    user: RobloxUser = Field(..., description="Sending user")
    content: str = Field(..., description="Message content")
    job_id: str = Field(..., description="Server job ID")
    place_id: str = Field(..., description="Place ID")
    timestamp: datetime = Field(..., description="Message timestamp")
    context: dict[str, str] | None = Field(None, description="Optional context data")


class RobloxGameAction(BaseModel):
    """Game action to execute in Roblox."""

    name: str = Field(..., description="Action name/type")
    parameters: dict[str, Any] = Field(default_factory=dict, description="Action parameters")
    target_player_ids: list[int] | None = Field(
        None, description="Target player IDs (empty = all)"
    )


class RobloxResponse(BaseModel):
    """Response to send back to Roblox."""

    content: str = Field(..., description="Response content")
    action: RobloxGameAction | None = Field(
        None, description="Optional action to trigger in-game"
    )
    flagged: bool = Field(False, description="Whether the message was flagged")


class DataStoreEntry(BaseModel):
    """Data store entry."""

    key: str = Field(..., description="Entry key")
    value: Any = Field(..., description="Entry value")
    version: str = Field(..., description="Entry version")
    created_at: datetime = Field(..., description="Creation timestamp")
    updated_at: datetime = Field(..., description="Last update timestamp")


class MessageSender(BaseModel):
    """Message sender information."""

    agent_id: UUID = Field(..., description="Agent ID")
    agent_name: str = Field(..., description="Agent name")


class MessagingServiceMessage(BaseModel):
    """Messaging service message."""

    topic: str = Field(..., description="Topic name")
    data: Any = Field(..., description="Message data")
    sender: MessageSender | None = Field(None, description="Sender information")


class RobloxEventType(str, Enum):
    """Roblox event types."""

    PLAYER_JOINED = "roblox:player_joined"
    PLAYER_LEFT = "roblox:player_left"
    PLAYER_MESSAGE = "roblox:player_message"
    GAME_EVENT = "roblox:game_event"
    WEBHOOK_RECEIVED = "roblox:webhook_received"


class RobloxServerInfo(BaseModel):
    """Server information."""

    job_id: str = Field(..., description="Job ID")
    place_id: str = Field(..., description="Place ID")
    player_count: int = Field(..., description="Current player count")
    max_players: int = Field(..., description="Maximum players")
    region: str | None = Field(None, description="Server region")
    uptime: int | None = Field(None, description="Server uptime in seconds")


class CreatorType(str, Enum):
    """Creator type enumeration."""

    USER = "User"
    GROUP = "Group"


class ExperienceCreator(BaseModel):
    """Experience creator information."""

    id: int = Field(..., description="Creator ID")
    creator_type: CreatorType = Field(..., description="Creator type")
    name: str = Field(..., description="Creator name")


class RobloxExperienceInfo(BaseModel):
    """Experience/Universe information."""

    universe_id: str = Field(..., description="Universe ID")
    name: str = Field(..., description="Experience name")
    description: str | None = Field(None, description="Description")
    creator: ExperienceCreator = Field(..., description="Creator info")
    playing: int | None = Field(None, description="Current active player count")
    visits: int | None = Field(None, description="Total visits")
    root_place_id: str = Field(..., description="Root place ID")

