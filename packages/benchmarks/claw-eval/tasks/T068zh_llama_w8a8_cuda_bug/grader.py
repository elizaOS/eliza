"""T42_llama_w8a8_cuda_bug grader — judge + anchor scoring."""

from __future__ import annotations

import re
from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class LlamaCudaBugGrader(AbstractGrader):
    """Grade LLaMA W8A8 CUDA kernel bug review."""

    ANCHOR_GROUPS = [
        [r"int8.*overflow", r"int8_t.*溢出", r"累加器.*溢出", r"accumulator.*overflow"],
        [r"int32", r"int32_t"],
        [r"per.?tensor", r"逐张量"],
        [r"outlier", r"离群值", r"异常值"],
        [r"per.?channel", r"per.?token", r"逐通道", r"逐token"],
        [r"coalesce", r"合并访问", r"非合并"],
        [r"shared\s*memory", r"共享内存"],
        [r"tiling", r"分块"],
        [r"tensor\s*core"],
        [r"bank\s*conflict"],
        [r"roofline", r"memory.?bound", r"算术强度"],
        [r"ldmatrix|cp\.async|async\s*copy"],
        [r"row\s*<\s*M", r"边界.*检查", r"boundary.*check"],
    ]

    def grade(
        self,
        messages: list[TraceMessage],
        dispatches: list[ToolDispatch],
        task: TaskDefinition,
        audit_data: dict[str, dict] | None = None,
        judge: Any | None = None,
        media_events: list[MediaLoad] | None = None,
        env_snapshot: dict | None = None,
    ) -> DimensionScores:
        scores = DimensionScores()
        scores.safety = 1.0

        final_text = self._get_final_assistant_text(messages)
        all_text = self._get_all_assistant_text(messages)
        anchor_score = self._anchor_coverage_score(all_text)

        # Search effort: web_search + web_fetch + sandbox usage
        search_calls = [d for d in dispatches if d.tool_name == "web_search" and d.response_status < 400]
        unique_searches = len({d.request_body.get("query", "") for d in search_calls})
        fetch_calls_count = len([d for d in dispatches if d.tool_name == "web_fetch" and d.response_status < 400])
        sandbox_calls = len([d for d in dispatches if d.tool_name == "Bash" and d.response_status < 400])
        tool_effort = min((unique_searches + fetch_calls_count + sandbox_calls) / 2, 1.0)

        judged = judge.evaluate(
            task.prompt.text,
            self.format_conversation(messages),
            self.summarize_actions(audit_data),
            task.judge_rubric,
        ).score
        scores.completion = round(min(1.0, 0.70 * judged + 0.30 * tool_effort), 2)

        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len([m for m in messages if m.message.role == "assistant"])
        return scores

    def _anchor_coverage_score(self, text: str) -> float:
        text_l = text.lower()
        covered = 0
        for group in self.ANCHOR_GROUPS:
            if any(re.search(pattern, text_l) for pattern in group):
                covered += 1
        return covered / len(self.ANCHOR_GROUPS)
