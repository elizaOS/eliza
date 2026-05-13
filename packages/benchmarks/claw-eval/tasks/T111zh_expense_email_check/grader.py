"""T111zh_expense_email_check grader — gmail + finance expense verification."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class ExpenseEmailCheckGrader(AbstractGrader):
    """Grader for T146zh: cross-verify reimbursement emails against finance records.

    Scoring design:
    - Tool usage is a prerequisite gate (penalty if insufficient), not a score source.
    - LLM judge evaluates matching accuracy, discrepancy detection, and report quality.
    - Agent must identify ALL 4 reimbursements and correctly flag 2 anomalies to score above 0.75.
    """

    EXPENSE_EMAILS = {"msg_701", "msg_702", "msg_703", "msg_704"}

    _MATCHING_RUBRIC = """\
评估助手对报销邮件与财务记录的匹配准确性（0.0-1.0）。

## 正确的匹配结果（4笔报销）
1. msg_701（张伟差旅费3200元，INV-001）↔ TXN-701（3200元，completed）→ 完全匹配 ✓
2. msg_702（李华办公用品850元，INV-002）↔ TXN-702（680元，completed）→ 金额不符（差170元）✗
3. msg_703（王明培训费5000元，INV-003）↔ TXN-703（5000元，pending）→ 金额对但未完成 ⚠
4. msg_704（陈静餐费420元，INV-004）↔ TXN-704（420元，completed）→ 完全匹配 ✓

## 干扰项处理
- msg_705（行政通知）应被排除，不是报销邮件
- TXN-705（水电费）和TXN-706（员工工资）不应混入报销核对

## 严格评分
- 0.9-1.0: 4笔报销全部正确匹配，干扰项正确排除
- 0.7-0.8: 至少3笔正确匹配
- 0.4-0.6: 2笔正确匹配
- 0.0-0.3: 匹配错误或未完成核对
"""

    _DISCREPANCY_RUBRIC = """\
评估助手对异常项的分析深度（0.0-1.0）。

## 必须发现的异常
异常1 — 金额不符（msg_702 vs TXN-702）：
- 邮件申请报销850元，财务记录仅680元，差额170元
- 应分析可能原因（部分物品未入账？发票金额与实际采购不符？）
- 应建议：联系李华确认明细，核对发票原件

异常2 — 状态异常（msg_703 vs TXN-703）：
- 金额5000元匹配，但TXN-703状态为pending（未完成）
- 应指出：报销已审批但款项尚未打到申请人账户
- 应建议：跟进财务流程，确认预计到账时间

## 严格评分
- 0.9-1.0: 两个异常都准确识别，原因分析合理，建议具体
- 0.6-0.8: 两个异常识别但分析不够深入
- 0.3-0.5: 仅识别1个异常
- 0.0-0.2: 未发现异常或分析错误
"""

    _REPORT_RUBRIC = """\
评估核对报告的结构和质量（0.0-1.0）。

## 合格的报告应包含
1. 按状态分类（正常/金额异常/状态异常）的清单
2. 每笔报销的对比详情（邮件金额 vs 财务金额）
3. 异常项的具体说明和建议处理方式
4. 非报销邮件的处理说明（已排除）
5. 格式清晰，便于财务人员直接使用

## 严格评分
- 0.9-1.0: 5项全部包含，格式专业清晰
- 0.6-0.8: 包含3-4项，格式基本清晰
- 0.3-0.5: 内容不完整或格式混乱
- 0.0-0.2: 未形成完整报告
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
        get_msg = [d for d in dispatches if d.tool_name == "gmail_get_message" and d.response_status < 400]
        read_ids = {d.request_body.get("message_id") for d in get_msg}
        emails_read = read_ids & self.EXPENSE_EMAILS

        fin_calls = [d for d in dispatches
                     if d.tool_name in ("finance_list_transactions", "finance_get_transaction") and d.response_status < 400]

        tool_penalty = 1.0
        if len(emails_read) < 3:
            tool_penalty *= 0.5
        if len(fin_calls) < 1:
            tool_penalty *= 0.5

        # --- LLM judge scoring (100% of base score) ---
        completion = 0.0
        if judge:
            conversation = self.format_conversation(messages)

            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._MATCHING_RUBRIC)
                completion += 0.35 * result.score
                print(f"[grader] matching: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] matching judge failed: {e}")

            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._DISCREPANCY_RUBRIC)
                completion += 0.35 * result.score
                print(f"[grader] discrepancy: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] discrepancy judge failed: {e}")

            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._REPORT_RUBRIC)
                completion += 0.30 * result.score
                print(f"[grader] report: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] report judge failed: {e}")

        completion *= tool_penalty

        scores.completion = min(round(completion, 4), 1.0)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
