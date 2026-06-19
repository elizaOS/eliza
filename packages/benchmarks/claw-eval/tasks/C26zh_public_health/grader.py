"""C26zh_public_health grader — multi-turn user-agent consultation: 公共卫生."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA214Grader(UserAgentClarifyGraderBase):
    """公共卫生 — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.35 * numerical + 0.30 * content
    """

    DOMAIN = "公共卫生"
    MUST_ASK = [
        "机构名称",
        "考核组织方和时间背景",
        "考核中指出的具体不达标项",
        "各项指标的具体数据（管理人数、管理率等）",
        "辖区常住人口数和老年人口数",
        "电子健康档案建档和更新数据",
    ]

    CLARIFICATION_RUBRIC = """评估助手在对话中的信息收集质量（0.0-1.0）。
不仅看第一轮的提问，也看整个对话过程中助手是否逐步深入收集了做分析和写报告所需的信息。

## 基础信息（必须收集，缺失任意一项不超过0.7）
  - 机构名称
  - 考核背景（谁组织的、什么时间）
  - 考核中指出的具体问题/不达标项
  - 高血压在管患者数和规范管理人数
  - 辖区老年人口数和体检完成人数

## 深入信息（好的顾问会进一步追问，每覆盖一项加分）
  - 电子健康档案建档总数和动态更新数
  - 糖尿病在管数据（管理人数、规范管理人数）
  - 辖区常住人口总数（计算建档率需要）
  - 家庭医生签约团队数量
  - 上季度的考核数据（做对比分析）
  - 高血压患者失访情况
  - 系统数据与手工台账是否一致

评分标准：
- 1.0：基础信息全部收集 + 主动追问了3项以上深入信息（含数据一致性问题）
- 0.8-0.9：基础信息全部收集 + 追问了1-2项深入信息
- 0.7：基础信息全部收集，但未追问任何深入信息
- 0.4-0.6：基础信息缺失1-2项
- 0.1-0.3：几乎没有主动提问，直接基于不完整信息给出回答
- 0.0：完全没有任何澄清行为

注意：
- 如果用户主动提供了部分信息，助手只需询问缺失的部分即可
- 深入信息不要求在第一轮就问完，可以在后续对话中自然追问
- 特别关注：助手是否追问了数据来源的可靠性（手工 vs 系统），这是高质量信息收集的标志"""

    TRAJECTORY_RUBRIC = """请评估整个对话过程中，助手对用户意图的理解和响应质量（0.0-1.0）。
不要只看最终回答，而是审视每一轮对话中助手的表现。

## 评估维度

### 1. 信息缺失识别（用户没给的关键信息，助手是否察觉并追问）
- 用户的初始 query 只问了"考核指标有没有变"和"高血压规范管理率算法改没改"
- 要写整改报告还需要大量具体数据（人数、比率），助手是否识别并主动询问
- 助手是否在第一轮就识别出缺失并主动询问，而非先给模糊回答再补问

### 2. 需求理解深度
- 用户表面在问"指标有没有变"，实际需求是：(1)确认最新考核标准 (2)帮忙写整改报告 (3)计算各项指标
- 助手是否准确理解了这个多层需求，而非只回答表面问题

### 3. 数据矛盾捕捉
- 用户手工台账记录3402人，系统显示3648人，差246人
- 助手是否注意到这个不一致并追问核实，或在计算时进行说明
- 如果用户提到两个数据源不一致，助手是否恰当处理了这种不确定性

### 4. 工具使用合理性
- **计算工具**：考核指标计算涉及多个百分比，是否在需要精确计算时主动调用工具
  - 一次通过最优，自我修正次优（扣0.1-0.2），错误未发现最差（扣0.3-0.5）
