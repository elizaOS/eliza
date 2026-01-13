from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, TypeAlias

from pydantic import BaseModel, Field

from elizaos.types.memory import Memory
from elizaos.types.primitives import Content

if TYPE_CHECKING:
    from elizaos.types.runtime import IAgentRuntime
    from elizaos.types.state import State


JsonPrimitive: TypeAlias = str | int | float | bool | None


class ActionExample(BaseModel):
    """Example content with associated user for demonstration purposes."""

    name: str = Field(..., description="User associated with the example")
    content: Content = Field(..., description="Content of the example")

    model_config = {"populate_by_name": True}


class ActionResult(BaseModel):
    text: str | None = Field(default=None, description="Optional text description of the result")
    values: dict[str, object] | None = Field(
        default=None, description="Values to merge into the state"
    )
    data: dict[str, object] | None = Field(
        default=None, description="Data payload containing action-specific results"
    )
    success: bool = Field(..., description="Whether the action succeeded")
    error: str | None = Field(default=None, description="Error message if the action failed")

    model_config = {"populate_by_name": True}


class ActionContext(BaseModel):
    """Context provided to actions during execution."""

    previous_results: list[ActionResult] = Field(
        ..., alias="previousResults", description="Results from previously executed actions"
    )

    model_config = {"populate_by_name": True}

    def get_previous_result(self, action_name: str) -> ActionResult | None:
        for result in self.previous_results:
            if result.data and isinstance(result.data, dict):
                stored_action_name = result.data.get("actionName")
                if stored_action_name == action_name:
                    return result
        return None


class ActionPlanStepInfo(BaseModel):
    """Information about an action step in a plan."""

    action: str = Field(..., description="Action name")
    status: str = Field(..., description="Step status: 'pending', 'completed', or 'failed'")
    result: ActionResult | None = Field(default=None, description="Step result")
    error: str | None = Field(default=None, description="Error if step failed")


class ActionPlanInfo(BaseModel):
    total_steps: int = Field(..., alias="totalSteps", description="Total number of steps")
    current_step: int = Field(
        ..., alias="currentStep", description="Current step being executed (1-based)"
    )
    steps: list[ActionPlanStepInfo] = Field(
        ..., description="Array of action steps with status tracking"
    )
    thought: str = Field(..., description="AI's reasoning for this execution plan")

    model_config = {"populate_by_name": True}


# Stream chunk callback type
StreamChunkCallback = Callable[[str, str | None], Awaitable[None] | None]


class HandlerOptions(BaseModel):
    """Options passed to action handlers during execution."""

    action_context: ActionContext | None = Field(
        default=None,
        alias="actionContext",
        description="Context with previous action results",
    )
    action_plan: ActionPlanInfo | None = Field(
        default=None,
        alias="actionPlan",
        description="Multi-step action plan information",
    )
    on_stream_chunk: StreamChunkCallback | None = Field(
        default=None,
        alias="onStreamChunk",
        description="Optional stream chunk callback for streaming responses",
        exclude=True,  # Don't serialize the callback
    )
    parameters: dict[str, object] | None = Field(
        default=None,
        description="Validated input parameters extracted from conversation",
    )
    parameter_errors: list[str] | None = Field(
        default=None,
        alias="parameterErrors",
        description="Parameter validation errors (if extraction/validation was incomplete)",
    )

    model_config = {"populate_by_name": True, "extra": "allow", "arbitrary_types_allowed": True}


# Type aliases for handler and validator functions
HandlerCallback = Callable[[Content], Awaitable[list[Memory]]]

Handler = Callable[
    [
        "IAgentRuntime",
        Memory,
        "State | None",
        HandlerOptions | None,
        HandlerCallback | None,
        list[Memory] | None,
    ],
    Awaitable[ActionResult | None],
]

Validator = Callable[
    ["IAgentRuntime", Memory, "State | None"],
    Awaitable[bool],
]


