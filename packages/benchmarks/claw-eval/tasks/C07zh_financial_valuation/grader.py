"""C07zh_financial_valuation grader — multi-turn user-agent consultation: 金融估值."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA10Grader(UserAgentClarifyGraderBase):
    """金融估值 — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.35 * numerical + 0.30 * content
    """

    DOMAIN = "金融估值"
    MUST_ASK = [
        "估值对象的行业属性（如医疗器械）",
        "融资阶段（如B轮）",
        "公司财务状况（是否有有息负债、收入规模、毛利率）",
        "业务模式（直销/经销比例、产品管线阶段）",
    ]

    CLARIFICATION_RUBRIC = """评估助手在对话中的信息收集质量（0.0-1.0）。
不仅看第一轮的提问，也看整个对话过程中助手是否逐步深入收集了做DCF估值所需的信息。

## 基础信息（必须收集，缺失任意一项不超过0.7）
  - 估值对象的行业属性（直接影响Beta和可比公司选取）
  - 融资阶段（影响风险溢价取值）
  - 公司资本结构（是否有有息负债，决定WACC计算方式）
  - 收入规模和增速预期（DCF模型核心输入）

## 深入信息（好的顾问会进一步追问，每覆盖一项加分）
  - 毛利率/净利率（构建利润预测需要）
  - 业务模式（直销/经销比例，影响费用率和增长确定性）
  - 产品管线阶段（如有在研管线，需要rNPV或概率加权）
  - 账面现金（净现金调整项）
  - 投资人的预期回报率或可比交易案例

评分标准：
- 1.0：基础信息全部收集 + 主动追问了2项以上深入信息
- 0.8-0.9：基础信息全部收集 + 追问了1项深入信息
- 0.7：基础信息全部收集，但未追问任何深入信息
- 0.4-0.6：基础信息缺失1-2项
- 0.1-0.3：几乎没有主动提问
- 0.0：完全没有任何澄清行为

注意：
- 如果用户主动提供了部分信息，助手只需询问缺失的部分即可
- 用户是非技术新手但有财务背景，提问应专业但不过度复杂"""

    TRAJECTORY_RUBRIC = """请评估整个对话过程中，助手对用户意图的理解和响应质量（0.0-1.0）。
不要只看最终回答，而是审视每一轮对话中助手的表现。

## 评估维度

### 1. 信息缺失识别（用户没给的关键信息，助手是否察觉并追问）
- 用户初始 query 只问了"无风险利率和折现率怎么取"，极其笼统
- 但DCF估值高度依赖公司具体参数，助手必须追问行业、融资阶段、财务数据等
- 助手是否在第一轮就识别出这些信息对折现率计算至关重要

### 2. 信息修正捕捉
- 用户先说"折现率先按15%算"——这其实偏低，助手是否在得到更多信息后建议修正
- 用户补充"5000万偏乐观了，今年大概率3500-4000万"——助手是否据此调整收入预测
- 用户说"债的部分可以忽略，基本没有有息负债"——助手是否正确处理了WACC=Ke

### 3. 需求演变跟踪
- 用户的需求从"无风险利率取多少"→"WACC完整计算"→"搭DCF模型"→"可比交易法交叉验证"
- 助手是否跟上了需求的自然升级，从点到面构建完整估值

### 4. 工具使用合理性（如果助手使用了计算工具）
- WACC计算和DCF建模需要精确——是否使用工具计算
- **错误与修正的评判标准（严格执行）**：
  - 一次计算正确 = 最优
  - 出错但自行修正 = 次优，扣0.1-0.2
  - 出错未发现 = 严重问题，扣0.3-0.5

### 5. 对话节奏控制
- 是否在获得足够参数后及时给出阶段性结论
- 用户下命令风格直接（"搭一下""列个表"），助手是否高效响应

### 6. 搜索工具使用质量（助手可使用 web_search 和 web_fetch）
本任务涉及时效性信息（当前国债收益率、ERP取值、可比公司Beta等）。

**搜索必要性判断：**
- 用户问"无风险利率现在取多少"——助手是否搜索了最新10年期国债收益率
- 可比公司Beta——是否搜索了A股/港股医疗器械上市公司的Beta数据
- 可比交易——是否搜索了介入类医疗器械近期融资案例

**搜索质量评估：**
- 优秀(不扣分)：精准搜索1-3次，覆盖利率+行业数据
- 良好(扣0.05)：搜索了但不够精准
- 一般(扣0.1)：过度搜索
- 未搜索(扣0.1)：凭记忆给出国债收益率等时效数据。如果记忆值合理，减轻至0.05