- **搜索工具**：
  - 用户明确问到"最新版规范里考核指标有没有变"，助手是否搜索了最新政策
  - 搜索《国家基本公共卫生服务规范》第四版/最新版相关内容
  - 优秀(不扣分)：精准搜索1-3次覆盖关键政策信息
  - 良好(扣0.05)：搜索了但查询不够精准，需4-5次
  - 一般(扣0.1)：过度搜索（6次以上）或重复搜索
  - 未搜索(扣0.1)：完全没有使用搜索工具确认政策更新，直接凭记忆回答

### 5. 对话节奏控制
- 是否在收集到足够数据后及时给出计算结果和报告框架
- 是否在合适时机给出阶段性结论，而非一直追问不给答案

## 评分标准
- 1.0：每一轮都精准理解用户意图，数据矛盾及时捕捉，工具使用高效恰当
- 0.7-0.9：整体理解准确，工具使用基本合理，偶有一轮响应不够精准
- 0.4-0.6：部分轮次理解偏差明显，或工具使用不当
- 0.1-0.3：多轮对话中反复出现意图误解或信息遗漏
- 0.0：完全无法跟踪用户意图"""

    NUMERICAL_RUBRIC = """请只评估助手回答中的数值计算准确性（0.0-1.0）。不要考虑内容质量、建议好坏等因素，只关注数字对不对。

## 话题一致性（前置检查）
原始问题是关于「基本公共卫生服务项目慢病管理考核指标计算 + 整改报告」。
如果助手的最终回答完全偏离了这个主题，数值准确性直接判0。

## 用户提供的参数
  - 辖区常住人口: 58000人
  - 高血压在管患者数: 4860人
  - 高血压规范管理人数（手工台账）: 3402人
  - 高血压规范管理人数（系统数据）: 3648人
  - 高血压血压达标人数: 3110人
  - 老年人（65岁以上）常住人口: 7250人
  - 老年人健康体检完成人数: 4930人
  - 电子健康档案建档数: 49300份
  - 动态更新档案数: 39440份
  - 糖尿病在管患者数: 1520人
  - 糖尿病规范管理人数: 1064人
  - 糖尿病血糖达标人数: 912人

## 正确参考值（程序化计算：指标 = 分子/分母 × 100%）

**核心指标（必须计算）：**

| 检查项 | 公式 | 正确值 | 允许误差 |
|--------|------|--------|----------|
| 高血压规范管理率（台账） | 3402/4860×100% | **69.96%≈70.0%** | ±1个百分点 |
| 老年人健康管理率 | 4930/7250×100% | **68.0%** | ±1个百分点 |
| 电子档案动态更新率 | 39440/49300×100% | **80.0%** | ±1个百分点 |

**扩展指标（如果用户提供了数据且助手计算了，加分；未计算不扣分）：**

| 检查项 | 公式 | 正确值 | 允许误差 |
|--------|------|--------|----------|
| 高血压规范管理率（系统） | 3648/4860×100% | **75.06%≈75.1%** | ±1个百分点 |
| 电子档案建档率 | 49300/58000×100% | **85.0%** | ±1个百分点 |
| 糖尿病规范管理率 | 1064/1520×100% | **70.0%** | ±1个百分点 |
| 高血压血压控制率 | 3110/4860×100% | **64.0%** | ±1个百分点 |
| 糖尿病血糖控制率 | 912/1520×100% | **60.0%** | ±1个百分点 |
| 台账与系统的差距 | 3648-3402 | **246人** | ±0 |
| 台账与系统管理率差距 | 75.06%-69.96% | **5.1个百分点** | ±0.5个百分点 |

## 评分规则（严格执行，不要被内容质量影响）
- 1.0：三个核心指标全部在误差范围内，且至少正确计算了2个扩展指标
- 0.8-0.9：三个核心指标正确，扩展指标未计算或仅计算1个
- 0.6-0.7：核心指标中2个正确，1个有偏差（偏差在1-3个百分点之间）
- 0.4-0.5：核心指标中仅1个正确，或使用了错误的分子/分母
- 0.2-0.3：尝试计算但多数数值偏差超过3个百分点
- 0.0-0.1：未进行任何数值计算，或使用的参数与用户提供的完全不一致
- 如果助手混淆了台账数据和系统数据而未说明，扣0.1
- 如果助手发现并指出了台账（3402）和系统（3648）的差异，额外加0.05（上限1.0）"""

    CONTENT_RUBRIC = """请评估助手回答的内容质量（0.0-1.0）。不要考虑数值是否准确，只关注回答的完整性、专业性、实用性。

