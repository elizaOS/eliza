"""T131zh_order_profit_analysis grader — finance + inventory + crm."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class OrderProfitAnalysisGrader(AbstractGrader):
    """Grader for T166zh: analyze order profitability across customers.

    Scoring design:
    - Tool usage is a prerequisite gate.
    - LLM judge evaluates profit calculation, payment analysis, and report quality.
    """

    ALL_CUSTOMERS = {"CUS-801", "CUS-802", "CUS-803", "CUS-804"}

    _PROFIT_RUBRIC = """\
评估助手的利润率计算准确性（0.0-1.0）。

## 正确计算
CUS-801 鼎新: 成本43k, 售价180k, 利润率76.1% ((180-43)/180)
CUS-802 瀚海: 成本20k, 售价80k, 利润率75% ((80-20)/80)
CUS-803 万通: 成本50k, 售价250k, 利润率80% ((250-50)/250)
CUS-804 前锋: 成本8k, 售价30k, 利润率73.3% ((30-8)/30)

## 关键：必须查产品成本价
- 不能只看售价和收款差异
- 必须从inventory获取每个产品的unit_cost
- 利润率=(售价-成本)/售价

## 严格评分
- 0.9-1.0: 4个客户利润率全部正确（允许±2%误差）
- 0.7-0.8: 3个正确
- 0.4-0.6: 2个正确
- 0.0-0.3: 不足2个或计算方法错误
"""

    _PAYMENT_RUBRIC = """\
评估助手对收款异常的识别（0.0-1.0）。

## 必须发现的异常
1. CUS-802瀚海电商：订单80k但只收到50k(TXN-812)，欠款30k
   → 需跟进催收或确认分期安排

2. CUS-803万通物流：已全额收款250k(TXN-813)但有退款20k(TXN-814)
   → 净收230k，退款原因是"实施延期补偿"
   → 实际利润 = 230k-50k = 180k（而非200k）

## 非异常
- CUS-801全额到账 ✓
- CUS-804全额到账 ✓
- TXN-816工资是非订单交易，应排除

## 严格评分
- 0.9-1.0: 两个异常都准确识别+影响分析
- 0.6-0.8: 识别了1个异常
- 0.3-0.5: 注意到问题但分析不准确
- 0.0-0.2: 未发现异常
"""

    _REPORT_RUBRIC = """\
评估报告的结构和洞察质量（0.0-1.0）。

## 合格报告应包含
1. 按客户的利润率对比表
2. 收款状态标注
3. 异常项说明和建议
4. 总体利润汇总
5. 洞察（如：万通利润率最高，瀚海有坏账风险）

## 严格评分
- 0.9-1.0: 5项全部包含
- 0.6-0.8: 包含3-4项
- 0.3-0.5: 包含1-2项
- 0.0-0.2: 无结构化报告
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
        crm_calls = [d for d in dispatches
                     if d.tool_name in ("crm_list_customers", "crm_get_customer") and d.response_status < 400]
        inv_calls = [d for d in dispatches
                     if d.tool_name in ("inventory_list_items", "inventory_get_item") and d.response_status < 400]
        fin_calls = [d for d in dispatches
                     if d.tool_name in ("finance_list_transactions", "finance_get_transaction") and d.response_status < 400]

        tool_penalty = 1.0
        if len(crm_calls) < 1:
            tool_penalty *= 0.5
        if len(inv_calls) < 1:
            tool_penalty *= 0.5
        if len(fin_calls) < 1:
            tool_penalty *= 0.6

        # --- LLM judge scoring ---
        completion = 0.0
        if judge:
            conversation = self.format_conversation(messages)

            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._PROFIT_RUBRIC)
                completion += 0.35 * result.score
                print(f"[grader] profit: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] profit judge failed: {e}")

            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._PAYMENT_RUBRIC)
                completion += 0.35 * result.score
                print(f"[grader] payment: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] payment judge failed: {e}")

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
