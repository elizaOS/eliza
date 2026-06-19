"""C05zh_personal_finance_2 grader — multi-turn user-agent consultation: 个人理财（组合贷）."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA7Grader(UserAgentClarifyGraderBase):
    """个人理财（组合贷LPR重定价） — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.35 * numerical + 0.30 * content
    """

    DOMAIN = "个人理财"
    MUST_ASK = [
        "商贷的原始贷款期限（总年限）",
        "商贷的利率加点数值（LPR+?bp）",
        "商贷的还款方式（等额本息或等额本金）",
        "公积金贷款的利率及还款方式",
    ]

    CLARIFICATION_RUBRIC = """评估助手在对话中的信息收集质量（0.0-1.0）。
不仅看第一轮的提问，也看整个对话过程中助手是否逐步深入收集了做决策所需的信息。

## 基础信息（必须收集，缺失任意一项不超过0.7）
  - 商贷的原始贷款期限（总年限）
  - 商贷的利率加点数值（LPR+多少bp）
  - 商贷的还款方式（等额本息或等额本金）
  - 商贷的剩余本金或原始贷款金额

## 深入信息（好的顾问会进一步追问，每覆盖一项加分）
  - 公积金贷款的余额及月供（判断可持续性）
  - 公积金是否在继续缴纳（直接影响对冲持续时间）
  - 家庭月收入和支出情况（判断现金流压力）
  - 手头可用于提前还贷的金额
  - 重定价日的具体日期确认

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
- 用户初始 query 提到"组合贷"但没给商贷/公积金的具体参数
- 助手是否在第一轮就识别出需要加点值、期限、本金等关键参数
- 助手是否避免了在参数不全时就给出具体数字

### 2. 信息修正捕捉
- 用户可能在对话中补充或修正信息（如从"大概100万"到具体APP显示的5380月供）
- 助手是否捕捉到了每次补充，并在后续计算中使用最新数据
- 用户说"三年前辞职了没在缴公积金"——这是关键信息，直接影响公积金对冲可持续性

### 3. 需求演变跟踪
- 用户的需求从"算月供省多少"→"公积金能撑多久"→"算剩余本金"→"提前还贷省多少利息"
- 助手是否跟上了需求的自然演变
- 是否在用户表示"算了不纠结了"后仍然敏锐地识别出用户其实仍在关心这个问题

### 4. 工具使用合理性（如果助手使用了计算工具）
- 是否在需要精确计算时主动调用工具（月供、利息节省都需要精确计算）
- 工具调用的时机是否恰当（收集到足够参数后再计算）
- **错误与修正的评判标准（严格执行）**：
  - 一次调用就得到正确结果 = 最优，不扣分
  - 调用出错但能自行发现并修正 = 次优，扣0.1-0.2
  - 调用出错且未发现，将错误结果呈现给用户 = 严重问题，扣0.3-0.5
  - 注意：自我修正不应被视为"加分项"

### 5. 对话节奏控制
- 是否在合适的时机给出阶段性结论
- 用户追问新问题时，是否流畅衔接

### 6. 搜索工具使用质量（助手可使用 web_search 和 web_fetch）
本任务涉及时效性信息（最新LPR数值、银行政策），好的助手应主动搜索验证。

**搜索必要性判断：**
- 用户问"今年LPR调整了好几次"——助手是否搜索了最新的5年期以上LPR？
- LPR的准确值直接决定月供计算结果，不应凭记忆回答

**搜索质量评估：**
- 优秀(不扣分)：搜索查询精准，1-3次搜索覆盖LPR数值
- 良好(扣0.05)：搜索了但不够精准
- 一般(扣0.1)：过度搜索（6次以上）
- 较差(扣0.15)：搜到了错误信息却未辨别
- 未搜索(扣0.1)：完全没有使用搜索工具。但如果凭记忆给出的LPR恰好正确，可减轻扣分至0.05

