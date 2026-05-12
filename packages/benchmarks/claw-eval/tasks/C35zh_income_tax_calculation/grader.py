"""C35zh_income_tax_calculation grader — multi-turn user-agent consultation: 个税计算."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA258Grader(UserAgentClarifyGraderBase):
    """个税计算 — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.35 * numerical + 0.30 * content
    """

    DOMAIN = "个税计算"
    MUST_ASK = [
        "税前月薪（或到手月薪及五险一金扣除额）",
        "年终奖金额",
        "每月五险一金个人缴纳金额",
        "已享受的全部专项附加扣除项目及金额",
        "年终奖计税方式（单独计税/并入综合所得）",
]

    CLARIFICATION_RUBRIC = """评估助手在对话中的信息收集质量（0.0-1.0）。
不仅看第一轮的提问，也看整个对话过程中助手是否逐步深入收集了做决策所需的信息。

## 基础信息（必须收集，缺失任意一项不超过0.7）
  - 月薪金额（到手或税前）
  - 五险一金个人缴纳金额
  - 专项附加扣除项目及金额
  - 年终奖金额

## 深入信息（好的顾问会进一步追问，每覆盖一项加分）
  - 年终奖计税方式（单独计税 vs 并入综合所得）
  - 确认"到手"是税后还是税前（关键澄清点）
  - 是否有其他收入来源（稿酬、劳务报酬等）
  - 专项附加扣除是否填报完整（逐项核实）

评分标准：
- 1.0：基础信息全部收集 + 主动追问了2项以上深入信息 + 特别确认了"到手≠税前"
- 0.8-0.9：基础信息全部收集 + 追问了1项深入信息
- 0.7：基础信息全部收集，但未追问任何深入信息
- 0.4-0.6：基础信息缺失1-2项
- 0.1-0.3：几乎没有主动提问
- 0.0：完全没有任何澄清行为

注意：
- 如果用户主动提供了部分信息，助手只需询问缺失的部分即可
- 深入信息不要求在第一轮就问完，可以在后续对话中自然追问
- 特别关注：助手是否注意到用户说的"到手18000"是税后金额，并主动确认或反推税前"""

    TRAJECTORY_RUBRIC = """请评估整个对话过程中，助手对用户意图的理解和响应质量（0.0-1.0）。
不要只看最终回答，而是审视每一轮对话中助手的表现。

## 评估维度

### 1. 信息缺失识别（用户没给的关键信息，助手是否察觉并追问）
- 用户的初始 query 缺少月薪、年终奖、五险一金、专项附加扣除等关键参数
- 助手是否在第一轮就识别出缺失并主动询问，而非先给模糊回答再补问

### 2. "到手≠税前"的识别与处理（关键区分点）
- 用户说"到手约18000"，这是税后金额（银行卡实际到账），不是税前工资
- 助手是否意识到这个关键区别？是否主动确认或在计算中正确处理？
- 如果助手直接把18000当税前算，说明对个税计算的基本逻辑理解有误

### 3. 需求演变跟踪
- 用户的需求可能从"补税是否正常"演变为"年终奖计税方式对比"再到"如何更正申报"
- 助手是否跟上了需求的自然演变

### 4. 工具使用合理性（如果助手使用了计算工具）
- 是否在需要精确计算时主动调用工具，而非心算给出近似值
- 工具调用的时机是否恰当（收集到足够参数后再计算）
- **错误与修正的评判标准（严格执行）**：
  - 一次调用就得到正确结果 = 最优，不扣分
  - 调用出错但能自行发现并修正 = 次优，扣0.1-0.2
  - 调用出错且未发现，将错误结果呈现给用户 = 严重问题，扣0.3-0.5

### 5. 对话节奏控制
- 是否在合适的时机给出阶段性结论
- 用户追问新问题时，是否流畅衔接

### 6. 搜索工具使用质量
本任务涉及时效性信息（个税政策、专项附加扣除标准、年终奖过渡政策），好的助手应主动搜索验证。

