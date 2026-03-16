"""Tests for knowledge plugin actions."""

import pytest
from elizaos_plugin_knowledge.actions import (
    ActionContext,
    ProcessKnowledgeAction,
    SearchKnowledgeAction,
    get_actions,
    knowledge_actions,
)


class TestProcessKnowledgeAction:
    """Tests for ProcessKnowledgeAction."""

    def test_name(self):
        action = ProcessKnowledgeAction()
        assert action.name == "PROCESS_KNOWLEDGE"

    def test_description(self):
        action = ProcessKnowledgeAction()
        assert len(action.description) > 0

    def test_validate_with_keyword(self):
        action = ProcessKnowledgeAction()
        context = ActionContext(
            message={"content": {"text": "Please process this document"}},
            agent_id="test-agent",
            room_id="room-1",
            entity_id="entity-1",
        )
        assert action.validate(context) is True

    def test_validate_with_path(self):
        action = ProcessKnowledgeAction()
        context = ActionContext(
            message={"content": {"text": "Load /path/to/document.pdf"}},
            agent_id="test-agent",
        )
        assert action.validate(context) is True

    def test_validate_no_match(self):
        action = ProcessKnowledgeAction()
        context = ActionContext(
            message={"content": {"text": "What is the weather today?"}},
            agent_id="test-agent",
        )
        assert action.validate(context) is False

    @pytest.mark.asyncio
    async def test_execute_with_path(self):
        action = ProcessKnowledgeAction()
        context = ActionContext(
            message={"content": {"text": "Process /documents/test.pdf"}},
            agent_id="test-agent",
            room_id="room-1",
            entity_id="entity-1",
        )

        result = await action.execute(context)

        assert result["action"] == "PROCESS_KNOWLEDGE"
        assert result["mode"] == "file"
        assert "/documents/test.pdf" in result["file_path"]

    @pytest.mark.asyncio
    async def test_execute_with_text(self):
        action = ProcessKnowledgeAction()
        context = ActionContext(
            message={"content": {"text": "Remember this: The capital of France is Paris"}},
            agent_id="test-agent",
            room_id="room-1",
        )

        result = await action.execute(context)

        assert result["action"] == "PROCESS_KNOWLEDGE"
        assert result["mode"] == "text"

    @pytest.mark.asyncio
    async def test_execute_empty_content(self):
        action = ProcessKnowledgeAction()
        context = ActionContext(
            message={"content": {"text": ""}},
            agent_id="test-agent",
        )

        result = await action.execute(context)

        assert result["success"] is False
        assert "error" in result


class TestSearchKnowledgeAction:
    """Tests for SearchKnowledgeAction."""

    def test_name(self):
        action = SearchKnowledgeAction()
        assert action.name == "SEARCH_KNOWLEDGE"

    def test_description(self):
        action = SearchKnowledgeAction()
        assert len(action.description) > 0

    def test_validate_search_knowledge(self):
        action = SearchKnowledgeAction()
        context = ActionContext(
            message={"content": {"text": "Search my knowledge base for quantum computing"}},
            agent_id="test-agent",
        )
        assert action.validate(context) is True

    def test_validate_find_information(self):
        action = SearchKnowledgeAction()
        context = ActionContext(
            message={"content": {"text": "Find information about AI"}},
            agent_id="test-agent",
        )
        assert action.validate(context) is True

    def test_validate_search_only(self):
        action = SearchKnowledgeAction()
        context = ActionContext(
            message={"content": {"text": "Search for cats"}},
            agent_id="test-agent",
        )
        # Should fail - no knowledge keyword
        assert action.validate(context) is False

    def test_validate_no_match(self):
        action = SearchKnowledgeAction()
        context = ActionContext(
            message={"content": {"text": "What is the weather today?"}},
            agent_id="test-agent",
        )
        assert action.validate(context) is False

    @pytest.mark.asyncio
    async def test_execute_with_query(self):
        action = SearchKnowledgeAction()
        context = ActionContext(
            message={"content": {"text": "Search knowledge base for quantum computing"}},
            agent_id="test-agent",
            room_id="room-1",
            entity_id="entity-1",
        )

        result = await action.execute(context)

        assert result["action"] == "SEARCH_KNOWLEDGE"
        assert "quantum" in result["query"]
        assert result["status"] == "pending"

    @pytest.mark.asyncio
    async def test_execute_empty_query(self):
        action = SearchKnowledgeAction()
        context = ActionContext(
            message={"content": {"text": "Search my knowledge base for"}},
            agent_id="test-agent",
        )

        result = await action.execute(context)

        assert result["success"] is False
        assert "error" in result


class TestGetActions:
    """Tests for get_actions function."""

    def test_get_actions_returns_list(self):
        actions = get_actions()
        assert isinstance(actions, list)
        assert len(actions) == 2

    def test_get_actions_contains_both(self):
        actions = get_actions()
        names = [a.name for a in actions]
        assert "PROCESS_KNOWLEDGE" in names
        assert "SEARCH_KNOWLEDGE" in names


class TestKnowledgeActions:
    """Tests for knowledge_actions list."""

    def test_knowledge_actions_list(self):
        assert len(knowledge_actions) == 2

    def test_knowledge_actions_types(self):
        assert isinstance(knowledge_actions[0], ProcessKnowledgeAction)
        assert isinstance(knowledge_actions[1], SearchKnowledgeAction)
