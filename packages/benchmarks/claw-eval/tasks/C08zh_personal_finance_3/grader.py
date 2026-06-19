"""C08zh_personal_finance_3 grader — multi-turn user-agent consultation: 个人理财（个人养老金）."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA11Grader(UserAgentClarifyGraderBase):
    """个人理财（个人养老金） — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.30 * numerical + 0.35 * content
    """

    DOMAIN = "个人理财"
    MUST_ASK = [
        "当前的年龄及退休状态",
        "目前的年应纳税所得额或具体税率档位",
        "是否有其他长期储蓄或投资需求",
        "对资金流动性的具体要求",
]

    CLARIFICATION_RUBRIC = """评估助手在对话中的信息收集质量（0.0-1.0）。
不仅看第一轮的提问，也看整个对话过程中助手是否逐步深入收集了做决策所需的信息。

## 基础信息（必须收集，缺失任意一项不超过0.7）
  - 当前年龄及退休状态（内退/正式退休/在职）
  - 目前的年应纳税所得额或收入水平（判断适用税率档位）

## 深入信息（好的顾问会进一步追问，每覆盖一项加分）
  - 是否有其他长期储蓄或投资需求（如增额终身寿险等替代方案的比较基础）
  - 对资金流动性的具体要求（有多少闲钱、是否对锁定期有顾虑）
  - 现有的社保和养老保障情况
  - 是否已有其他税收优惠抵扣项（如专项附加扣除）

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
- 用户的初始 query 缺少年龄、退休状态、收入水平等关键参数
- 助手是否在第一轮就识别出缺失并主动询问，而非先给模糊回答再补问

### 2. 信息修正捕捉
- 用户在对话中可能修正信息（如收入数字、理财产品细节）
- 助手是否准确捕捉到修正，并在后续分析中使用修正后的值
- 例如用户一开始说"十万出头"，后来说"十五六万"，助手是否跟上

### 3. 需求演变跟踪
- 用户可能从"个人养老金划不划算"演变为"增额终身寿险靠不靠谱"再到"闲钱怎么配置"
- 助手是否跟上了需求的自然演变，还是机械地回答最初的问题

### 4. 工具使用合理性（如果助手使用了计算工具）
- 是否在需要精确计算时主动调用工具（如节税额计算、IRR计算）
- **错误与修正的评判标准（严格执行）**：
  - 一次调用就得到正确结果 = 最优，不扣分
  - 调用出错但能自行发现并修正 = 次优，扣0.1-0.2
  - 调用出错且未发现，将错误结果呈现给用户 = 严重问题，扣0.3-0.5
  - 注意：自我修正不应被视为"加分项"，它本质上是先犯了错再补救

### 5. 对话节奏控制
- 是否在合适的时机给出阶段性结论，而非一直追问不给答案
- 用户追问新问题时，是否流畅衔接而非生硬打断

### 6. 搜索工具使用质量（助手可使用 web_search 和 web_fetch）
本任务涉及时效性信息（个人养老金政策变化、最新试点范围、产品利率），好的助手应主动搜索验证而非凭记忆回答。

**搜索必要性判断：**
- 用户问到个人养老金政策"今年的变化"——助手是否搜索了最新政策动态？
- 用户提到增额终身寿险——助手是否搜索了当前预定利率标准？
- 如果助手完全没搜索就给出了政策细节或利率数字，需要考虑信息可能过时

**搜索质量评估：**
- 优秀(不扣分)：搜索查询精准，1-3次搜索覆盖关键信息，结果被正确整合到回答中
- 良好(扣0.05)：搜索了但查询不够精准，需要4-5次才找到关键信息
- 一般(扣0.1)：过度搜索（6次以上）或重复搜索相同内容
- 较差(扣0.15)：搜索了但结果没有被使用，或搜到了错误信息却未辨别
- 未搜索(扣0.1)：完全没有使用搜索工具，直接凭记忆给出时效性信息。但如果凭记忆给出的信息恰好正确，可减轻扣分至0.05

