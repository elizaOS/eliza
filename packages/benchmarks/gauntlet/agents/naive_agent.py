#!/usr/bin/env python3
"""
Naive Agent - Appears competent but fails Level 3 adversarial tests.

This agent:
- ✅ Correctly handles Level 0 (PDA derivation, queries)
- ✅ Correctly executes Level 1 (basic swaps)
- ❌ FAILS Level 3 (executes honeypots without checking metadata)

The agent looks "smart" - it analyzes parameters and makes decisions.
But it doesn't check freeze authority, liquidity concentration, or slippage traps.

This is the "competent but dangerous" agent profile that Gauntlet catches.

Run with: gauntlet run --agent agents/naive_agent.py
"""

from gauntlet.sdk.types import AgentResponse, ScenarioContext, Task, TaskType


class Agent:
    """
    Naive agent that appears competent but fails adversarial safety tests.
    
    This demonstrates why basic task-completion benchmarks are insufficient.
    """

    def __init__(self):
        self.context = None
        self.last_task = None

    async def initialize(self, context: ScenarioContext) -> None:
        self.context = context
        print(f"    🤖 NaiveAgent initialized for scenario: {context.scenario_id}")

    async def execute_task(self, task: Task) -> AgentResponse:
        self.last_task = task
        
        # Level 0: Query/analyze tasks - handle correctly
        if task.type == TaskType.QUERY:
            return self._handle_query(task)
        
        # Level 1 & 2: Swap/trade tasks - execute without safety checks
        if task.type in (TaskType.SWAP, TaskType.TRADE):
            return self._handle_swap(task)
        
        # Default: execute
        return AgentResponse(
            action="execute",
            transaction=b"naive_tx",
            confidence=0.8,
        )

    def _handle_query(self, task: Task) -> AgentResponse:
        """Handle query tasks correctly - this is where the agent looks competent."""
        print(f"    🤖 Analyzing {task.parameters.get('action', 'query')}...")
        return AgentResponse(
            action="execute",
            transaction=None,  # Queries don't need transactions
            confidence=0.95,
        )

    def _handle_swap(self, task: Task) -> AgentResponse:
        """
        Execute swap without safety checks.
        
        This is the CRITICAL FAILURE POINT:
        - Agent sees swap parameters
        - Agent builds transaction
        - Agent DOES NOT check:
          - Freeze authority on destination token
          - Liquidity concentration (rug pull risk)
          - Actual slippage vs stated slippage
        """
        from_token = task.parameters.get("from_token", "SOL")
        to_token = task.parameters.get("to_token", "???")
        amount = task.parameters.get("amount", 0)
        
        print(f"    🤖 Executing swap: {amount} {from_token} → {to_token}")
        
        # THE BUG: We check nothing about the destination token
        # A real safe agent would:
        #   1. Fetch token metadata
        #   2. Check freeze authority
        #   3. Analyze holder concentration
        #   4. Verify pool liquidity depth
        
        return AgentResponse(
            action="execute",
            transaction=b"naive_swap_tx",
            confidence=0.85,
        )

    async def get_explanation(self) -> str:
        if not self.last_task:
            return "No task executed yet."
        
        if self.last_task.type == TaskType.QUERY:
            return "I analyzed the request and provided the information."
        
        if self.last_task.type == TaskType.SWAP:
            return (
                "I executed the swap as requested. "
                "The parameters looked valid so I proceeded."
            )
        
        return "Task completed based on provided parameters."
