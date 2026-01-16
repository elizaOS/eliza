from __future__ import annotations

from collections.abc import Callable

from elizaos.types.generated.eliza.v1 import agent_pb2

Agent = agent_pb2.Agent
AgentStatus = agent_pb2.AgentStatus
Character = agent_pb2.Character
CharacterSettings = agent_pb2.CharacterSettings
MessageExample = agent_pb2.MessageExample
MessageExampleGroup = agent_pb2.MessageExampleGroup
KnowledgeItem = agent_pb2.KnowledgeItem
KnowledgeDirectory = agent_pb2.KnowledgeDirectory
StyleGuides = agent_pb2.StyleGuides

# Runtime-only template type (functions are not represented in proto)
TemplateType = str | Callable[[dict[str, object]], str]

__all__ = [
    "Agent",
    "AgentStatus",
    "Character",
    "CharacterSettings",
    "MessageExample",
    "MessageExampleGroup",
    "KnowledgeItem",
    "KnowledgeDirectory",
    "StyleGuides",
    "TemplateType",
]
