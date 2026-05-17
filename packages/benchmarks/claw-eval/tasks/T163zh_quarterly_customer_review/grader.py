"""T163zh_quarterly_customer_review grader — gmail + finance + crm + rss + contacts."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class QuarterlyCustomerReviewGrader(AbstractGrader):
    """Grader for T198zh: Q1 quarterly customer review across 5 services.

    Scoring design (hard difficulty, 5 services):
    - Tool usage across all 5 services is a prerequisite gate.
    - LLM judge evaluates three dimensions:
      * customer_analysis (0.35): accuracy of per-customer Q1 data synthesis
      * risk_opportunity (0.35): identification of risk and growth customers
      * report_quality (0.30): completeness, structure, industry correlation
    - No safety checks.
    """

    _CUSTOMER_ANALYSIS_RUBRIC = """\
评估助手对6个客户Q1数据的综合分析准确性（0.0-1.0）。

## 正确的Q1收入分析
| 客户 | 1月 | 2月 | 3月 | Q1总计 | 趋势 |
|------|------|------|------|--------|------|
| CUS-1601 鼎新软件(VIP) | 80,000 | 85,000 | 90,000 | 255,000 | ↑持续增长(+12.5%) |
| CUS-1602 瀚海电商 | 50,000 | 50,000 | 45,000 | 145,000 | ↓轻微下降(-10%) |
| CUS-1603 万通物流(VIP) | 120,000 | 125,000 | 130,000 | 375,000 | ↑稳定增长(+8.3%) 最大客户 |
| CUS-1604 前锋科技 | 35,000 | 30,000 | 0 | 65,000 | ↓↓3月零收入 |
| CUS-1605 阳光传媒(VIP) | 60,000 | 65,000 | 70,000 | 195,000 | ↑快速增长(+16.7%) |
| CUS-1606 公共机构 | 40,000 | 40,000 | 40,000 | 120,000 | →持平 |

## 必须整合的CRM信息
- CUS-1604: 满意度2.5/5(最低), 合同4月15日到期
- CUS-1602: 满意度3.2/5(偏低), 合同6月30日到期
- CUS-1603: 满意度4.8/5(最高), VIP最大客户
- CUS-1601: 满意度4.5/5, VIP核心客户

## 必须整合的邮件沟通线索
- 鼎新: 讨论续约(msg_1601) + 项目进展汇报(msg_1602)
- 瀚海: 投诉响应慢(msg_1603) + 咨询新功能(msg_1604)
- 万通: 感谢服务(msg_1605) + 讨论扩展(msg_1606)
- 前锋: 1月20日最后沟通后无回复(msg_1607)
- 阳光: Q1复盘+AI应用(msg_1608)
- 公共: 2月询问预算(msg_1609)

## 严格评分
- 0.9-1.0: 6客户收入+CRM+邮件三维度分析全部准确完整
- 0.7-0.8: 收入分析正确，CRM和邮件信息覆盖大部分
- 0.5-0.6: 收入数据正确但缺少CRM或邮件交叉分析
- 0.3-0.4: 仅列出部分数据无综合分析
- 0.0-0.2: 数据严重缺失或错误
"""

    _RISK_OPPORTUNITY_RUBRIC = """\
评估助手对风险客户和增长客户的识别准确度（0.0-1.0）。

## 必须识别的风险客户
1. CUS-1604 前锋科技 = 高流失风险（必须标注为最高风险）
   证据链：3月零收入 + 满意度仅2.5/5 + 合同4月15日到期(不到1个月) + 1月后沟通中断 + 行业(制造业)IT预算缩减
2. CUS-1602 瀚海电商 = 中等风险
   证据链：收入从50k降至45k + 满意度3.2/5 + 投诉服务响应慢(msg_1603) + 行业(电商)竞争加剧

## 必须识别的增长客户
3. CUS-1603 万通物流 = 最大增长机会
   证据链：最大客户(Q1共375k) + 稳定增长 + 满意度4.8最高 + 讨论扩展方案 + 行业(物流)数字化投入增加
4. CUS-1601 鼎新软件 = 持续增长
   证据链：稳定增长(80k→90k) + VIP + 讨论续约 + 行业(软件)高增长
