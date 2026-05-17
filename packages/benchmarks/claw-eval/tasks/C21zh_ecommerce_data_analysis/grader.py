"""C21zh_ecommerce_data_analysis grader — multi-turn user-agent consultation: 电商数据分析."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA205Grader(UserAgentClarifyGraderBase):
    """电商数据分析 — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.35 * numerical + 0.30 * content
    """

    DOMAIN = "电商数据分析"
    MUST_ASK = [
        "退货率",
        "佣金率/分佣比例",
        "商品成本率/进货成本",
        "坑位费/主播固定费用",
        "主播分成比例",
        "平台技术服务费",
    ]

    CLARIFICATION_RUBRIC = """评估助手在对话中的信息收集质量（0.0-1.0）。
不仅看第一轮的提问，也看整个对话过程中助手是否逐步深入收集了做决策所需的信息。

## 基础信息（必须收集，缺失任意一项不超过0.7）
  - 成交额和投放费用（用户初始query已暗示有）
  - 退货率
  - 佣金率/分佣比例
  - 商品成本率或进货成本

## 深入信息（好的顾问会进一步追问，每覆盖一项加分）
  - 坑位费/主播固定出场费
  - 主播分成比例（按成交额的提成）
  - 平台技术服务费比例
  - 退货后佣金/服务费是否退还（影响实际成本计算）

评分标准：
- 1.0：基础信息全部收集 + 主动追问了2项以上深入信息
- 0.8-0.9：基础信息全部收集 + 追问了1项深入信息
- 0.7：基础信息全部收集，但未追问任何深入信息
- 0.4-0.6：基础信息缺失1-2项
- 0.1-0.3：几乎没有主动提问，直接基于不完整信息给出回答
- 0.0：完全没有任何澄清行为

注意：
- 如果用户主动提供了部分信息，助手只需询问缺失的部分即可
- 直播带货的成本结构远比"成交额-投放费"复杂，好的助手应该意识到这一点并主动追问
- 深入信息不要求在第一轮就问完，可以在后续对话中自然追问"""

    TRAJECTORY_RUBRIC = """请评估整个对话过程中，助手对用户意图的理解和响应质量（0.0-1.0）。
不要只看最终回答，而是审视每一轮对话中助手的表现。

## 评估维度

### 1. 信息缺失识别（用户没给的关键信息，助手是否察觉并追问）
- 用户的初始query只提到"算ROI"和"成交额除以投放费"——这远远不够
- 助手是否在第一轮就识别出需要了解完整成本结构，而非先给模糊回答再补问
- 关键缺失信息：退货率、佣金率、商品成本、坑位费、主播分成、平台服务费

### 2. 成本结构识别深度
- 用户只想到"投放费"这一个成本，助手是否主动引导用户梳理完整成本结构
- 是否展现出对直播带货业务模型的理解（知道有哪些成本项）
- 助手是否在收集到部分信息后能推测还有哪些遗漏

### 3. 需求演变跟踪
- 用户从"算ROI"可能演变为"到底赚没赚钱""怎么优化"
- 助手是否跟上了需求的自然演变

### 4. 工具使用合理性（如果助手使用了计算工具）
- 是否在需要精确计算时主动调用工具，而非心算给出近似值
- 工具调用的时机是否恰当（收集到足够参数后再计算）
- **错误与修正的评判标准（严格执行）**：
  - 一次调用就得到正确结果 = 最优，不扣分
  - 调用出错但能自行发现并修正 = 次优，扣0.1-0.2
  - 调用出错且未发现，将错误结果呈现给用户 = 严重问题，扣0.3-0.5

### 5. 对话节奏控制
- 是否在合适的时机给出阶段性结论，而非一直追问不给答案
- 用户追问新问题时，是否流畅衔接

### 6. 搜索工具使用质量（助手可使用 web_search 和 web_fetch）
本任务涉及平台政策信息（抖音佣金结算规则、退货后佣金是否退还等），好的助手可以搜索验证。

