from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from elizaos.types.components import ActionResult


class ActionPlanStep(BaseModel):
    action: str = Field(..., description="Action name")
    status: str = Field(..., description="Step status: 'pending', 'completed', or 'failed'")
    error: str | None = Field(default=None, description="Error message if failed")
    result: ActionResult | None = Field(default=None, description="Step result")

    model_config = {"populate_by_name": True}


class ActionPlan(BaseModel):
    thought: str = Field(..., description="AI's reasoning for this plan")
    total_steps: int = Field(..., alias="totalSteps", description="Total number of steps")
    current_step: int = Field(..., alias="currentStep", description="Current step being executed")
    steps: list[ActionPlanStep] = Field(..., description="Array of action steps")

    model_config = {"populate_by_name": True}


class WorkingMemoryEntry(BaseModel):
    action_name: str = Field(
        ..., alias="actionName", description="Name of action that created entry"
    )
    result: ActionResult = Field(..., description="Result from the action execution")
    timestamp: int = Field(..., description="Timestamp when the entry was created")

    model_config = {"populate_by_name": True}


class StateData(BaseModel):
    room: dict[str, Any] | None = Field(default=None, description="Cached room data from providers")
    world: dict[str, Any] | None = Field(
        default=None, description="Cached world data from providers"
    )
    entity: dict[str, Any] | None = Field(
        default=None, description="Cached entity data from providers"
    )
    providers: dict[str, dict[str, Any]] | None = Field(
        default=None, description="Provider results cache keyed by provider name"
    )
    action_plan: ActionPlan | None = Field(
        default=None,
        alias="actionPlan",
        description="Current action plan for multi-step actions",
    )
    action_results: list[ActionResult] | None = Field(
        default=None,
        alias="actionResults",
        description="Results from previous action executions",
    )
    working_memory: dict[str, WorkingMemoryEntry] | None = Field(
        default=None,
        alias="workingMemory",
        description="Working memory for temporary state during multi-step action execution",
    )

    model_config = {"populate_by_name": True, "extra": "allow"}


class State(BaseModel):
    values: dict[str, Any] = Field(
        default_factory=dict,
        description="Key-value store for general state variables",
    )
    data: StateData = Field(
        default_factory=StateData,
        description="Structured data cache with typed properties",
    )
    text: str = Field(
        default="",
        description="String representation of the current context",
    )

    model_config = {"populate_by_name": True, "extra": "allow"}
