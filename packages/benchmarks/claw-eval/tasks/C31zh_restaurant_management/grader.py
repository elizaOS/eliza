"""C31zh_restaurant_management grader — multi-turn user-agent consultation: 餐饮经营."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA238Grader(UserAgentClarifyGraderBase):
    """餐饮经营 — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.35 * numerical + 0.30 * content
    """

    DOMAIN = "餐饮经营"
    MUST_ASK = [
        "门店位置和面积",
        "当前月租金金额",
        "月均营收",
        "餐饮业态（正餐/快餐/茶饮等）",
        "毛利率",
        "涨租幅度",
]

    CLARIFICATION_RUBRIC = """评估助手在对话中的信息收集质量（0.0-1.0）。
不仅看第一轮的提问，也看整个对话过程中助手是否逐步深入收集了做决策所需的信息。

## 基础信息（第一批，必须收集，缺失任意一项不超过0.7）
  - 门店位置和面积
  - 当前月租金金额
  - 月均营收
  - 餐饮业态（正餐/快餐/茶饮等）

## 深入信息（第二批，好的顾问会进一步追问，每覆盖一项加分）
  - 毛利率（对计算租后利润至关重要）
  - 涨租具体幅度（百分比或金额）
  - 合同到期时间

## 关键细节（第三批，优秀的顾问才会追问到）
  - 装修投入（涉及沉没成本分析）
  - 是否有替代铺位选项
  - 合同条款细节（违约金、优先续租权等）

评分标准：
- 1.0：基础信息全部收集 + 主动追问了第三批中2项以上信息
- 0.8-0.9：基础信息全部收集 + 追问了第二批全部 + 第三批1项
- 0.7：基础信息全部收集 + 追问了第二批部分信息
- 0.4-0.6：基础信息缺失1-2项
- 0.1-0.3：几乎没有主动提问
- 0.0：完全没有任何澄清行为

注意：
- 如果用户主动提供了部分信息，助手只需询问缺失的部分即可
- 深入信息不要求在第一轮就问完，可以在后续对话中自然追问"""

    TRAJECTORY_RUBRIC = """请评估整个对话过程中，助手对用户意图的理解和响应质量（0.0-1.0）。
不要只看最终回答，而是审视每一轮对话中助手的表现。

## 评估维度

### 1. 信息缺失识别（用户没给的关键信息，助手是否察觉并追问）
- 用户的初始 query 只说了"餐饮行业平均租金占营收比"，缺少具体门店信息、业态、营收等
- 助手是否在第一轮就识别出缺失并主动询问，而非先给模糊回答再补问

### 2. 信息整合能力
- 用户在多轮对话中逐步透露了位置、租金、营收、业态、毛利率、涨幅、装修投入等信息
- 助手是否将这些分散的信息有机整合到分析中

### 3. 需求演变跟踪
- 用户的需求可能从"查行业标准"演变为"帮我算算值不值""帮我想谈判策略"
- 助手是否跟上了需求的自然演变

### 4. 工具使用合理性（如果助手使用了计算工具）
- 是否在需要精确计算时主动调用工具
- **错误与修正的评判标准（严格执行）**：
  - 一次调用就得到正确结果 = 最优，不扣分
  - 调用出错但能自行发现并修正 = 次优，扣0.1-0.2
  - 调用出错且未发现，将错误结果呈现给用户 = 严重问题，扣0.3-0.5

### 5. 对话节奏控制
- 是否在合适的时机给出阶段性结论，而非一直追问不给答案
- 用户追问新问题时，是否流畅衔接

### 6. 搜索工具使用质量（助手可使用 web_search 和 web_fetch）
本任务涉及行业数据（不同业态的租金占比标准），好的助手应主动搜索而非凭记忆回答。

**搜索必要性判断：**
- 用户问的是"餐饮行业平均租金占营收比"——这是行业数据，助手应搜索验证
- 茶饮+轻食在商场B1的租金标准与正餐差异很大——助手是否搜索区分了不同业态
- 如果助手完全没搜索就给出了行业数据，需要考虑信息可能不准确

