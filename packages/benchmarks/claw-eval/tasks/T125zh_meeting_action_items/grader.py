"""T125zh_meeting_action_items grader — notes + todo action item extraction."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class MeetingActionItemsGrader(AbstractGrader):
    """Grader for T160zh: extract action items from meeting notes and deduplicate with todos.

    Scoring design:
    - Tool usage is a prerequisite gate.
    - LLM judge evaluates extraction, deduplication, and recommendations.
    - Agent must extract all 9 action items and correctly match 3 to existing todos.
    """

    ALL_NOTES = {"NOTE-301", "NOTE-302", "NOTE-303"}

    _EXTRACTION_RUBRIC = """\
评估助手对会议行动项的提取完整性（0.0-1.0）。

## 3份纪要中的9个行动项
NOTE-301（4个）：
1. 王明 — Q2产品路线图文档，截止3/28
2. 李华 — 竞品新功能调研报告，截止3/30
3. 赵蕾 — Top10客户需求清单，截止3/27
4. 张伟 — 安全合规评估报告，截止3/31

NOTE-302（3个）：
5. 李华 — 微服务拆分技术方案，截止4/3
6. 马强 — 数据库迁移测试环境，截止3/28
7. 周明 — 前端组件库升级v3.0，截止4/5

NOTE-303（2个）：
8. 王明 — Q1技术团队绩效总结，截止3/29
9. 赵蕾 — 大客户续约策略方案，截止3/30

## 严格评分
- 0.9-1.0: 9个行动项全部提取，含负责人和截止日期
- 0.7-0.8: 提取7-8个
- 0.4-0.6: 提取5-6个
- 0.0-0.3: 提取不足5个
"""

    _DEDUP_RUBRIC = """\
评估助手对行动项与待办的去重匹配准确性（0.0-1.0）。

## 正确的3组模糊匹配
1. 行动项"Q2产品路线图文档"(王明) ↔ TODO-401"完成产品路线图"(王明)
   匹配依据：同一负责人+同一主题+相同截止日期
2. 行动项"Top10客户需求清单"(赵蕾) ↔ TODO-402"整理客户需求"(赵蕾)
   匹配依据：同一负责人+主题重叠+相同截止日期
3. 行动项"数据库迁移测试环境"(马强) ↔ TODO-403"DB迁移测试环境搭建"(马强)
   匹配依据：同一负责人+同一主题(DB=数据库)+相同截止日期

## 不应匹配
- TODO-404(站会)和TODO-405(部署文档)与任何行动项无关
- 其余6个行动项在待办中无对应项

## 严格评分
- 0.9-1.0: 3组匹配全部正确，无误匹配
- 0.6-0.8: 2组正确
- 0.3-0.5: 1组正确
- 0.0-0.2: 匹配错误或未做去重
"""

    _RECOMMENDATION_RUBRIC = """\
评估新建待办建议的完整性（0.0-1.0）。

## 需新建的6个待办
1. 李华 — 竞品调研报告 (截止3/30, 来源NOTE-301)
2. 张伟 — 安全合规评估 (截止3/31, 来源NOTE-301)
3. 李华 — 微服务拆分方案 (截止4/3, 来源NOTE-302)
4. 周明 — 前端组件库升级 (截止4/5, 来源NOTE-302)
5. 王明 — Q1绩效总结 (截止3/29, 来源NOTE-303)
6. 赵蕾 — 续约策略方案 (截止3/30, 来源NOTE-303)

## 建议应包含
- 负责人、截止日期、来源会议
- 建议的优先级

## 严格评分
- 0.9-1.0: 6个新建建议全部列出，信息完整
- 0.6-0.8: 4-5个列出
- 0.3-0.5: 2-3个列出
- 0.0-0.2: 建议不足2个
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
        notes_calls = [d for d in dispatches if d.tool_name in ("notes_list", "notes_get") and d.response_status < 400]
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
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._EXTRACTION_RUBRIC)
                completion += 0.35 * result.score
                print(f"[grader] extraction: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] extraction judge failed: {e}")

            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._DEDUP_RUBRIC)
                completion += 0.35 * result.score
                print(f"[grader] dedup: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] dedup judge failed: {e}")

            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._RECOMMENDATION_RUBRIC)
                completion += 0.30 * result.score
                print(f"[grader] recommendation: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] recommendation judge failed: {e}")

        completion *= tool_penalty

        scores.completion = min(round(completion, 4), 1.0)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
