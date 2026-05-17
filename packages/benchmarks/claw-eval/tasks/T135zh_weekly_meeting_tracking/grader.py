"""T135zh_weekly_meeting_tracking grader — calendar + notes + todo."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class WeeklyMeetingTrackingGrader(AbstractGrader):
    """Grader for T170zh: track action items from weekly meetings against todos.

    Scoring design:
    - Tool usage is a prerequisite gate.
    - LLM judge evaluates tracking accuracy, gap identification, and report structure.
    """

    ALL_NOTES = {"NOTE-501", "NOTE-502", "NOTE-503"}

    _TRACKING_RUBRIC = """\
评估行动项状态追踪的准确性（0.0-1.0）。

## 8个行动项的正确状态
NOTE-501(产品周会3/16):
1. 王明-需求排序 → TODO-501 completed ✓
2. 李华-微服务评估 → TODO-502 in_progress ⚠
3. 赵蕾-客户反馈 → TODO-503 completed ✓

NOTE-502(技术评审3/18):
4. 李华-API网关设计 → TODO-504 in_progress ⚠
5. 马强-压力测试 → TODO-505 completed ✓
6. 周明-前端优化 → TODO-506 pending(已逾期3/24截止) ✗

NOTE-503(客户进展3/20):
7. 赵蕾-鼎新合同 → TODO-507 pending ⚠
8. 王明-万通POC → 无对应待办（遗漏）✗

## 统计: completed=3, in_progress=2, pending=2, 遗漏=1

## 严格评分
- 0.9-1.0: 8个行动项状态全部正确追踪
- 0.7-0.8: 6-7个正确
- 0.4-0.6: 4-5个正确
- 0.0-0.3: 不足4个
"""

    _GAP_RUBRIC = """\
评估对遗漏和逾期项的识别（0.0-1.0）。

## 必须识别的问题
1. 遗漏：行动项8(王明-万通POC,截止3/27)在待办中不存在 → 需要补建待办
2. 逾期：TODO-506(周明-前端优化)截止3/24但状态仍为pending → 已逾期
3. 接近截止：TODO-502,504,507截止3/25 → 需关注

## 严格评分
- 0.9-1.0: 遗漏+逾期都识别，并给出建议
- 0.6-0.8: 识别了1个问题
- 0.3-0.5: 注意到有问题但不够明确
- 0.0-0.2: 未识别
"""

    _REPORT_RUBRIC = """\
评估报告的结构（0.0-1.0）。

## 合格报告应包含
1. 按会议分组的行动项清单
2. 每项的状态和负责人
3. 总体完成率(3/8=37.5%)
4. 遗漏和逾期标注
5. 下周重点关注事项

## 严格评分
- 0.9-1.0: 5项全含
- 0.6-0.8: 3-4项
- 0.3-0.5: 1-2项
- 0.0-0.2: 无结构
"""

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

        # --- Tool usage gate ---
        notes_read = {d.request_body.get("note_id") for d in dispatches if d.tool_name == "notes_get" and d.response_status < 400}
        todo_calls = [d for d in dispatches if d.tool_name in ("todo_list_tasks", "todo_get_task") and d.response_status < 400]

        tool_penalty = 1.0
        if len(notes_read) < 2:
            tool_penalty *= 0.5
        if len(todo_calls) < 1:
            tool_penalty *= 0.6

        # --- LLM judge scoring ---
        completion = 0.0
        if judge:
            conversation = self.format_conversation(messages)
            try:
                result = judge.evaluate(task.prompt.text, conversation, "", self._TRACKING_RUBRIC)
                completion += 0.35 * result.score
                print(f"[grader] tracking: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] tracking judge failed: {e}")
            try:
                result = judge.evaluate(task.prompt.text, conversation, "", self._GAP_RUBRIC)
                completion += 0.35 * result.score
                print(f"[grader] gap: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] gap judge failed: {e}")
            try:
                result = judge.evaluate(task.prompt.text, conversation, "", self._REPORT_RUBRIC)
                completion += 0.30 * result.score
                print(f"[grader] report: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] report judge failed: {e}")

        completion *= tool_penalty
        scores.completion = min(round(completion, 4), 1.0)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len([m for m in messages if m.message.role == "assistant"])
        return scores