## 评分标准
- 1.0：每一轮都精准理解用户意图，参数修正零遗漏
- 0.7-0.9：整体理解准确，偶有一轮不够精准
- 0.4-0.6：部分轮次理解偏差（如忽略了用户的收入修正、未处理无负债情况）
- 0.1-0.3：多轮对话中反复出现意图误解
- 0.0：完全无法跟踪用户意图"""

    NUMERICAL_RUBRIC = """请只评估助手回答中的数值计算准确性（0.0-1.0）。不要考虑内容质量，只关注数字对不对。

## 话题一致性（前置检查）
原始问题是关于「医疗器械（介入类高值耗材）B轮项目的DCF估值和WACC计算」。
如果助手的最终回答完全偏离了这个主题，数值准确性直接判0。

## 用户提供的参数
  - 行业：医疗器械（介入类高值耗材）
  - 阶段：B轮
  - 无有息负债 → WACC = Ke（100%股权融资）
  - 去年收入：2000万
  - 今年预计：3500-4000万
  - 毛利率：75%
  - 经销为主，直销不到两成
  - 第二产品线在临床阶段
  - 账面现金：6000万
  - 永续增长率：用户指定3%

## 正确参考值（基于行业标准参数计算）

**WACC/Ke计算（CAPM + 调整项）：**

| 检查项 | 正确值/范围 | 允许误差 |
|--------|-------------|----------|
| Rf（无风险利率，10Y国债） | **~2.3%-2.5%** | +/- 30bp |
| Beta（医疗器械Unlevered） | **1.2-1.5** | +/- 0.3 |
| ERP（中国市场） | **6%-7%** | +/- 50bp |
| 规模溢价（微型企业） | **3%-5%** | 需至少 >= 2.5% |
| B轮/特定风险溢价 | **5%-8%** | 需至少 >= 4% |
| 最终Ke/WACC | **~20%-22%** | 合理区间 18%-25% |

参考计算: Ke = 2.5% + 1.3*6.5% + 4% + 6% = 20.95%

**关键逻辑检查：**

| 检查项 | 正确处理方式 | 评判标准 |
|--------|-------------|----------|
| 无有息负债 | WACC直接等于Ke | 如果仍计算Wd成分，逻辑错误 |
| 收入预测基础 | 今年用3500-4000万中值(3750) | 不应仍用5000万 |
| 永续增长率 | 3%（用户指定） | 不应擅自改为其他值 |

**可比交易法交叉验证：**

| 检查项 | 正确值/范围 | 允许误差 |
|--------|-------------|----------|
| PS倍数（介入类B轮） | **15-25x** 当年收入 | 10-30x可接受 |
| 估值区间（PS法） | **6.75亿-8.25亿** | +/- 2亿 |

## 评分规则（严格执行）
- 1.0：WACC在18-22%区间，各参数取值合理，可比法估值合理
- 0.7-0.9：WACC在15-25%区间，逻辑正确但个别参数偏差
- 0.4-0.6：WACC方法论正确但数字偏差较大（如用了15%折现率未修正）
- 0.2-0.3：WACC方法论有误（如未正确处理无负债情况）
- 0.0-0.1：未做WACC计算，或折现率严重偏离（<10%或>35%）
- 未正确处理无有息负债情况（WACC=Ke）→ 扣0.15
- 未提供可比交易法交叉验证 → 扣0.10
- 收入预测仍用5000万而非用户修正的3500-4000万 → 扣0.10"""

    CONTENT_RUBRIC = """请评估助手回答的内容质量（0.0-1.0）。不要考虑数值是否准确，只关注回答的完整性、专业性、实用性。

## 话题一致性（前置检查）
原始问题是关于「医疗器械B轮项目的DCF估值」。
如果助手的最终回答完全偏离了这个主题，内容质量直接判0。

## 用户完整情况（对话中逐步透露）
  - 人民币项目，医疗器械行业，介入类高值耗材
  - B轮融资估值用，预计融1.5-2亿，稀释15-20%
  - 无有息负债，去年收入2000万，今年3500-4000万（从乐观的5000万下修）
  - 去年净亏损约1500万（研发投入大）
  - 毛利率75%，研发费用率约40%（基数不明确）
  - 经销为主（直销不到两成）
  - 第二产品线在临床阶段，预计明年底拿证
  - 账面现金6000万（A轮剩的）
  - 核心产品只有一个注册证，竞品三四家（含进口替代龙头）
  - 集采风险：品类尚未进国家集采，但省级集采有苗头
  - 用户是有财务背景的非技术新手，命令式表达

## 关键矛盾（高质量回答应发现并分析）

