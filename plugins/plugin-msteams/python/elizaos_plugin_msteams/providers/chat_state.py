"""Chat state providers for MS Teams."""

from abc import ABC, abstractmethod
from typing import Any

from pydantic import BaseModel


class ProviderContext(BaseModel):
    """Context provided to providers."""

    conversation_id: str | None = None
    user_id: str | None = None
    tenant_id: str | None = None
    conversation_type: str | None = None
    activity_id: str | None = None
    room_id: str | None = None


class MSTeamsProvider(ABC):
    """Base class for MS Teams providers."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Returns the provider name."""

    @abstractmethod
    async def get(self, context: ProviderContext) -> dict[str, Any]:
        """Returns provider data for the current context."""


class ChatStateProvider(MSTeamsProvider):
    """Provider that exposes the current conversation/user/tenant context."""

    @property
    def name(self) -> str:
        return "msteams_chat_state"

    async def get(self, context: ProviderContext) -> dict[str, Any]:
        is_personal = context.conversation_type == "personal"
        is_group_chat = context.conversation_type == "groupChat"
        is_channel = context.conversation_type == "channel"

        return {
            "conversationId": context.conversation_id,
            "userId": context.user_id,
            "tenantId": context.tenant_id,
            "conversationType": context.conversation_type,
            "activityId": context.activity_id,
            "roomId": context.room_id,
            "isPersonal": is_personal,
            "isGroupChat": is_group_chat,
            "isChannel": is_channel,
        }


class ConversationMembersProvider(MSTeamsProvider):
    """Provider that exposes information about conversation members."""

    @property
    def name(self) -> str:
        return "msteams_conversation_members"

    async def get(self, context: ProviderContext) -> dict[str, Any]:
        # In a real implementation, this would fetch members from the service
        return {
            "conversationId": context.conversation_id,
            "members": [],
            "memberCount": 0,
        }


class TeamInfoProvider(MSTeamsProvider):
    """Provider that exposes team and channel information."""

    @property
    def name(self) -> str:
        return "msteams_team_info"

    async def get(self, context: ProviderContext) -> dict[str, Any]:
        is_channel = context.conversation_type == "channel"

        return {
            "conversationId": context.conversation_id,
            "tenantId": context.tenant_id,
            "isChannel": is_channel,
            "teamId": None,
            "teamName": None,
            "channelId": context.conversation_id if is_channel else None,
            "channelName": None,
        }
