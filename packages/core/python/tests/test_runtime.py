"""Tests for AgentRuntime."""

import pytest

from elizaos.runtime import AgentRuntime
from elizaos.types import (
    Action,
    ActionResult,
    Character,
    Evaluator,
    Memory,
    Plugin,
    Provider,
    ProviderResult,
    State,
    as_uuid,
)


@pytest.fixture
def character() -> Character:
    """Create a test character."""
    return Character(
        name="TestAgent",
        bio="A test agent for unit testing.",
        system="You are a helpful test agent.",
    )


@pytest.fixture
def runtime(character: Character) -> AgentRuntime:
    """Create a test runtime."""
    return AgentRuntime(character=character)


class TestAgentRuntimeInit:
    """Tests for AgentRuntime initialization."""

    def test_runtime_creation(self, character: Character) -> None:
        """Test creating a runtime."""
        runtime = AgentRuntime(character=character)
        assert runtime.character.name == "TestAgent"
        assert runtime.agent_id is not None

    def test_runtime_with_agent_id(self, character: Character) -> None:
        """Test creating a runtime with a specific agent ID."""
        agent_id = as_uuid("12345678-1234-1234-1234-123456789012")
        runtime = AgentRuntime(character=character, agent_id=agent_id)
        assert runtime.agent_id == agent_id

    def test_runtime_with_settings(self, character: Character) -> None:
        """Test creating a runtime with settings."""
        runtime = AgentRuntime(
            character=character,
            settings={"custom_setting": "value"},
        )
        assert runtime.get_setting("custom_setting") == "value"


class TestAgentRuntimeSettings:
    """Tests for runtime settings."""

    def test_get_setting_from_runtime(self, runtime: AgentRuntime) -> None:
        """Test getting a setting from runtime."""
        runtime.set_setting("test_key", "test_value")
        assert runtime.get_setting("test_key") == "test_value"

    def test_get_setting_from_character(self) -> None:
        """Test getting a setting from character."""
        character = Character(
            name="Test",
            bio="Test",
            settings={"char_setting": "char_value"},
        )
        runtime = AgentRuntime(character=character)
        assert runtime.get_setting("char_setting") == "char_value"

    def test_get_setting_from_secrets(self) -> None:
        """Test getting a setting from character secrets."""
        character = Character(
            name="Test",
            bio="Test",
            secrets={"API_KEY": "secret_key"},
        )
        runtime = AgentRuntime(character=character)
        assert runtime.get_setting("API_KEY") == "secret_key"

    def test_get_nonexistent_setting(self, runtime: AgentRuntime) -> None:
        """Test getting a nonexistent setting."""
        assert runtime.get_setting("nonexistent") is None


class TestAgentRuntimeProviders:
    """Tests for provider registration."""

    @pytest.mark.asyncio
    async def test_register_provider(self, runtime: AgentRuntime) -> None:
        """Test registering a provider."""

        async def get_data(rt: AgentRuntime, msg: Memory, state: State) -> ProviderResult:
            return ProviderResult(text="Provider data")

        provider = Provider(
            name="test-provider",
            description="A test provider",
            get=get_data,
        )
        runtime.register_provider(provider)
        assert len(runtime.providers) == 1
        assert runtime.providers[0].name == "test-provider"


class TestAgentRuntimeActions:
    """Tests for action registration."""

    @pytest.mark.asyncio
    async def test_register_action(self, runtime: AgentRuntime) -> None:
        """Test registering an action."""

        async def validate(rt: AgentRuntime, msg: Memory, state: State | None) -> bool:
            return True

        async def handler(
            rt: AgentRuntime,
            msg: Memory,
            state: State | None,
            options: object,
            callback: object,
            responses: list[Memory] | None,
        ) -> ActionResult:
            return ActionResult(success=True)

        action = Action(
            name="TEST_ACTION",
            description="A test action",
            validate=validate,
            handler=handler,
        )
        runtime.register_action(action)
        assert len(runtime.actions) == 1
        assert runtime.actions[0].name == "TEST_ACTION"


class TestAgentRuntimeEvaluators:
    """Tests for evaluator registration."""

    @pytest.mark.asyncio
    async def test_register_evaluator(self, runtime: AgentRuntime) -> None:
        """Test registering an evaluator."""

        async def validate(rt: AgentRuntime, msg: Memory, state: State | None) -> bool:
            return True

        async def handler(
            rt: AgentRuntime,
            msg: Memory,
            state: State | None,
            options: object,
            callback: object,
            responses: list[Memory] | None,
        ) -> ActionResult:
            return ActionResult(success=True)

        evaluator = Evaluator(
            name="test-evaluator",
            description="A test evaluator",
            examples=[],
            validate=validate,
            handler=handler,
        )
        runtime.register_evaluator(evaluator)
        assert len(runtime.evaluators) == 1
        assert runtime.evaluators[0].name == "test-evaluator"


