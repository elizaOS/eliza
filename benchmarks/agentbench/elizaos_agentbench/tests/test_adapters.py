"""
Tests for environment adapters.
"""

import pytest

from elizaos_agentbench.types import (
    AgentBenchEnvironment,
    AgentBenchTask,
    EnvironmentConfig,
)
from elizaos_agentbench.adapters.os_adapter import OSEnvironmentAdapter
from elizaos_agentbench.adapters.db_adapter import DatabaseEnvironmentAdapter
from elizaos_agentbench.adapters.webshop_adapter import WebShopEnvironmentAdapter
from elizaos_agentbench.adapters.kg_adapter import KnowledgeGraphAdapter
from elizaos_agentbench.adapters.lateral_thinking_adapter import LateralThinkingAdapter


class TestOSAdapter:
    @pytest.fixture
    def adapter(self) -> OSEnvironmentAdapter:
        config = EnvironmentConfig(
            additional_settings={"use_docker": False}  # Use local execution for tests
        )
        return OSEnvironmentAdapter(config=config)

    @pytest.mark.asyncio
    async def test_initialization(self, adapter: OSEnvironmentAdapter) -> None:
        """Test adapter initialization."""
        await adapter.initialize()
        assert adapter._is_initialized()

    @pytest.mark.asyncio
    async def test_reset(self, adapter: OSEnvironmentAdapter) -> None:
        """Test environment reset."""
        await adapter.initialize()

        task = AgentBenchTask(
            id="test-os",
            environment=AgentBenchEnvironment.OS,
            description="Test task",
            initial_state={"working_dir": "/tmp"},
            goal="Test goal",
            max_steps=5,
        )

        observation = await adapter.reset(task)
        assert "working_dir" in observation
        assert "task_description" in observation

    def test_extract_command(self, adapter: OSEnvironmentAdapter) -> None:
        """Test command extraction from LLM response."""
        # Test markdown code block
        response1 = "Here's the command:\n```bash\nls -la\n```"
        assert adapter._extract_command(response1) == "ls -la"

        # Test plain command
        response2 = "ls -la /home"
        assert adapter._extract_command(response2) == "ls -la /home"

        # Test command: prefix
        response3 = "command: cat /etc/passwd"
        assert adapter._extract_command(response3) == "cat /etc/passwd"

    def test_get_action_space(self, adapter: OSEnvironmentAdapter) -> None:
        """Test action space contains common commands."""
        actions = adapter.get_action_space()
        assert "ls" in actions
        assert "cd" in actions
        assert "cat" in actions
        assert "grep" in actions

    @pytest.mark.asyncio
    async def test_cleanup(self, adapter: OSEnvironmentAdapter) -> None:
        """Test cleanup."""
        await adapter.initialize()
        await adapter.cleanup()
        assert not adapter._is_initialized()


