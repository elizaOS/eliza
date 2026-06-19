"""
Web Browsing (Mind2Web) environment adapter for AgentBench.

Mind2Web (`Deng et al., 2023 <https://arxiv.org/abs/2306.06070>`_) tests
the agent's ability to pick the correct next action from a flattened
HTML page + candidate set. The full dataset (HTML traces and
top-K element scores) is large and is served via the local
``packages/benchmarks/mind2web`` adapter.

This AgentBench adapter:

- Loads Mind2Web prompt fixtures via
  ``upstream_loader.load_web_browsing_tasks``.
- Delegates the actual agent loop to ``benchmarks.mind2web`` when
  available. If the package or the dataset is unavailable, it returns
  a "skipped" result with instructions.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from elizaos_agentbench.adapters.base import EnvironmentAdapter
from elizaos_agentbench.types import (
    AgentBenchEnvironment,
    AgentBenchTask,
    AgentRuntimeProtocol,
    EnvironmentConfig,
    ObservationType,
)
from elizaos_agentbench.upstream_loader import UPSTREAM_DATA

logger = logging.getLogger(__name__)

StepInfoType = dict[str, str | int | float | bool | None]


class WebBrowsingAdapter(EnvironmentAdapter):
    """Mind2Web adapter.

    For the simple per-prompt scoring mode (multiple choice over the
    candidate set in the prompt body), this adapter is fully
    self-contained: we extract the correct option letter from the
    upstream prompt fixture's *next* message (the assistant reply that
    upstream uses as the gold label) and check that the agent's
    response begins with that letter.

    For full dataset evaluation across the Mind2Web HTML traces,
    callers should use ``packages/benchmarks/mind2web`` directly.
    """

    environment = AgentBenchEnvironment.WEB_BROWSING

    def __init__(
        self,
        runtime: AgentRuntimeProtocol | None = None,
        config: EnvironmentConfig | None = None,
    ) -> None:
        super().__init__(runtime, config)
        self._prompt_pairs: list[dict[str, str]] = []
        self._last_prompt: str = ""
        self._gold_letter: str = ""
        self._submitted_letter: str = ""

    async def initialize(self) -> None:
        if self._initialized:
            return
        # Load the upstream prompt fixture once and pair user/assistant turns.
        prompt_file: Path = UPSTREAM_DATA / "mind2web" / "prompt" / "llm_prompt.json"
        if prompt_file.exists():
            try:
                raw = json.loads(prompt_file.read_text(encoding="utf-8"))
                pairs: list[dict[str, str]] = []
                pending_user: str | None = None
                for entry in raw if isinstance(raw, list) else []:
                    if not isinstance(entry, dict):
                        continue
                    role = entry.get("role", "")
                    content = entry.get("content", "")
                    if role == "user" and isinstance(content, str):
                        pending_user = content
                    elif role == "assistant" and isinstance(content, str) and pending_user:
                        pairs.append({"user": pending_user, "assistant": content})
                        pending_user = None
                self._prompt_pairs = pairs
            except Exception as e:
                logger.warning(f"[Mind2Web] Failed to load prompt fixture: {e}")
        else:
            logger.info(f"[Mind2Web] Prompt fixture missing: {prompt_file}")
        self._initialized = True

    async def reset(self, task: AgentBenchTask) -> ObservationType:
        idx_raw = (
            task.initial_state.get("prompt_index") if isinstance(task.initial_state, dict) else None
        )
        idx = idx_raw if isinstance(idx_raw, int) else 0
        if 0 <= idx < len(self._prompt_pairs):
            pair = self._prompt_pairs[idx]
            self._last_prompt = pair["user"]
            self._gold_letter = self._extract_gold_letter(pair["assistant"])
        else:
            prompt = task.metadata.get("prompt") if isinstance(task.metadata, dict) else None
            gold = task.metadata.get("gold_letter") if isinstance(task.metadata, dict) else None
            self._last_prompt = prompt if isinstance(prompt, str) and prompt else task.description
            self._gold_letter = gold if isinstance(gold, str) else ""
        self._submitted_letter = ""
        return {
            "prompt": self._last_prompt,
            "task_description": task.description,
        }

    async def step(self, action: str) -> tuple[ObservationType, float, bool, StepInfoType]:
        # Mind2Web is single-turn: the agent submits a letter, we score it.
        letter = self._extract_letter(action)
        self._submitted_letter = letter
        correct = bool(self._gold_letter and letter and letter.upper() == self._gold_letter.upper())
        reward = 1.0 if correct else 0.0
        return (
            {"submitted": letter, "gold": self._gold_letter, "correct": correct},
            reward,
            True,
            {"correct": correct},
        )

    async def evaluate(self, task: AgentBenchTask, trajectory: list[str]) -> bool:
        if not self._gold_letter:
            return False
        return bool(self._submitted_letter) and self._submitted_letter.upper() == self._gold_letter.upper()

    async def cleanup(self) -> None:
        self._initialized = False

    def get_action_space(self) -> list[str]:
        return ["A", "B", "C", "D", "E", "F"]

    def format_prompt(self, task: AgentBenchTask, observation: ObservationType) -> str:
        prompt = observation.get("prompt") or self._last_prompt or task.description
        return (
            f"{prompt}\n\n"
            "Reply with only the letter of the correct choice (A, B, C, ...)."
        )

    def parse_action(self, response: str) -> str:
        return self._extract_letter(response)

    @staticmethod
    def _extract_letter(text: str) -> str:
        if not text:
            return ""
        s = text.strip()
        m = re.match(r"^\s*([A-Z])\b", s, re.IGNORECASE)
        if m:
            return m.group(1).upper()
        m = re.search(r"\bAnswer\s*[:=]\s*([A-Z])\b", s, re.IGNORECASE)
        if m:
            return m.group(1).upper()
        return ""

    @staticmethod
    def _extract_gold_letter(assistant_reply: str) -> str:
        if not assistant_reply:
            return ""
        # Upstream's gold reply format is typically "Answer: X" or
        # "Element: ... \nAction: ... X". Heuristically extract.
        for pattern in (r"Answer\s*[:=]?\s*([A-Z])\b", r"^\s*([A-Z])\b"):
            m = re.search(pattern, assistant_reply, re.IGNORECASE | re.MULTILINE)
            if m:
                return m.group(1).upper()
        return ""
