#!/usr/bin/env python3
"""
ElizaOS-Powered Agent for the Solana Gauntlet.

Uses the FULL ElizaOS message processing pipeline to analyze Solana DeFi
scenarios and make safety decisions. This is the canonical way to integrate
an ElizaOS agent with the Gauntlet benchmark.

The agent:
1. Receives scenario context (wallet, RPC, programs) via initialize()
2. For each task, runs the full ElizaOS pipeline (providers → LLM → actions)
3. The GAUNTLET provider injects task details and safety checklist
4. The LLM analyzes risks and selects GAUNTLET_DECISION action
5. Returns execute/refuse with explanation and confidence

Requirements:
    pip install elizaos elizaos-plugin-openai
    export OPENAI_API_KEY=...

Usage:
    gauntlet run --agent agents/eliza_agent.py
    gauntlet run --agent agents/eliza_agent.py --mock
"""

from gauntlet.sdk.types import AgentResponse, ScenarioContext, Task


class Agent:
    """
    ElizaOS-powered agent for the Solana Gauntlet.

    Implements the GauntletAgent protocol by delegating to an
    ElizaGauntletHarness that runs the full ElizaOS message pipeline.

    The runtime is lazily initialized on the first call to initialize()
    so that the module can be imported without requiring elizaos to be
    installed (the gauntlet CLI loads agents via importlib).
    """

    def __init__(self) -> None:
        self._harness: object | None = None
        self._last_explanation: str | None = None
        self._initialized = False
        print("    [ElizaOS Agent] Created (runtime will initialize on first scenario)")

    async def initialize(self, context: ScenarioContext) -> None:
        """
        Initialize agent with scenario context.

        On the first call, sets up the full ElizaOS runtime with:
        - Bootstrap plugin (core capabilities)
        - OpenAI plugin (model provider)
        - Gauntlet plugin (GAUNTLET provider + GAUNTLET_DECISION action)
        - Gauntlet-optimized character (Solana safety analyzer)
        - In-memory database adapter
        """
        if not self._initialized:
            print("    [ElizaOS Agent] Initializing ElizaOS runtime...")
            try:
                from gauntlet.eliza_harness import ElizaGauntletHarness

                harness = ElizaGauntletHarness()
                await harness.setup_runtime()
                self._harness = harness
                self._initialized = True
                print("    [ElizaOS Agent] Runtime ready")
            except ImportError as e:
                raise RuntimeError(
                    f"ElizaOS packages not available: {e}\n"
                    "Install with: pip install elizaos elizaos-plugin-openai"
                ) from e

        # Update scenario context for subsequent tasks
        # (safe to cast — we know the type from the guard above)
        from gauntlet.eliza_harness import ElizaGauntletHarness

        harness: ElizaGauntletHarness = self._harness  # type: ignore[assignment]
        harness.set_scenario_context(context)
        print(f"    [ElizaOS Agent] Scenario: {context.scenario_id} (level {context.level})")

    async def execute_task(self, task: Task) -> AgentResponse:
        """
        Execute a task through the full ElizaOS pipeline.

        The pipeline:
        1. GAUNTLET provider injects task context + safety checklist
        2. LLM analyzes risks via messageHandlerTemplate
        3. LLM selects GAUNTLET_DECISION action with execute/refuse
        4. Action handler queues the decision
        5. Harness reads the decision and returns AgentResponse
        """
        if self._harness is None:
            raise RuntimeError("Agent not initialized — call initialize() first")

        from gauntlet.eliza_harness import ElizaGauntletHarness

        harness: ElizaGauntletHarness = self._harness  # type: ignore[assignment]
        response, explanation = await harness.execute_task(task)
        self._last_explanation = explanation

        icon = "EXECUTE" if response.action == "execute" else "REFUSE"
        print(f"    [ElizaOS Agent] {icon}: {explanation[:80] if explanation else 'no reason'}")

        return response

    async def get_explanation(self) -> str:
        """Return explanation for the last decision."""
        return self._last_explanation or "No decision made yet"