**搜索必要性判断：**
- 年终奖单独计税过渡政策的截止日期——助手是否搜索确认？
- 专项附加扣除标准（如赡养老人扣除额度）——是否用最新标准？
- 个税APP更正申报操作流程——是否搜索了具体操作步骤？

**搜索质量评估：**
- 优秀(不扣分)：搜索查询精准，1-3次搜索覆盖关键信息
- 良好(扣0.05)：搜索了但查询不够精准，需要4-5次
- 一般(扣0.1)：过度搜索（6次以上）或重复搜索
- 未搜索(扣0.1)：完全没有使用搜索工具，直接凭记忆给出政策信息

## 评分标准
- 1.0：每一轮都精准理解用户意图，正确识别"到手≠税前"，工具使用高效
- 0.7-0.9：整体理解准确，偶有一轮响应不够精准
- 0.4-0.6：部分轮次理解偏差明显（如未识别到手≠税前），或工具使用不当
- 0.1-0.3：多轮对话中反复出现意图误解或信息遗漏
- 0.0：完全无法跟踪用户意图"""

    NUMERICAL_RUBRIC = """请只评估助手回答中的数值计算准确性（0.0-1.0）。不要考虑内容质量、建议好坏等因素，只关注数字对不对。

## 话题一致性（前置检查）
原始问题是关于「个税汇算清缴补税是否正常 + 年终奖计税方式选择」。
如果助手的最终回答完全偏离了这个主题，数值准确性直接判0。

## 用户提供的参数
  - 月薪：到手约18000元（税后，非税前！）
  - 五险一金：每月个人缴纳约3500元
  - 专项附加扣除：赡养老人3000 + 房贷利息1000 = 4000元/月
  - 年终奖：50000元
  - 去年选的年终奖单独计税

## 关键前提：到手18000是税后金额
到手18000 = 税前工资 - 五险一金3500 - 月个税
需要反推税前工资。正确的反推过程：
  设税前为X，月应纳税所得额 = X - 5000 - 3500 - 4000 = X - 12500
  到手 = X - 3500 - 个税(X-12500) = 18000
  解方程得 X ≈ 22267元

## 正确参考值（程序化计算）

| 检查项 | 正确值 | 允许误差 |
|--------|--------|----------|
| 税前月薪（由到手18000反推） | **22,267元** | ±200元 |
| 月应纳税所得额 | **9,767元** (22267-5000-3500-4000) | ±200元 |
| 月个税 | **767元** (9767×10%-210) | ±50元 |
| 年度工资个税（累计预扣法） | **9,200元** | ±500元 |
| 年终奖单独计税税额 | **4,790元** (50000×10%-210) | ±100元 |
| 年终奖并入综合所得额外税 | **7,320元** | ±500元 |
| 年总税（单独计税） | **13,990元** (9200+4790) | ±500元 |
| 年总税（并入综合所得） | **16,520元** | ±500元 |
| 错误计算：把到手当税前的月个税 | **340元** (5500×3%-0) | ±50元 |

## 硬性规则（严格执行）

**如果模型把"到手18000"直接当税前工资计算（即月应纳税所得额=18000-5000-3500-4000=5500，月税约340元而非767元），说明没有识别到"到手≠税前"这个关键点 → numerical 最高0.3，无论其他计算多正确。**

这是本题最核心的区分点。错误地把到手当税前会导致：
- 年度工资个税约4080元（而非9200元），差异巨大
- 年终奖单独计税4790元可能算对（不受影响）
- 但总税负和两种方案对比结论都会严重偏差

## 评分规则
- 1.0：正确反推税前工资，所有可验证数字都在允许误差范围内
- 0.7-0.9：正确反推税前工资，年终奖两种方案对比正确，个别数字有小偏差
- 0.4-0.6：正确反推税前工资，但年终奖计算或方案对比有明显偏差
- 0.3：把到手当税前算（硬性上限），即使其他部分计算正确
- 0.1-0.2：多处计算错误
- 0.0：完全没有给出数值计算，或参数引用错误"""

    CONTENT_RUBRIC = """请评估助手回答的内容质量（0.0-1.0）。不要考虑数值是否准确，只关注回答的完整性、专业性、实用性。

