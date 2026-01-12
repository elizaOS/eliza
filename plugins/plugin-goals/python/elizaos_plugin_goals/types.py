from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field


class GoalStatus(str, Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class GoalOwnerType(str, Enum):
    AGENT = "agent"
    ENTITY = "entity"


class Goal(BaseModel):
    id: str
    agent_id: str
    owner_type: GoalOwnerType
    owner_id: str
    name: str
    description: str | None = None
    is_completed: bool = False
    completed_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
    metadata: dict[str, object] = Field(default_factory=dict)
    tags: list[str] = Field(default_factory=list)


class GoalTag(BaseModel):
    id: str
    goal_id: str
    tag: str
    created_at: datetime


class CreateGoalParams(BaseModel):
    agent_id: str
    owner_type: GoalOwnerType
    owner_id: str
    name: str
    description: str | None = None
    metadata: dict[str, object] = Field(default_factory=dict)
    tags: list[str] = Field(default_factory=list)


class UpdateGoalParams(BaseModel):
    name: str | None = None
    description: str | None = None
    is_completed: bool | None = None
    completed_at: datetime | None = None
    metadata: dict[str, object] | None = None
    tags: list[str] | None = None


class GoalFilters(BaseModel):
    owner_type: GoalOwnerType | None = None
    owner_id: str | None = None
    is_completed: bool | None = None
    tags: list[str] | None = None


class ExtractedGoalInfo(BaseModel):
    name: str
    description: str | None = None
    owner_type: GoalOwnerType = GoalOwnerType.ENTITY


class SimilarityCheckResult(BaseModel):
    has_similar: bool
    similar_goal_name: str | None = None
    confidence: int = 0


class GoalSelectionResult(BaseModel):
    goal_id: str | None = None
    goal_name: str | None = None
    is_found: bool = False


class ConfirmationResult(BaseModel):
    is_confirmation: bool
    should_proceed: bool
    modifications: str | None = None
