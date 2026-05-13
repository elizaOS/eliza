"""T149zh_project_progress_report grader — calendar + notes + todo + contacts."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class ProjectProgressReportGrader(AbstractGrader):
    """Grader for T184zh: generate progress reports for 3 parallel projects.

    Scoring design:
    - Tool usage is a prerequisite gate (notes, todos, contacts must all be queried).
    - LLM judge evaluates progress accuracy, risk identification, and report completeness.
    """

    # Notes that should be read for complete coverage
    ALL_NOTES = {"NOTE-601", "NOTE-602", "NOTE-603", "NOTE-604", "NOTE-605"}

    _PROGRESS_RUBRIC = """\
评估三个项目进度数据的准确性（0.0-1.0）。

## Alpha项目（进度~75%，按时推进）
待办4个: TODO-601 completed, TODO-602 completed, TODO-603 in_progress, TODO-604 completed
完成率: 3/4=75%（或综合纪要行动项约60-80%）
行动项: 5个(NOTE-601的3个+NOTE-602的2个)，其中3个完成、1个进行中、1个待开始
状态: 按时推进，技术可行性报告进行中

## Beta项目（进度~20-45%，严重延迟）
待办5个: TODO-605 completed, TODO-606 in_progress, TODO-607 pending(blocked), TODO-608 pending, TODO-609 in_progress
完成率: 1/5=20%（综合行动项约30-45%）
行动项: 5个(NOTE-603的3个+NOTE-604的2个)，其中1个完成、2个进行中/blocked、2个pending
状态: 延迟约1周，有阻塞项

## Gamma项目（进度~90-100%，即将完成）
待办3个: TODO-610 completed, TODO-611 completed, TODO-612 completed
完成率: 3/3=100%（但3/24交付评审无纪要，综合约90%）
行动项: 2个(NOTE-605的2个)，全部完成
状态: 即将完成

## 严格评分
- 0.9-1.0: 三个项目进度数据全部准确，完成率计算正确
- 0.7-0.8: 至少2个项目进度准确
- 0.4-0.6: 至少1个项目准确，其余大致正确
- 0.0-0.3: 进度数据严重错误或遗漏
"""

    _RISK_RUBRIC = """\
评估风险识别的完整性和准确性（0.0-1.0）。

## 必须识别的风险

### Beta项目关键风险（最重要）
1. TODO-607 前端原型设计 blocked — 等待第三方API文档，且已逾期(截止3/22)
2. TODO-608 API接口开发 pending(high priority) — 依赖数据库设计(TODO-606)未完
3. 整体进度落后约1周（NOTE-604会议结论明确指出）
4. 第三方API文档阻塞是核心瓶颈，影响前端和后端

### Alpha项目注意事项
5. TODO-603 技术可行性报告截止3/25，仍在进行中 — 需关注
6. NOTE-602行动项2(微服务拆分方案)依赖可行性报告 — 串联依赖

### Gamma项目注意事项
7. evt_606(3/24交付评审)缺少会议纪要 — 需要跟进补充

## 严格评分
- 0.9-1.0: Beta核心风险(1-4)全部识别，Gamma缺纪要也指出
- 0.7-0.8: Beta主要风险识别到位(至少3个)
- 0.4-0.6: 识别了部分风险但不完整
- 0.0-0.3: 未识别关键风险
"""

    _REPORT_RUBRIC = """\
评估进度汇报的完整性和专业性（0.0-1.0）。

## 合格报告应包含
1. 按项目分组的结构化报告（Alpha/Beta/Gamma各一节）
2. 每个项目的会议列表和纪要摘要
3. 行动项清单及完成状态对照
4. 待办事项完成率统计
5. 项目负责人及联系方式（邮箱/电话）
6. 风险项标注和建议
7. 项目间的优先级或关注度排序（Beta最需关注）

## 负责人联系方式
- 王明(项目经理): wangming@company.com, 13900139001 → Alpha, Gamma
- 李华(架构师): lihua@company.com, 13900139002 → Alpha
- 赵蕾(产品经理): zhaolei@company.com, 13900139003 → Beta, Gamma
- 张伟(后端开发): zhangwei@company.com, 13900139004 → Beta
- 马强(运维): maqiang@company.com, 13900139005 → Alpha
- 周明(前端开发): zhouming@company.com, 13900139006 → Beta

## 严格评分
- 0.9-1.0: 7项全含，结构清晰专业
- 0.6-0.8: 5-6项，结构合理
- 0.3-0.5: 3-4项，缺少关键信息
- 0.0-0.2: 报告残缺或无结构
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
        notes_read = {
            d.request_body.get("note_id")
            for d in dispatches
            if d.tool_name == "notes_get" and d.response_status < 400
        }
        todo_calls = [
            d
            for d in dispatches
            if d.tool_name in ("todo_list_tasks", "todo_get_task") and d.response_status < 400
        ]
        contacts_calls = [
            d
            for d in dispatches
            if d.tool_name in ("contacts_search", "contacts_get") and d.response_status < 400
        ]
        calendar_calls = [
            d
            for d in dispatches
            if d.tool_name in ("calendar_list_events", "calendar_get_event") and d.response_status < 400
        ]

        tool_penalty = 1.0
        # Must read at least 3 of 5 notes to understand project status
        if len(notes_read & self.ALL_NOTES) < 3:
            tool_penalty *= 0.5
        # Must query todos to verify completion
        if len(todo_calls) < 1:
            tool_penalty *= 0.5
        # Must query contacts for responsible persons
        if len(contacts_calls) < 1:
            tool_penalty *= 0.6
        # Must query calendar for project meetings
        if len(calendar_calls) < 1:
            tool_penalty *= 0.6

        # --- LLM judge scoring ---
        completion = 0.0
        if judge:
            conversation = self.format_conversation(messages)
            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._PROGRESS_RUBRIC
                )
                completion += 0.35 * result.score
                print(f"[grader] progress_accuracy: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] progress_accuracy judge failed: {e}")
            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._RISK_RUBRIC
                )
                completion += 0.35 * result.score
                print(f"[grader] risk_identification: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] risk_identification judge failed: {e}")
            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._REPORT_RUBRIC
                )
                completion += 0.30 * result.score
                print(f"[grader] report_completeness: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] report_completeness judge failed: {e}")

        completion *= tool_penalty
        scores.completion = min(round(completion, 4), 1.0)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