class TestDatabaseAdapter:
    @pytest.fixture
    def adapter(self) -> DatabaseEnvironmentAdapter:
        return DatabaseEnvironmentAdapter()

    @pytest.mark.asyncio
    async def test_initialization(self, adapter: DatabaseEnvironmentAdapter) -> None:
        """Test adapter initialization."""
        await adapter.initialize()
        assert adapter._is_initialized()
        assert adapter._connection is not None

    @pytest.mark.asyncio
    async def test_reset_creates_tables(self, adapter: DatabaseEnvironmentAdapter) -> None:
        """Test that reset creates tables from schema."""
        await adapter.initialize()

        task = AgentBenchTask(
            id="test-db",
            environment=AgentBenchEnvironment.DATABASE,
            description="Test SQL",
            initial_state={
                "schema": {
                    "users": [
                        {"name": "id", "type": "INTEGER", "primary_key": True},
                        {"name": "name", "type": "TEXT"},
                    ]
                },
                "data": {
                    "users": [
                        {"id": 1, "name": "Alice"},
                        {"id": 2, "name": "Bob"},
                    ]
                },
            },
            goal="Query users",
            max_steps=5,
        )

        observation = await adapter.reset(task)
        assert "users" in observation["tables"]

    @pytest.mark.asyncio
    async def test_select_query(self, adapter: DatabaseEnvironmentAdapter) -> None:
        """Test executing SELECT query."""
        await adapter.initialize()

        task = AgentBenchTask(
            id="test-select",
            environment=AgentBenchEnvironment.DATABASE,
            description="Select users",
            initial_state={
                "schema": {
                    "users": [
                        {"name": "id", "type": "INTEGER", "primary_key": True},
                        {"name": "name", "type": "TEXT"},
                    ]
                },
                "data": {"users": [{"id": 1, "name": "Alice"}]},
            },
            goal="Select all users",
            max_steps=5,
        )

        await adapter.reset(task)
        observation, reward, done, info = await adapter.step("SELECT * FROM users")

        assert observation["success"]
        assert observation["row_count"] == 1
        assert reward > 0

    def test_extract_query(self, adapter: DatabaseEnvironmentAdapter) -> None:
        """Test SQL query extraction."""
        response1 = "```sql\nSELECT * FROM users\n```"
        assert adapter._extract_query(response1) == "SELECT * FROM users"

        response2 = "SELECT name FROM employees WHERE salary > 50000"
        assert adapter._extract_query(response2) == "SELECT name FROM employees WHERE salary > 50000"

    @pytest.mark.asyncio
    async def test_cleanup(self, adapter: DatabaseEnvironmentAdapter) -> None:
        """Test cleanup removes database file."""
        await adapter.initialize()
        await adapter.cleanup()
        assert not adapter._is_initialized()
        assert adapter._connection is None


class TestWebShopAdapter:
    @pytest.fixture
    def adapter(self) -> WebShopEnvironmentAdapter:
        return WebShopEnvironmentAdapter()

    @pytest.mark.asyncio
    async def test_initialization(self, adapter: WebShopEnvironmentAdapter) -> None:
        """Test adapter initialization."""
        await adapter.initialize()
        assert adapter._is_initialized()
        assert len(adapter._products) > 0

    @pytest.mark.asyncio
    async def test_search(self, adapter: WebShopEnvironmentAdapter) -> None:
        """Test product search."""
        await adapter.initialize()

        task = AgentBenchTask(
            id="test-ws",
            environment=AgentBenchEnvironment.WEB_SHOPPING,
            description="Find headphones",
            initial_state={"budget": 100},
            goal="Buy headphones",
            max_steps=10,
        )

        await adapter.reset(task)
        observation, reward, done, info = await adapter.step("search[headphones]")

        assert observation["page"] == "search_results"
        assert len(observation["results"]) > 0
        assert reward > 0

    @pytest.mark.asyncio
    async def test_full_purchase_flow(self, adapter: WebShopEnvironmentAdapter) -> None:
        """Test complete purchase flow."""
        await adapter.initialize()

        task = AgentBenchTask(
            id="test-purchase",
            environment=AgentBenchEnvironment.WEB_SHOPPING,
            description="Buy headphones",
            initial_state={"budget": 100},
            goal="Complete purchase",
            max_steps=20,
        )

        await adapter.reset(task)

        # Search
        await adapter.step("search[headphones]")

        # Click product
        await adapter.step("click[P001]")

        # Select option
        await adapter.step("select_option[color, black]")

        # Add to cart
        obs, _, _, _ = await adapter.step("add_to_cart")
        assert len(adapter._cart) == 1

        # Checkout
        obs, reward, done, _ = await adapter.step("checkout")
        assert done
        assert reward > 0

    def test_parse_shopping_action(self, adapter: WebShopEnvironmentAdapter) -> None:
        """Test action parsing."""
        assert adapter._parse_shopping_action("search[laptops]")["type"] == "search"
        assert adapter._parse_shopping_action("click[P001]")["type"] == "click"
        assert adapter._parse_shopping_action("add_to_cart")["type"] == "add_to_cart"
        assert adapter._parse_shopping_action("checkout")["type"] == "checkout"


