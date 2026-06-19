"""T143zh_quarterly_business_insight grader — finance + crm + rss."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class QuarterlyBusinessInsightGrader(AbstractGrader):
    """Grader for T178zh: Q1 quarterly business insight with industry analysis.

    Scoring design:
    - Tool usage is a prerequisite gate.
    - LLM judge evaluates data analysis, industry correlation, and insight quality.
    """

    _DATA_RUBRIC = """\
评估助手的Q1收入数据分析准确性（0.0-1.0）。

## 正确的收入分析
| 客户 | 1月 | 2月 | 3月 | Q1总计 | 趋势 |
|------|------|------|------|--------|------|
| CUS-901 鼎新软件 | 85,000 | 90,000 | 95,000 | 270,000 | ↑增长 |
| CUS-902 瀚海电商 | 45,000 | 45,000 | 45,000 | 135,000 | →持平 |
| CUS-903 万通物流 | 120,000 | 120,000 | 115,000 | 355,000 | ↓微降 |
| CUS-904 前锋科技 | 30,000 | 30,000 | 25,000 | 85,000 | ↓下降 |
| CUS-905 阳光传媒 | 60,000 | 65,000 | 70,000 | 195,000 | ↑增长 |
| CUS-906 公共机构 | 0 | 0 | 0 | 0 | 已流失 |

## 总收入: Q1合计1,040,000元

## 严格评分
- 0.9-1.0: 按客户完整汇总，趋势分类正确(2个增长/1个持平/2个下降/1个流失)，有量化对比
- 0.7-0.8: 数据大致正确，趋势判断基本准确
- 0.5-0.6: 列出了数据但趋势分析不完整
- 0.3-0.4: 数据有误或遗漏多个客户
- 0.0-0.2: 未有效分析收入数据
"""

    _CORRELATION_RUBRIC = """\
评估客户收入变化与行业动态的关联分析深度（0.0-1.0）。

## 正确的关联对
1. 鼎新(软件) ↔ RSS-901(软件行业增长12%) → 行业红利推动增长
2. 瀚海(电商) ↔ RSS-902(电商流量增长放缓) → 行业放缓导致需求持平
3. 万通(物流) ↔ RSS-903(物流价格竞争/利润率承压) → 解释价格敏感和微降
4. 前锋(制造) ↔ RSS-904(制造业IT预算收紧) → 行业逆风导致降级
5. 阳光(传媒) ↔ RSS-905(传媒AI驱动增长) → AI红利推动增购
6. 公共(政府) ↔ RSS-906(政府预算调整) → 预算削减导致流失

## 严格评分
- 0.9-1.0: 6对关联全部正确，因果分析逻辑清晰
- 0.7-0.8: 至少4对正确
- 0.5-0.6: 3对正确
- 0.3-0.4: 仅1-2对正确或分析浮于表面
- 0.0-0.2: 未将行业动态与客户数据关联
"""

    _INSIGHT_RUBRIC = """\
评估Q2预测和建议的质量（0.0-1.0）。

## 必须包含的洞察
1. 风险预警：CUS-904合同4月到期+收入下降+行业逆风=高流失风险
2. 风险预警：CUS-903 VIP但价格敏感，需防止降级
3. 增长机会：CUS-905增速最快(+16.7%)，可推更多增值服务
4. 增长机会：CUS-901持续增购，VIP价值提升中
5. 关注点：CUS-902持平无增长，电商行业放缓需关注续约
6. 流失复盘：CUS-906因预算问题流失，同类客户需预防

## 严格评分
- 0.9-1.0: 6项洞察全部覆盖，Q2建议具有可操作性
- 0.7-0.8: 至少4项洞察，建议合理
- 0.5-0.6: 识别了主要风险和机会但不够深入
- 0.3-0.4: 仅列出了数据汇总无深度分析
- 0.0-0.2: 未提供有效预测和建议
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
        fin_calls = [d for d in dispatches
                     if d.tool_name in ("finance_list_transactions", "finance_get_transaction") and d.response_status < 400]
        crm_calls = [d for d in dispatches
                     if d.tool_name in ("crm_list_customers", "crm_get_customer") and d.response_status < 400]
        rss_calls = [d for d in dispatches
                     if d.tool_name in ("rss_list_feeds", "rss_get_feed", "rss_get_article") and d.response_status < 400]

        tool_penalty = 1.0
        if len(fin_calls) < 1:
            tool_penalty *= 0.5
        if len(crm_calls) < 1:
            tool_penalty *= 0.6
        if len(rss_calls) < 1:
            tool_penalty *= 0.6

        # --- LLM judge scoring ---
        completion = 0.0
        if judge:
            conversation = self.format_conversation(messages)

            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._DATA_RUBRIC)
                completion += 0.35 * result.score
                print(f"[grader] data_analysis: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] data_analysis judge failed: {e}")

            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._CORRELATION_RUBRIC)
                completion += 0.35 * result.score
                print(f"[grader] industry_correlation: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] industry_correlation judge failed: {e}")

            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._INSIGHT_RUBRIC)
                completion += 0.30 * result.score
                print(f"[grader] insight: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] insight judge failed: {e}")

        completion *= tool_penalty

        scores.completion = min(round(completion, 4), 1.0)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