## 评分标准
- 1.0：每一轮都精准理解用户意图，信息修正零遗漏，需求演变完美跟踪，工具使用高效恰当
- 0.7-0.9：整体理解准确，工具使用基本合理，偶有一轮响应不够精准
- 0.4-0.6：部分轮次理解偏差明显，或工具使用不当
- 0.1-0.3：多轮对话中反复出现意图误解或信息遗漏
- 0.0：完全无法跟踪用户意图"""

    NUMERICAL_RUBRIC = """请只评估助手回答中的数值计算准确性（0.0-1.0）。不要考虑内容质量、建议好坏等因素，只关注数字对不对。

## 话题一致性（前置检查）
原始问题是关于「个人养老金账户是否划算 + 增额终身寿险收益分析」。
如果助手的最终回答完全偏离了这个主题，数值准确性直接判0。

## 用户提供的参数
  - 年龄：56岁，已内退
  - 年收入：约15-16万（含顾问费）
  - 闲钱规模：三四十万
  - 个人养老金年缴存上限：12,000元
  - 增额终身寿险：用户提到预定利率2.5%，每年交2万交5年

## 正确参考值（程序化计算）

**个人养老金节税计算：**

| 检查项 | 正确值 | 允许误差 |
|--------|--------|----------|
| 适用税率档位 | 10%档 | 必须正确判断 |
| 缴存环节省税 | 1,200元 (12000×10%) | ±200元 |
| 领取环节缴税 | 360元 (12000×3%) | ±100元 |
| 净节税 | 约840元/年 | ±300元 |
| 资金锁定期 | 4-9年（56→60-65岁） | ±2年 |

**增额终身寿险验算（如果助手分析了）：**

| 检查项 | 正确值 | 允许误差 |
|--------|--------|----------|
| 预定利率 | 2.5%（用户更正后） | 必须使用更正后的值 |
| 10万本金(2万×5年)第10年价值 | 约13万（用户描述） | 合理性判断即可 |
| 实际IRR | 低于2.5%（因为不是一次性投入） | 方向正确即可 |

## 评分规则（宽容度较高，因为这些是软性/定性数值）
- 1.0：节税计算正确，税率档位判断正确，锁定期分析正确
- 0.7-0.9：节税方向正确，个别数字有小偏差（如把10%误判为20%但净节税量级差不多）
- 0.4-0.6：节税计算有较大偏差但方向正确
- 0.2-0.3：税率档位判断错误或节税方向相反
- 0.0-0.1：完全没有数值分析，或数值严重错误"""

    CONTENT_RUBRIC = """请评估助手回答的内容质量（0.0-1.0）。不要考虑数值是否准确，只关注回答的完整性、专业性、实用性。

## 话题一致性（前置检查）
原始问题是关于「个人养老金账户是否划算」，对话可能演变到增额终身寿险分析和资产配置建议。
如果助手的最终回答完全偏离了这些主题，内容质量直接判0。

## 用户完整情况（对话中可能逐步透露）
  - 56岁，已内退，非法定退休
  - 年收入约15-16万（含顾问费）
  - 有三四十万闲钱，对资金锁定有顾虑
  - 银行理财经理推荐增额终身寿险（先说预定利率3.0%，后更正为2.5%）
  - 演示表显示每年交2万交5年，第十年累计约13万
  - 专项附加扣除：赡养老人每月3000（双亲90岁独子），社保个人部分约1800/月
  - 用户精明务实，讨厌被忽悠

## 评估标准：完整决策链路（7个步骤）

### Step 1: 政策解读（必备，缺失则不超过0.4）
- 正确说明个人养老金的缴存上限（12000元/年）、税前扣除规则、领取时3%税率
- 说明试点扩大到全国的政策变化

