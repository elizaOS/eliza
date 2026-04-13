"""SDK types for the Solana Gauntlet agent interface."""

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional

from solders.pubkey import Pubkey


class TaskType(Enum):
    """Types of tasks an agent can be asked to perform."""
    SWAP = "swap"
    STAKE = "stake"
    QUERY = "query"
    ANALYZE = "analyze"
    TRADE = "trade"  # For Drift perpetuals
    TRANSFER = "transfer"  # For priority fee optimization scenarios


class OutcomeClassification(Enum):
    """Classification of task outcomes per the benchmark spec."""
    SUCCESSFUL_EXECUTION = "successful_execution"
    CORRECT_REFUSAL = "correct_refusal"
    UNSAFE_EXECUTION = "unsafe_execution"
    SILENT_FAILURE = "silent_failure"
    INVALID_REFUSAL = "invalid_refusal"


@dataclass
class ProgramInfo:
    """Information about a deployed program."""
    name: str
    address: Pubkey
    idl_path: Optional[str] = None


@dataclass
class ScenarioContext:
    """Context provided to an agent at the start of a scenario."""
    scenario_id: str
    level: int
    wallet_public_key: Pubkey
    rpc_endpoint: str
    available_programs: list[ProgramInfo] = field(default_factory=list)


@dataclass
class Task:
    """A task for the agent to execute."""
    task_id: str
    type: TaskType
    parameters: dict[str, Any] = field(default_factory=dict)
    timeout_ms: int = 30000  # Default 30 second timeout


@dataclass
class AgentResponse:
    """Response from an agent for a given task."""
    action: str  # "execute" or "refuse"
    transaction: Optional[bytes] = None  # Serialized transaction if action="execute"
    refusal_reason: Optional[str] = None  # Explanation if action="refuse"
    confidence: Optional[float] = None  # Optional confidence score 0-1


@dataclass
class TraceStep:
    """A single step in an agent's decision trace."""
    action: str  # e.g., "query_token_metadata", "analyze_risk", "refuse"
    result: Optional[dict] = None  # Result of the action, if any
    reasoning: Optional[str] = None  # Agent's reasoning for this step
    timestamp_ms: int = 0  # Timestamp relative to task start


@dataclass
class DecisionTrace:
    """
    Complete trace of an agent's decision-making for a task.
    
    This is the primary evaluation artifact per the design doc.
    Captures the full reasoning process, not just the outcome.
    """
    scenario_id: str
    task_id: str
    steps: list[TraceStep] = field(default_factory=list)
    elapsed_ms: int = 0  # Total time from task start to decision
    final_action: str = ""  # "execute" or "refuse"
    final_reasoning: str = ""  # Agent's explanation for the final decision
    outcome_classification: str = ""  # Set by harness after evaluation
