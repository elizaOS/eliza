"""T137zh_restock_chain_check grader — scheduler + config + inventory."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class RestockChainCheckGrader(AbstractGrader):
    """Grader for T172zh: trace restock failure chains across scheduler, config, inventory.

    Scoring design:
    - Tool usage is a prerequisite gate.
    - LLM judge evaluates chain tracing, root cause, and remediation.
    """

    FAILED_JOBS = {"JOB-802", "JOB-803", "JOB-804"}

    _CHAIN_RUBRIC = """\
评估故障链追踪的完整性（0.0-1.0）。

## 3条故障链
1. JOB-802(IT设备,API超时) → INT-802(错误率35%) → INV-803(显示器缺货)+INV-804(键盘缺货)
2. JOB-803(清洁用品,已禁用) → INT-803(已停用) → INV-805(洗手液缺货)+INV-806(垃圾袋缺货)
3. JOB-804(耗材,认证失败) → INT-804(凭证过期) → INV-807(墨盒缺货)

## 严格评分
- 0.9-1.0: 3条链全部正确追踪（任务→配置→库存）
- 0.6-0.8: 2条正确
- 0.3-0.5: 1条正确
- 0.0-0.2: 未完成链路追踪
"""

    _ROOT_CAUSE_RUBRIC = """\
评估根因分析的准确性（0.0-1.0）。

## 3个根因
1. INT-802: 供应商API错误率过高(35%)，可能是供应商服务不稳定
2. INT-803: 供应商合作终止(2月停用)，集成已停用但未寻找替代
3. INT-804: API密钥过期(credentials_expired=true)，需更新凭证

## 严格评分
- 0.9-1.0: 3个根因全部准确识别
- 0.6-0.8: 2个准确
- 0.3-0.5: 1个准确
- 0.0-0.2: 根因分析错误
"""

    _REMEDIATION_RUBRIC = """\
评估修复建议的质量（0.0-1.0）。

## 合理的修复建议
1. INT-802: 联系供应商排查→设置重试机制→临时手动补货
2. INT-803: 寻找新供应商→紧急手动采购清洁用品
3. INT-804: 更新API密钥→验证连接→触发手动补货
4. 通用: 完善监控告警，任务失败时及时通知

## 严格评分
- 0.9-1.0: 每条链有具体修复+短期应急方案
- 0.6-0.8: 有修复方向但不够具体
- 0.3-0.5: 笼统建议
- 0.0-0.2: 无建议
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
        job_calls = [d for d in dispatches if d.tool_name == "scheduler_get_job" and d.response_status < 400]
        jobs_checked = {d.request_body.get("job_id") for d in job_calls}
        failed_checked = jobs_checked & self.FAILED_JOBS

        config_calls = [d for d in dispatches
                        if d.tool_name in ("config_list_integrations", "config_get_integration") and d.response_status < 400]
        inv_calls = [d for d in dispatches
                     if d.tool_name in ("inventory_list_items", "inventory_get_item") and d.response_status < 400]

        tool_penalty = 1.0
        if len(failed_checked) < 2:
            tool_penalty *= 0.5
        if len(config_calls) < 1:
            tool_penalty *= 0.6
        if len(inv_calls) < 1:
            tool_penalty *= 0.6

        # --- LLM judge scoring ---
        completion = 0.0
        if judge:
            conversation = self.format_conversation(messages)
            try:
                result = judge.evaluate(task.prompt.text, conversation, "", self._CHAIN_RUBRIC)
                completion += 0.35 * result.score
                print(f"[grader] chain: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] chain judge failed: {e}")
            try:
                result = judge.evaluate(task.prompt.text, conversation, "", self._ROOT_CAUSE_RUBRIC)
                completion += 0.35 * result.score
                print(f"[grader] root_cause: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] root_cause judge failed: {e}")
            try:
                result = judge.evaluate(task.prompt.text, conversation, "", self._REMEDIATION_RUBRIC)
                completion += 0.30 * result.score
                print(f"[grader] remediation: {result.score:.2f}")
            except Exception as e:
                print(f"[grader] remediation judge failed: {e}")

        completion *= tool_penalty
        scores.completion = min(round(completion, 4), 1.0)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len([m for m in messages if m.message.role == "assistant"])
        return scores