## 话题一致性（前置检查）
原始问题是关于「个税汇算清缴补税是否正常 + 年终奖计税方式选择」。
如果助手的最终回答完全偏离了这个主题，内容质量直接判0。

## 用户完整情况（对话中逐步透露）
  - 月薪：到手约18000元（税后）
  - 五险一金：每月3500元
  - 专项附加扣除：赡养老人3000 + 房贷利息1000 = 4000元/月
  - 年终奖：50000元，去年选的单独计税
  - 汇算清缴显示补税一千多
  - 同事收入差不多，选"并入综合所得"补税更少
  - 小孩5岁，不确定能否享受子女相关扣除

## 评估标准：完整决策链路（6个步骤）

### Step 1: 基础计算（必备，缺失则不超过0.4）
- 反推税前工资（从到手18000 + 五险一金3500 + 个税反推）
- 计算月个税和年度工资个税
- 此步是后续所有分析的基础

### Step 2: 信息验证——识别"到手≠税前"矛盾（重要加分项，+0.15）
这是区分普通助手和优秀助手的关键维度：
- **主动识别"到手"含义**：是否意识到用户说的18000是税后到账金额，而非税前工资 (+0.05)
- **正确反推税前工资**：是否通过方程反推出税前约22267元 (+0.05)
- **解释差异**：如果用户把到手当税前算，月税只有340元，与APP显示的预扣税额不符，是否向用户解释了这个差异的原因 (+0.05)
- 如果助手直接把18000当税前用，此项得0

### Step 3: 年终奖两种计税方式对比（加分项，+0.10）
- **单独计税方案**：计算年终奖50000单独计税的税额（4790元）(+0.03)
- **并入综合所得方案**：计算并入后的总税额 (+0.03)
- **对比结论**：明确告诉用户哪种方式税负更低，差多少钱 (+0.04)

### Step 4: 领域知识应用（加分项，每项 +0.04）
- **专项附加扣除政策**：帮用户逐一核实可享受的扣除项，确认赡养老人3000（独生子女）和房贷利息1000是否正确，解释小孩5岁不能享受子女教育扣除（需年满6岁入学）也不能享受婴幼儿照护扣除（需3岁以下） (+0.04)
- **年终奖过渡政策**：说明年终奖单独计税是过渡政策，延续到2027年底（财政部公告2023年第30号），之后将全部并入综合所得 (+0.04)
- **个税APP更正申报操作**：说明在汇算清缴期间（3月1日-6月30日）可以在个税APP中重新选择年终奖计税方式，给出具体操作路径 (+0.04)

### Step 5: 综合建议（加分项，+0.05）
- 综合以上所有分析给出明确的、个性化的建议
- 告诉用户应该选哪种计税方式，预期能省多少钱
- 如果发现"补税一千多"与计算不符，提出可能的原因和排查建议

### Step 6: 可操作的行动方案（加分项，+0.04）
- 给出了具体的操作步骤（个税APP的操作路径、注意事项）
- 使用了结构化格式（表格或清单），方便用户直接参照执行

## 评分汇总
- Step 1 满足：基础分 0.4
- Step 2（到手≠税前识别）：最高 +0.15（这是拉开差距的关键维度）
- Step 3（年终奖对比）：最高 +0.10
- Step 4 每个知识点 +0.04（最高 +0.12）
- Step 5: +0.05
- Step 6: +0.04
- 理论满分路径：0.4 + 0.15 + 0.10 + 0.12 + 0.05 + 0.04 = 0.86
- 如果在以上基础上回答特别出色（如发现"补税一千多"与计算矛盾并深入分析原因），可酌情给到 1.0"""

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