**搜索质量评估：**
- 优秀(不扣分)：搜索查询精准，1-3次搜索覆盖了不同业态的租金标准，结果被正确整合到回答中
- 良好(扣0.05)：搜索了但查询不够精准，需要4-5次才找到关键信息
- 一般(扣0.1)：过度搜索（6次以上）或重复搜索相同内容
- 较差(扣0.15)：搜索了但结果没有被使用，或搜到了错误信息却未辨别
- 未搜索(扣0.1)：完全没有搜索，直接凭记忆给出行业数据。但如果凭记忆给出的信息恰好合理，可减轻扣分至0.05

## 评分标准
- 1.0：每一轮都精准理解用户意图，信息整合完整，工具使用高效恰当
- 0.7-0.9：整体理解准确，工具使用基本合理，偶有一轮响应不够精准
- 0.4-0.6：部分轮次理解偏差明显，或工具使用不当
- 0.1-0.3：多轮对话中反复出现意图误解或信息遗漏
- 0.0：完全无法跟踪用户意图"""

    NUMERICAL_RUBRIC = """请只评估助手回答中的数值计算准确性（0.0-1.0）。不要考虑内容质量、建议好坏等因素，只关注数字对不对。

## 话题一致性（前置检查）
原始问题是关于「餐饮门店续租涨租金的分析」。
如果助手的最终回答完全偏离了这个主题，数值准确性直接判0。

## 用户提供的参数
  - 门店面积: 180平
  - 当前月租: 4.2万
  - 月均营收: 约28万
  - 业态: 茶饮+轻食
  - 毛利率: 约65%
  - 涨幅: 15%（涨到约4.83万）
  - 隔壁铺位面积: 约120平
  - 去年装修投入: 约40万

## 正确参考值（程序化计算）

| 检查项 | 正确值 | 允许误差 |
|--------|--------|----------|
| 当前租金占营收比 | **15.0%** (4.2万/28万) | ±0.5% |
| 涨后租金占营收比 | **17.25%** (4.83万/28万) | ±0.5% |
| 当前单位面积租金 | **233元/平/月** (4.2万/180平) | ±5元 |
| 涨后单位面积租金 | **268元/平/月** (4.83万/180平) | ±5元 |
| 月毛利 | **18.2万** (28万x65%) | ±0.5万 |
| 当前租后毛利 | **14.0万** (18.2-4.2) | ±0.5万 |
| 涨后租后毛利 | **13.37万** (18.2-4.83) | ±0.5万 |
| 利润减少额 | **0.63万/月** (4.83-4.2) 即 **7.56万/年** | ±0.1万/月 |

## 硬性规则（严格执行）
- 如果租金占比计算错误（偏差超过2%）→ 本维度最高0.3
- 如果没有计算涨后的具体影响（如利润减少额）→ 本维度最高0.5

## 评分规则
- 1.0：所有可验证数字都在允许误差范围内
- 0.7-0.9：租金占比正确，衍生计算（毛利、利润变化等）有小偏差
- 0.4-0.6：租金占比正确，但缺少涨后影响分析的计算
- 0.2-0.3：租金占比计算偏差在1%-2%之间
- 0.0-0.1：租金占比偏差超过2%，或使用了错误的用户参数
- 如果助手回答中引用的参数与用户提供的不一致（如用户说28万按30万算），直接判0"""

    CONTENT_RUBRIC = """请评估助手回答的内容质量（0.0-1.0）。不要考虑数值是否准确，只关注回答的完整性、专业性、实用性。

## 话题一致性（前置检查）
原始问题是关于「餐饮门店续租涨租金的分析」。
如果助手的最终回答完全偏离了这个主题，内容质量直接判0。

