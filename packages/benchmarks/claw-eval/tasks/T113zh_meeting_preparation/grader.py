"""T113zh_meeting_preparation grader — calendar + contacts meeting prep."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class MeetingPreparationGrader(AbstractGrader):
    """Grader for T148zh: prepare meeting materials with attendee lookup.

    Scoring design:
    - Tool usage is a prerequisite gate.
    - LLM judge evaluates attendee coverage, analysis, and material quality.
    - Agent must cover ALL 4 meetings and identify external attendee + busiest person.
    """

    ALL_EVENTS = {"evt_201", "evt_202", "evt_203", "evt_204"}

    _ATTENDEE_RUBRIC = """\
评估助手对参会者信息的覆盖度（0.0-1.0）。

## 必须查找的参会者（6位内部+1位外部）
1. 王明 — 技术总监，产品部（3场：评审+周会... 实际是评审evt_201 + 周会evt_204 = 2场）
   修正：王明参加evt_201和evt_204 = 2场
2. 李华 — 高级架构师，研发部（evt_201+evt_203+evt_204 = 3场）
3. 赵蕾 — 客户经理，销售部（evt_201+evt_202+evt_204 = 3场）
4. 张伟 — 安全经理，安全部（evt_202+evt_204 = 2场）
5. 马强 — 运维主管，运维部（evt_203+evt_204 = 2场）
6. 周明 — 前端组长，研发部（evt_203+evt_204 = 2场）
7. 陈总 — 外部人员，无通讯录记录

## 严格评分
- 0.9-1.0: 7位参会者全部覆盖，联系方式完整
- 0.7-0.8: 至少5位覆盖
- 0.4-0.6: 3-4位覆盖
- 0.0-0.3: 覆盖不足3位
"""

    _ANALYSIS_RUBRIC = """\
评估助手的分析深度（0.0-1.0）。

## 必须标注的关键信息
1. 陈总是外部人员，不在内部通讯录 — 必须明确标注
2. 李华参加3场会议（评审+选型+周会），是最忙的同事
3. 赵蕾也参加3场（评审+演示+周会），同样很忙
4. 会议时间分布：上午2场，下午2场，留午休时间

## 严格评分
- 0.9-1.0: 正确标注外部人员 + 识别最忙同事 + 时间分析
- 0.6-0.8: 标注外部人员 + 识别最忙同事
- 0.3-0.5: 仅标注了外部人员或仅识别了最忙同事
- 0.0-0.2: 未做任何分析
"""

    _MATERIAL_RUBRIC = """\
评估会议准备材料的结构和完整性（0.0-1.0）。

## 合格的材料应包含
1. 按会议分组的清晰结构
2. 每个会议：时间、地点、议题、参会者列表（含职位和联系方式）
3. 参会者汇总表（去重后的完整列表）
4. 特别提醒事项（外部人员、会议间衔接等）

## 严格评分
- 0.9-1.0: 4项全部包含，格式专业
- 0.6-0.8: 包含3项
- 0.3-0.5: 包含1-2项
- 0.0-0.2: 未形成结构化材料
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
        cal_calls = [d for d in dispatches
                     if d.tool_name in ("calendar_list_events", "calendar_get_event") and d.response_status < 400]
        contact_calls = [d for d in dispatches
                         if d.tool_name in ("contacts_search", "contacts_get") and d.response_status < 400]

        tool_penalty = 1.0
        if len(cal_calls) < 1:
            tool_penalty *= 0.5
        if len(contact_calls) < 3:
            tool_penalty *= 0.6

        # --- LLM judge scoring ---
        completion = 0.0
        if judge:
            conversation = self.format_conversation(messages)

            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._ATTENDEE_RUBRIC)
                completion += 0.35 * result.score
                print(f"[grader] attendee: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] attendee judge failed: {e}")

            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._ANALYSIS_RUBRIC)
                completion += 0.35 * result.score
                print(f"[grader] analysis: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] analysis judge failed: {e}")

            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._MATERIAL_RUBRIC)
                completion += 0.30 * result.score
                print(f"[grader] material: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] material judge failed: {e}")

        completion *= tool_penalty

        scores.completion = min(round(completion, 4), 1.0)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