**搜索质量评估：**
- 优秀(不扣分)：搜索查询精准，1-3次搜索覆盖关键信息，搜索结果被正确整合到回答中
- 良好(扣0.05)：搜索了但查询不够精准，需要4-5次才找到关键信息
- 一般(扣0.1)：过度搜索（6次以上）或重复搜索相同内容
- 较差(扣0.15)：搜索了但结果没有被使用，或搜到了错误信息却未辨别
- 未搜索(扣0.05)：没有使用搜索工具，直接凭记忆回答平台政策。如果凭记忆给出的信息基本正确，可不扣分

## 评分标准
- 1.0：每一轮都精准理解用户意图，主动识别完整成本结构，工具使用高效恰当
- 0.7-0.9：整体理解准确，成本结构基本覆盖，偶有一轮响应不够精准
- 0.4-0.6：部分轮次理解偏差明显，成本项遗漏较多，或工具使用不当
- 0.1-0.3：多轮对话中反复出现意图误解或信息遗漏
- 0.0：完全无法跟踪用户意图"""

    NUMERICAL_RUBRIC = """请只评估助手回答中的数值计算准确性（0.0-1.0）。不要考虑内容质量、建议好坏等因素，只关注数字对不对。

## 话题一致性（前置检查）
原始问题是关于「抖音直播带货ROI和利润核算」。
如果助手的最终回答完全偏离了这个主题，数值准确性直接判0。

## 用户提供的参数（对话中逐步透露）
  - 成交额: 28万
  - 投放费用: 5.2万（千川投流）
  - 佣金率: 20%
  - 退货率: 18%
  - 商品成本率: 45%（占实际成交额）
  - 坑位费: 1万
  - 主播分成: 10%（按实际成交额）
  - 平台技术服务费: 2%

## 正确参考值（程序化计算）

**核心计算逻辑：先扣退货，再算各项成本**

| 检查项 | 正确值 | 计算过程 | 允许误差 |
|--------|--------|----------|----------|
| 实际成交额（扣退货后） | **22.96万** | 28×(1-0.18) | ±0.3万 |
| 佣金 | **4.592万** | 22.96×0.20 | ±0.3万 |
| 平台技术服务费 | **0.4592万** | 22.96×0.02 | ±0.1万 |
| 主播分成 | **2.296万** | 22.96×0.10 | ±0.2万 |
| 商品成本 | **10.332万** | 22.96×0.45 | ±0.5万 |
| 投放费用 | **5.2万** | 固定 | 精确 |
| 坑位费 | **1万** | 固定 | 精确 |
| 总成本 | **23.88万** | 4.592+0.4592+2.296+10.332+5.2+1 | ±0.8万 |
| 净利润 | **-0.92万** | 22.96-23.88 | ±0.5万（必须为负数） |
| 投放ROI | **4.42** | 22.96/5.2 | ±0.3 |
| 综合ROI | **0.96** | 22.96/23.88 | ±0.05 |

## 关键判断点
- 净利润必须为**负数**（亏损），这是本题的核心矛盾
- 如果助手算出正利润，说明成本项遗漏或计算错误，严重扣分
- 投放ROI(4.42)和综合ROI(0.96)的对比是核心洞察

## 评分规则（严格执行，不要被内容质量影响）
- 1.0：所有可验证数字都在允许误差范围内，净利润为负数，综合ROI<1
- 0.7-0.9：实际成交额和主要成本项正确，净利润为负数，个别小项有偏差
- 0.5-0.6：正确识别出退货影响并扣除，但部分成本项遗漏导致利润计算有偏差（可能算出微利）
- 0.3-0.4：计算了部分成本但遗漏多项，或未正确处理退货率（如用28万直接算成本）
- 0.1-0.2：只算了投放ROI=28/5.2=5.4，未做综合利润核算
- 0.0：没有给出任何数值计算，或参数使用完全错误

注意：
- 退货后佣金/服务费的处理存在不确定性（用户自己也不清楚），助手如果按实际成交额计算佣金是合理的
- 如果助手给出了两种情况的对比（退货佣金退/不退），应视为加分项"""

    CONTENT_RUBRIC = """请评估助手回答的内容质量（0.0-1.0）。不要考虑数值是否准确，只关注回答的完整性、专业性、实用性。

## 话题一致性（前置检查）
原始问题是关于「抖音直播带货ROI和利润核算」。
如果助手的最终回答完全偏离了这个主题，内容质量直接判0。

