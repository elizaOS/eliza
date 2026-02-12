"""
Trajectory Schema Definitions

Provides strict schema validation for trajectories to ensure data integrity
between TypeScript trajectory generation and Python training pipeline.

This module catches schema drift early and provides clear error messages
when data doesn't match expectations.
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple, Union
import json
import logging

logger = logging.getLogger(__name__)


# ============================================================================
# Step Schemas
# ============================================================================

@dataclass
class EnvironmentStateSchema:
    """Schema for step environment state"""
    agent_balance: float = 0.0
    agent_pnl: float = 0.0
    agent_points: int = 0
    open_positions: int = 0
    timestamp: Optional[int] = None
    
    # Optional reputation/influence fields
    reputation_delta: Optional[int] = None
    followers_gained: Optional[int] = None
    positive_reactions: Optional[int] = None
    information_spread: Optional[int] = None
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "EnvironmentStateSchema":
        """Create from dictionary with field name normalization"""
        return cls(
            agent_balance=data.get("agentBalance", data.get("agent_balance", 0.0)),
            agent_pnl=data.get("agentPnL", data.get("agent_pnl", 0.0)),
            agent_points=data.get("agentPoints", data.get("agent_points", 0)),
            open_positions=data.get("openPositions", data.get("open_positions", 0)),
            timestamp=data.get("timestamp"),
            reputation_delta=data.get("reputationDelta", data.get("reputation_delta")),
            followers_gained=data.get("followersGained", data.get("followers_gained")),
            positive_reactions=data.get("positiveReactions", data.get("positive_reactions")),
            information_spread=data.get("informationSpread", data.get("information_spread")),
        )


@dataclass
class ActionParametersSchema:
    """Schema for action parameters"""
    # Trading parameters
    ticker: Optional[str] = None
    amount: Optional[float] = None
    leverage: Optional[float] = None
    confidence: Optional[float] = None
    market_id: Optional[str] = None
    
    # Social parameters
    target_user_id: Optional[str] = None
    recipient_id: Optional[str] = None
    message: Optional[str] = None
    
    # Archetype (for batch recording mode)
    archetype: Optional[str] = None
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ActionParametersSchema":
        """Create from dictionary"""
        return cls(
            ticker=data.get("ticker"),
            amount=data.get("amount", data.get("size", data.get("quantity"))),
            leverage=data.get("leverage"),
            confidence=data.get("confidence"),
            market_id=data.get("marketId", data.get("market")),
            target_user_id=data.get("targetUserId"),
            recipient_id=data.get("recipientId"),
            message=data.get("message"),
            archetype=data.get("archetype"),
        )


@dataclass
class ActionResultSchema:
    """Schema for action result"""
    position_id: Optional[str] = None
    pnl: Optional[float] = None
    success: bool = True
    error: Optional[str] = None
    archetype: Optional[str] = None
    
    # Prediction-specific
    correct: Optional[bool] = None
    prediction_correct: Optional[bool] = None
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ActionResultSchema":
        """Create from dictionary"""
        return cls(
            position_id=data.get("positionId"),
            pnl=data.get("pnl"),
            success=data.get("success", True),
            error=data.get("error"),
            archetype=data.get("archetype"),
            correct=data.get("correct"),
            prediction_correct=data.get("predictionCorrect"),
        )


@dataclass
class ActionSchema:
    """Schema for trajectory action"""
    action_type: str
    parameters: ActionParametersSchema = field(default_factory=ActionParametersSchema)
    success: bool = True
    result: ActionResultSchema = field(default_factory=ActionResultSchema)
    reasoning: Optional[str] = None
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ActionSchema":
        """Create from dictionary with field name normalization"""
        return cls(
            action_type=data.get("actionType", data.get("action_type", "unknown")),
            parameters=ActionParametersSchema.from_dict(data.get("parameters", {})),
            success=data.get("success", True),
            result=ActionResultSchema.from_dict(data.get("result", {})),
            reasoning=data.get("reasoning"),
        )


@dataclass
class LLMCallSchema:
    """Schema for LLM call within a step"""
    model: str
    purpose: str = "action"
    system_prompt: Optional[str] = None
    user_prompt: Optional[str] = None
    response: Optional[str] = None
    reasoning: Optional[str] = None
    temperature: float = 0.7
    max_tokens: int = 1000
    latency_ms: Optional[int] = None
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "LLMCallSchema":
        """Create from dictionary with field name normalization"""
        return cls(
            model=data.get("model", "unknown"),
            purpose=data.get("purpose", "action"),
            system_prompt=data.get("systemPrompt", data.get("system_prompt")),
            user_prompt=data.get("userPrompt", data.get("user_prompt")),
            response=data.get("response"),
            reasoning=data.get("reasoning"),
            temperature=data.get("temperature", 0.7),
            max_tokens=data.get("maxTokens", data.get("max_tokens", 1000)),
            latency_ms=data.get("latencyMs", data.get("latency_ms")),
        )


@dataclass
class StepSchema:
    """Schema for a single trajectory step"""
    step_number: int
    timestamp: Optional[int] = None
    environment_state: EnvironmentStateSchema = field(default_factory=EnvironmentStateSchema)
    action: ActionSchema = field(default_factory=lambda: ActionSchema(action_type="unknown"))
    llm_calls: List[LLMCallSchema] = field(default_factory=list)
    reward: float = 0.0
    observation: Optional[Dict[str, Any]] = None
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "StepSchema":
        """Create from dictionary with field name normalization"""
        llm_calls_raw = data.get("llmCalls", data.get("llm_calls", []))
        llm_calls = [LLMCallSchema.from_dict(call) for call in llm_calls_raw]
        
        return cls(
            step_number=data.get("stepNumber", data.get("step_number", 0)),
            timestamp=data.get("timestamp"),
            environment_state=EnvironmentStateSchema.from_dict(
                data.get("environmentState", data.get("environment_state", {}))
            ),
            action=ActionSchema.from_dict(data.get("action", {})),
            llm_calls=llm_calls,
            reward=data.get("reward", 0.0),
            observation=data.get("observation"),
        )


# ============================================================================
# Trajectory Schema
# ============================================================================

@dataclass
class TrajectorySchema:
    """Schema for a complete trajectory"""
    trajectory_id: str
    agent_id: str
    window_id: str
    scenario_id: Optional[str] = None
    archetype: Optional[str] = None
    steps_json: str = "[]"
    final_pnl: float = 0.0
    final_balance: Optional[float] = None
    episode_length: int = 0
    total_reward: float = 0.0
    trades_executed: int = 0
    is_training_data: bool = True
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "TrajectorySchema":
        """Create from dictionary with field name normalization"""
        return cls(
            trajectory_id=data.get("trajectoryId", data.get("trajectory_id", "")),
            agent_id=data.get("agentId", data.get("agent_id", "")),
            window_id=data.get("windowId", data.get("window_id", "")),
            scenario_id=data.get("scenarioId", data.get("scenario_id")),
            archetype=data.get("archetype"),
            steps_json=data.get("stepsJson", data.get("steps_json", "[]")),
            final_pnl=float(data.get("finalPnL", data.get("final_pnl", 0.0))),
            final_balance=data.get("finalBalance", data.get("final_balance")),
            episode_length=data.get("episodeLength", data.get("episode_length", 0)),
            total_reward=float(data.get("totalReward", data.get("total_reward", 0.0))),
            trades_executed=data.get("tradesExecuted", data.get("trades_executed", 0)),
            is_training_data=data.get("isTrainingData", data.get("is_training_data", True)),
        )
    
    def get_steps(self) -> List[StepSchema]:
        """Parse and return steps as StepSchema objects"""
        try:
            steps_raw = json.loads(self.steps_json)
            return [StepSchema.from_dict(step) for step in steps_raw]
        except json.JSONDecodeError:
            return []
    
    def extract_archetype_from_steps(self) -> Optional[str]:
        """Extract archetype from step action parameters if not set at trajectory level"""
        if self.archetype:
            return self.archetype
        
        steps = self.get_steps()
        for step in steps:
            if step.action.parameters.archetype:
                return step.action.parameters.archetype
            if step.action.result.archetype:
                return step.action.result.archetype
        
        return None


# ============================================================================
# Validation Functions
# ============================================================================

def validate_trajectory(data: Dict[str, Any]) -> Tuple[bool, List[str]]:
    """
    Validate trajectory data against schema.
    
    Returns:
        Tuple of (is_valid, list of error messages)
    """
    errors = []
    
    # Required fields
    required_fields = ["trajectoryId", "agentId", "windowId"]
    for field_name in required_fields:
        snake_case = _camel_to_snake(field_name)
        if field_name not in data and snake_case not in data:
            errors.append(f"Missing required field: {field_name}")
    
    # Validate stepsJson if present
    steps_json = data.get("stepsJson", data.get("steps_json", "[]"))
    if steps_json:
        try:
            steps = json.loads(steps_json)
            if not isinstance(steps, list):
                errors.append(f"stepsJson must be an array, got {type(steps).__name__}")
            elif len(steps) == 0:
                errors.append("stepsJson is empty - trajectory has no steps")
            else:
                for i, step in enumerate(steps):
                    step_errors = _validate_step(step, i)
                    errors.extend(step_errors)
        except json.JSONDecodeError as e:
            errors.append(f"Invalid JSON in stepsJson: {e}")
    
    # Validate numeric fields
    pnl = data.get("finalPnL", data.get("final_pnl"))
    if pnl is not None:
        try:
            float(pnl)
        except (TypeError, ValueError):
            errors.append(f"finalPnL must be a number, got {type(pnl).__name__}")
    
    episode_length = data.get("episodeLength", data.get("episode_length"))
    if episode_length is not None:
        if not isinstance(episode_length, int) or episode_length < 0:
            errors.append("episodeLength must be a non-negative integer")
    
    return len(errors) == 0, errors


def _validate_step(step: Dict[str, Any], index: int) -> List[str]:
    """Validate a single step"""
    errors = []
    prefix = f"Step {index}"
    
    # stepNumber should exist
    if "stepNumber" not in step and "step_number" not in step:
        errors.append(f"{prefix}: missing stepNumber")
    
    # action should exist and have actionType
    action = step.get("action", {})
    if not action:
        errors.append(f"{prefix}: missing action")
    elif "actionType" not in action and "action_type" not in action:
        errors.append(f"{prefix}: action missing actionType")
    
    # environmentState should exist
    env_state = step.get("environmentState", step.get("environment_state"))
    if not env_state:
        errors.append(f"{prefix}: missing environmentState")
    
    return errors


def validate_step(data: Dict[str, Any]) -> Tuple[bool, List[str]]:
    """
    Validate step data against schema.
    
    Returns:
        Tuple of (is_valid, list of error messages)
    """
    errors = _validate_step(data, 0)
    return len(errors) == 0, errors


def validate_llm_call(data: Dict[str, Any]) -> Tuple[bool, List[str]]:
    """
    Validate LLM call data against schema.
    
    Returns:
        Tuple of (is_valid, list of error messages)
    """
    errors = []
    
    if "model" not in data:
        errors.append("LLM call missing 'model' field")
    
    return len(errors) == 0, errors


def _camel_to_snake(name: str) -> str:
    """Convert camelCase to snake_case"""
    result = []
    for i, char in enumerate(name):
        if char.isupper() and i > 0:
            result.append("_")
        result.append(char.lower())
    return "".join(result)


# ============================================================================
# Schema Comparison
# ============================================================================

def compare_trajectory_formats(
    json_data: Dict[str, Any],
    db_data: Dict[str, Any],
) -> Tuple[bool, List[str]]:
    """
    Compare trajectory data from JSON and database formats.
    
    Returns:
        Tuple of (are_equivalent, list of difference descriptions)
    """
    differences = []
    
    # Map of JSON field names to DB field names
    field_mapping = {
        "trajectoryId": "trajectoryId",
        "agentId": "agentId",
        "windowId": "windowId",
        "scenarioId": "scenarioId",
        "archetype": "archetype",
        "stepsJson": "stepsJson",
        "finalPnL": "finalPnL",
        "episodeLength": "episodeLength",
    }
    
    for json_field, db_field in field_mapping.items():
        json_val = json_data.get(json_field)
        db_val = db_data.get(db_field)
        
        if json_val != db_val:
            # Special handling for numeric comparison
            if isinstance(json_val, (int, float)) and isinstance(db_val, (int, float)):
                if abs(float(json_val) - float(db_val)) < 0.001:
                    continue  # Close enough
            
            differences.append(f"{json_field}: JSON={json_val!r}, DB={db_val!r}")
    
    return len(differences) == 0, differences


# ============================================================================
# Export Validation Results
# ============================================================================

@dataclass
class ValidationResult:
    """Result of schema validation"""
    is_valid: bool
    errors: List[str]
    warnings: List[str] = field(default_factory=list)
    
    def __bool__(self) -> bool:
        return self.is_valid


def validate_trajectory_file(file_path: str) -> ValidationResult:
    """
    Validate a trajectory JSON file.
    
    Args:
        file_path: Path to JSON file
        
    Returns:
        ValidationResult with validation status and any errors/warnings
    """
    errors = []
    warnings = []
    
    try:
        with open(file_path, "r") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        return ValidationResult(False, [f"Invalid JSON: {e}"])
    except FileNotFoundError:
        return ValidationResult(False, [f"File not found: {file_path}"])
    
    # Check for trajectory wrapper
    if "trajectory" not in data:
        warnings.append("Missing 'trajectory' wrapper - treating root as trajectory data")
        traj_data = data
    else:
        traj_data = data["trajectory"]
    
    # Validate trajectory
    is_valid, traj_errors = validate_trajectory(traj_data)
    errors.extend(traj_errors)
    
    # Check for archetype
    archetype = traj_data.get("archetype")
    if not archetype:
        # Try to find in steps
        steps_json = traj_data.get("stepsJson", "[]")
        try:
            steps = json.loads(steps_json)
            found_archetype = False
            for step in steps:
                params = step.get("action", {}).get("parameters", {})
                if params.get("archetype"):
                    found_archetype = True
                    break
            if not found_archetype:
                warnings.append("No archetype found at trajectory or step level - will use 'default'")
        except json.JSONDecodeError:
            pass  # Already caught above
    
    return ValidationResult(
        is_valid=len(errors) == 0,
        errors=errors,
        warnings=warnings,
    )

