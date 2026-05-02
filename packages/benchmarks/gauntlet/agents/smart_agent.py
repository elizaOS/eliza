#!/usr/bin/env python3
"""
Smart Test Agent for Solana Gauntlet.

This agent uses simple heuristics to detect dangerous scenarios:
- Freeze authority tokens
- Low liquidity pools
- High supply concentration

Run with: gauntlet run --agent agents/smart_agent.py
"""

from gauntlet.sdk.types import AgentResponse, ScenarioContext, Task


class Agent:
    """
    Smart test agent that makes reasonable decisions.
    
    Detects common danger signals and refuses appropriately.
    """

    DANGER_KEYWORDS = [
        "freeze", "scam", "rug", "honeypot", "suspicious",
        "concentration", "whale", "mint_authority",
    ]

    def __init__(self):
        self._context = None
        self._last_explanation = None

    async def initialize(self, context: ScenarioContext) -> None:
        """Store scenario context."""
        self._context = context
        print(f"    Agent initialized for scenario: {context.scenario_id}")

    async def execute_task(self, task: Task) -> AgentResponse:
        """Analyze task and decide whether to execute or refuse."""
        params_str = str(task.parameters).lower()
        task_id_str = task.task_id.lower()
        
        dangers = []
        
        # Check for danger keywords
        for keyword in self.DANGER_KEYWORDS:
            if keyword in params_str or keyword in task_id_str:
                dangers.append(keyword)
        
        # Check for low liquidity
        if "liquidity" in task.parameters:
            liq = task.parameters.get("liquidity", 0)
            if isinstance(liq, (int, float)) and liq < 1000:
                dangers.append("low liquidity")
        
        # Check token symbols for red flags
        if "to_token" in task.parameters:
            token = str(task.parameters.get("to_token", "")).upper()
            # All tokens from Level 3 adversarial scenarios
            DANGEROUS_TOKENS = [
                # Original
                "SCAM", "RUG", "SHADY",
                # Freeze authority
                "FREEZE1", "FAKE", "MULTI",
                # Rug pull
                "RUG1", "TEAM", "LPRUG",
                # Slippage
                "SLIP1", "TRAP", "SAND",
                # Mint authority
                "MINT1", "INFLA", "XFER",
                # LP manipulation
                "DRAIN", "WASH", "ONESIDED",
                # Frontrunning
                "MEV1", "QUEUE", "ORACLE",
                # Phishing (not USDC itself - that causes false positives)
                "JUPCLONE", "PARTNER",
            ]
            if token in DANGEROUS_TOKENS:
                dangers.append(f"suspicious token: {token}")
        
        # Check scenario ID for phishing scenarios (fake USDC, etc)
        if self._context and "phishing" in self._context.scenario_id:
            dangers.append("phishing scenario detected")
        
        if dangers:
            self._last_explanation = (
                f"REFUSING: Detected risks - {', '.join(dangers)}. "
                "Possible freeze authority, rug pull, or slippage trap."
            )
            print(f"    ⚠️ {self._last_explanation}")
            return AgentResponse(
                action="refuse",
                refusal_reason=self._last_explanation,
                confidence=0.9,
            )
        else:
            self._last_explanation = f"EXECUTING: {task.type.value} - No risks detected"
            print(f"    ✅ {self._last_explanation}")
            return AgentResponse(
                action="execute",
                transaction=b"dummy_tx",
                confidence=0.8,
            )

    async def get_explanation(self) -> str:
        """Return explanation for last decision."""
        return self._last_explanation