## 话题一致性（前置检查）
原始问题是关于「基本公共卫生服务规范最新版慢病管理考核指标 + 整改报告撰写」。
如果助手的最终回答完全偏离了这个主题，内容质量直接判0。

## 用户完整情况（对话中逐步透露）
  - 某区社区卫生服务中心，区卫健局2024年Q2督导考核
  - 问题：高血压规范管理率未达标、老年人体检完成率偏低、电子档案更新不及时
  - 手工台账高血压规范管理人数3402人，系统显示3648人（不一致）
  - 高血压在管4860人，老年人口7250人体检4930人
  - 电子档案49300份动态更新39440份，常住人口58000人
  - 糖尿病在管1520人规范管理1064人，血糖达标912人
  - 高血压血压达标3110人，失访约286人（不确定是否296人）
  - 6个全科团队，上季度规范管理率65.2%（旧算法）

## 关键矛盾（高质量回答应发现并分析）
用户提供的信息中存在明确矛盾：
  - 手工台账记录的高血压规范管理人数是3402人（规范管理率69.96%）
  - 系统自动统计的是3648人（规范管理率75.06%）
  - 差距246人，一个达标（若标准60%则两个都达标，若标准75%则台账不达标系统刚达标）
  - 好的助手应该发现这个差异并分析可能原因：系统计算口径不同（如是否包含失访人员）、手工台账剔除了不规范记录、系统自动补录了部分数据等
  - 更好的助手会建议用户先核实数据一致性再上报，避免数据质量问题在督导中被追问

## 评估标准：完整决策链路（6个步骤）

### Step 1: 政策规范确认（必备，缺失则不超过0.4）
- 回答了用户最初的问题：最新版规范中慢病管理考核指标是否有变化
- 说明了高血压规范管理率的计算公式：规范管理人数/管理人数×100%
- 提到了第三版或第四版规范的相关要求

### Step 2: 数据矛盾处理（重要加分项，+0.15）
这是区分普通助手和优秀助手的关键维度：
- **发现台账与系统数据不一致**：注意到3402人和3648人的差异并主动追问或指出 (+0.05)
- **分析差异原因**：给出了合理的可能原因（计算口径不同、失访处理方式不同、系统自动补录等） (+0.05)
- **给出数据核实建议**：建议用户在上报前先核实数据一致性，明确以哪套数据为准 (+0.05)
- 如果助手完全没有注意到数据不一致，此项得0

### Step 3: 指标计算与分析（必备，缺失则不超过0.6）
- 计算了高血压规范管理率、老年人健康管理率、电子档案更新率等核心指标
- 将计算结果与考核标准进行了对比分析
- 结合上季度数据分析了变化趋势

### Step 4: 领域知识应用（加分项，每项 +0.04）
- **规范管理判定标准**：说明了什么样的随访才算"规范管理"（如随访频次、血压监测记录完整性、用药方案调整记录等） (+0.04)
- **失访处理规则**：说明了失访患者在计算规范管理率时如何处理（分母是否包含失访） (+0.04)
- **老年人体检政策**：提到65岁以上老年人每年一次免费健康体检是国家基本公卫项目要求，体检内容包括哪些 (+0.04)
- **电子档案质量要求**：提到档案动态更新的时效性要求（如诊疗信息应在多少天内更新） (+0.04)
- **绩效考核关联**：提到基本公卫项目经费与考核结果挂钩的机制 (+0.04)

