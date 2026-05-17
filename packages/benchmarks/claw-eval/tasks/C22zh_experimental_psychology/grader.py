"""C22zh_experimental_psychology grader — multi-turn user-agent consultation: 实验心理学."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA208Grader(UserAgentClarifyGraderBase):
    """实验心理学 — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.35 * numerical + 0.30 * content
    """

    DOMAIN = "实验心理学"
    MUST_ASK = [
        "具体的击中率(H)和虚报率(FA)数值",
        "用户自己算出的d'是多少，答案给的又是多少",
        "查表用的是哪种标准正态分布表（累积概率表 vs 0到z面积表）",
        "用的d'公式是哪个（d'=z(H)-z(FA) 还是其他变体）",
        "查表得到的具体z值是多少",
    ]

    CLARIFICATION_RUBRIC = """评估助手在对话中的信息收集质量（0.0-1.0）。
不仅看第一轮的提问，也看整个对话过程中助手是否逐步深入收集了排查计算错误所需的信息。

## 基础信息（必须收集，缺失任意一项不超过0.7）
  - 具体的击中率(H)和虚报率(FA)数值
  - 用户自己算出的d'具体是多少，答案给的又是多少
  - 用户使用的d'计算公式

## 深入信息（好的顾问会进一步追问，每覆盖一项加分）
  - 用户查表得到的具体z值是多少（z(H)和z(FA)各是多少）
  - 用户查的是哪种类型的正态分布表（累积概率表、0到z面积表、还是其他格式）
  - 查表时的精度（几位小数）和插值方式
  - 同学用计算器算的结果是多少（交叉验证）

评分标准：
- 1.0：基础信息全部收集 + 主动追问了2项以上深入信息（尤其是查表得到的具体z值）
- 0.8-0.9：基础信息全部收集 + 追问了1项深入信息
- 0.7：基础信息全部收集，但未追问任何深入信息
- 0.4-0.6：基础信息缺失1-2项
- 0.1-0.3：几乎没有主动提问，直接基于不完整信息给出回答
- 0.0：完全没有任何澄清行为

注意：
- 如果用户主动提供了部分信息，助手只需询问缺失的部分即可
- 深入信息不要求在第一轮就问完，可以在后续对话中自然追问"""

    TRAJECTORY_RUBRIC = """请评估整个对话过程中，助手对用户意图的理解和响应质量（0.0-1.0）。
不要只看最终回答，而是审视每一轮对话中助手的表现。

## 评估维度

### 1. 信息缺失识别（用户没给的关键信息，助手是否察觉并追问）
- 用户的初始 query 没有给出 H、FA 的具体数值，也没说自己查到的z值是多少
- 助手是否在早期就识别出这些缺失并主动询问，而非先给模糊回答再补问

### 2. 矛盾发现与追问
- 用户说自己算出d'=1.80，但后来提供的z值是z(H)=1.04和z(FA)=-0.84
- 1.04-(-0.84)=1.88，不是1.80——助手是否发现了这个矛盾并追问用户到底是怎么算出1.80的
- 这是区分优秀助手和普通助手的关键：普通助手只会说"查表精度不够"，优秀助手会发现用户声称的z值和d'结果不自洽

### 3. 需求演变跟踪
- 用户的需求从"验算d'"可能演变为"帮我排查哪步算错了""帮我查教材勘误"
- 助手是否跟上了需求的自然演变

### 4. 工具使用合理性（如果助手使用了计算工具或搜索工具）
- 是否用 Python/计算器精确计算了z值和d'，而非仅凭记忆给出近似值
- **计算工具评判标准（严格执行）**：
  - 一次调用就得到正确结果 = 最优，不扣分
  - 调用出错但能自行发现并修正 = 次优，扣0.1-0.2
  - 调用出错且未发现，将错误结果呈现给用户 = 严重问题，扣0.3-0.5

### 5. 搜索工具使用质量（助手可使用 web_search 和 web_fetch）
用户明确要求"帮我查查最新版教材勘误"，好的助手应当使用搜索工具回应这个需求。

**搜索必要性判断：**
- 用户直接要求查教材勘误——助手是否搜索了朱滢《实验心理学》最新版勘误信息？
- 搜索结果是否被合理整合到回答中（即便没找到相关勘误也应告知用户）

