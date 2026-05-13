"""C02zh_personal_finance grader — multi-turn user-agent consultation: 个人理财."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA2Grader(UserAgentClarifyGraderBase):
    """个人理财 — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.35 * numerical + 0.30 * content
    """

    DOMAIN = "个人理财"
    MUST_ASK = [
        "剩余本金金额",
        "剩余还款年限",
        "当前的执行利率（或加点值）",
        "还款方式（等额本息/等额本金）",
        "家庭收入支出情况（判断还款能力）",
        "应急资金储备（判断流动性风险）",
]

    CLARIFICATION_RUBRIC = """评估助手在对话中的信息收集质量（0.0-1.0）。
不仅看第一轮的提问，也看整个对话过程中助手是否逐步深入收集了做决策所需的信息。

## 基础信息（必须收集，缺失任意一项不超过0.7）
  - 剩余本金金额
  - 剩余还款年限
  - 当前执行利率（或加点值）
  - 还款方式（等额本息/等额本金）

## 深入信息（好的顾问会进一步追问，每覆盖一项加分）
  - 家庭收入和支出情况（判断月结余和还款能力）
  - 应急资金储备（判断提前还款后的流动性风险）
  - 是否有违约金（不同银行政策不同）
  - 是否在享受住房贷款利息个税专项附加扣除

评分标准：
- 1.0：基础信息全部收集 + 主动追问了2项以上深入信息
- 0.8-0.9：基础信息全部收集 + 追问了1项深入信息
- 0.7：基础信息全部收集，但未追问任何深入信息
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
- 用户的初始 query 缺少本金、年限、利率、还款方式等关键参数
- 助手是否在第一轮就识别出缺失并主动询问，而非先给模糊回答再补问

### 2. 信息修正捕捉
- 用户在对话中会修正利率信息（从3.85%更新为2.95%）
- 助手是否准确捕捉到了修正，并在后续计算中使用修正后的值
- 如果用户表示不确定（"好像是2.95%还是3.05%"），助手是否恰当处理了不确定性

### 3. 需求演变跟踪
- 用户的需求可能从"算月供"演变为"要不要提前还款"再到"留多少应急金"
- 助手是否跟上了需求的自然演变，还是机械地回答最初的问题

### 4. 工具使用合理性（如果助手使用了计算工具）
- 是否在需要精确计算时主动调用工具，而非心算给出近似值
- 工具调用的时机是否恰当（收集到足够参数后再计算，而非参数不全就开算）
- **错误与修正的评判标准（严格执行）**：
  - 一次调用就得到正确结果 = 最优，不扣分
  - 调用出错但能自行发现并修正 = 次优，扣0.1-0.2（说明代码能力不足，虽有纠错意识）
  - 调用出错且未发现，将错误结果呈现给用户 = 严重问题，扣0.3-0.5
  - 注意：自我修正不应被视为"加分项"，它本质上是先犯了错再补救

### 5. 对话节奏控制
- 是否在合适的时机给出阶段性结论，而非一直追问不给答案
- 用户追问新问题时，是否流畅衔接而非生硬打断

### 6. 搜索工具使用质量（助手可使用 web_search 和 web_fetch）
本任务涉及时效性信息（LPR利率、银行政策），好的助手应主动搜索验证而非凭记忆回答。

**搜索必要性判断：**
- 用户提到利率从3.85%调为2.95%——助手是否搜索了最新LPR来验证这个数字的合理性？
- 用户提到招行的政策——助手是否搜索了招行具体的提前还款规则和重定价日规则？
- 如果助手完全没搜索就给出了利率数字或政策细节，需要考虑信息可能过时

**搜索质量评估：**
- 优秀(不扣分)：搜索查询精准，1-3次搜索覆盖关键信息（LPR利率+银行政策），搜索结果被正确整合到回答中
- 良好(扣0.05)：搜索了但查询不够精准，需要4-5次才找到关键信息
- 一般(扣0.1)：过度搜索（6次以上）或重复搜索相同内容，效率低下
- 较差(扣0.15)：搜索了但结果没有被使用，或搜到了错误信息却未辨别
- 未搜索(扣0.1)：完全没有使用搜索工具，直接凭记忆给出时效性信息（利率、政策），存在信息过时风险。但如果凭记忆给出的信息恰好正确，可减轻扣分至0.05

## 评分标准
- 1.0：每一轮都精准理解用户意图，信息修正零遗漏，需求演变完美跟踪，工具使用高效恰当（包括计算工具和搜索工具）
- 0.7-0.9：整体理解准确，工具使用基本合理，偶有一轮响应不够精准
- 0.4-0.6：部分轮次理解偏差明显（如忽略了用户的利率修正、需求变化），或工具使用不当（过度搜索/不搜索/计算出错）
- 0.1-0.3：多轮对话中反复出现意图误解或信息遗漏
- 0.0：完全无法跟踪用户意图"""

    NUMERICAL_RUBRIC = """请只评估助手回答中的数值计算准确性（0.0-1.0）。不要考虑内容质量、建议好坏等因素，只关注数字对不对。

## 话题一致性（前置检查）
原始问题是关于「房贷浮动利率月供变化 + 提前还款是否划算」。
如果助手的最终回答完全偏离了这个主题（如转向讨论基金、保险等无关话题），数值准确性直接判0。

## 用户提供的参数
  - 剩余本金: 82万
  - 剩余还款年限: 17年（204期）
  - 利率: 从3.85%调整到2.95%
  - 还款方式: 等额本息
  - 提前还款金额: 用户可能提供10万或15万（取决于对话走向）

## 正确参考值（等额本息公式程序化计算）

**基础月供计算（82万/17年）：**