class TestAgentRuntimePlugins:
    """Tests for plugin registration."""

    @pytest.mark.asyncio
    async def test_register_plugin(self, runtime: AgentRuntime) -> None:
        """Test registering a plugin."""

        async def get_data(rt: AgentRuntime, msg: Memory, state: State) -> ProviderResult:
            return ProviderResult(text="Plugin provider data")

        plugin = Plugin(
            name="test-plugin",
            description="A test plugin",
            providers=[
                Provider(
                    name="plugin-provider",
                    get=get_data,
                )
            ],
        )
        await runtime.register_plugin(plugin)
        assert len(runtime.plugins) == 1
        assert runtime.plugins[0].name == "test-plugin"
        assert len(runtime.providers) == 1


class TestAgentRuntimeEvents:
    """Tests for event handling."""

    @pytest.mark.asyncio
    async def test_register_event_handler(self, runtime: AgentRuntime) -> None:
        """Test registering an event handler."""
        events_received: list[str] = []

        async def handler(params: dict[str, object]) -> None:
            events_received.append("event_received")

        runtime.register_event("TEST_EVENT", handler)
        await runtime.emit_event("TEST_EVENT", {"data": "test"})

        assert len(events_received) == 1
        assert events_received[0] == "event_received"

    @pytest.mark.asyncio
    async def test_multiple_event_handlers(self, runtime: AgentRuntime) -> None:
        """Test multiple handlers for same event."""
        count = [0]

        async def handler1(params: dict[str, object]) -> None:
            count[0] += 1

        async def handler2(params: dict[str, object]) -> None:
            count[0] += 1

        runtime.register_event("MULTI_EVENT", handler1)
        runtime.register_event("MULTI_EVENT", handler2)
        await runtime.emit_event("MULTI_EVENT", {})

        assert count[0] == 2


class TestAgentRuntimeModels:
    """Tests for model registration."""

    @pytest.mark.asyncio
    async def test_register_model(self, runtime: AgentRuntime) -> None:
        """Test registering a model handler."""

        async def model_handler(rt: AgentRuntime, params: dict[str, object]) -> str:
            return f"Generated: {params.get('prompt', '')}"

        runtime.register_model(
            model_type="TEXT_LARGE",
            handler=model_handler,
            provider="test-provider",
        )

        result = await runtime.use_model("TEXT_LARGE", {"prompt": "Hello"})
        assert result == "Generated: Hello"

    @pytest.mark.asyncio
    async def test_model_priority(self, runtime: AgentRuntime) -> None:
        """Test model handler priority."""

        async def low_priority_handler(rt: AgentRuntime, params: dict[str, object]) -> str:
            return "low"

        async def high_priority_handler(rt: AgentRuntime, params: dict[str, object]) -> str:
            return "high"

        runtime.register_model(
            model_type="TEXT_LARGE",
            handler=low_priority_handler,
            provider="low",
            priority=0,
        )
        runtime.register_model(
            model_type="TEXT_LARGE",
            handler=high_priority_handler,
            provider="high",
            priority=10,
        )

        result = await runtime.use_model("TEXT_LARGE", {})
        assert result == "high"


class TestAgentRuntimeRunTracking:
    """Tests for run tracking."""

    def test_create_run_id(self, runtime: AgentRuntime) -> None:
        """Test creating a run ID."""
        run_id = runtime.create_run_id()
        assert run_id is not None
        assert len(run_id) == 36  # UUID format

    def test_start_and_end_run(self, runtime: AgentRuntime) -> None:
        """Test starting and ending a run."""
        room_id = as_uuid("12345678-1234-1234-1234-123456789012")
        run_id = runtime.start_run(room_id)
        assert run_id == runtime.get_current_run_id()

        runtime.end_run()
        # Should create a new run when accessed
        new_run_id = runtime.get_current_run_id()
        assert new_run_id != run_id


class TestAgentRuntimeServices:
    """Tests for service management."""

    def test_has_service_empty(self, runtime: AgentRuntime) -> None:
        """Test has_service with no services."""
        assert runtime.has_service("test-service") is False

    def test_get_service_empty(self, runtime: AgentRuntime) -> None:
        """Test get_service with no services."""
        assert runtime.get_service("test-service") is None

    def test_get_registered_service_types_empty(self, runtime: AgentRuntime) -> None:
        """Test getting registered service types when empty."""
        assert runtime.get_registered_service_types() == []
