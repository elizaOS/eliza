"""T119zh_inventory_cost_analysis grader — inventory + finance cost analysis."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class InventoryCostAnalysisGrader(AbstractGrader):
    """Grader for T154zh: cross-verify inventory costs against purchase records.

    Scoring design:
    - Tool usage is a prerequisite gate.
    - LLM judge evaluates anomaly detection, reconciliation, and report quality.
    - Agent must find both cost anomalies (monitor price gap + mousepad batch pricing).
    """

    _ANOMALY_RUBRIC = """\
评估助手对成本异常的识别能力（0.0-1.0）。

## 必须发现的异常

异常1 — 显示器单价差异（严重）：
- ITEM-804库存记录unit_cost = 1500元/台
- TXN-804实际采购金额 = 26400元 ÷ 12台 = 2200元/台
- 差异：每台700元，总计8400元
- 这是需要立即调查的重大差异

异常2 — 鼠标垫分批价格不同（需关注）：
- TXN-806a 第一批：60个 × 8元 = 480元
- TXN-806b 第二批：40个 × 12元 = 480元
- 第二批单价上涨50%（从8元到12元）
- ITEM-806库存只记录了unit_cost=8，未反映第二批涨价

## 严格评分
- 0.9-1.0: 两个异常都准确识别，数据计算正确
- 0.6-0.8: 发现显示器异常（较明显的那个）
- 0.3-0.5: 注意到有差异但分析不准确
- 0.0-0.2: 未发现任何异常
"""

    _RECONCILIATION_RUBRIC = """\
评估助手对全部品类的成本核对完整性（0.0-1.0）。

## 6个品类的核对结果
1. A4打印纸: 150×25=3750 vs TXN-801(3750) → 一致
2. 墨盒: 20×180=3600 vs TXN-802(3600) → 一致
3. 键盘: 45×350=15750 vs TXN-803(15750) → 一致
4. 显示器: 12×1500=18000 vs TXN-804(26400) → 不一致(差8400)
5. USB线: 200×15=3000 vs TXN-805(3000) → 一致
6. 鼠标垫: 100×8=800 vs TXN-806a(480)+TXN-806b(480)=960 → 需确认

## TXN-807(租金85000)应被识别为非采购交易并排除

## 严格评分
- 0.9-1.0: 6个品类全部核对，正确排除非采购交易
- 0.7-0.8: 至少5个品类核对
- 0.4-0.6: 3-4个品类核对
- 0.0-0.3: 核对严重不完整
"""

    _REPORT_RUBRIC = """\
评估成本分析报告的质量（0.0-1.0）。

## 合格报告应包含
1. 核对汇总表（品类/库存成本/采购成本/状态）
2. 异常项详细说明
3. 建议处理措施（更新库存单价、调查显示器差价原因、确认鼠标垫涨价原因）
4. 总成本统计

## 严格评分
- 0.9-1.0: 4项全部包含，数据准确
- 0.6-0.8: 包含3项
- 0.3-0.5: 包含1-2项
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
        inv_calls = [d for d in dispatches
                     if d.tool_name in ("inventory_list_items", "inventory_get_item") and d.response_status < 400]
        fin_calls = [d for d in dispatches
                     if d.tool_name in ("finance_list_transactions", "finance_get_transaction") and d.response_status < 400]

        tool_penalty = 1.0
        if len(inv_calls) < 1:
            tool_penalty *= 0.5
        if len(fin_calls) < 1:
            tool_penalty *= 0.5

        # --- LLM judge scoring ---
        completion = 0.0
        if judge:
            conversation = self.format_conversation(messages)

            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._ANOMALY_RUBRIC)
                completion += 0.35 * result.score
                print(f"[grader] anomaly: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] anomaly judge failed: {e}")

            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._RECONCILIATION_RUBRIC)
                completion += 0.35 * result.score
                print(f"[grader] reconciliation: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] reconciliation judge failed: {e}")

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