**搜索质量评估：**
- 优秀(不扣分)：搜索查询精准，1-3次搜索覆盖关键信息，结果正确整合
- 良好(扣0.05)：搜索了但查询不够精准，需要4-5次
- 一般(扣0.1)：过度搜索（6次以上）或重复搜索相同内容
- 未搜索(扣0.1)：用户明确要求查勘误但助手完全没搜索

### 6. 对话节奏控制
- 是否在合适的时机给出阶段性结论
- 收集到足够信息后是否及时给出计算结果和分析

## 评分标准
- 1.0：每一轮都精准理解用户意图，发现z值与d'的矛盾并追问，工具使用高效恰当
- 0.7-0.9：整体理解准确，工具使用基本合理，偶有一轮响应不够精准
- 0.4-0.6：部分轮次理解偏差明显（如未发现1.88≠1.80的矛盾），或工具使用不当
- 0.1-0.3：多轮对话中反复出现意图误解或信息遗漏
- 0.0：完全无法跟踪用户意图"""

    NUMERICAL_RUBRIC = """请只评估助手回答中的数值计算和统计参数准确性（0.0-1.0）。

## 正确参考值
- z(H=0.85) = 1.0364, z(FA=0.20) = -0.8416
- d' = 1.8781（精确值），四舍五入到两位小数 = 1.88
- β = 0.8609, c = -0.0974
- 用户声称算出1.80——这与正确值1.88差0.08，说明用户查表或计算过程有误

## 严格分5档评分

### d' 精确度（权重50%）
- 1.0档：给出d'在1.87-1.89范围内（精确计算）
- 0.7档：给出d'在1.85-1.90范围内（合理近似）
- 0.4档：给出d'在1.80-1.84或1.91-1.95范围内（明显偏差）
- 0.1档：给出d'超出1.75-2.00范围
- 0.0档：未计算d'

### 是否发现用户计算错误（权重30%）——核心区分点
用户说"自己算出d'=1.80"，但用查表值1.04和-0.84代入得1.88，不是1.80。
- 1.0档：明确指出用户算出的1.80有误，分析了可能的错误原因（如z值查错行列、小数位对错、减法算错）
- 0.5档：指出1.80和答案1.87有差异，但没有深入分析用户哪里算错
- 0.0档：没有发现用户计算有误，或者直接采信了1.80

### 是否计算了β和c（权重20%）
- 1.0档：正确计算了β（0.86±0.05）和c（-0.10±0.02）
- 0.5档：只计算了β或c中的一个
- 0.0档：只给了d'没给β和c