### Step 5: 整改报告撰写（加分项，+0.05）
- 提供了结构完整的整改报告框架或范文（含问题描述、原因分析、整改措施、时间节点）
- 报告内容针对用户的三个具体问题逐一展开
- 数据处合理留空或用占位符标注

### Step 6: 可操作的行动方案（加分项，+0.04）
- 给出了具体的整改操作步骤（如组织培训、补访、数据清理等）
- 建议了数据核查流程（台账与系统对账）
- 使用了结构化格式方便用户直接参照执行

## 评分汇总
- Step 1 + Step 3 都满足：基础分 0.5
- Step 2（数据矛盾处理）：最高 +0.15
- Step 4 每个知识点 +0.04（最高 +0.20）
- Step 5: +0.05
- Step 6: +0.04
- 理论满分路径：0.5 + 0.15 + 0.20 + 0.05 + 0.04 = 0.94
- 如果在以上基础上回答特别出色（如给出了用户没想到的洞察），可酌情给到 1.0"""

    # Keep FINAL_ANSWER_RUBRIC empty so base class won't make its own call
    FINAL_ANSWER_RUBRIC = ""

    def grade(self, messages, dispatches, task, audit_data=None, judge=None,
              media_events=None, env_snapshot=None):
        from claw_eval.models.trace import DimensionScores

        scores = DimensionScores()
        scores.safety = 1.0
        scores.robustness = 1.0

        if judge is None:
            return scores

        full_conversation = self.format_conversation_detailed(
            messages, include_tool_use=True, include_tool_result=True,
        )
        clarify_conversation, _ = self._split_phases(messages)
        prompt_text = task.prompt.text

        # 1. Clarification quality (15%)
        clarify_score = 0.0
        if self.CLARIFICATION_RUBRIC and clarify_conversation:
            try:
                result = judge.evaluate(prompt_text, clarify_conversation, "",
                                        self.CLARIFICATION_RUBRIC)
                clarify_score = result.score
                print(f"[grader] clarification score: {clarify_score:.2f} — {result.reasoning[:200]}")
            except Exception as exc:
                print(f"[grader] clarification judge failed: {exc}")

        # 2. Trajectory quality (20%) — full conversation intent understanding
        trajectory_score = 0.0
        try:
            result = judge.evaluate(prompt_text, full_conversation, "",
                                    self.TRAJECTORY_RUBRIC)
            trajectory_score = result.score
            print(f"[grader] trajectory score: {trajectory_score:.2f} — {result.reasoning[:200]}")
        except Exception as exc:
            print(f"[grader] trajectory judge failed: {exc}")

        # 3. Numerical accuracy (35%)
        numerical_score = 0.0
        try:
            result = judge.evaluate(prompt_text, full_conversation, "",
                                    self.NUMERICAL_RUBRIC)
            numerical_score = result.score
            print(f"[grader] numerical score: {numerical_score:.2f} — {result.reasoning[:200]}")
        except Exception as exc:
            print(f"[grader] numerical judge failed: {exc}")

        # 4. Content quality (30%)
        content_score = 0.0
        try:
            result = judge.evaluate(prompt_text, full_conversation, "",
                                    self.CONTENT_RUBRIC)
            content_score = result.score
            print(f"[grader] content score: {content_score:.2f} — {result.reasoning[:200]}")
        except Exception as exc:
            print(f"[grader] content judge failed: {exc}")

        # Combine: 15% clarify + 20% trajectory + 35% numerical + 30% content
        scores.completion = round(
            0.15 * clarify_score +
            0.20 * trajectory_score +
            0.35 * numerical_score +
            0.30 * content_score,
            4
        )
        print(f"[grader] completion: {scores.completion:.4f} "
              f"(clarify={clarify_score:.2f}*0.15 + trajectory={trajectory_score:.2f}*0.20 "
              f"+ numerical={numerical_score:.2f}*0.35 + content={content_score:.2f}*0.30)")

        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
