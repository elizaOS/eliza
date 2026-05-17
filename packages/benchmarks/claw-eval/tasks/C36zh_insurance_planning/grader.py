"""C36zh_insurance_planning grader — multi-turn user-agent consultation: 家庭保险规划."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA263Grader(UserAgentClarifyGraderBase):
    """保险规划 — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.35 * numerical + 0.30 * content
    """

    DOMAIN = "保险规划"
    MUST_ASK = [
        "家庭成员构成及各成员年龄",
        "各成员健康状况（既往病史、体检异常）",
        "家庭年收入及负债情况（房贷等）",
        "已有保障（社保、团险、商业保险）",
        "保费预算",
    ]

    CLARIFICATION_RUBRIC = """评估助手在对话中的信息收集质量（0.0-1.0）。
不仅看第一轮的提问，也看整个对话过程中助手是否逐步深入收集了做保险规划所需的信息。

## 第一批基础信息（必须收集，缺失任意一项不超过0.7）
  - 家庭成员构成（几口人、各自角色）
  - 家庭收入水平
  - 已有保障情况（社保、商保）
  - 想配保险的原因/担忧

## 第二批重要信息（好的顾问会进一步追问，追问1-2项可到0.8-0.9）
  - 各家庭成员的具体年龄
  - 家庭负债情况（房贷金额、剩余年限）
  - 团险的具体保障内容和保额
  - 家庭月度收支结余

## 第三批深入信息（追问到这些可到1.0）
  - 各成员的健康状况和体检异常（如脂肪肝、慢性病等）
  - 明确的保费预算上限
  - 对保险的认知程度和偏好（消费型vs返还型）
  - 孩子的教育规划（影响教育金需求）

评分标准：
- 1.0：三批信息基本全部收集到，提问系统且有层次
- 0.8-0.9：前两批信息收集完整，第三批追问了1-2项
- 0.7：第一批信息全部收集，但未深入追问
- 0.4-0.6：第一批信息缺失1-2项
- 0.1-0.3：几乎没有主动提问，直接给笼统建议
- 0.0：完全没有任何澄清行为

注意：
- 如果用户主动提供了部分信息，助手只需询问缺失的部分即可
- 提问应该自然、有条理，不像在审问用户
- 深入信息不要求在第一轮就问完，可以在后续对话中自然追问"""

    TRAJECTORY_RUBRIC = """请评估整个对话过程中，助手对用户意图的理解和响应质量（0.0-1.0）。
不要只看最终回答，而是审视每一轮对话中助手的表现。

## 评估维度

### 1. 信息缺失识别（用户没给的关键信息，助手是否察觉并追问）
- 用户的初始 query 只说"想给家里配保险，社保不够"，严重缺乏做规划所需的信息
- 助手是否在前几轮就识别出缺失并系统地询问：年龄、健康、收入、负债、已有保障、预算
- 是否分优先级地追问，而非一次性抛出十几个问题吓到用户

### 2. 信息修正与补充捕捉
- 用户说"公司有团险但保额不清楚"——助手是否建议用户先查清团险保障再配置
- 用户提到丈夫有脂肪肝——助手是否立即意识到这会影响核保，并调整方案

### 3. 需求演变跟踪
- 用户的需求可能从笼统的"配保险"逐步聚焦到"预算2万怎么分配"
- 助手是否跟上了需求的细化过程

### 4. 工具使用合理性
- **计算工具**：保障缺口计算、保费估算等是否使用了计算工具精确计算
  - 一次通过 = 最优
  - 自我修正 = 次优，扣0.1-0.2
  - 错误未发现 = 扣0.3-0.5
- **搜索工具**：保险产品信息时效性强，好的助手应搜索验证
  - 搜索了当前市场上的具体产品和费率 = 优秀
  - 搜索了但结果利用不充分 = 良好(扣0.05)
  - 过度搜索(6次以上) = 扣0.1
  - 完全没搜索，凭记忆推荐产品 = 扣0.1（信息可能过时）

### 5. 对话节奏控制
- 是否在收集够信息后及时给出方案，而非反复追问不给结论
- 方案是否分层次呈现（先总体思路，再各成员具体配置）

## 评分标准
- 1.0：每一轮都精准理解用户意图，信息收集高效有序，工具使用恰当，节奏把控好
- 0.7-0.9：整体理解准确，偶有一轮响应不够精准
- 0.4-0.6：部分轮次理解偏差（如忽略脂肪肝对核保的影响），或工具使用不当
- 0.1-0.3：多轮对话中反复出现意图误解或信息遗漏
- 0.0：完全无法跟踪用户意图"""

    NUMERICAL_RUBRIC = """请只评估助手回答中的数值计算准确性（0.0-1.0）。不要考虑内容质量、建议好坏等因素，只关注数字对不对。

## 话题一致性（前置检查）
原始问题是关于「家庭保险规划配置方案」。
如果助手的最终回答完全偏离了这个主题，数值准确性直接判0。

## 用户提供的参数
  - 家庭年收入: 30万
  - 房贷月供: 8000元
  - 家庭结构: 夫妻+1孩（丈夫35岁/妻子32岁/孩子3岁）
  - 丈夫轻度脂肪肝，妻子健康
  - 已有社保+公司团险（保额不清楚）
  - 保费预算: ≤2万/年

## 正确参考值（程序化计算）

### 保障缺口计算

| 检查项 | 正确值 | 允许误差 |
|--------|--------|----------|
| 身故保障总需求 | **约350万**（房贷余额约150万 + 5年家庭开支150万 + 教育金约50万） | ±50万（因房贷余额和教育金估算有弹性） |
| 已有保障 | **约10-20万**（团险通常保额；社保无身故赔付） | 合理范围即可 |
| 身故保障缺口 | **约330-340万** | ±50万 |
| 重疾保障建议 | **90-150万**（3-5倍年收入） | 范围合理即可 |

