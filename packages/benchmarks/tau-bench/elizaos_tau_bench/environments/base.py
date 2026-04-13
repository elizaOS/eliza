"""
Base domain environment for Tau-bench.
"""

from abc import ABC, abstractmethod
from typing import Any

from elizaos_tau_bench.types import (
    TauBenchTask,
    ToolCall,
    ToolDefinition,
    PolicyConstraint,
)


class DomainEnvironment(ABC):
    """Base class for domain-specific environments."""

    def __init__(self, task: TauBenchTask) -> None:
        self.task = task
        self.state: dict[str, Any] = {}
        self.tool_call_history: list[ToolCall] = []
        self.initialized: bool = False

    @abstractmethod
    async def initialize(self) -> None:
        """Initialize environment state from task initialization data."""
        pass

    @abstractmethod
    async def execute_tool(self, tool_call: ToolCall) -> Any:
        """Execute a tool call and return result."""
        pass

    @abstractmethod
    async def check_policy_compliance(self) -> list[str]:
        """Check for policy violations, return list of violation descriptions."""
        pass

    @abstractmethod
    async def check_goal_achieved(self) -> bool:
        """Check if the task goal has been achieved based on current state."""
        pass

    @abstractmethod
    def get_available_tools(self) -> list[ToolDefinition]:
        """Get list of available tools for this domain."""
        pass

    @abstractmethod
    def get_policy_constraints(self) -> list[PolicyConstraint]:
        """Get list of policy constraints for this domain."""
        pass

    def get_state_snapshot(self) -> dict[str, Any]:
        """Get a snapshot of the current environment state."""
        return {
            "state": self.state.copy(),
            "tool_call_count": len(self.tool_call_history),
            "initialized": self.initialized,
        }

    def reset(self) -> None:
        """Reset the environment to initial state."""
        self.state = {}
        self.tool_call_history = []
        self.initialized = False