**矛盾一：折现率15%偏低**
用户说"折现率先按15%算"，但这是一个B轮未盈利的医疗器械公司——行业通常用20-30%的折现率（VC method隐含IRR更高），15%更适合成熟期上市企业。好的助手在获得更多信息后应该指出15%偏低并建议修正到20%+，而不是直接用15%算。

**矛盾二：研发费用率40%的基数不明**
用户说"研发费用率现在大概40%"——但40%的基数是什么？如果是收入的40%=800万，那毛利1500万-800万研发=700万用于销售+管理，对于收入才2000万、亏损1500万的公司来说意味着销售+管理费用=2200万，管理费率110%，显然不合理。更合理的解读是40%指研发占总运营费用的比例（总费用~3500万×40%=1400万研发）。好的助手应该注意到这个歧义并追问确认。

## 评估标准：完整决策链路

### Step 1: 无风险利率取值说明（必备，缺失则不超过0.3）
- 是否说明了无风险利率的选取依据（10年期国债收益率）
- 是否给出了具体数值和数据来源

### Step 2: 信息验证与矛盾处理（重要加分项，+0.15）
这是区分普通助手和优秀助手的关键维度：
- **折现率纠偏**：用户提出15%折现率后，助手是否在获得"B轮、未盈利、医疗器械"等信息后指出15%偏低，并给出合理建议（20%+），而不是直接按15%计算？(+0.05)
- **费用率基数澄清**：用户说"研发费用率40%"——助手是否注意到如果以收入为基数（40%×2000万=800万），则费用结构与亏损1500万不自洽，进而追问40%是基于收入还是基于总运营费用？(+0.05)
- **收入预期修正确认**：用户从"5000万"修正为"3500-4000万"——助手是否据此调整预测基础，而非继续沿用5000万？(+0.05)
- 如果助手直接用15%折现率和未经确认的费用率建模，此项得0

### Step 3: WACC/Ke完整推导（必备，缺失则不超过0.4）
- 是否展示了完整的CAPM公式和各参数取值
- 是否正确处理了"无有息负债"情况（WACC=Ke，无需算债务成本）
- 各参数是否有行业数据支撑（可比公司Beta、ERP来源等）
- 是否体现了B轮项目的特有风险溢价

### Step 4: 收入预测与DCF框架（必备，缺失则不超过0.5）
- 是否基于用户提供的3500-4000万构建了收入预测
- 是否建立了合理的增速递减路径
- 是否考虑了毛利率75%→净利率的转化路径
- 终值计算是否使用了永续增长模型(g=3%)

### Step 5: 可比交易法（重要加分项，+0.10）
- 是否提供了介入类医疗器械的可比融资案例
- PS/EV倍数是否合理
- 是否与DCF结果做了交叉验证

### Step 6: 领域知识应用（加分项，每项 +0.04）
- **VC method vs DCF的适用性讨论**：是否指出对于B轮未盈利公司，纯DCF估值的局限性（现金流为负、终值占比过高），建议结合VC method（基于目标退出倍数反推）或可比交易法，而非仅依赖DCF (+0.04)
- **医疗器械集采风险折价**：是否在估值中考虑了集采风险（品类尚未进国家集采但省级有苗头），并给出了合理的风险折价处理方式（如在DCF中加入集采情景分析、或在估值倍数上打折） (+0.04)
- **第二产品线的 option value 估值**：第二产品线在临床阶段（明年底拿证）——是否建议用rNPV（风险调整净现值）或 option value 方法单独估值，而非简单并入主业DCF（因为临床阶段成功概率<100%） (+0.04)
- **可比交易法的选取标准**：是否讨论了可比交易案例的筛选逻辑（阶段匹配、品类匹配、时间窗口），并对用户提供的XX心脉/XX脉搏案例做了适用性评判（如这些公司是否同为介入类、融资时间是否近期） (+0.04)

### Step 7: 综合估值结论（加分项，+0.05）
- 是否给出了明确的估值区间（而非只给参数不给结论）
- 估值区间是否综合了DCF和可比法的结果
- 是否标注了Pre-money/Post-money

## 评分汇总
- Step 1 + Step 3 + Step 4 都满足：基础分 0.50
- Step 2（矛盾处理）：最高 +0.15（关键区分维度）
- Step 5（可比交易法）：+0.10
- Step 6 每个知识点 +0.04（最高 +0.16）
- Step 7: +0.05
- 理论满分路径：0.50 + 0.15 + 0.10 + 0.16 + 0.05 = 0.96
- 如果估值框架特别完善（如给出了完整的情景分析矩阵），可酌情给到 1.0"""

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
