from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, TypeAlias

from elizaos.types.generated.eliza.v1 import components_pb2
from elizaos.types.primitives import Content

if TYPE_CHECKING:
    from elizaos.types.memory import Memory
    from elizaos.types.runtime import IAgentRuntime
    from elizaos.types.state import State

JsonPrimitive: TypeAlias = str | int | float | bool | None

# Proto-backed data types
ActionExample = components_pb2.ActionExample
ActionParameterSchema = components_pb2.ActionParameterSchema
ActionParameter = components_pb2.ActionParameter
ActionParameters = components_pb2.ActionParameters
ActionResult = components_pb2.ActionResult
ActionContext = components_pb2.ActionContext
HandlerOptions = components_pb2.HandlerOptions
ProviderResult = components_pb2.ProviderResult
EvaluationExample = components_pb2.EvaluationExample

# Runtime handler signatures (not in proto)
HandlerCallback = Callable[[Content], Awaitable[list["Memory"]]]
StreamChunkCallback = Callable[[str, str | None], Awaitable[None]]

Handler = Callable[
    [
        "IAgentRuntime",
        "Memory",
        "State | None",
        HandlerOptions | None,
        HandlerCallback | None,
        "list[Memory] | None",
    ],
    Awaitable[ActionResult | None],
]

Validator = Callable[["IAgentRuntime", "Memory", "State | None"], Awaitable[bool]]


class ActionDefinition:  # runtime interface
    """Definition for an action that can be executed by the agent."""

    name: str
    description: str
    handler: Handler
    validate: Validator
    similes: list[str] | None
    examples: list[list[ActionExample]] | None
    priority: int | None
    tags: list[str] | None
    parameters: list[ActionParameter] | None

    def __init__(
        self,
        name: str,
        description: str,
        handler: Handler,
        validate: Validator,
        similes: list[str] | None = None,
        examples: list[list[ActionExample]] | None = None,
        priority: int | None = None,
        tags: list[str] | None = None,
        parameters: list[ActionParameter] | None = None,
    ) -> None:
        self.name = name
        self.description = description
        self.handler = handler
        self.validate = validate
        self.similes = similes
        self.examples = examples
        self.priority = priority
        self.tags = tags
        self.parameters = parameters


class EvaluatorDefinition:  # runtime interface
    """Definition for an evaluator that processes agent responses."""

    always_run: bool | None
    description: str
    similes: list[str] | None
    examples: list[EvaluationExample]
    handler: Handler
    name: str
    validate: Validator

    def __init__(
        self,
        name: str,
        description: str,
        handler: Handler,
        validate: Validator,
        examples: list[EvaluationExample] | None = None,
        similes: list[str] | None = None,
        always_run: bool | None = None,
    ) -> None:
        self.name = name
        self.description = description
        self.handler = handler
        self.validate = validate
        self.examples = examples or []
        self.similes = similes
        self.always_run = always_run


class ProviderDefinition:  # runtime interface
    """Definition for a context provider that supplies information to the agent."""

    name: str
    description: str | None
    dynamic: bool | None
    position: int | None
    private: bool | None
    get: Callable[[IAgentRuntime, Memory, State], Awaitable[ProviderResult]]

    def __init__(
        self,
        name: str,
        get: Callable[[IAgentRuntime, Memory, State], Awaitable[ProviderResult]],
        description: str | None = None,
        dynamic: bool | None = None,
        position: int | None = None,
        private: bool | None = None,
    ) -> None:
        self.name = name
        self.get = get
        self.description = description
        self.dynamic = dynamic
        self.position = position
        self.private = private


Action = ActionDefinition
Evaluator = EvaluatorDefinition
Provider = ProviderDefinition

__all__ = [
    "Action",
    "Evaluator",
    "Provider",
    "ActionExample",
    "ActionParameterSchema",
    "ActionParameter",
    "ActionParameters",
    "ActionResult",
    "ActionContext",
    "HandlerOptions",
    "ProviderResult",
    "EvaluationExample",
    "Handler",
    "Validator",
    "HandlerCallback",
    "StreamChunkCallback",
    "JsonPrimitive",
]
