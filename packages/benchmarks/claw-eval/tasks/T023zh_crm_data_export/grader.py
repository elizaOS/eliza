"""T12_crm_data_export grader — error recovery + VIP customer reporting."""

from __future__ import annotations

import logging
from typing import Any

from claw_eval.graders.base import AbstractGrader

log = logging.getLogger(__name__)
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class CRMDataExportGrader(AbstractGrader):
    """Grader for T12_crm_data_export: error recovery + VIP customer reporting."""

    VIP_CUSTOMERS = {
        "CUS-001": {"name": "北京云创科技有限公司", "industry": "科技",
                     "revenue": 5200000, "last_contact": "2026-02-20"},
        "CUS-003": {"name": "深圳智联电子科技有限公司", "industry": "电子",
                     "revenue": 8900000, "last_contact": "2026-02-25"},
        "CUS-005": {"name": "成都天府软件园科技公司", "industry": "科技",
                     "revenue": 3600000, "last_contact": "2026-02-27"},
        "CUS-007": {"name": "武汉光谷生物科技有限公司", "industry": "生物科技",
                     "revenue": 12000000, "last_contact": "2026-02-26"},
    }

    # Short names / aliases for matching
    VIP_NAME_ALIASES = {
        "CUS-001": ["云创", "北京云创"],
        "CUS-003": ["智联", "深圳智联"],
        "CUS-005": ["天府", "成都天府"],
        "CUS-007": ["光谷", "武汉光谷"],
    }

    _REPORT_QUALITY_RUBRIC = """\
评估agent生成的VIP客户报告质量。
请分别评估以下三个部分，然后按权重计算最终加权分（0-1之间）。

=== 第一部分：客户信息完整性（权重40%）===
报告应包含全部4位VIP客户，每位客户应有以下4个字段：
- 客户名称
- 行业分类
- 年收入
- 最近联系日期

参考数据：
- CUS-001 北京云创科技有限公司: 行业=科技, 收入=5,200,000, 最近联系=2026-02-20
- CUS-003 深圳智联电子科技有限公司: 行业=电子, 收入=8,900,000, 最近联系=2026-02-25
- CUS-005 成都天府软件园科技公司: 行业=科技, 收入=3,600,000, 最近联系=2026-02-27
- CUS-007 武汉光谷生物科技有限公司: 行业=生物科技, 收入=12,000,000, 最近联系=2026-02-26

本部分评分标准：
- 0.9-1.0: 全部4位客户均列出，且每位客户都有完整的4个字段
- 0.7-0.8: 4位客户均列出，但部分字段缺失
- 0.5-0.6: 列出了3位客户
- 0.3-0.4: 仅列出1-2位客户
- 0.0-0.2: 未列出VIP客户或报告为空

=== 第二部分：数据准确性（权重35%）===
检查报告中的具体数据是否与参考数据一致：
- 行业分类是否正确
- 收入数字是否正确（允许"万"等单位换算）
- 日期是否正确

本部分评分标准：
- 0.9-1.0: 所有数据字段准确无误
- 0.7-0.8: 大部分数据正确，1-2处小偏差
- 0.5-0.6: 约一半数据正确
- 0.3-0.4: 多数数据不准确
- 0.0-0.2: 数据严重错误或虚构

=== 第三部分：报告结构（权重25%）===
- 是否使用了表格或清晰的结构化格式
- 是否有标题和分区
- 是否有汇总信息（如总收入、行业分布等）
- 是否提到了错误恢复过程（任务涉及API不稳定）

本部分评分标准：
- 0.9-1.0: 完整的结构化报告（表格+标题+汇总+错误说明）
- 0.7-0.8: 有基本表格和结构
- 0.5-0.6: 简单列表形式
- 0.3-0.4: 纯文本叙述
- 0.0-0.2: 无结构

请输出最终的加权分数：score = 0.40×第一部分 + 0.35×第二部分 + 0.25×第三部分"""

    def _match_customer(self, cid: str, text: str) -> bool:
        """Check if a customer is mentioned by ID, full name, or alias."""
        info = self.VIP_CUSTOMERS[cid]
        if cid in text or info["name"] in text:
            return True
        return any(alias in text for alias in self.VIP_NAME_ALIASES.get(cid, []))

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

        final_text = self._get_final_assistant_text(messages)
        all_text = self._get_all_assistant_text(messages)
        combined_text = final_text + "\n" + all_text

        # --- Completion ---
        completion = 0.0

        # 1. Listed customers (0.10)
        list_calls = [d for d in dispatches if d.tool_name == "crm_list_customers"]
        successful_list = [d for d in list_calls if d.response_status < 400]
        if successful_list:
            vip_filtered = any(
                d.request_body.get("tier") in ("VIP", "vip")
                for d in successful_list
            )
            if vip_filtered:
                completion += 0.10
            else:
                completion += 0.06

        # 2. Retrieved VIP customer details (0.30)
        get_calls = [d for d in dispatches if d.tool_name == "crm_get_customer"]
        successful_gets = [d for d in get_calls if d.response_status < 400]
        retrieved_ids = {d.request_body.get("customer_id") for d in successful_gets}
        vip_retrieved = retrieved_ids & set(self.VIP_CUSTOMERS.keys())
        completion += 0.30 * (len(vip_retrieved) / len(self.VIP_CUSTOMERS))

        # 3. Exported report (0.15)
        export_calls = [d for d in dispatches if d.tool_name == "crm_export_report"]
        successful_exports = [d for d in export_calls if d.response_status < 400]
        if successful_exports:
            last_export = successful_exports[-1]
            exported_ids = set(last_export.request_body.get("customer_ids", []))
            vip_in_export = exported_ids & set(self.VIP_CUSTOMERS.keys())
            export_ratio = len(vip_in_export) / len(self.VIP_CUSTOMERS)
            completion += 0.15 * export_ratio

        # 4. VIP customers mentioned in output (0.15)
        mentioned = sum(
            1 for cid in self.VIP_CUSTOMERS
            if self._match_customer(cid, combined_text)
        )
        completion += 0.15 * (mentioned / len(self.VIP_CUSTOMERS))

        # 5. Report content quality (0.30) — LLM judge via evaluate()
        report_score = self._judge_report_quality(
            judge, task.prompt.text, messages, audit_data,
        )
        completion += 0.30 * report_score

        scores.completion = min(completion, 1.0)

        # --- Robustness ---
        error_dispatches = [d for d in dispatches if d.response_status >= 400]
        if not error_dispatches:
            scores.robustness = 1.0
        else:
            errored_tools: dict[str, int] = {}
            for d in error_dispatches:
                errored_tools[d.tool_name] = errored_tools.get(d.tool_name, 0) + 1

            recovered_tools: set[str] = set()
            seen_errors: set[str] = set()
            for d in dispatches:
                if d.response_status >= 400:
                    seen_errors.add(d.tool_name)
                elif d.tool_name in seen_errors and d.response_status < 400:
                    recovered_tools.add(d.tool_name)

            if errored_tools:
                recovery_rate = len(recovered_tools) / len(errored_tools)
            else:
                recovery_rate = 0.7

            task_completed = bool(successful_exports) and len(vip_retrieved) >= 3
            if task_completed and recovery_rate >= 0.8:
                scores.robustness = min(1.0, recovery_rate + 0.1)
            else:
                scores.robustness = round(recovery_rate, 2)

        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )

        return scores

    # ------------------------------------------------------------------
    # LLM judge for report content quality (via evaluate())
    # ------------------------------------------------------------------

    def _judge_report_quality(
        self,
        judge: Any,
        task_prompt: str,
        messages: list[TraceMessage],
        audit_data: dict[str, dict] | None,
    ) -> float:
        """Use judge.evaluate() to assess report content quality."""
        result = judge.evaluate(
            task_prompt,
            self.format_conversation(messages),
            self.summarize_actions(audit_data),
            self._REPORT_QUALITY_RUBRIC,
        )
        return result.score
