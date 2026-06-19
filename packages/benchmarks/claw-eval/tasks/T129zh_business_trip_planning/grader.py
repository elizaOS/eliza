"""T129zh_business_trip_planning grader — gmail + calendar + contacts."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class BusinessTripPlanningGrader(AbstractGrader):
    """Grader for T164zh: plan business trips with conflict detection.

    Scoring design:
    - Tool usage is a prerequisite gate.
    - LLM judge evaluates conflict analysis, trip recommendation, and contact preparation.
    """

    TRIP_EMAILS = {"msg_801", "msg_802", "msg_803"}

    _CONFLICT_RUBRIC = """\
评估助手对出差日程冲突的分析（0.0-1.0）。

## 必须识别的冲突
4月2日三方冲突：
- 上海：VIP客户鼎新软件邀请拜访（msg_801）— 重要客户
- 深圳：技术交流4/2-4/3（msg_802）— 非必须
- 本地：产品评审会9:00-12:00（evt_401）— 可协调改期

4月5日无冲突：
- 北京年度会议（msg_803 + evt_403）— 已确认+已订机票

## 严格评分
- 0.9-1.0: 正确识别4/2三方冲突+4/5无冲突，排除干扰邮件
- 0.7-0.8: 识别4/2冲突但分析不够细致
- 0.4-0.6: 识别部分冲突
- 0.0-0.3: 冲突分析错误
"""

    _RECOMMENDATION_RUBRIC = """\
评估出差建议方案的合理性（0.0-1.0）。

## 合理的方案
1. 4/2优先上海（VIP客户 > 技术交流 > 本地评审）
2. 本地产品评审需协调改期
3. 深圳可以婉拒或看能否4/3单独去
4. 4/5北京正常参加
5. 可能的行程优化：4/2上海→4/3深圳→4/4北京→4/5北京会议

## 严格评分
- 0.9-1.0: 方案合理且有优化建议，考虑了行程衔接
- 0.6-0.8: 方案大方向对但缺少优化
- 0.3-0.5: 有建议但不够合理
- 0.0-0.2: 无建议或建议不可行
"""

    _CONTACT_RUBRIC = """\
评估联系人准备的完整性（0.0-1.0）。

## 应列出的联系人
- 上海：陈经理(客户关系), 吴总(办公室负责人)
- 深圳：李伟(技术经理), 黄工(高级工程师)
- 北京：张总(副总裁), 刘秘书(会议组织)

## 严格评分
- 0.9-1.0: 三地联系人完整，含联系方式
- 0.6-0.8: 至少两地联系人完整
- 0.3-0.5: 仅列出部分
- 0.0-0.2: 未查找联系人
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
        gmail_calls = [d for d in dispatches if d.tool_name == "gmail_get_message" and d.response_status < 400]
        emails_read = {d.request_body.get("message_id") for d in gmail_calls}
        trip_emails_read = emails_read & self.TRIP_EMAILS

        cal_calls = [d for d in dispatches
                     if d.tool_name in ("calendar_list_events", "calendar_get_event") and d.response_status < 400]
        contact_calls = [d for d in dispatches
                         if d.tool_name in ("contacts_search", "contacts_get") and d.response_status < 400]

        tool_penalty = 1.0
        if len(trip_emails_read) < 2:
            tool_penalty *= 0.5
        if len(cal_calls) < 1:
            tool_penalty *= 0.6
        if len(contact_calls) < 2:
            tool_penalty *= 0.7

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
                    task.prompt.text, conversation, "", self._RECOMMENDATION_RUBRIC)
                completion += 0.35 * result.score
                print(f"[grader] recommendation: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] recommendation judge failed: {e}")

            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._CONTACT_RUBRIC)
                completion += 0.30 * result.score
                print(f"[grader] contact: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] contact judge failed: {e}")

        completion *= tool_penalty

        scores.completion = min(round(completion, 4), 1.0)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
