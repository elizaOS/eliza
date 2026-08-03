"""
Tests for environment adapters.
"""

import asyncio
import sqlite3

import pytest

from elizaos_agentbench import upstream_loader
from elizaos_agentbench.adapters.db_adapter import DatabaseEnvironmentAdapter
from elizaos_agentbench.adapters.kg_adapter import KnowledgeGraphAdapter
from elizaos_agentbench.adapters.lateral_thinking_adapter import LateralThinkingAdapter
from elizaos_agentbench.adapters.os_adapter import (
    OSEnvironmentAdapter,
    _official_protocol_requirements,
)
from elizaos_agentbench.adapters.webshop_adapter import WebShopEnvironmentAdapter
from elizaos_agentbench.types import (
    AgentBenchEnvironment,
    AgentBenchInfrastructureError,
    AgentBenchTask,
    EnvironmentConfig,
)


class _FakeProcess:
    def __init__(self, *, returncode: int, stdout: bytes = b"", stderr: bytes = b"") -> None:
        self.returncode = returncode
        self._stdout = stdout
        self._stderr = stderr

    async def communicate(self) -> tuple[bytes, bytes]:
        return self._stdout, self._stderr


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

    @pytest.mark.parametrize("settings", [{}, {"use_docker": True}])
    @pytest.mark.parametrize("failed_stage", ["pull", "create", "start"])
    @pytest.mark.asyncio
    async def test_docker_lifecycle_failure_is_infrastructure_without_local_fallback(
        self,
        monkeypatch: pytest.MonkeyPatch,
        settings: dict[str, bool],
        failed_stage: str,
    ) -> None:
        adapter = OSEnvironmentAdapter(config=EnvironmentConfig(additional_settings=settings))

        async def create_process(*arguments: str, **_kwargs: object) -> _FakeProcess:
            stage = arguments[1]
            if stage == failed_stage:
                return _FakeProcess(
                    returncode=1,
                    stderr=f"{stage} control-plane failure".encode(),
                )
            return _FakeProcess(
                returncode=0,
                stdout=b"container-id\n" if stage == "create" else b"",
            )

        monkeypatch.setattr(asyncio, "create_subprocess_exec", create_process)

        with pytest.raises(
            AgentBenchInfrastructureError,
            match=rf"docker {failed_stage} failed.*{failed_stage} control-plane failure",
        ):
            await adapter.initialize()
        assert adapter._temp_dir is None
        assert adapter._container_id is None
        assert not adapter._is_initialized()

    @pytest.mark.asyncio
    async def test_local_execution_requires_explicit_false(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def unexpected_docker(*_args: object, **_kwargs: object) -> None:
            raise AssertionError("Docker must not run in explicit local mode")

        monkeypatch.setattr(asyncio, "create_subprocess_exec", unexpected_docker)
        adapter = OSEnvironmentAdapter(
            config=EnvironmentConfig(additional_settings={"use_docker": False})
        )

        await adapter.initialize()

        assert adapter._temp_dir is not None
        assert adapter._container_id is None

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

    @pytest.mark.asyncio
    async def test_script_backed_upstream_task_fails_closed(
        self, adapter: OSEnvironmentAdapter
    ) -> None:
        await adapter.initialize()
        task = AgentBenchTask(
            id="os-test-1-stock-000",
            environment=AgentBenchEnvironment.OS,
            description="Read /usr/stock.log.",
            initial_state={
                "create": {
                    "local": "default",
                    "init": {"file": "init/stock-log.sh"},
                }
            },
            goal="Return the transaction count.",
            max_steps=8,
            metadata={"evaluation": {"check": [None, {"file": "check/integer-match.py"}]}},
        )

        with pytest.raises(AgentBenchInfrastructureError, match="refusing partial execution"):
            await adapter.reset(task)

    @pytest.mark.asyncio
    async def test_start_only_official_task_fails_closed(
        self, adapter: OSEnvironmentAdapter
    ) -> None:
        await adapter.initialize()
        task = AgentBenchTask(
            id="os-test-start-only",
            environment=AgentBenchEnvironment.OS,
            description="Run the prepared program.",
            initial_state={"create": {}, "start": "service example start"},
            goal="Return the expected answer.",
            max_steps=8,
            ground_truth="ready",
            metadata={"evaluation": {"match": "ready"}},
        )

        with pytest.raises(AgentBenchInfrastructureError, match="start, answer action"):
            await adapter.reset(task)

    def test_full_official_os_corpus_requires_upstream_protocol(self) -> None:
        tasks = upstream_loader.load_os_tasks(
            split="test", data_mode="full", include_edge_scenarios=False
        )

        assert len(tasks) == 144
        assert all(_official_protocol_requirements(task) for task in tasks)

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

    @pytest.mark.asyncio
    async def test_executor_process_failure_is_infrastructure(
        self, adapter: OSEnvironmentAdapter, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        await adapter.initialize()

        async def fail_process(_command: str) -> tuple[str, int]:
            raise OSError("process launch failed")

        monkeypatch.setattr(adapter, "_execute_local_command", fail_process)

        with pytest.raises(AgentBenchInfrastructureError, match="process launch failed"):
            await adapter.step("printf ready")

    @pytest.mark.asyncio
    async def test_dead_container_docker_exec_is_infrastructure(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        adapter = OSEnvironmentAdapter(
            config=EnvironmentConfig(additional_settings={"use_docker": True})
        )
        adapter._container_id = "dead-container"
        adapter._working_directory = "/workspace"

        async def dead_container(*_args: object, **_kwargs: object) -> _FakeProcess:
            return _FakeProcess(
                returncode=1,
                stderr=(b"Error response from daemon: Container dead-container is not running"),
            )

        monkeypatch.setattr(asyncio, "create_subprocess_exec", dead_container)

        with pytest.raises(AgentBenchInfrastructureError, match="container/daemon boundary"):
            await adapter.step("ls")

    @pytest.mark.asyncio
    async def test_model_command_nonzero_exit_remains_a_task_result(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        adapter = OSEnvironmentAdapter(
            config=EnvironmentConfig(additional_settings={"use_docker": True})
        )
        adapter._container_id = "running-container"
        adapter._working_directory = "/workspace"

        async def failed_command(*_args: object, **_kwargs: object) -> _FakeProcess:
            return _FakeProcess(
                returncode=2,
                stderr=b"ls: cannot access missing: No such file or directory",
            )

        monkeypatch.setattr(asyncio, "create_subprocess_exec", failed_command)

        observation, reward, done, info = await adapter.step("ls missing")

        assert observation["exit_code"] == 2
        assert reward < 0
        assert done is False
        assert info["exit_code"] == 2

    @pytest.mark.asyncio
    async def test_model_command_timeout_remains_a_task_observation(
        self, adapter: OSEnvironmentAdapter, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        await adapter.initialize()

        async def time_out(_command: str) -> tuple[str, int]:
            raise asyncio.TimeoutError

        monkeypatch.setattr(adapter, "_execute_local_command", time_out)

        observation, _reward, _done, info = await adapter.step("sleep 999")
        assert observation == {"error": "Command timed out"}
        assert info["timeout"] is True


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
    async def test_invalid_model_query_remains_a_scored_failure(
        self, adapter: DatabaseEnvironmentAdapter
    ) -> None:
        await adapter.initialize()
        task = AgentBenchTask(
            id="test-invalid-sql",
            environment=AgentBenchEnvironment.DATABASE,
            description="Query the users table.",
            initial_state={
                "schema": {"users": [{"name": "id", "type": "INTEGER"}]},
                "data": {"users": [{"id": 1}]},
            },
            goal="Return the user id.",
            max_steps=1,
            metadata={"label": [1]},
        )
        await adapter.reset(task)
        await adapter.step("SELECT missing FROM users")

        assert await adapter.evaluate(task, ["SELECT missing FROM users"]) is False

    @pytest.mark.asyncio
    async def test_missing_connection_is_infrastructure(
        self, adapter: DatabaseEnvironmentAdapter
    ) -> None:
        await adapter.initialize()
        assert adapter._connection is not None
        adapter._connection.close()
        adapter._connection = None

        with pytest.raises(AgentBenchInfrastructureError, match="connection is unavailable"):
            await adapter.step("SELECT 1")

    @pytest.mark.asyncio
    async def test_database_engine_failure_is_infrastructure(
        self, adapter: DatabaseEnvironmentAdapter
    ) -> None:
        class FailingCursor:
            def execute(self, _query: str) -> None:
                raise sqlite3.OperationalError("database is locked")

        class FailingConnection:
            def cursor(self) -> FailingCursor:
                return FailingCursor()

        adapter._connection = FailingConnection()  # type: ignore[assignment]

        with pytest.raises(AgentBenchInfrastructureError, match="database is locked"):
            await adapter.step("SELECT 1")

    @pytest.mark.asyncio
    async def test_database_scorer_runtime_failure_is_infrastructure(
        self, adapter: DatabaseEnvironmentAdapter
    ) -> None:
        await adapter.initialize()
        task = AgentBenchTask(
            id="test-scoring-infrastructure",
            environment=AgentBenchEnvironment.DATABASE,
            description="Query the users table.",
            initial_state={
                "schema": {"users": [{"name": "id", "type": "INTEGER"}]},
                "data": {"users": [{"id": 1}]},
            },
            goal="Return the user id.",
            max_steps=1,
            metadata={"label": [1]},
        )
        await adapter.reset(task)
        await adapter.step("SELECT id FROM users")
        assert adapter._connection is not None
        adapter._connection.close()

        with pytest.raises(AgentBenchInfrastructureError, match="scoring failed"):
            await adapter.evaluate(task, ["SELECT id FROM users"])

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
        assert (
            adapter._extract_query(response2) == "SELECT name FROM employees WHERE salary > 50000"
        )

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
        # No built-in product corpus; products are injected per task.
        assert adapter._products == []

    # Minimal injected product corpus used by WebShop tests; the
    # adapter no longer ships a built-in catalog, so each test supplies
    # its own fixture via ``task.initial_state["products"]``.
    _PRODUCTS_FIXTURE: list[dict] = [
        {
            "id": "P001",
            "name": "Wireless Bluetooth Headphones",
            "price": 79.99,
            "category": "Electronics",
            "rating": 4.5,
            "features": ["noise cancelling"],
            "options": {"color": ["black", "white"]},
        },
    ]

    @pytest.mark.asyncio
    async def test_search(self, adapter: WebShopEnvironmentAdapter) -> None:
        """Test product search."""
        await adapter.initialize()

        task = AgentBenchTask(
            id="test-ws",
            environment=AgentBenchEnvironment.WEB_SHOPPING,
            description="Find headphones",
            initial_state={"budget": 100, "products": self._PRODUCTS_FIXTURE},
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
            initial_state={"budget": 100, "products": self._PRODUCTS_FIXTURE},
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
    # Minimal injected subgraph used by KG adapter tests. The adapter
    # no longer ships a built-in graph; the official benchmark queries
    # Freebase via SPARQL.
    _KG_FIXTURE: dict = {
        "entities": {
            "e001": {"name": "Albert Einstein", "type": "person", "birth_year": 1879},
            "e002": {"name": "Germany", "type": "country"},
        },
        "relations": [
            {"subject": "e001", "predicate": "born_in", "object": "e002"},
        ],
    }

    @pytest.fixture
    def adapter(self) -> KnowledgeGraphAdapter:
        return KnowledgeGraphAdapter()

    @pytest.mark.asyncio
    async def test_initialization(self, adapter: KnowledgeGraphAdapter) -> None:
        """Test adapter initialization (no built-in graph)."""
        await adapter.initialize()
        assert adapter._is_initialized()
        # Adapter no longer ships SAMPLE_ENTITIES; the graph is injected
        # per task or read from Freebase.
        assert adapter._entities == {}
        assert adapter._relations == []

    @pytest.mark.asyncio
    async def test_get_entity(self, adapter: KnowledgeGraphAdapter) -> None:
        """Test entity retrieval with an injected subgraph."""
        await adapter.initialize()

        task = AgentBenchTask(
            id="test-kg",
            environment=AgentBenchEnvironment.KNOWLEDGE_GRAPH,
            description="Find Einstein",
            initial_state=self._KG_FIXTURE,
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
        """Test relation search with an injected subgraph."""
        await adapter.initialize()

        task = AgentBenchTask(
            id="test-relations",
            environment=AgentBenchEnvironment.KNOWLEDGE_GRAPH,
            description="Find relations",
            initial_state=self._KG_FIXTURE,
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
            description="A man walks into a bar and asks for a glass of water...",
            initial_state={"answer_key": "hiccups\nstartled"},
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
            description="A man walks into a bar and asks for water...",
            initial_state={"answer_key": "hiccups"},
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
        """Test hint request when hints are supplied on the task."""
        await adapter.initialize()

        task = AgentBenchTask(
            id="test-hint",
            environment=AgentBenchEnvironment.LATERAL_THINKING,
            description="Test puzzle",
            initial_state={"answer_key": "hiccups"},
            goal="Solve",
            max_steps=20,
            ground_truth="hiccups",
            hints=["The man had a physical condition.", "Fear can cure things."],
        )

        await adapter.reset(task)
        observation, reward, done, info = await adapter.step("hint")

        assert "hint" in observation
        assert adapter._hints_revealed == 1
