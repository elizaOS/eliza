"""T157zh_month_end_reconciliation grader — 5-service month-end reconciliation."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class MonthEndReconciliationGrader(AbstractGrader):
    """Grader for T192zh: month-end reconciliation across finance, CRM, config, inventory, scheduler.

    Scoring design:
    - Tool usage is a prerequisite gate (penalty if insufficient), not a score source.
    - LLM judge evaluates anomaly detection, reconciliation accuracy, and action items.
    - Agent must find all 3 anomaly types AND trace the root cause chain to score above 0.75.
    """

    # Expected anomaly entities
    DUPLICATE_TXNS = {"TXN-1301", "TXN-1302"}
    PROCUREMENT_MISMATCH_TXN = "TXN-1305"
    PROCUREMENT_MISMATCH_ITEM = "ITEM-1303"
    UNDERPAID_CUSTOMER = "CUS-1303"
    FAILED_JOBS = {"JOB-1301", "JOB-1302"}
    BROKEN_INTEGRATIONS = {"INT-1303", "INT-1304"}

    _ANOMALY_RUBRIC = """\
评估助手对月末对账中3类财务异常的识别能力（0.0-1.0）。

## 必须发现的3类异常

异常1 — 重复扣款（最严重）：
- TXN-1301和TXN-1302完全相同：同一客户CUS-1301、同一金额85000、同一日期2026-03-01、同一描述"3月订阅费"
- CRM中CUS-1301的expected_monthly=85000，但被扣了两笔共170000
- 必须识别为重复扣款并建议退还85000

异常2 — 采购金额与库存入库不符：
- TXN-1305采购ITEM-1303金额45000
- ITEM-1303库存记录：unit_cost=1900 × 入库20块 = 38000
- 差额7000元（45000-38000），原因待查

异常3 — 应收款短收：
- CUS-1303 CRM合同月度应收150000（contract_amount=150000）
- TXN-1310实际收款120000
- 短收30000元

## 额外发现（加分）
- ITEM-1307出库5块但无对应销售交易记录
- ITEM-1308出库3台但与交易记录数量不匹配

## 严格评分
- 0.9-1.0: 3类异常全部准确识别，数据引用正确
- 0.7-0.8: 发现重复扣款+至少1个其他异常
- 0.5-0.6: 只发现2类异常
- 0.3-0.4: 只发现1类异常
- 0.0-0.2: 未发现任何异常或分析错误
"""

    _RECONCILIATION_RUBRIC = """\
评估助手对根因分析和系统对账的准确性（0.0-1.0）。

## 核心根因链（最重要）
1. JOB-1301"每日对账"自3/21起连续6天失败
2. 失败原因：对账系统API超时，关联INT-1303
3. INT-1303"对账系统"最后同步时间2026-03-20，之后6天数据未同步
4. 根因结论：对账任务中断 → 财务异常未被自动检出 → 异常堆积6天无人知晓

## 发票系统故障链
1. JOB-1302"发票自动生成"自3/19起失败
2. 失败原因：发票API版本不兼容(v2已弃用)，关联INT-1304
3. INT-1304"发票系统"状态error，供应商升级至v3但我方仍用v2

## 系统集成状态全貌
- INT-1301/INT-1302 支付网关正常
- INT-1303 对账系统6天未同步（紧急）
- INT-1304 发票系统API错误（重要）

## 客户应收核对准确性
- CUS-1301: 85000应收，实收170000（重复）
- CUS-1302: 45000应收，实收45000-12000退款（正常）
- CUS-1303: 150000应收，实收120000（短收30000）
- CUS-1304: 30000应收，实收30000-5500退款（有退款记录）
- CUS-1305: 25000应收，实收25000（正常）

## 严格评分
- 0.9-1.0: 根因链(JOB-1301→INT-1303→6天中断)完整，客户应收核对准确，系统集成状态全面
- 0.7-0.8: 根因链基本正确，大部分核对准确
- 0.4-0.6: 发现了任务失败但未追溯到集成故障，或核对不完整
- 0.0-0.3: 未做根因分析或分析严重错误
"""

    _ACTION_RUBRIC = """\
评估对账报告的行动建议质量（0.0-1.0）。

## 合格的对账报告应包含

1. 异常汇总表：每个异常类型/涉及ID/金额/影响/紧急程度
2. 根因分析：对账系统故障→自动化中断→异常积压
3. 具体行动建议（至少应包含以下关键项）：
   a. 立即处理CUS-1301重复扣款，退还85000
   b. 联系CUS-1303确认30000差额原因
   c. 紧急修复INT-1303对账系统连接（恢复JOB-1301）
   d. 升级发票系统SDK至v3（恢复JOB-1302/INT-1304）
   e. 调查TXN-1305与ITEM-1303的7000元差额
4. 优先级排序：重复扣款（立即退款）> 对账系统恢复 > 发票系统升级 > 短收确认 > 采购差额调查

## 严格评分
- 0.9-1.0: 4项全部包含，行动建议具体可执行，有优先级排序
- 0.6-0.8: 包含3项，建议基本可行
- 0.3-0.5: 包含1-2项，或建议过于笼统
- 0.0-0.2: 未形成完整报告或无行动建议
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
        scores.safety = 1.0  # No safety checks for this task

        # --- Tool usage gate (prerequisite, not score) ---
        finance_calls = [d for d in dispatches
                         if d.tool_name in ("finance_list_transactions", "finance_get_transaction") and d.response_status < 400]
        crm_calls = [d for d in dispatches
                     if d.tool_name in ("crm_list_customers", "crm_get_customer") and d.response_status < 400]
        config_calls = [d for d in dispatches
                        if d.tool_name in ("config_list_integrations", "config_get_integration") and d.response_status < 400]
        inventory_calls = [d for d in dispatches
                           if d.tool_name in ("inventory_list_products", "inventory_get_product") and d.response_status < 400]
        scheduler_calls = [d for d in dispatches
                           if d.tool_name in ("scheduler_list_jobs", "scheduler_get_job",
                                              "scheduler_job_history") and d.response_status < 400]

        # Count how many of the 5 services were actually queried
        services_queried = sum([
            len(finance_calls) >= 1,
            len(crm_calls) >= 1,
            len(config_calls) >= 1,
            len(inventory_calls) >= 1,
            len(scheduler_calls) >= 1,
        ])

        tool_penalty = 1.0
        if services_queried < 5:
            # Significant penalty for not querying all 5 services
            tool_penalty *= max(0.3, services_queried / 5)
        if len(finance_calls) < 1 or len(crm_calls) < 1:
            tool_penalty *= 0.6  # Finance + CRM are essential for reconciliation

        # --- LLM judge scoring (100% of base score) ---
        completion = 0.0
        if judge:
            conversation = self.format_conversation(messages)

            # Anomaly detection (35%)
            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._ANOMALY_RUBRIC)
                completion += 0.35 * result.score
                print(f"[grader] anomaly_detection: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] anomaly_detection judge failed: {e}")

            # Reconciliation accuracy (35%)
            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._RECONCILIATION_RUBRIC)
                completion += 0.35 * result.score
                print(f"[grader] reconciliation_accuracy: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] reconciliation_accuracy judge failed: {e}")

            # Action items (30%)
            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._ACTION_RUBRIC)
                completion += 0.30 * result.score
                print(f"[grader] action_items: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] action_items judge failed: {e}")

        # Apply tool usage penalty
        completion *= tool_penalty

        scores.completion = min(round(completion, 4), 1.0)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
