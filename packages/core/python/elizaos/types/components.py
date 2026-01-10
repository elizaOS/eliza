"""
Component types for elizaOS.

This module defines types for Actions, Providers, Evaluators, and related components.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, Field

from elizaos.types.memory import Memory
from elizaos.types.primitives import Content

if TYPE_CHECKING:
    from elizaos.types.runtime import IAgentRuntime
    from elizaos.types.state import State


class ActionExample(BaseModel):
    """Example content with associated user for demonstration purposes."""

    name: str = Field(..., description="User associated with the example")
    content: Content = Field(..., description="Content of the example")

    model_config = {"populate_by_name": True}


class ActionResult(BaseModel):
    """Result returned by an action after execution."""

    text: str | None = Field(default=None, description="Optional text description of the result")
    values: dict[str, Any] | None = Field(
        default=None, description="Values to merge into the state"
    )
    data: dict[str, Any] | None = Field(
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
        """Get a specific previous result by action name.
        
        Searches through previous_results for a result where the action name
        matches the provided action_name. Action names are stored in result.data.actionName.
        
        Args:
            action_name: The name of the action to find results for
            
        Returns:
            The first matching ActionResult, or None if no match is found
        """
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
    """Multi-step action plan information."""

    total_steps: int = Field(..., alias="totalSteps", description="Total number of steps")
    current_step: int = Field(
        ..., alias="currentStep", description="Current step being executed (1-based)"
    )
    steps: list[ActionPlanStepInfo] = Field(
        ..., description="Array of action steps with status tracking"
    )
    thought: str = Field(..., description="AI's reasoning for this execution plan")

    model_config = {"populate_by_name": True}


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

    model_config = {"populate_by_name": True, "extra": "allow"}


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


class Action(BaseModel):
    """Represents an action the agent can perform."""

    name: str = Field(..., description="Action name")
    description: str = Field(..., description="Detailed description")
    similes: list[str] | None = Field(default=None, description="Similar action descriptions")
    examples: list[list[ActionExample]] | None = Field(default=None, description="Example usages")
    handler: Handler = Field(..., description="Handler function")
    validate_fn: Validator = Field(..., alias="validate", description="Validation function")

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
    """Result returned by a provider."""

    text: str | None = Field(
        default=None, description="Human-readable text for LLM prompt inclusion"
    )
    values: dict[str, Any] | None = Field(
        default=None, description="Key-value pairs for template variable substitution"
    )
    data: dict[str, Any] | None = Field(
        default=None, description="Structured data for programmatic access"
    )

    model_config = {"populate_by_name": True}


# Provider get function type
ProviderGet = Callable[
    ["IAgentRuntime", Memory, "State"],
    Awaitable[ProviderResult],
]


class Provider(BaseModel):
    """Provider for external data/services."""

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