class ActionParameterSchema(BaseModel):
    type: str = Field(..., description="JSON Schema type (string, number, boolean, object, array)")
    description: str | None = Field(default=None, description="Description for LLM guidance")
    default: str | int | float | bool | None = Field(
        default=None, description="Default value if parameter is not provided"
    )
    enum: list[str] | None = Field(
        default=None, description="Allowed values for enum-style parameters"
    )
    properties: dict[str, ActionParameterSchema] | None = Field(
        default=None, description="For object types, define nested properties"
    )
    items: ActionParameterSchema | None = Field(
        default=None, description="For array types, define the item schema"
    )
    minimum: int | float | None = Field(default=None, description="Minimum value for numbers")
    maximum: int | float | None = Field(default=None, description="Maximum value for numbers")
    pattern: str | None = Field(default=None, description="Pattern for string validation (regex)")

    model_config = {"populate_by_name": True, "extra": "allow"}


class ActionParameter(BaseModel):
    """Defines a single parameter for an action."""

    name: str = Field(..., description="Parameter name (used as key in parameters object)")
    description: str = Field(..., description="Human-readable description for LLM guidance")
    required: bool | None = Field(default=None, description="Whether this parameter is required")
    examples: list[object] | None = Field(
        default=None, description="Optional example values for this parameter"
    )
    schema_def: ActionParameterSchema = Field(
        ..., alias="schema", description="JSON Schema for parameter validation"
    )

    model_config = {"populate_by_name": True}


ActionParameters: TypeAlias = dict[str, object]


class Action(BaseModel):
    name: str = Field(..., description="Action name")
    description: str = Field(..., description="Detailed description")
    similes: list[str] | None = Field(default=None, description="Similar action descriptions")
    examples: list[list[ActionExample]] | None = Field(default=None, description="Example usages")
    handler: Handler = Field(..., description="Handler function")
    validate_fn: Validator = Field(..., alias="validate", description="Validation function")
    priority: int | None = Field(default=None, description="Optional priority for action ordering")
    tags: list[str] | None = Field(default=None, description="Optional tags for categorization")
    parameters: list[ActionParameter] | None = Field(
        default=None, description="Optional input parameters extracted by LLM"
    )

    model_config = {"populate_by_name": True, "extra": "allow", "arbitrary_types_allowed": True}


class EvaluationExample(BaseModel):
    """Example for evaluating agent behavior."""

    prompt: str = Field(..., description="Evaluation context")
    messages: list[ActionExample] = Field(..., description="Example messages")
    outcome: str = Field(..., description="Expected outcome")

    model_config = {"populate_by_name": True}


class Evaluator(BaseModel):
    """Evaluator for assessing agent responses."""

    name: str = Field(..., description="Evaluator name")
    description: str = Field(..., description="Detailed description")
    always_run: bool | None = Field(
        default=None,
        alias="alwaysRun",
        description="Whether to always run even if agent didn't respond",
    )
    similes: list[str] | None = Field(default=None, description="Similar evaluator descriptions")
    examples: list[EvaluationExample] = Field(..., description="Example evaluations")
    handler: Handler = Field(..., description="Handler function")
    validate_fn: Validator = Field(..., alias="validate", description="Validation function")

    model_config = {"populate_by_name": True, "arbitrary_types_allowed": True}


class ProviderResult(BaseModel):
    text: str | None = Field(
        default=None, description="Human-readable text for LLM prompt inclusion"
    )
    values: dict[str, object] | None = Field(
        default=None, description="Key-value pairs for template variable substitution"
    )
    data: dict[str, object] | None = Field(
        default=None, description="Structured data for programmatic access"
    )

    model_config = {"populate_by_name": True}


# Provider get function type
ProviderGet = Callable[
    ["IAgentRuntime", Memory, "State"],
    Awaitable[ProviderResult],
]


class Provider(BaseModel):
    name: str = Field(..., description="Provider name")
    description: str | None = Field(default=None, description="Description of the provider")
    dynamic: bool | None = Field(default=None, description="Whether the provider is dynamic")
    position: int | None = Field(default=None, description="Position in the provider list")
    private: bool | None = Field(
        default=None,
        description="Whether the provider is private (not in regular provider list)",
    )
    get: ProviderGet = Field(..., description="Data retrieval function")

    model_config = {"populate_by_name": True, "arbitrary_types_allowed": True}