| 检查项 | 正确值 | 允许误差 |
|--------|--------|----------|
| 2.95%利率下月供 | **5,116元** | ±100元 (5,016~5,216) |
| 3.85%利率下月供 | **5,484元** | ±100元 (5,384~5,584) |
| 利率下调后每月节省 | **367元** | ±50元 |

**提前还10万方案（新本金72万/利率2.95%）：**

| 检查项 | 正确值 | 允许误差 |
|--------|--------|----------|
| 缩短年限：新还款期 | **173个月（14.4年）** | ±6个月 |
| 缩短年限：节省利息 | **5.9万** | ±1万 |
| 减少月供：新月供 | **4,492元** | ±100元 |
| 减少月供：月供减少 | **624元** | ±80元 |

**提前还15万方案（新本金67万/利率2.95%，如果用户提供15万）：**

| 检查项 | 正确值 | 允许误差 |
|--------|--------|----------|
| 缩短年限：新还款期 | **158个月（13.2年）** | ±6个月 |
| 减少月供：新月供 | **4,180元** | ±100元 |

## 评分规则（严格执行，不要被内容质量影响）
- 1.0：所有可验证数字都在允许误差范围内
- 0.7-0.9：基础月供正确，提前还款计算有小偏差
- 0.4-0.6：基础月供偏差在100-300元之间
- 0.2-0.3：基础月供偏差在300-500元之间
- 0.0-0.1：基础月供偏差超过500元，或始终使用3.85%未采用修正后的2.95%
- 如果助手回答中引用的参数与用户提供的不一致（如用户说82万但按50万算），直接判0"""

    CONTENT_RUBRIC = """请评估助手回答的内容质量（0.0-1.0）。不要考虑数值是否准确，只关注回答的完整性、专业性、实用性。

## 话题一致性（前置检查）
原始问题是关于「房贷浮动利率月供变化 + 提前还款是否划算」。
如果助手的最终回答完全偏离了这个主题，内容质量直接判0。

## 用户完整情况（对话中可能逐步透露）
  - 剩余本金82万，17年，等额本息
  - 用户说APP显示利率2.95%，合同上写的是LPR减55个基点
  - 2021年7月放款，贷款银行：招商银行（商贷），已还约4年
  - 家庭月收入约1.5-1.6万，月支出约1.2-1.3万，月结余约3000
  - 正在享受住房贷款利息个税专项附加扣除（每月1000额度）
  - 已确认招行还款满1年后无违约金
  - 不确定重定价日是1月1日还是放款对月日（7月）
  - 上个月实际扣款约5116元

## 关键矛盾（高质量回答应发现并分析）
用户提供的信息中存在潜在矛盾：
  - 用户说"APP显示2.95%"，且合同上"LPR减55个基点"
  - 如果助手搜索最新LPR（5年期以上），会发现当前LPR可能与2.95%+55BP不匹配
  - 但用户实际扣款5116元，反推利率确实接近2.95%（82万/17年/等额本息/2.95% → 月供5116）
  - 好的助手应该注意到这些信息之间的关系，通过交叉验证来确认利率（而非简单采信用户的一个说法）

## 评估标准：完整决策链路（6个步骤）

### Step 1: 基础计算（必备，缺失则不超过0.4）
- 计算了利率调整前后的月供变化
- 对比了「缩短年限」vs「减少月供」两种提前还款方案

### Step 2: 信息验证与矛盾处理（重要加分项，+0.15）
这是区分普通助手和优秀助手的关键维度：
- **交叉验证利率**：是否通过搜索最新LPR + 用户的加点值来验算当前利率，而非直接采信用户说的数字 (+0.05)
- **发现并分析矛盾**：如果搜索到的LPR与用户说的利率/加点值不一致，是否指出了这个矛盾并给出可能的解释（如存量房贷统一下调、加点值记错、重定价日未到等） (+0.05)
- **用实际扣款反推验证**：如果用户提供了实际月供金额（5116元），是否用这个数字反推利率来交叉验证 (+0.05)
- 如果助手完全没有做任何验证，直接用用户给的数字计算，此项得0

### Step 3: 财务状况分析（必备，缺失则不超过0.6）
- 结合了用户的收入支出情况分析还款能力
- 评估了应急资金是否充足（至少覆盖3-6个月支出）

### Step 4: 领域知识应用（加分项，每项 +0.04）
- **违约金**：提到了提前还款可能涉及违约金，或确认了用户已满年限免违约金 (+0.04)
- **个税专项扣除影响**：提到提前还清后将无法继续享受住房贷款利息专项附加扣除（每月1000额度），分析了这对实际收益的影响 (+0.04)
- **重定价日机制**：解释了重定价日的作用（利率调整生效时点），帮用户分析1月1日 vs 7月放款日的区别，以及这对未来利率变动的影响 (+0.04)
- **机会成本深度分析**：考虑了等额本息的实际利息结构（前期利息占比高）对提前还款收益的影响 (+0.04)

### Step 5: 综合建议（加分项，+0.05）
- 综合以上所有分析（包括矛盾处理的结论）给出明确的、个性化的建议
- 建议考虑了用户的具体约束条件（月结余少、有个税扣除、利率不确定性等）

### Step 6: 可操作的行动方案（加分项，+0.04）
- 给出了具体的操作步骤（去哪办、怎么操作、注意什么）
- 使用了结构化格式（表格或清单），方便用户直接参照执行

## 评分汇总
- Step 1 + Step 3 都满足：基础分 0.5
- Step 2（矛盾处理）：最高 +0.15（这是拉开差距的关键维度）
- Step 4 每个知识点 +0.04（最高 +0.16）
- Step 5: +0.05
- Step 6: +0.04
- 理论满分路径：0.5 + 0.15 + 0.16 + 0.05 + 0.04 = 0.90
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
