"""T127zh_ticket_assignment grader — contacts + helpdesk ticket assignment."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class TicketAssignmentGrader(AbstractGrader):
    """Grader for T162zh: assign unassigned tickets to appropriate handlers.

    Scoring design:
    - Tool usage is a prerequisite gate.
    - LLM judge evaluates routing accuracy, reasoning, and report format.
    - Agent must correctly assign all 6 tickets including identifying TK-905 as non-IT.
    """

    ALL_TICKETS = {"TK-901", "TK-902", "TK-903", "TK-904", "TK-905", "TK-906"}

    _ROUTING_RUBRIC = """\
评估助手对工单分配的准确性（0.0-1.0）。

## 正确的分配方案
1. TK-901 系统登录异常 → 马强/IT运维组（系统故障）
2. TK-902 报表数据不准 → 李华/数据组（数据质量问题）
3. TK-903 VPN无法连接 → 马强/IT运维组（网络基础设施）
4. TK-904 权限申请 → 张伟/安全组（账号权限管理）
5. TK-905 办公椅损坏 → 陈婷/行政部（办公设备，非IT）
6. TK-906 邮箱存储满 → 马强/IT运维组（邮箱系统管理）

## 严格评分
- 0.9-1.0: 6个全部正确，特别是TK-905(行政)和TK-904(安全)的区分
- 0.7-0.8: 5个正确
- 0.4-0.6: 3-4个正确
- 0.0-0.3: 不足3个正确
"""

    _REASONING_RUBRIC = """\
评估分配理由的质量和逻辑性（0.0-1.0）。

## 好的分配理由应包含
1. 问题类型分类（系统故障/数据问题/网络/权限/行政）
2. 负责人的职责说明（为什么选这个人）
3. 特别指出TK-905是非IT问题（办公设备属行政范畴）
4. 马强负责3个工单时，建议按优先级排序处理

## 严格评分
- 0.9-1.0: 每个分配都有清晰理由，IT/非IT区分明确
- 0.6-0.8: 大部分有理由，个别不够清晰
- 0.3-0.5: 理由笼统
- 0.0-0.2: 无理由或理由错误
"""

    _FORMAT_RUBRIC = """\
评估分配建议表的格式和完整性（0.0-1.0）。

## 合格的输出应包含
1. 清晰的表格或列表（工单→处理人→理由）
2. 每个工单的关键信息（标题、优先级、类型）
3. 处理人的联系方式
4. 处理建议或注意事项

## 严格评分
- 0.9-1.0: 4项全部包含，格式专业
- 0.6-0.8: 3项包含
- 0.3-0.5: 1-2项
- 0.0-0.2: 格式混乱
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
        ticket_calls = [d for d in dispatches if d.tool_name == "helpdesk_get_ticket" and d.response_status < 400]
        tickets_read = {d.request_body.get("ticket_id") for d in ticket_calls}
        contact_calls = [d for d in dispatches
                         if d.tool_name in ("contacts_search", "contacts_get") and d.response_status < 400]

        tool_penalty = 1.0
        if len(tickets_read) < 4:
            tool_penalty *= 0.5
        if len(contact_calls) < 2:
            tool_penalty *= 0.6

        # --- LLM judge scoring ---
        completion = 0.0
        if judge:
            conversation = self.format_conversation(messages)

            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._ROUTING_RUBRIC)
                completion += 0.35 * result.score
                print(f"[grader] routing: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] routing judge failed: {e}")

            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._REASONING_RUBRIC)
                completion += 0.35 * result.score
                print(f"[grader] reasoning: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] reasoning judge failed: {e}")

            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._FORMAT_RUBRIC)
                completion += 0.30 * result.score
                print(f"[grader] format: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] format judge failed: {e}")

        completion *= tool_penalty

        scores.completion = min(round(completion, 4), 1.0)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