## 最终打分 = 0.50×d'精确度 + 0.30×错误发现 + 0.20×β和c"""

    CONTENT_RUBRIC = """请评估助手回答的内容质量（0.0-1.0）。不要考虑数值是否准确，只关注回答的完整性、专业性、实用性。

## 话题一致性（前置检查）
原始问题是关于「信号检测论 d' 计算、查表精度差异、教材勘误」。
如果助手的最终回答完全偏离了这个主题，内容质量直接判0。

## 用户完整情况（对话中可能逐步透露）
  - 正在准备考研（统考312），复习信号检测论（SDT）
  - 用朱滢《实验心理学》，按书上例题算 d'
  - H=0.85, FA=0.20，自己算出 d'=1.80，答案给的 1.87
  - 查表得 z(0.85)=1.04, z(0.20)=-0.84
  - 同学用计算器算得 z=1.0364 和 -0.8416

## 关键矛盾（高质量回答应发现并分析）
用户提供的信息中存在矛盾：
  - 用户查表得 z(H)=1.04, z(FA)=-0.84 → d'=1.04-(-0.84)=1.88
  - 但用户声称自己算出 d'=1.80
  - 1.88 ≠ 1.80，说明用户除了查表精度问题之外，计算过程中还有额外的错误
  - 好的助手应该发现这个不自洽并帮用户排查到底哪一步出了问题

## 评估标准：完整决策链路（6个步骤）

### Step 1: 基础计算（必备，缺失则不超过0.4）
- 使用精确z值计算了 d' = z(H) - z(FA) ≈ 1.8781
- 还应给出完整的 SDT 三件套中至少 d' 和 β 或 c（判断标准）
- 对比了查表近似值和精确计算值的差异

### Step 2: 差异溯源（重要加分项，+0.15）
这是区分普通助手和优秀助手的关键维度：
- **查表精度分析**：指出查表法（两位小数）与精确计算的差异来源，解释为什么查表得 1.88 而精确算得 1.8781 (+0.05)
- **发现用户的计算矛盾**：发现"z值算出1.88"与"用户声称1.80"的不一致，追问或分析用户可能在哪一步额外犯了错——如查表查错行列、z值符号搞反、减法算错等 (+0.05)
- **排查具体错误**：给出用户得到1.80的可能原因（如z(FA)查成了-0.76，1.04-(-0.76)=1.80）(+0.05)
- 如果助手只说"查表精度不够"但没发现1.88≠1.80的矛盾，此项最多得0.05

### Step 3: 搜索教材勘误信息（加分项，+0.05）
- 用户明确要求查教材勘误，助手是否使用搜索工具查找了朱滢《实验心理学》最新版勘误
- 即便搜索后没找到相关勘误，也应如实告知用户搜索结果
- 完全不搜索不回应用户的勘误请求：此项得0

### Step 4: 领域知识（加分项，每项 +0.04）
- **正态分布表的类型区别**：解释累积概率表 vs 0到z面积表的区别，以及使用不同类型表时的换算方式 (+0.04)
- **ROC曲线**：提到 d' 在 ROC 空间中的几何意义（等 d' 曲线）(+0.04)
- **判断标准 c 的含义**：解释 c = -0.5*(z(H)+z(FA)) 代表的判断倾向（保守 vs 冒险）(+0.04)
- **SDT的心理学应用场景**：提到信号检测论在记忆再认、医学诊断、质量检验等领域的应用 (+0.04)

### Step 5: 实用建议（加分项，+0.05）
- 考研是用计算器还是查表——给出明确建议（一般建议用科学计算器求精确值）
- 如果必须查表，推荐精度更高的表或插值方法
- 推荐用 Python/Excel 等工具自行验算

### Step 6: 拓展（加分项，+0.04）
- SDT在不同实验范式中的变体（如强迫选择范式、等级评定法）
- 当极端击中率/虚报率（接近0或1）时的修正方法（如 log-linear 修正）
- d' 和其他敏感性指标的对比（如 A'、Az）

## 评分汇总
- Step 1 满足：基础分 0.5
- Step 2（差异溯源）：最高 +0.15（这是拉开差距的关键维度）
- Step 3（搜索勘误）：+0.05
- Step 4 每个知识点 +0.04（最高 +0.16）
- Step 5: +0.05
- Step 6: +0.04
- 理论满分路径：0.5 + 0.15 + 0.05 + 0.16 + 0.05 + 0.04 = 0.95
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

        # 3. Numerical accuracy (35%) — hybrid: programmatic d' check + judge
        # Try to extract d' value from assistant messages
        import re as _re
        d_prime_from_trace = None
        for m in messages:
            if m.message.role == "assistant":
                text = m.message.text or ""
                for pat in [r"d['′]?\s*[=≈]\s*([\d.]+)", r"d-prime\s*[=≈:]\s*([\d.]+)"]:
                    matches = _re.findall(pat, text)
                    for match in matches:
                        val = float(match)
                        if 0.5 < val < 4.0:
                            d_prime_from_trace = val
                            break

        numerical_score = 0.0
        if d_prime_from_trace is not None:
            # Programmatic scoring for d' precision (50% of numerical)
            d_err = abs(d_prime_from_trace - 1.8781)
            if d_err <= 0.01:
                d_score = 1.0
            elif d_err <= 0.03:
                d_score = 0.7
            elif d_err <= 0.08:
                d_score = 0.4
            else:
                d_score = 0.1
            print(f"[grader] d' extracted: {d_prime_from_trace:.4f}, error={d_err:.4f}, d_score={d_score}")
            # Judge scores the other 50% (error discovery + beta/c)
            try:
                result = judge.evaluate(prompt_text, full_conversation, "",
                                        self.NUMERICAL_RUBRIC)
                judge_num = result.score
                print(f"[grader] numerical judge: {judge_num:.2f}")
                numerical_score = 0.50 * d_score + 0.50 * judge_num
            except Exception as exc:
                numerical_score = 0.50 * d_score
                print(f"[grader] numerical judge failed, using d_score only: {exc}")
        else:
            print("[grader] d' not extracted from trace, using full judge")
            try:
                result = judge.evaluate(prompt_text, full_conversation, "",
                                        self.NUMERICAL_RUBRIC)
                numerical_score = result.score
                print(f"[grader] numerical score (judge only): {numerical_score:.2f}")
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