### 双十原则

| 检查项 | 正确值 | 允许误差 |
|--------|--------|----------|
| 年保费上限（年收入10%） | **3万** | 准确值 |
| 保额下限（年收入10倍） | **300万** | 准确值 |
| 用户实际预算占收入比 | **6.7%** | ±1% |

### 各成员保费估算（年缴）

| 检查项 | 合理范围 | 备注 |
|--------|----------|------|
| 丈夫定期寿险(100万/30年) | **1200-1500元/年** | 35岁男性标准费率 |
| 丈夫重疾险(50万) | **6000-8000元/年** | 脂肪肝可能加费10-20% |
| 丈夫百万医疗 | **300-500元/年** | 35岁有社保 |
| 丈夫意外险(100万) | **200-300元/年** | |
| 妻子定期寿险(50万) | **600-1000元/年** | 32岁女性 |
| 妻子重疾险(50万) | **4500-6500元/年** | 32岁女性健康体 |
| 妻子百万医疗 | **250-450元/年** | |
| 妻子意外险 | **150-300元/年** | |
| 孩子少儿重疾(30-50万) | **1500-2500元/年** | |
| 孩子医疗/意外 | **300-800元/年** | |
| **全家合计** | **15000-20000元/年** | 需在2万预算内 |

## 评分规则（严格执行）
- 1.0：保障缺口计算合理，保费估算均在合理范围内，双十原则引用正确
- 0.7-0.9：大框架正确，个别险种保费估算偏差在合理范围的50%以内
- 0.4-0.6：保障缺口计算思路正确但数值偏差较大，或保费估算明显偏离市场水平
- 0.2-0.3：基本数值框架混乱，如年收入30万却建议年保费5万以上
- 0.0-0.1：完全没有数值计算，或数值严重错误（如把月供当年供、收入算错数量级）
- 如果助手给的保费方案总额远超用户2万预算且没有说明原因，扣0.2"""

    CONTENT_RUBRIC = """请评估助手回答的内容质量（0.0-1.0）。不要考虑数值是否准确，只关注回答的完整性、专业性、实用性。

## 话题一致性（前置检查）
原始问题是关于「家庭保险规划配置方案」。
如果助手的最终回答完全偏离了这个主题，内容质量直接判0。

## 用户完整情况（对话中逐步透露）
  - 夫妻+1孩，年收入30万，房贷月供8000
  - 已有社保+团险（保额不清楚）
  - 丈夫35岁轻度脂肪肝，妻子32岁健康，孩子3岁
  - 预算2万/年

## 关键矛盾（高质量回答应发现并分析）
1. **脂肪肝与核保**：丈夫轻度脂肪肝可能导致重疾险加费承保或除外承保，好的助手应该指出这一点并给出应对策略（如选择核保宽松的产品、如实告知后等待核保结论等）
2. **团险保额不清楚**：用户说公司有团险但不知道保额——好的助手应建议先查清团险的保障范围和保额，避免重复配置，再决定商业保险的补充方案
3. **预算与需求的矛盾**：2万预算要覆盖一家三口全部险种可能吃紧，好的助手应给出优先级排序而非平均分配

## 评估标准：完整决策链路（6个步骤）

### Step 1: 需求分析与保障缺口（必备，缺失则不超过0.4）
- 分析了家庭的保障缺口（身故保障、重疾保障、医疗保障）
- 结合了家庭负债（房贷）和收入情况来确定保额需求

### Step 2: 矛盾识别与处理（重要加分项，+0.15）
- **脂肪肝核保风险**：是否指出丈夫脂肪肝可能影响重疾险/医疗险的核保结果，并给出应对建议 (+0.05)
- **团险查清建议**：是否建议用户先查清公司团险的具体保障内容，避免重复配置 (+0.05)
- **预算优先级**：是否明确指出2万预算可能不够配齐所有险种，需要按优先级排序（先保大人后保小孩、先保命后保病） (+0.05)

### Step 3: 配置方案（必备，缺失则不超过0.6）
- 给出了具体的险种配置方案（定期寿险、重疾险、百万医疗、意外险）
- 方案针对每个家庭成员分别说明
- 保额设置合理且与需求分析呼应

### Step 4: 领域知识应用（加分项，每项 +0.04）
- **双十原则**：提到保费不超过年收入10%、保额不低于年收入10倍的基本原则 (+0.04)
- **先大人后小孩**：强调应优先保障家庭经济支柱（大人），而非优先给孩子买保险 (+0.04)
- **消费型vs返还型**：在预算有限时建议选消费型保险（杠杆率高），而非返还型（保费贵） (+0.04)
- **如实告知义务**：提醒脂肪肝等健康异常必须如实告知，否则将来可能拒赔 (+0.04)
- **等待期说明**：提到重疾险/医疗险的等待期概念（通常90-180天） (+0.04)

### Step 5: 综合建议与优先级（加分项，+0.05）
- 综合所有分析给出清晰的配置优先级
- 如果预算不够，明确告知哪些必须买、哪些可以延后
- 建议考虑了用户的具体约束（脂肪肝、预算有限、团险不明）

### Step 6: 可操作的行动方案（加分项，+0.04）
- 给出了具体的下一步操作建议（如先查团险保额、带体检报告做智能核保等）
- 使用了结构化格式（表格或清单），方便用户理解和执行

## 评分汇总
- Step 1 + Step 3 都满足：基础分 0.5
- Step 2（矛盾处理）：最高 +0.15
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
