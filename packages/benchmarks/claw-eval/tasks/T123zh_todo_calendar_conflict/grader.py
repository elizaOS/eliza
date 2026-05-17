"""T123zh_todo_calendar_conflict grader — todo + calendar conflict detection."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class TodoCalendarConflictGrader(AbstractGrader):
    """Grader for T158zh: detect conflicts between todo deadlines and calendar events.

    Scoring design:
    - Tool usage is a prerequisite gate.
    - LLM judge evaluates conflict detection, resolution quality, and plan completeness.
    - Agent must find all 3 conflict groups and propose viable rescheduling.
    """

    _CONFLICT_RUBRIC = """\
评估助手对待办-日历冲突的识别准确性（0.0-1.0）。

## 必须识别的3组冲突

冲突1 — 3/27全天培训(9:00-17:00)：
- TODO-301 Q1总结报告(high) due 3/27 → 全天被占，无法完成
- TODO-304 回复供应商报价(medium) due 3/27 → 同样无法完成
- 严重性：高（2个待办，其中1个high优先级）

冲突2 — 3/28下午大会(14:00-17:00)：
- TODO-302 提交预算审批表(high) due 3/28 → 下午被占，仅上午可用
- TODO-307 阅读技术文章(low) due 3/28 → 次要冲突
- 严重性：中（上午3小时可以完成预算审批表）

冲突3 — 3/30全天出差：
- TODO-303 准备客户PPT(high) due 3/30 → 全天出差无法做PPT
- 严重性：高（PPT必须提前完成）

## 严格评分
- 0.9-1.0: 3组冲突全部正确识别，优先级标注清楚
- 0.7-0.8: 3组识别但缺少细节
- 0.4-0.6: 识别了2组
- 0.0-0.3: 识别不足2组
"""

    _RESOLUTION_RUBRIC = """\
评估重排建议的合理性和可行性（0.0-1.0）。

## 合理的重排方案
1. TODO-301(Q1报告,4h,high) → 移至3/26完成
2. TODO-304(供应商报价,2h,medium) → 移至3/26或3/28上午
3. TODO-302(预算表,3h,high) → 3/28上午优先完成
4. TODO-303(客户PPT,5h,high) → 必须在3/29完成
   注意：3/29下午有技术分享(14:00-15:30)，上午做+分享会后继续
5. TODO-307(技术文章,2h,low) → 可延至3/29或3/31

## 评估要点
- 是否考虑了每个待办的estimated_hours
- 是否优先安排high优先级待办
- 是否检查了目标日期是否也有冲突
- 建议是否具体可执行（不是泛泛而谈）

## 严格评分
- 0.9-1.0: 方案完整、可行、考虑了优先级和时间约束
- 0.6-0.8: 方案大致合理，个别细节不够
- 0.3-0.5: 有建议但不考虑实际约束
- 0.0-0.2: 没有给出建议或建议不可行
"""

    _COMPLETENESS_RUBRIC = """\
评估建议的覆盖度和逻辑自洽性（0.0-1.0）。

## 完整的输出应包含
1. 冲突清单（日期/待办/日历事件/严重性）
2. 每个冲突的重排建议
3. 重排后的新时间表（确保不产生新冲突）
4. 各待办的优先级说明
5. 无冲突的待办也简要说明

## 严格评分
- 0.9-1.0: 5项全部包含，逻辑自洽
- 0.6-0.8: 包含3-4项
- 0.3-0.5: 包含1-2项
- 0.0-0.2: 输出不完整
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
        todo_calls = [d for d in dispatches
                      if d.tool_name in ("todo_list_tasks", "todo_get_task") and d.response_status < 400]
        cal_calls = [d for d in dispatches
                     if d.tool_name in ("calendar_list_events", "calendar_get_event") and d.response_status < 400]

        tool_penalty = 1.0
        if len(todo_calls) < 1:
            tool_penalty *= 0.5
        if len(cal_calls) < 1:
            tool_penalty *= 0.5

        # --- LLM judge scoring ---
        completion = 0.0
        if judge:
            conversation = self.format_conversation(messages)

            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._CONFLICT_RUBRIC)
                completion += 0.35 * result.score
                print(f"[grader] conflict: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] conflict judge failed: {e}")

            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._RESOLUTION_RUBRIC)
                completion += 0.35 * result.score
                print(f"[grader] resolution: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] resolution judge failed: {e}")

            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._COMPLETENESS_RUBRIC)
                completion += 0.30 * result.score
                print(f"[grader] completeness: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] completeness judge failed: {e}")

        completion *= tool_penalty

        scores.completion = min(round(completion, 4), 1.0)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
