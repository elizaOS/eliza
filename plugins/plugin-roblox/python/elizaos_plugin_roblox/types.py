from datetime import datetime
from enum import Enum
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field


class RobloxUser(BaseModel):
    id: int = Field(...)
    username: str = Field(...)
    display_name: str = Field(...)
    avatar_url: str | None = Field(None)
    created_at: datetime | None = Field(None)
    is_banned: bool = Field(False)


class RobloxPlayerSession(BaseModel):
    user: RobloxUser = Field(...)
    job_id: str = Field(...)
    place_id: str = Field(...)
    joined_at: datetime = Field(...)


class RobloxGameMessage(BaseModel):
    id: str = Field(...)
    user: RobloxUser = Field(...)
    content: str = Field(...)
    job_id: str = Field(...)
    place_id: str = Field(...)
    timestamp: datetime = Field(...)
    context: dict[str, str] | None = Field(None)


class RobloxGameAction(BaseModel):
    name: str = Field(...)
    parameters: dict[str, Any] = Field(default_factory=dict)
    target_player_ids: list[int] | None = Field(None)


class RobloxResponse(BaseModel):
    content: str = Field(...)
    action: RobloxGameAction | None = Field(None)
    flagged: bool = Field(False)


class DataStoreEntry(BaseModel):
    key: str = Field(...)
    value: Any = Field(...)
    version: str = Field(...)
    created_at: datetime = Field(...)
    updated_at: datetime = Field(...)


class MessageSender(BaseModel):
    agent_id: UUID = Field(...)
    agent_name: str = Field(...)


class MessagingServiceMessage(BaseModel):
    topic: str = Field(...)
    data: Any = Field(...)
    sender: MessageSender | None = Field(None)


class RobloxEventType(str, Enum):
    PLAYER_JOINED = "roblox:player_joined"
    PLAYER_LEFT = "roblox:player_left"
    PLAYER_MESSAGE = "roblox:player_message"
    GAME_EVENT = "roblox:game_event"
    WEBHOOK_RECEIVED = "roblox:webhook_received"


class RobloxServerInfo(BaseModel):
    job_id: str = Field(...)
    place_id: str = Field(...)
    player_count: int = Field(...)
    max_players: int = Field(...)
    region: str | None = Field(None)
    uptime: int | None = Field(None)


class CreatorType(str, Enum):
    USER = "User"
    GROUP = "Group"


class ExperienceCreator(BaseModel):
    id: int = Field(...)
    creator_type: CreatorType = Field(...)
    name: str = Field(...)


class RobloxExperienceInfo(BaseModel):
    universe_id: str = Field(...)
    name: str = Field(...)
    description: str | None = Field(None)
    creator: ExperienceCreator = Field(...)
    playing: int | None = Field(None)
    visits: int | None = Field(None)
    root_place_id: str = Field(...)
