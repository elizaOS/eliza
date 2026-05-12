"""C32zh_saas_metrics grader — multi-turn user-agent consultation: SaaS OKR量化指标."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA241Grader(UserAgentClarifyGraderBase):
    """SaaS指标 — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.35 * numerical + 0.30 * content
    """

    DOMAIN = "SaaS指标"
    MUST_ASK = [
        "产品所处阶段（初创/成长/成熟）及营收规模",
        "具体产品方向/赛道",
        "需要设定 benchmark 的具体 KR 指标有哪些",
        "当前的关键运营数据（NRR、churn等）",
        "自定义复合指标的构成与权重",
    ]

    CLARIFICATION_RUBRIC = """评估助手在对话中的信息收集质量（0.0-1.0）。
不仅看第一轮的提问，也看整个对话过程中助手是否逐步深入收集了做决策所需的信息。

## 基础信息（必须收集，缺失任意一项不超过0.7）
  - 产品所处阶段（初创/成长/成熟）
  - 营收规模（ARR量级）
  - 具体产品方向/赛道
  - 需要设定benchmark的具体KR指标列表

## 深入信息（好的顾问会进一步追问，每覆盖一项加分）
  - 当前NRR和churn的实际数据（判断现状与目标差距）
  - 功能采纳率的衡量方式（DAU/MAU还是其他口径）
  - 客户健康度评分的具体构成维度和权重
  - 客户分层结构（SMB / Mid-Market / Enterprise占比）
  - CAC payback或获客成本情况

评分标准：
- 1.0：基础信息全部收集 + 主动追问了2项以上深入信息
- 0.8-0.9：基础信息全部收集 + 追问了1项深入信息
- 0.7：基础信息全部收集，但未追问任何深入信息
- 0.4-0.6：基础信息缺失1-2项
- 0.1-0.3：几乎没有主动提问，直接给出泛泛的benchmark
- 0.0：完全没有任何澄清行为

注意：
- 如果用户主动提供了部分信息，助手只需询问缺失的部分即可
- 深入信息不要求在第一轮就问完，可以在后续对话中自然追问"""

    TRAJECTORY_RUBRIC = """请评估整个对话过程中，助手对用户意图的理解和响应质量（0.0-1.0）。
不要只看最终回答，而是审视每一轮对话中助手的表现。

## 评估维度

### 1. 信息缺失识别（用户没给的关键信息，助手是否察觉并追问）
- 用户的初始query只说了"B端SaaS产品"和"KR目标范围"，缺少阶段、赛道、具体指标、当前数据等
- 助手是否在第一轮就识别出缺失并主动询问，而非先给模糊回答再补问

### 2. 信息修正与矛盾捕捉
- 用户会透露月churn约5%且NRR约105%——这两个数据存在潜在矛盾
- 助手是否察觉到月churn 5%（年化约46%）与NRR 105%难以共存的矛盾
- 助手是否在对话中恰当地提出了这个疑点

### 3. 需求演变跟踪
- 用户的需求从"找benchmark"逐步深入到"自定义指标怎么设"再到"数据是否合理"
- 助手是否跟上了需求的自然演变

### 4. 工具使用合理性
- **计算工具**：是否在验证churn/NRR关系时用计算工具做定量分析（如月churn 5%→年化留存=0.95^12≈54%→年churn 46%→需要expansion ~51%才能NRR 105%）
- **搜索工具**：是否搜索了SaaS行业benchmark数据（如OpenView、Bessemer、KeyBanc的报告）
  - 优秀(不扣分)：搜索查询精准，1-3次覆盖关键benchmark来源
  - 良好(扣0.05)：需要4-5次搜索
  - 一般(扣0.1)：过度搜索（6次以上）或重复搜索
  - 较差(扣0.15)：搜索了但结果未被有效使用
  - 未搜索(扣0.1)：完全没有搜索，仅凭记忆给出benchmark（存在数据过时风险）。若凭记忆给出的数据恰好准确，可减轻至扣0.05

### 5. 对话节奏控制
- 是否在合适的时机给出阶段性结论
- 收集到足够信息后是否及时给出分析，而非无限追问

## 评分标准
- 1.0：每一轮都精准理解用户意图，矛盾识别敏锐，工具使用高效恰当
- 0.7-0.9：整体理解准确，工具使用基本合理，偶有一轮响应不够精准
- 0.4-0.6：部分轮次理解偏差明显（如忽略了churn/NRR矛盾），或工具使用不当
- 0.1-0.3：多轮对话中反复出现意图误解或信息遗漏
- 0.0：完全无法跟踪用户意图"""

    NUMERICAL_RUBRIC = """请只评估助手回答中涉及的数值和行业benchmark准确性（0.0-1.0）。不要考虑内容质量、建议好坏等因素，只关注数字对不对。

## 话题一致性（前置检查）
原始问题是关于「B端SaaS产品OKR量化指标的行业benchmark」。
如果助手的最终回答完全偏离了这个主题，数值准确性直接判0。

## 用户提供的参数
  - 产品阶段：成长期，ARR约2000万
  - 赛道：企业协作SaaS
  - KR指标：功能采纳率(DAU/MAU)、客户健康度评分覆盖率、NRR
  - 当前NRR：约105%
  - 当前月churn：约5%

## 行业benchmark参考值（公开数据源）