## 用户完整情况（对话中可能逐步透露）
  - 万达广场B1层，180平，茶饮+轻食
  - 当前月租4.2万，月均营收约28万，毛利率约65%
  - 合同还有8个月到期，房东要涨15%（到4.83万）
  - 隔壁有个铺位空着，约120平
  - 去年投了约40万装修

## 关键矛盾（高质量回答应发现并分析）

1. 行业数据矛盾：餐饮租金占比的"行业标准"说法不一——正餐8-15%、商场茶饮可能15-25%。用户做的是"茶饮+轻食在商场B1"，好的助手应搜索区分业态，而非给一个笼统的"餐饮行业10%-15%"。当前15%的租金占比在茶饮商场业态中其实已经是合理范围。

2. 沉没成本陷阱：用户去年投了40万装修，如果不续租就"打水漂"。但好的助手应识别这是沉没成本，不应因为"装修都投了"就建议续租——应该基于未来现金流做决策。

3. 隔壁小铺位的坑：120平看似省租金，但面积缩小1/3可能导致营收下降更多，需要算坪效（单位面积产出）。

## 评估标准：完整决策链路（6个步骤）

### Step 1: 基础计算（必备，缺失则不超过0.4）
- 计算了当前租金占营收比
- 计算了涨后租金及新的占营收比
- 计算了单位面积租金（坪效相关）

### Step 2: 行业数据验证（重要加分项，+0.15）
这是区分普通助手和优秀助手的关键维度：
- **搜索不同业态的租金标准**：是否区分了正餐/快餐/茶饮/商场/街边的租金占比标准，而非给一个笼统数字 (+0.05)
- **正确定位用户业态**：识别到"茶饮+轻食在商场B1"对应的标准与传统正餐不同 (+0.05)
- **给出合理的行业参考区间**：茶饮商场业态租金占比15%-25%是合理区间，当前15%其实在合理范围内 (+0.05)
- 如果助手只给了一个笼统的"餐饮行业10%-15%"而不区分业态，此项最高得0.05

### Step 3: 多方案对比分析（加分项，+0.10）
好的助手应帮用户分析至少两种方案并对比：
- **续租+涨价方案**：涨后的经营可行性分析 (+0.03)
- **搬到隔壁小铺位方案**：分析面积缩小对营收的影响、坪效变化 (+0.04)
- **不续租止损方案**：分析退出的成本和收益 (+0.03)

### Step 4: 领域知识应用（加分项，每项 +0.04）
- **沉没成本识别**：明确指出40万装修是沉没成本，不应影响续租决策，应基于未来现金流判断 (+0.04)
- **坪效分析**：计算单位面积产出（28万/180平=1556元/平/月），用于对比隔壁小铺位的可行性 (+0.04)
- **租金谈判技巧**：提供具体的谈判策略（如用同区域租金数据压价、要求阶梯涨幅、绑定长约换优惠等） (+0.04)
- **合同条款注意事项**：提到应关注的条款（免租期、物业费分担、优先续租权、违约金等） (+0.04)

### Step 5: 谈判策略建议（加分项，+0.05）
- 综合以上分析给出具体的谈判策略
- 建议基于数据而非情绪（如用坪效数据、同区域对比数据开口）
- 考虑了用户的具体约束（合同还有8个月、有装修投入）

### Step 6: 可操作的行动方案（加分项，+0.04）
- 给出具体的行动步骤（先做什么、再做什么）
- 使用了结构化格式（表格或清单），方便用户直接参照执行

## 评分汇总
- Step 1 满足：基础分 0.5
- Step 2（行业数据验证）：最高 +0.15
- Step 3（多方案对比）：最高 +0.10
- Step 4 每个知识点 +0.04（最高 +0.16）
- Step 5: +0.05
- Step 6: +0.04
- 理论满分路径：0.5 + 0.15 + 0.10 + 0.16 + 0.05 + 0.04 = 1.00
- 如果在以上基础上回答特别出色，可给到 1.0"""

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
