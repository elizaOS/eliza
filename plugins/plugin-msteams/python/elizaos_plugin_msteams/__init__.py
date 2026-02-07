"""Microsoft Teams integration plugin for elizaOS.

This package provides:
- MS Teams Bot Framework integration
- Proactive messaging
- Adaptive Cards support
- Polls
- Graph API integration for user/file operations
"""

from elizaos_plugin_msteams.client import MSTeamsClient
from elizaos_plugin_msteams.config import MSTeamsConfig, MSTeamsCredentials
from elizaos_plugin_msteams.service import MSTeamsService
from elizaos_plugin_msteams.types import (
    ConversationType,
    MSTeamsAttachment,
    MSTeamsCardActionPayload,
    MSTeamsChannel,
    MSTeamsContent,
    MSTeamsConversation,
    MSTeamsConversationReference,
    MSTeamsEntityPayload,
    MSTeamsEventType,
    MSTeamsMention,
    MSTeamsMessagePayload,
    MSTeamsPoll,
    MSTeamsPollVote,
    MSTeamsReactionPayload,
    MSTeamsSendOptions,
    MSTeamsSendResult,
    MSTeamsTeam,
    MSTeamsUser,
    MSTeamsWorldPayload,
)

# Plugin metadata
PLUGIN_NAME = "msteams"
PLUGIN_VERSION = "2.0.0"
PLUGIN_DESCRIPTION = "Microsoft Teams integration for elizaOS agents via Bot Framework"

__version__ = PLUGIN_VERSION

__all__ = [
    # Metadata
    "PLUGIN_NAME",
    "PLUGIN_VERSION",
    "PLUGIN_DESCRIPTION",
    # Core classes
    "MSTeamsService",
    "MSTeamsClient",
    "MSTeamsConfig",
    "MSTeamsCredentials",
    # Types - Events
    "MSTeamsEventType",
    "ConversationType",
    # Types - Entities
    "MSTeamsUser",
    "MSTeamsConversation",
    "MSTeamsChannel",
    "MSTeamsTeam",
    "MSTeamsConversationReference",
    # Types - Content
    "MSTeamsContent",
    "MSTeamsMention",
    "MSTeamsAttachment",
    "MSTeamsPoll",
    "MSTeamsPollVote",
    # Types - Payloads
    "MSTeamsMessagePayload",
    "MSTeamsReactionPayload",
    "MSTeamsCardActionPayload",
    "MSTeamsWorldPayload",
    "MSTeamsEntityPayload",
    # Types - Results/Options
    "MSTeamsSendResult",
    "MSTeamsSendOptions",
]


def create_plugin() -> dict:
    """Returns the plugin definition used by the elizaOS plugin system."""
    from elizaos_plugin_msteams.actions import (
        SendAdaptiveCardAction,
        SendMessageAction,
        SendPollAction,
    )
    from elizaos_plugin_msteams.providers import (
        ChatStateProvider,
        ConversationMembersProvider,
        TeamInfoProvider,
    )

    return {
        "name": PLUGIN_NAME,
        "description": PLUGIN_DESCRIPTION,
        "version": PLUGIN_VERSION,
        "services": [MSTeamsService],
        "actions": [
            SendMessageAction(),
            SendPollAction(),
            SendAdaptiveCardAction(),
        ],
        "providers": [
            ChatStateProvider(),
            ConversationMembersProvider(),
            TeamInfoProvider(),
        ],
    }