| 检查项 | 参考范围 | 允许误差 | 来源 |
|--------|----------|----------|------|
| NRR（好的SaaS） | **100%-120%** | 提到的范围落在90%-130%内均可接受 | OpenView, Bessemer |
| NRR（顶级SaaS） | **>120%** | 提到顶级水平超过120%即可 | 公开数据 |
| Gross churn（月）| **<5%** 为良好 | 提到月churn 3%-7%的范围均可 | SaaS行业通用 |
| 功能采纳率 DAU/MAU | **20%-30%** 为SaaS平均 | 15%-40%范围内均可接受 | Mixpanel benchmarks |
| CAC payback | **12-18个月** | 8-24个月范围内均可接受 | KeyBanc, OpenView |

## 关键矛盾验算（程序化计算）
用户说月churn 5%且NRR 105%，助手应发现矛盾：
  - 月churn 5% → 年化留存 = 0.95^12 ≈ 0.540 → 年churn约46%
  - 要维持NRR 105%，需要 expansion revenue ratio = 105% - 54% = 51%（即现有客户扩展收入占比51%）
  - 这个expansion比例极高，在ARR 2000万级别的成长期SaaS中极不寻常
  - 合理推测：用户可能混淆了月churn和年churn（如果年churn 5%则NRR 105%完全合理）

| 验算项 | 正确值 | 允许误差 |
|--------|--------|----------|
| 月churn 5%年化留存率 | **54%** (0.95^12) | ±3% |
| 维持NRR 105%所需expansion | **~51%** | ±5% |

## 评分规则（严格执行）
- 1.0：所有benchmark范围合理 + 发现并量化了churn/NRR矛盾
- 0.7-0.9：benchmark范围基本准确 + 至少定性提到了churn数据偏高或与NRR不匹配
- 0.5-0.6：benchmark范围大致准确，但完全没注意到churn/NRR矛盾
- 0.3-0.4：benchmark范围有明显偏差（如说NRR应该>150%，或DAU/MAU应>60%）
- 0.1-0.2：大部分benchmark数值错误或完全脱离行业实际
- 0.0：没有给出任何具体数值，或话题完全偏离"""

    CONTENT_RUBRIC = """请评估助手回答的内容质量（0.0-1.0）。不要考虑数值是否准确，只关注回答的完整性、专业性、实用性。

## 话题一致性（前置检查）
原始问题是关于「B端SaaS产品OKR量化指标的行业benchmark」。
如果助手的最终回答完全偏离了这个主题，内容质量直接判0。

## 用户完整情况（对话中逐步透露）
  - 成长期企业协作SaaS，ARR约2000万
  - 三个核心KR：功能采纳率(DAU/MAU)、客户健康度评分覆盖率、NRR
  - 客户健康度是自定义复合指标（使用频次+功能深度+NPS，各1/3权重）
  - 当前NRR约105%，月churn约5%

## 关键矛盾（高质量回答应发现并分析）
用户提供的月churn 5%与NRR 105%之间存在严重矛盾：
  - 月churn 5%意味着年化流失约46%，需要极高的expansion revenue才能维持NRR 105%
  - 这种组合在成长期SaaS中极为罕见
  - 最可能的解释：用户把年churn 5%说成了月churn 5%（年churn 5% + NRR 105%是完全合理的组合）
  - 好的助手应该指出这一点，帮用户厘清数据口径，避免基于错误数据设定OKR

## 评估标准：完整决策链路（6个步骤）

### Step 1: 分类给出benchmark（必备，缺失则不超过0.4）
- 区分了哪些KR有公开benchmark可参照（NRR、DAU/MAU、churn）、哪些需要自建基线（客户健康度）
- 给出了与阶段匹配的benchmark范围（不是笼统的"行业平均"，而是针对成长期/ARR 2000万级别）

### Step 2: 矛盾识别与数据质量分析（重要加分项，+0.15）
这是区分普通助手和优秀助手的关键维度：
- **发现churn/NRR矛盾**：指出月churn 5%与NRR 105%难以共存 (+0.05)
- **定量分析矛盾**：用计算说明月churn 5%年化后的实际影响（年留存约54%） (+0.05)
- **给出合理解释**：推测用户可能混淆了月/年churn，并建议核实数据口径 (+0.05)
- 如果完全没有发现矛盾，此项得0

### Step 3: 自定义指标拆解方法论（必备，缺失则不超过0.6）
- 为客户健康度评分这种无直接外部benchmark的复合指标，提供了拆解对标思路
- 如：各子维度（使用频次、功能深度、NPS）分别找外部参照，再组合为内部基线
- 或：建议先内部跑几个季度数据建立基线，再逐步调优

### Step 4: 领域知识应用（加分项，每项 +0.04）
- **SaaS指标体系关联性**：提到NRR、churn、expansion三者的数学关系，帮用户理解指标间的联动 (+0.04)
- **阶段匹配建议**：指出成长期SaaS应侧重的指标优先级（如NRR比gross margin更重要）(+0.04)
- **客户分层视角**：建议按客户规模（SMB/Mid-Market/Enterprise）分层看指标，避免平均值掩盖问题 (+0.04)
- **OKR设定方法论**：提到拍KR目标的方法（如基线+增幅、同行对标、历史趋势外推等） (+0.04)

### Step 5: 综合建议（加分项，+0.05）
- 综合所有分析给出个性化的OKR设定建议
- 建议考虑了用户的具体约束（成长期、ARR 2000万、自定义指标无外部对标）

### Step 6: 可操作的落地方案（加分项，+0.04）
- 给出了具体的下一步操作（如去哪里查报告、如何建内部基线、数据口径怎么统一）
- 使用了结构化格式方便用户直接参照

## 评分汇总
- Step 1 + Step 3 都满足：基础分 0.5
- Step 2（矛盾识别）：最高 +0.15（这是拉开差距的关键维度）
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
