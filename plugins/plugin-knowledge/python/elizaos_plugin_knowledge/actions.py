import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional, List

KNOWLEDGE_KEYWORDS = [
    "process",
    "add",
    "upload",
    "document",
    "knowledge",
    "learn",
    "remember",
    "store",
    "ingest",
    "file",
]

SEARCH_KEYWORDS = ["search", "find", "look up", "query", "what do you know about"]

KNOWLEDGE_SEARCH_KEYWORDS = ["knowledge", "information", "document", "database"]


@dataclass
class ActionContext:
    message: dict = field(default_factory=dict)
    agent_id: str = ""
    room_id: Optional[str] = None
    entity_id: Optional[str] = None
    state: dict = field(default_factory=dict)


class KnowledgeAction(ABC):
    @property
    @abstractmethod
    def name(self) -> str:
        pass

    @property
    @abstractmethod
    def description(self) -> str:
        pass

    @abstractmethod
    def validate(self, context: ActionContext) -> bool:
        pass

    @abstractmethod
    async def execute(self, context: ActionContext) -> dict:
        pass


class ProcessKnowledgeAction(KnowledgeAction):
    @property
    def name(self) -> str:
        return "PROCESS_KNOWLEDGE"

    @property
    def description(self) -> str:
        return (
            "Process and store knowledge from a file path or text content into the knowledge base"
        )

    def validate(self, context: ActionContext) -> bool:
        text = (
            context.message.get("content", {}).get("text", "") or context.message.get("text", "")
        ).lower()

        has_keyword = any(keyword in text for keyword in KNOWLEDGE_KEYWORDS)
        has_path = "/" in text and "http" not in text

        return has_keyword or has_path

    async def execute(self, context: ActionContext) -> dict:
        text = context.message.get("content", {}).get("text", "") or context.message.get("text", "")

        path_pattern = r"(?:/[\w.\-]+)+|(?:[a-zA-Z]:[/\\][\w\s.\-]+(?:[/\\][\w\s.\-]+)*)"
        path_match = re.search(path_pattern, text)

        if path_match:
            file_path = path_match.group()
            return {
                "action": self.name,
                "mode": "file",
                "file_path": file_path,
                "agent_id": context.agent_id,
                "room_id": context.room_id,
                "entity_id": context.entity_id,
                "status": "pending",
                "message": f"Processing document at {file_path}",
            }
        else:
            knowledge_content = text.strip()

            if not knowledge_content:
                return {
                    "action": self.name,
                    "success": False,
                    "error": "No content provided to process",
                }

            return {
                "action": self.name,
                "mode": "text",
                "content": knowledge_content,
                "agent_id": context.agent_id,
                "room_id": context.room_id,
                "entity_id": context.entity_id,
                "status": "pending",
                "message": "Processing text content",
            }


class SearchKnowledgeAction(KnowledgeAction):
    @property
    def name(self) -> str:
        return "SEARCH_KNOWLEDGE"

    @property
    def description(self) -> str:
        return "Search the knowledge base for specific information"

    def validate(self, context: ActionContext) -> bool:
        text = (
            context.message.get("content", {}).get("text", "") or context.message.get("text", "")
        ).lower()

        has_search_keyword = any(keyword in text for keyword in SEARCH_KEYWORDS)
        has_knowledge_keyword = any(keyword in text for keyword in KNOWLEDGE_SEARCH_KEYWORDS)

        return has_search_keyword and has_knowledge_keyword

    async def execute(self, context: ActionContext) -> dict:
        text = context.message.get("content", {}).get("text", "") or context.message.get("text", "")

        query = text.lower()
        for word in [
            "search",
            "find",
            "look up",
            "query",
            "your",
            "my",
            "knowledge",
            "base",
            "for",
            "information",
            "document",
            "database",
        ]:
            query = query.replace(word, "")
        query = query.strip()

        if not query:
            return {
                "action": self.name,
                "success": False,
                "error": "No search query provided",
                "message": "What would you like me to search for in my knowledge base?",
            }

        return {
            "action": self.name,
            "query": query,
            "agent_id": context.agent_id,
            "room_id": context.room_id,
            "entity_id": context.entity_id,
            "status": "pending",
            "message": f"Searching knowledge base for: {query}",
        }


def get_actions() -> List[KnowledgeAction]:
    return [ProcessKnowledgeAction(), SearchKnowledgeAction()]


process_knowledge_action = ProcessKnowledgeAction()
search_knowledge_action = SearchKnowledgeAction()
knowledge_actions = [process_knowledge_action, search_knowledge_action]