## 评分标准
- 1.0：每一轮都精准理解用户意图，信息修正零遗漏，需求演变完美跟踪
- 0.7-0.9：整体理解准确，偶有一轮响应不够精准
- 0.4-0.6：部分轮次理解偏差明显
- 0.1-0.3：多轮对话中反复出现意图误解或信息遗漏
- 0.0：完全无法跟踪用户意图"""

    NUMERICAL_RUBRIC = """请只评估助手回答中的数值计算准确性（0.0-1.0）。不要考虑内容质量、建议好坏等因素，只关注数字对不对。

## 话题一致性（前置检查）
原始问题是关于「组合贷LPR重定价后月供变化 + 公积金余额可持续性 + 提前还贷利息节省」。
如果助手的最终回答完全偏离了这个主题，数值准确性直接判0。

## 用户提供的参数
  - 商贷期限: 25年（300期）
  - 商贷利率: LPR + 55bp
  - 还款方式: 等额本息
  - 商贷大约100万
  - 公积金贷款余额: 4万出头，已停缴
  - APP显示月供约5380元
  - 拟提前还贷金额: 25万，选择缩短期限

## 正确参考值（等额本息公式程序化计算）

**LPR利率计算：**

| 检查项 | 正确值 | 允许误差 |
|--------|--------|----------|
| 旧执行利率（LPR4.20+55bp） | **4.75%** | +/- 5bp |
| 新执行利率（LPR3.60+55bp） | **4.15%** | +/- 5bp |
| 利率下降幅度 | **0.60个百分点** | +/- 5bp |
| 最新5年期LPR引用值 | **3.60%** | 应引用合理值 |

**月供变化（基于100万/25年/等额本息）：**

| 检查项 | 正确值 | 允许误差 |
|--------|--------|----------|
| 旧利率4.75%月供 | **5,701元** | +/- 150元 |
| 新利率4.15%月供 | **5,362元** | +/- 150元 |
| 每月节省 | **~340元** | +/- 100元 |
| 每10万贷款月供差 | **~34元** | +/- 10元 |

**公积金对冲可持续性：**

| 检查项 | 正确值 | 允许误差 |
|--------|--------|----------|
| 公积金月供（~4万余额） | **~197元** | +/- 80元 |
| 余额可撑月数 | **~200个月（16年+）** | +/- 60个月 |

注：如果助手基于用户说的停缴状态计算为约14个月（基于更高的月供假设，如约2800元/月），说明助手假设公积金贷款余额更大或利率不同，需结合对话上下文判断。关键是计算逻辑是否自洽。

**提前还贷25万（缩短期限方案）：**

| 检查项 | 正确值 | 允许误差 |
|--------|--------|----------|
| 剩余本金~95万→还25万后~70万 | 逻辑自洽 | — |
| 缩短期限后还款年限 | **约15年（181个月）** | +/- 12个月 |
| 利息节省总额 | **约25-30万** | +/- 8万 |

## 评分规则（严格执行）
- 1.0：所有可验证数字都在允许误差范围内
- 0.7-0.9：利率计算正确，月供计算有小偏差
- 0.4-0.6：利率逻辑正确但LPR引用值偏差较大，导致下游数字偏移
- 0.2-0.3：加点逻辑错误（如把55bp搞混）
- 0.0-0.1：核心利率计算完全错误，或使用了与用户提供完全不一致的参数
- 如果LPR引用值错误（如用3.85%/3.95%等旧值）→ 最高0.3
- 如果编造不存在的政策（如"加点已被批量调整"）→ 扣0.2"""

    CONTENT_RUBRIC = """请评估助手回答的内容质量（0.0-1.0）。不要考虑数值是否准确，只关注回答的完整性、专业性、实用性。

## 话题一致性（前置检查）
原始问题是关于「组合贷LPR重定价后月供变化 + 还款压力评估 + 提前还贷决策」。
如果助手的最终回答完全偏离了这个主题，内容质量直接判0。

## 用户完整情况（对话中逐步透露）
  - 商贷约62万（用户说法），25年期限（已还约4年，剩约21年），LPR+55bp，等额本息
  - 2021年签合同时5年期LPR=4.65%，当时利率=5.20%
  - 公积金余额仅4万出头，三年前辞职已停缴公积金
  - 目前每月公积金对冲扣款约480元（公积金贷款原始15万/25年/3.25%）
  - APP显示商贷月供约5380元
  - 家里有货基+短债约35万，留10万应急后能动25万
  - 想提前还商贷25万，选择缩短期限
  - 老婆月入约1.2万，投资收益不稳定