5. CUS-1605 阳光传媒 = 快速增长
   证据链：增速最快(+16.7%) + AI应用成效 + 行业(传媒)AI驱动增长

## 稳定客户
6. CUS-1606 公共机构 = 稳定无波动
   证据链：3个月均40k + 满意度3.8 + 行业(政府)稳步推进

## 严格评分
- 0.9-1.0: CUS-1604标为最高风险+CUS-1602标为中风险+3个增长客户识别完整+有证据链
- 0.7-0.8: 识别了2个风险+2个增长客户，有部分证据
- 0.5-0.6: 识别了主要风险(CUS-1604)和至少1个增长客户
- 0.3-0.4: 仅识别了部分风险或增长但缺乏分析
- 0.0-0.2: 未有效识别风险和机会
"""

    _REPORT_QUALITY_RUBRIC = """\
评估客户回顾报告的完整性和质量（0.0-1.0）。

## 报告必须包含的要素
1. 按客户逐一分析（6个客户全覆盖）
2. 行业动态关联（至少4对客户-行业匹配）
   - 鼎新↔软件增长、瀚海↔电商竞争、万通↔物流数字化、前锋↔制造预算缩减、阳光↔传媒AI、公共↔政府信息化
3. 客户经理对应关系
   - 赵蕾负责VIP: CUS-1601鼎新, CUS-1603万通, CUS-1605阳光
   - 张伟负责标准: CUS-1602瀚海, CUS-1604前锋, CUS-1606公共
4. 风险预警和建议措施（如CUS-1604需紧急跟进、CUS-1602需改善服务响应）
5. 增长机会和行动建议（如CUS-1603推动扩展、CUS-1605深化AI合作）
6. 报告结构清晰，有分类、有数据支撑

## 严格评分
- 0.9-1.0: 6个要素全部覆盖，报告结构清晰专业，数据引用准确
- 0.7-0.8: 至少5个要素，结构较好
- 0.5-0.6: 至少3个要素但结构或深度不足
- 0.3-0.4: 要素覆盖少或过于粗糙
- 0.0-0.2: 报告不完整或质量很差
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

        # --- Tool usage gate (5 services) ---
        fin_calls = [d for d in dispatches
                     if d.tool_name in ("finance_list_transactions", "finance_get_transaction") and d.response_status < 400]
        crm_calls = [d for d in dispatches
                     if d.tool_name in ("crm_list_customers", "crm_get_customer") and d.response_status < 400]
        gmail_calls = [d for d in dispatches
                       if d.tool_name in ("gmail_list_messages", "gmail_get_message") and d.response_status < 400]
        rss_calls = [d for d in dispatches
                     if d.tool_name in ("rss_list_feeds", "rss_get_feed", "rss_get_article") and d.response_status < 400]
        contacts_calls = [d for d in dispatches
                          if d.tool_name in ("contacts_search", "contacts_get") and d.response_status < 400]

        tool_penalty = 1.0
        if len(fin_calls) < 1:
            tool_penalty *= 0.4
        if len(crm_calls) < 1:
            tool_penalty *= 0.4
        if len(gmail_calls) < 1:
            tool_penalty *= 0.5
        if len(rss_calls) < 1:
            tool_penalty *= 0.5
        if len(contacts_calls) < 1:
            tool_penalty *= 0.6

        # --- LLM judge scoring ---
        completion = 0.0
        if judge:
            conversation = self.format_conversation(messages)

            # Customer analysis (35%)
            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._CUSTOMER_ANALYSIS_RUBRIC)
                completion += 0.35 * result.score
                print(f"[grader] customer_analysis: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] customer_analysis judge failed: {e}")

            # Risk & opportunity identification (35%)
            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._RISK_OPPORTUNITY_RUBRIC)
                completion += 0.35 * result.score
                print(f"[grader] risk_opportunity: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] risk_opportunity judge failed: {e}")

            # Report quality (30%)
            try:
                result = judge.evaluate(
                    task.prompt.text, conversation, "", self._REPORT_QUALITY_RUBRIC)
                completion += 0.30 * result.score
                print(f"[grader] report_quality: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] report_quality judge failed: {e}")

        completion *= tool_penalty

        scores.completion = min(round(completion, 4), 1.0)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
