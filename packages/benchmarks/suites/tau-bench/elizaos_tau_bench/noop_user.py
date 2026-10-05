"""A non-LLM user simulator used for ``--mock`` smoke runs.

Returns the task instruction once on reset, then ``###STOP###`` on every step.
Lets the harness exercise the upstream Env without any LLM calls.
"""

from __future__ import annotations

from typing import Optional

from elizaos_tau_bench.upstream.envs.user import BaseUserSimulationEnv


class NoopUserSimulationEnv(BaseUserSimulationEnv):
    def __init__(self) -> None:
        self.instruction = ""

    def reset(self, instruction: Optional[str] = None) -> str:
        self.instruction = instruction or ""
        return self.instruction

    def step(self, content: str) -> str:
        return "###STOP###"

    def get_total_cost(self) -> float:
        return 0.0


__all__ = ["NoopUserSimulationEnv"]