## 关键矛盾（高质量回答应发现并分析）
用户说商贷月供5380元，但按62万/21年剩余/5.20%等额本息反推，月供应该接近4300元左右。
5380更接近按更高本金（约75万）或更短剩余期限算出的数字，也可能是用户记错了剩余本金（实际可能还剩更多），或者5380是某个历史时点的数字。
好的助手应该通过计算发现月供和本金/期限之间不匹配，追问确认具体数字。

## 评估标准：完整决策链路

### Step 1: LPR利率机制解释（必备，缺失则不超过0.4）
- 是否说明了LPR+加点的利率构成机制（加点值合同期内不变，LPR会在重定价日更新）
- 是否正确识别了重定价日为1月1日的含义

### Step 2: 信息验证与矛盾处理（重要加分项，+0.15）
这是区分普通助手和优秀助手的关键维度：
- **月供反推验证**：是否用62万/21年剩余/5.20%反推月供，发现计算结果（约4300元）与用户说的5380元明显不符？(+0.05)
- **追问确认**：发现不符后，是否主动追问用户确认剩余本金、已还期数等信息，而不是直接用不一致的数据继续计算？(+0.05)
- **可能性分析**：是否给出了矛盾的可能解释（本金记错、期限记错、5380可能是调整前的数字等），帮用户定位真实数据？(+0.05)
- 如果助手完全没有做任何验证，直接用用户给的数字计算，此项得0

### Step 3: 月供变化计算（必备，缺失则不超过0.5）
- 是否给出了利率调整前后的具体月供数字
- 是否与用户APP显示的5380元做了对照验证

### Step 4: 公积金可持续性分析（重要，缺失不超过0.6）
- 是否评估了公积金余额在停缴状态下的耗尽时间
- 是否提醒用户公积金见底后需要用现金补足月供
- 是否给出了现金流规划建议

### Step 5: 提前还贷分析（加分项，+0.10）
- 对比了缩短期限 vs 减少月供两种方案
- 结合用户的现金流情况给出了合理建议
- 计算了利息节省总额

### Step 6: 领域知识应用（加分项，每项 +0.04）
- **组合贷利率分别调整机制**：是否说明了组合贷中商贷和公积金贷款的利率是分别调整的——商贷跟LPR走（重定价日更新），公积金贷款利率由央行单独调整（调整频次和幅度不同），两者不是同步变动的 (+0.04)
- **公积金停缴后余额耗尽时间计算**：是否具体计算了公积金账户余额（4万出头）按月扣480元大约能撑多少个月（约83个月≈7年），而不是笼统说"七八个月"；是否指出公积金耗尽后月供增加的具体金额 (+0.04)
- **LPR加点值与重定价日机制**：是否解释了加点值在合同期内固定不变（+55bp），只有LPR部分在重定价日（1月1日）更新；是否说明了重定价日选择1月1日的利弊（1月1日更早享受降息但也更早承受加息） (+0.04)
- **提前还款对个税专项扣除的影响**：是否提到如果提前还清贷款将不能再享受住房贷款利息专项附加扣除（每月1000元额度），并分析了缩短期限（但不还清）是否仍可继续享受扣除 (+0.04)

### Step 7: 综合建议与操作方案（加分项，+0.05）
- 综合以上分析给出明确的个性化建议
- 给出了具体操作步骤或行动清单

## 评分汇总
- Step 1 + Step 3 + Step 4 都满足：基础分 0.50
- Step 2（矛盾处理）：最高 +0.15（关键区分维度）
- Step 5（提前还贷）：+0.10
- Step 6 每个知识点 +0.04（最高 +0.16）
- Step 7: +0.05
- 理论满分路径：0.50 + 0.15 + 0.10 + 0.16 + 0.05 = 0.96
- 如果回答特别出色（如给出了用户没想到的洞察），可酌情给到 1.0"""

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
