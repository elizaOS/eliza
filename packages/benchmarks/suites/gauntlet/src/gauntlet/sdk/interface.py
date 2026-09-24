"""Agent interface protocol for the Solana Gauntlet."""

from typing import Protocol, Optional, runtime_checkable

from gauntlet.sdk.types import AgentResponse, ScenarioContext, Task


@runtime_checkable
class GauntletAgent(Protocol):
    """
    Protocol that all benchmark agents must implement.
    
    The interface is intentionally minimal to avoid constraining agent design.
    Agents are responsible for all decision-making logic.
    """

    async def initialize(self, context: ScenarioContext) -> None:
        """
        Called once per scenario with context about the environment.
        
        Args:
            context: Information about the scenario, wallet, and available programs.
        """
        ...

    async def execute_task(self, task: Task) -> AgentResponse:
        """
        Called for each task the agent must complete or refuse.
        
        Args:
            task: The task to execute, including type, parameters, and timeout.
            
        Returns:
            AgentResponse indicating action (execute/refuse) and relevant data.
        """
        ...

    async def get_explanation(self) -> Optional[str]:
        """
        Optional: Retrieve the agent's explanation for its last action.
        
        For adversarial scenarios, explanations are evaluated for the presence
        of correct causal factors (e.g., freeze authority, supply concentration).
        
        Returns:
            Explanation string or None if not applicable.
        """
        ...