## 用户完整情况（对话中逐步透露）
  - 做抖音直播带货，卖家居收纳用品，客单价约60元
  - 直播数据：观看人次12万、成交额28万、投放费5.2万
  - 佣金率20%、退货率18%、商品成本率45%
  - 坑位费1万、主播分成10%、平台技术服务费2%
  - 用户自己算的投放ROI=28/5.2=5.4，觉得"还行"
  - 同行说"综合算下来可能不赚钱"

## 关键矛盾（高质量回答必须发现并分析）
这场直播的核心矛盾是：
  - 表面数据很好看：成交额28万，投放ROI=5.4
  - 但扣完退货(18%)后实际成交额只有22.96万
  - 再扣佣金+分成+成本+服务费，总成本23.88万 > 实际收入22.96万
  - **实际亏损约0.92万！综合ROI=0.96<1**
  - 用户只算了"投放ROI"而忽略了综合成本，这是典型的认知盲区
  - 好的助手必须主动指出这个矛盾：投放ROI好看≠赚钱

## 评估标准：完整决策链路（6个步骤）

### Step 1: 基础计算与成本拆解（必备，缺失则不超过0.4）
- 完整列出了所有成本项（佣金、商品成本、坑位费、主播分成、投放费、平台服务费）
- 正确处理了退货率对实际成交额的影响
- 计算了净利润和综合ROI

### Step 2: 认知矛盾揭示（重要加分项，+0.15）
这是区分普通助手和优秀助手的关键维度：
- **指出投放ROI vs 综合ROI的区别**：用户只看投放ROI=5.4就觉得不错，但综合ROI<1实际亏损 (+0.05)
- **解释为什么表面数据会误导**：高成交额、高投放ROI不代表赚钱，退货率和多层分成是隐形成本 (+0.05)
- **直接回应用户的疑惑**：同行说"综合算可能不赚钱"是对的，帮用户建立正确的ROI认知框架 (+0.05)
- 如果助手只算了投放ROI就告诉用户"表现不错"，此项得0

### Step 3: 成本结构分析（必备，缺失则不超过0.6）
- 分析了各项成本占比，找出最大的成本吞噬项
- 商品成本率45%是最大头（10.33万），其次是投放+坑位费（6.2万），然后是佣金（4.59万）
- 帮用户建立"成本全景图"的概念

### Step 4: 领域知识应用（加分项，每项 +0.04）
- **退货率对利润的杠杆效应**：退货率每降低1%对净利润的边际影响分析，18%的退货率在家居品类是否偏高 (+0.04)
- **佣金结构优化**：20%佣金率+10%主播分成=30%的分佣比例偏高，可考虑自播或调整合作模式 (+0.04)
- **投放效率指标**：除了ROI，还应关注GPM（千次观看成交额）、观看-成交转化率等指标来评估投放质量 (+0.04)
- **退货后费用退还规则**：说明抖音平台退货后佣金/技术服务费的退还政策（一般退货后佣金会退） (+0.04)
- **盈亏平衡点测算**：在当前成本结构下，要达到盈亏平衡需要多少成交额或退货率需降到多少 (+0.04)

### Step 5: 优化建议（加分项，+0.05）
- 综合以上分析给出明确、可操作的优化方向
- 建议应具有优先级排序（先优化影响最大的成本项）
- 如：降低退货率（改善产品描述准确度）、谈判更低佣金比例、提升客单价、考虑自播模式等

### Step 6: 决策支持工具（加分项，+0.04）
- 提供了利润核算模板或公式，方便用户未来自行计算
- 使用了结构化格式（表格或清单），一目了然
- 给出了关键指标的监控建议（哪些数字必须盯）

## 评分汇总
- Step 1 + Step 3 都满足：基础分 0.5
- Step 2（矛盾揭示）：最高 +0.15
- Step 4 每个知识点 +0.04（最高 +0.20）
- Step 5: +0.05
- Step 6: +0.04
- 理论满分路径：0.5 + 0.15 + 0.20 + 0.05 + 0.04 = 0.94
- 如果在以上基础上回答特别出色，可酌情给到 1.0"""

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