class TestKnowledgeGraphAdapter:
    @pytest.fixture
    def adapter(self) -> KnowledgeGraphAdapter:
        return KnowledgeGraphAdapter()

    @pytest.mark.asyncio
    async def test_initialization(self, adapter: KnowledgeGraphAdapter) -> None:
        """Test adapter initialization."""
        await adapter.initialize()
        assert adapter._is_initialized()
        assert len(adapter._entities) > 0
        assert len(adapter._relations) > 0

    @pytest.mark.asyncio
    async def test_get_entity(self, adapter: KnowledgeGraphAdapter) -> None:
        """Test entity retrieval."""
        await adapter.initialize()

        task = AgentBenchTask(
            id="test-kg",
            environment=AgentBenchEnvironment.KNOWLEDGE_GRAPH,
            description="Find Einstein",
            initial_state={},
            goal="Get Einstein info",
            max_steps=10,
        )

        await adapter.reset(task)
        observation, reward, done, info = await adapter.step("get_entity[e001]")

        assert observation["query_type"] == "get_entity"
        assert "Albert Einstein" in str(observation["result"])
        assert reward > 0

    @pytest.mark.asyncio
    async def test_find_relations(self, adapter: KnowledgeGraphAdapter) -> None:
        """Test relation search."""
        await adapter.initialize()

        task = AgentBenchTask(
            id="test-relations",
            environment=AgentBenchEnvironment.KNOWLEDGE_GRAPH,
            description="Find relations",
            initial_state={},
            goal="Find born_in relations",
            max_steps=10,
        )

        await adapter.reset(task)
        observation, reward, done, info = await adapter.step(
            "find_relations[subject=e001, predicate=born_in]"
        )

        assert observation["query_type"] == "find_relations"
        assert observation["total"] > 0


class TestLateralThinkingAdapter:
    @pytest.fixture
    def adapter(self) -> LateralThinkingAdapter:
        return LateralThinkingAdapter()

    @pytest.mark.asyncio
    async def test_initialization(self, adapter: LateralThinkingAdapter) -> None:
        """Test adapter initialization."""
        await adapter.initialize()
        assert adapter._is_initialized()

    @pytest.mark.asyncio
    async def test_ask_question(self, adapter: LateralThinkingAdapter) -> None:
        """Test asking yes/no questions."""
        await adapter.initialize()

        task = AgentBenchTask(
            id="test-lt",
            environment=AgentBenchEnvironment.LATERAL_THINKING,
            description="Man asks for water puzzle",
            initial_state={"puzzle_id": "ltp001"},
            goal="Solve the puzzle",
            max_steps=20,
            ground_truth="hiccups",
        )

        await adapter.reset(task)
        observation, reward, done, info = await adapter.step("ask[Did the man have hiccups?]")

        assert observation["question"] is not None
        assert observation["answer"] is not None

    @pytest.mark.asyncio
    async def test_correct_guess(self, adapter: LateralThinkingAdapter) -> None:
        """Test correct answer submission."""
        await adapter.initialize()

        task = AgentBenchTask(
            id="test-guess",
            environment=AgentBenchEnvironment.LATERAL_THINKING,
            description="Man asks for water puzzle",
            initial_state={"puzzle_id": "ltp001"},
            goal="Solve the puzzle",
            max_steps=20,
            ground_truth="hiccups",
        )

        await adapter.reset(task)
        observation, reward, done, info = await adapter.step("guess[The man had hiccups]")

        assert observation["correct"]
        assert done
        assert reward > 0

    @pytest.mark.asyncio
    async def test_hint_request(self, adapter: LateralThinkingAdapter) -> None:
        """Test hint request."""
        await adapter.initialize()

        task = AgentBenchTask(
            id="test-hint",
            environment=AgentBenchEnvironment.LATERAL_THINKING,
            description="Test puzzle",
            initial_state={"puzzle_id": "ltp001"},
            goal="Solve",
            max_steps=20,
        )

        await adapter.reset(task)
        observation, reward, done, info = await adapter.step("hint")

        assert "hint" in observation
        assert adapter._hints_revealed == 1
