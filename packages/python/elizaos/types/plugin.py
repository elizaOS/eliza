from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, Field

if TYPE_CHECKING:
    from elizaos.types.agent import Character
    from elizaos.types.components import Action, Evaluator, Provider
    from elizaos.types.database import IDatabaseAdapter
    from elizaos.types.runtime import IAgentRuntime
    from elizaos.types.service import Service

# Type for streaming model handlers
StreamingModelHandler = Callable[["IAgentRuntime", dict[str, Any]], AsyncIterator[str]]


class RouteRequest(BaseModel):
    body: Any | None = Field(default=None, description="Request body")
    params: dict[str, str] | None = Field(default=None, description="Route parameters")
    query: dict[str, Any] | None = Field(default=None, description="Query parameters")
    headers: dict[str, str | list[str] | None] | None = Field(
        default=None, description="Request headers"
    )
    method: str | None = Field(default=None, description="HTTP method")
    path: str | None = Field(default=None, description="Request path")
    url: str | None = Field(default=None, description="Full URL")

    model_config = {"extra": "allow"}


class RouteResponse:
    def __init__(self) -> None:
        self._status_code: int = 200
        self._headers: dict[str, str | list[str]] = {}
        self._body: Any = None
        self.headers_sent: bool = False

    def status(self, code: int) -> RouteResponse:
        self._status_code = code
        return self

    def json(self, data: Any) -> RouteResponse:
        self._body = data
        return self

    def send(self, data: Any) -> RouteResponse:
        self._body = data
        return self

    def end(self) -> RouteResponse:
        self.headers_sent = True
        return self

    def set_header(self, name: str, value: str | list[str]) -> RouteResponse:
        self._headers[name] = value
        return self


# Route handler type
RouteHandler = Callable[
    [RouteRequest, RouteResponse, "IAgentRuntime"],
    Awaitable[None],
]


class Route(BaseModel):
    """Route definition for plugin HTTP routes."""

    type: Literal["GET", "POST", "PUT", "PATCH", "DELETE", "STATIC"] = Field(
        ..., description="HTTP method"
    )
    path: str = Field(..., description="Route path")
    file_path: str | None = Field(default=None, alias="filePath", description="Static file path")
    public: bool | None = Field(default=None, description="Whether route is public")
    name: str | None = Field(default=None, description="Route name for tab display")
    handler: RouteHandler | None = Field(default=None, description="Route handler")
    is_multipart: bool | None = Field(
        default=None,
        alias="isMultipart",
        description="Whether route expects multipart/form-data",
    )

    model_config = {"populate_by_name": True, "arbitrary_types_allowed": True}


# Plugin events type - maps event names to lists of event handlers
PluginEvents = dict[str, list[Callable[[Any], Awaitable[None]]]]


class TestCase(BaseModel):
    name: str = Field(..., description="Test case name")
    fn: Callable[[IAgentRuntime], Awaitable[None]] = Field(..., description="Test function")

    model_config = {"arbitrary_types_allowed": True}


class TestSuite(BaseModel):
    """Test suite definition for plugin tests."""

    name: str = Field(..., description="Test suite name")
    tests: list[TestCase] = Field(..., description="Test cases")

    model_config = {"arbitrary_types_allowed": True}


class ComponentTypeDefinition(BaseModel):
    name: str = Field(..., description="Component type name")
    schema_def: dict[str, Any] = Field(..., alias="schema", description="Component schema")
    validator: Callable[[Any], bool] | None = Field(
        default=None, description="Optional validator function"
    )

    model_config = {"arbitrary_types_allowed": True, "populate_by_name": True}


class Plugin(BaseModel):
    name: str = Field(..., description="Unique name for the plugin")
    description: str = Field(..., description="Human-readable description")

    # Initialize plugin with runtime services
    init: (
        Callable[[dict[str, str | int | float | bool | None], IAgentRuntime], Awaitable[None]]
        | None
    ) = Field(default=None, description="Plugin initialization function")

    # Configuration
    config: dict[str, str | int | float | bool | None] | None = Field(
        default=None, description="Plugin configuration"
    )

    # Services
    services: list[type[Service]] | None = Field(
        default=None, description="Service classes to register"
    )

    # Component type definitions
    component_types: list[ComponentTypeDefinition] | None = Field(
        default=None, alias="componentTypes", description="Entity component definitions"
    )

    # Optional plugin features
    actions: list[Action] | None = Field(default=None, description="Actions to register")
    providers: list[Provider] | None = Field(default=None, description="Providers to register")
    evaluators: list[Evaluator] | None = Field(default=None, description="Evaluators to register")
    adapter: IDatabaseAdapter | None = Field(default=None, description="Database adapter")
    models: dict[str, Callable[[IAgentRuntime, dict[str, Any]], Awaitable[Any]]] | None = Field(
        default=None, description="Model handlers by model type"
    )
    streaming_models: dict[str, StreamingModelHandler] | None = Field(
        default=None,
        alias="streamingModels",
        description="Streaming model handlers by model type",
    )
    events: PluginEvents | None = Field(default=None, description="Event handlers by event type")
    routes: list[Route] | None = Field(default=None, description="HTTP routes to register")
    tests: list[TestSuite] | None = Field(default=None, description="Test suites")

    dependencies: list[str] | None = Field(default=None, description="Plugin dependencies")
    test_dependencies: list[str] | None = Field(
        default=None, alias="testDependencies", description="Test dependencies"
    )
    priority: int | None = Field(default=None, description="Plugin priority")
    schema_def: dict[str, Any] | None = Field(
        default=None, alias="schema", description="Plugin schema"
    )

    model_config = {"populate_by_name": True, "arbitrary_types_allowed": True}


class ProjectAgent(BaseModel):
    """Agent configuration within a project."""

    character: Character = Field(..., description="Agent character")
    init: Callable[[IAgentRuntime], Awaitable[None]] | None = Field(
        default=None, description="Agent initialization function"
    )
    plugins: list[Plugin] | None = Field(default=None, description="Agent-specific plugins")
    tests: TestSuite | list[TestSuite] | None = Field(default=None, description="Agent tests")

    model_config = {"arbitrary_types_allowed": True}


class Project(BaseModel):
    agents: list[ProjectAgent] = Field(..., description="Project agents")

    model_config = {"arbitrary_types_allowed": True}