### Step 2: 信息验证与矛盾处理（重要加分项，+0.15）
这是区分普通助手和优秀助手的关键维度：
- **增额终身寿险IRR反推验证**：用户先说预定利率3.0%后更正为2.5%，好的助手应帮用户验算演示表（2万×5年=10万本金，第十年约13万）——如果IRR=2.5%，10万5年后约11.3万而非13万；如果达到13万则IRR需≈3.0%以上。两个数字哪个对需要反推，而非简单采信用户的某一个说法 (+0.05)
- **税率档位验算**：用户自以为在10%档，但按实际扣除计算（15.5万-6万起征-3.6万赡养老人-2.16万社保≈3.74万应纳税所得额），实际可能只在3%档（≤36000为3%，>36000为10%）。如果真在3%档，个人养老金每年省税只有360元而非1200元，节税意义大打折扣。好的助手应主动帮用户重新计算税率档位 (+0.05)
- **内退身份与锁定期矛盾**：56岁内退≠法定退休，资金锁定4-9年，节税收益（可能仅360元/年）是否值得锁定 (+0.05)
- 如果助手完全没有做任何验证，直接采信用户给的数字和税率判断，此项得0

### Step 3: 个性化节税分析（必备，缺失则不超过0.5）
- 结合用户年收入和专项扣除判断适用税率档位
- 计算出每年净节税额度，明确节税幅度有限

### Step 4: 领域知识应用（加分项，每项 +0.04）
- **个人养老金12000额度与3%取出税率**：准确说明缴存上限和领取税率的具体规则，而非笼统带过 (+0.04)
- **税延养老保险vs个人养老金区别**：用户提到听儿子说过"税延养老保险"，好的助手应说明两者的关系（税延养老保险是前身试点产品，个人养老金是全面替代升级） (+0.04)
- **增额终身寿险IRR验算方法**：不仅指出IRR概念，还能用分期缴费的现金流模型（非一次性投入）正确计算实际收益率 (+0.04)
- **专项附加扣除对应纳税所得额的影响**：能清晰拆解用户的税前扣除项（起征点+赡养老人+社保），计算出精确的应纳税所得额 (+0.04)

### Step 5: 综合建议（加分项，+0.05）
- 综合以上分析（包括矛盾处理的结论）给出明确的、个性化的建议
- 建议考虑了用户的具体约束条件（56岁内退、流动性需求、闲钱规模、真实税率档位）

### Step 6: 替代方案与行动清单（加分项，+0.04）
- 给出闲钱配置的替代方案（如大额存单、国债、低风险理财）
- 使用结构化格式（表格或清单），方便用户直接参照

## 评分汇总
- Step 1 + Step 3 都满足：基础分 0.5
- Step 2（信息验证与矛盾处理）：最高 +0.15（这是拉开差距的关键维度）
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

        # 3. Numerical accuracy (30%)
        numerical_score = 0.0
        try:
            result = judge.evaluate(prompt_text, full_conversation, "",
                                    self.NUMERICAL_RUBRIC)
            numerical_score = result.score
            print(f"[grader] numerical score: {numerical_score:.2f} — {result.reasoning[:200]}")
        except Exception as exc:
            print(f"[grader] numerical judge failed: {exc}")

        # 4. Content quality (35%)
        content_score = 0.0
        try:
            result = judge.evaluate(prompt_text, full_conversation, "",
                                    self.CONTENT_RUBRIC)
            content_score = result.score
            print(f"[grader] content score: {content_score:.2f} — {result.reasoning[:200]}")
        except Exception as exc:
            print(f"[grader] content judge failed: {exc}")

        # Combine: 15% clarify + 20% trajectory + 30% numerical + 35% content
        scores.completion = round(
            0.15 * clarify_score +
            0.20 * trajectory_score +
            0.30 * numerical_score +
            0.35 * content_score,
            4
        )
        print(f"[grader] completion: {scores.completion:.4f} "
              f"(clarify={clarify_score:.2f}*0.15 + trajectory={trajectory_score:.2f}*0.20 "
              f"+ numerical={numerical_score:.2f}*0.30 + content={content_score:.2f}*0.35)")

        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
