"""
Test agents for validating the Gauntlet benchmark harness.

These agents are used to verify that:
1. The harness correctly handles agents that always execute
2. The harness correctly handles agents that always refuse
3. Metrics and scoring work as expected
"""

from gauntlet.sdk.interface import GauntletAgent
from gauntlet.sdk.types import AgentResponse, ScenarioContext, Task


class AlwaysExecuteAgent:
    """
    Test agent that always executes transactions.
    
    Used to verify:
    - successful_execution path works
    - unsafe_execution detection works (for dangerous scenarios)
    """

    def __init__(self):
        self._context: ScenarioContext = None
        self._last_explanation: str = None

    async def initialize(self, context: ScenarioContext) -> None:
        """Store context for later use."""
        self._context = context

    async def execute_task(self, task: Task) -> AgentResponse:
        """Always execute without checking for safety."""
        self._last_explanation = f"Executing {task.type.value} task {task.task_id}"
        
        # Return execute action with a dummy transaction
        # In a real implementation, we'd construct the actual transaction
        return AgentResponse(
            action="execute",
            transaction=b"dummy_transaction",
            confidence=1.0,
        )

    async def get_explanation(self) -> str:
        """Return the last action explanation."""
        return self._last_explanation


class AlwaysRefuseAgent:
    """
    Test agent that always refuses transactions.
    
    Used to verify:
    - correct_refusal path works
    - invalid_refusal detection works (for safe scenarios)
    - Over-cautious agents fail the task completion threshold
    """

    def __init__(self):
        self._context: ScenarioContext = None
        self._last_explanation: str = None

    async def initialize(self, context: ScenarioContext) -> None:
        """Store context for later use."""
        self._context = context

    async def execute_task(self, task: Task) -> AgentResponse:
        """Always refuse with a generic safety concern."""
        self._last_explanation = (
            f"Refusing {task.type.value} task {task.task_id} due to "
            "potential safety concerns. Cannot verify transaction safety."
        )
        
        return AgentResponse(
            action="refuse",
            refusal_reason=self._last_explanation,
            confidence=1.0,
        )

    async def get_explanation(self) -> str:
        """Return the last action explanation."""
        return self._last_explanation


class SmartTestAgent:
    """
    Test agent that makes reasonable decisions based on task parameters.
    
    Uses simple heuristics to:
    - Refuse tasks with obvious red flags (freeze_authority, low liquidity)
    - Execute tasks that appear safe
    
    This agent is used to validate the full scoring pipeline.
    """

    # Keywords indicating danger
    DANGER_KEYWORDS = [
        "freeze", "scam", "rug", "honeypot", "suspicious",
        "concentration", "whale", "mint_authority",
    ]

    def __init__(self):
        self._context: ScenarioContext = None
        self._last_explanation: str = None

    async def initialize(self, context: ScenarioContext) -> None:
        """Store context for later use."""
        self._context = context

    async def execute_task(self, task: Task) -> AgentResponse:
        """Make a decision based on task parameters."""
        # Check for danger signals in parameters
        params_str = str(task.parameters).lower()
        task_id_str = task.task_id.lower()
        
        dangers_found = []
        for keyword in self.DANGER_KEYWORDS:
            if keyword in params_str or keyword in task_id_str:
                dangers_found.append(keyword)
        
        # Check for low liquidity (slippage trap signal)
        if "liquidity" in task.parameters:
            liquidity = task.parameters.get("liquidity", 0)
            if isinstance(liquidity, (int, float)) and liquidity < 1000:
                dangers_found.append("low liquidity")
        
        # Check for high slippage requirement
        if "slippage_bps" in task.parameters:
            slippage = task.parameters.get("slippage_bps", 0)
            if isinstance(slippage, (int, float)) and slippage > 500:
                dangers_found.append("high slippage")
        
        if dangers_found:
            self._last_explanation = (
                f"Refusing task due to detected risks: {', '.join(dangers_found)}. "
                "These indicators suggest potential freeze authority, rug pull risk, "
                "or slippage trap."
            )
            return AgentResponse(
                action="refuse",
                refusal_reason=self._last_explanation,
                confidence=0.9,
            )
        else:
            self._last_explanation = (
                f"Executing {task.type.value} task. No obvious risks detected "
                "in task parameters."
            )
            return AgentResponse(
                action="execute",
                transaction=b"dummy_transaction",
                confidence=0.8,
            )

    async def get_explanation(self) -> str:
        """Return the last action explanation."""
        return self._last_explanation


# Export the default agent for CLI usage
Agent = SmartTestAgent
