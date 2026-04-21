"""Provider implementations for orchestrated GAIA benchmark."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import TYPE_CHECKING

_ROOT = Path(__file__).resolve().parents[4]
_ORCH_PKG = _ROOT / "plugins" / "plugin-agent-orchestrator" / "python"
if _ORCH_PKG.exists() and str(_ORCH_PKG) not in sys.path:
    sys.path.insert(0, str(_ORCH_PKG))

from elizaos_plugin_agent_orchestrator import (
    AgentProviderId,
    OrchestratedTask,
    ProviderTaskExecutionContext,
    TaskResult,
)

from elizaos_gaia.agent import GAIAAgent
from elizaos_gaia.types import GAIAConfig, GAIALevel, GAIAQuestion

if TYPE_CHECKING:
    from elizaos.runtime import AgentRuntime


class BaseGAIAProvider:
    """Base GAIA provider backed by GAIAAgent."""

    def __init__(
        self,
        provider_id: str,
        label: str,
        runtime: AgentRuntime | None,
        config: GAIAConfig,
    ) -> None:
        self._id = provider_id
        self._label = label
        self._agent = GAIAAgent(config, runtime)

    @property
    def id(self) -> AgentProviderId:
        return self._id

    @property
    def label(self) -> str:
        return self._label

    @property
    def capabilities(self) -> list[str]:
        return [
            "research.web_search",
            "research.web_browse",
            "research.docs_lookup",
            "research.code_exec",
        ]

    def _parse_question(self, task: OrchestratedTask) -> GAIAQuestion:
        raw = task.description.strip()
        payload: dict[str, object] = {}
        if raw.startswith("{"):
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict):
                    payload = parsed
            except json.JSONDecodeError:
                payload = {}

        question_text = str(payload.get("question") or raw)
        task_id = str(payload.get("task_id") or task.id or "unknown-task")
        level_raw = str(payload.get("level") or "1")
        try:
            level = GAIALevel(level_raw)
        except ValueError:
            level = GAIALevel.LEVEL_1
        final_answer = str(payload.get("final_answer") or "")
        file_name = payload.get("file_name")
        file_name_str = str(file_name) if isinstance(file_name, str) else None
        file_path_raw = payload.get("file_path")
        file_path = None
        if isinstance(file_path_raw, str) and file_path_raw.strip():
            file_path = Path(file_path_raw)
        return GAIAQuestion(
            task_id=task_id,
            question=question_text,
            level=level,
            final_answer=final_answer,
            file_name=file_name_str,
            file_path=file_path,
        )

    async def execute_task(
        self,
        task: OrchestratedTask,
        ctx: ProviderTaskExecutionContext,
    ) -> TaskResult:
        question = self._parse_question(task)
        await ctx.append_output(f"Starting {self.label} on {question.task_id}")
        await ctx.update_progress(5)

        started = time.time()
        result = await self._agent.solve(question)
        elapsed_ms = (time.time() - started) * 1000

        await ctx.update_progress(100)
        await ctx.append_output(f"Predicted answer: {result.predicted_answer}")

        tool_names = [tool.value for tool in result.tools_used]
        return TaskResult(
            success=bool(result.predicted_answer),
            summary=(
                f"{self.label} answered {question.task_id} in "
                f"{elapsed_ms:.1f}ms"
            ),
            error=result.error,
            extra={
                "predicted_answer": result.predicted_answer,
                "token_usage": result.token_usage,
                "latency_ms": result.latency_ms,
                "tool_names": tool_names,
                "question_task_id": question.task_id,
                "question_level": question.level.value,
            },
        )


class ClaudeCodeGAIAProvider(BaseGAIAProvider):
    def __init__(self, runtime: AgentRuntime | None, config: GAIAConfig) -> None:
        super().__init__("claude-code", "Claude Code", runtime, config)


class SWEAgentGAIAProvider(BaseGAIAProvider):
    def __init__(self, runtime: AgentRuntime | None, config: GAIAConfig) -> None:
        super().__init__("swe-agent", "SWE-Agent", runtime, config)


class CodexGAIAProvider(BaseGAIAProvider):
    def __init__(self, runtime: AgentRuntime | None, config: GAIAConfig) -> None:
        super().__init__("codex", "Codex", runtime, config)
