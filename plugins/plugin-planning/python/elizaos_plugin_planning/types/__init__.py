"""Type definitions for the Planning Plugin."""

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional
from uuid import UUID


class MessageClassification(Enum):
    """Classification of incoming messages."""

    SIMPLE = "simple"
    STRATEGIC = "strategic"
    CAPABILITY_REQUEST = "capability_request"
    RESEARCH_NEEDED = "research_needed"


@dataclass
class StrategySpec:
    """Strategy specification for planning."""

    goal: str
    requirements: list[str]
    constraints: dict[str, Any]
    expected_outcome: str


@dataclass
class ExecutionStep:
    """Execution step in a plan."""

    id: str
    action: str
    inputs: dict[str, Any]
    dependencies: list[str]
    optional: bool = False


@dataclass
class ExecutionDAG:
    """Directed Acyclic Graph representation for plan execution."""

    steps: list[ExecutionStep]
    edges: list[tuple[str, str]]
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class ExecutionResult:
    """Execution result from a plan run."""

    dag_id: str
    status: str  # 'pending' | 'running' | 'completed' | 'failed' | 'aborted'
    completed_steps: list[str]
    failed_steps: list[str]
    results: dict[str, Any]
    errors: dict[str, str]


@dataclass
class RequiredCapability:
    """Required capability for a plan."""

    type: str  # 'action' | 'provider' | 'service' | 'model'
    name: str
    description: Optional[str] = None
    required: bool = True


@dataclass
class CapabilityGap:
    """Gap in capabilities identified during planning."""

    capability: RequiredCapability
    suggestions: list[str]
    can_generate: bool


@dataclass
class GenerationMethod:
    """Method for generating missing capabilities."""

    type: str  # 'plugin' | 'mcp' | 'n8n' | 'custom'
    confidence: float
    estimated_time: float


@dataclass
class RetryPolicy:
    """Retry policy for action steps."""

    max_retries: int = 2
    backoff_ms: int = 1000
    backoff_multiplier: float = 2.0
    on_error: str = "abort"  # 'abort' | 'continue' | 'skip'


@dataclass
class PlanningConfig:
    """Configuration for the planning service."""

    max_steps: int = 10
    default_timeout_ms: int = 60000
    execution_model: str = "sequential"  # 'sequential' | 'parallel' | 'dag'
    enable_adaptation: bool = True
    retry_policy: RetryPolicy = field(default_factory=RetryPolicy)


@dataclass
class ClassificationResult:
    """Result from message classification."""

    classification: str
    confidence: float
    complexity: str
    planning_type: str
    planning_required: bool
    capabilities: list[str] = field(default_factory=list)
    stakeholders: list[str] = field(default_factory=list)
    constraints: list[str] = field(default_factory=list)
    dependencies: list[str] = field(default_factory=list)


@dataclass
class ActionStep:
    """Step in an action plan."""

    id: UUID
    action_name: str
    parameters: dict[str, Any]
    dependencies: list[UUID] = field(default_factory=list)
    retry_policy: Optional[RetryPolicy] = None
    on_error: Optional[str] = None


@dataclass
class ActionPlan:
    """Complete action plan."""

    id: UUID
    goal: str
    steps: list[ActionStep]
    execution_model: str
    status: str = "pending"
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class PlanExecutionResult:
    """Result from plan execution."""

    plan_id: UUID
    success: bool
    completed_steps: int
    total_steps: int
    results: list[dict[str, Any]]
    errors: Optional[list[Exception]] = None
    duration: float = 0.0
    adaptations: Optional[list[str]] = None





