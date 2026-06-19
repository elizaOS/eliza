"""C20zh_mental_health_social_work grader — multi-turn user-agent consultation: 精神卫生社工."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA200Grader(UserAgentClarifyGraderBase):
    """精神卫生社工 — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.25 * numerical + 0.40 * content
    """

    DOMAIN = "精神卫生社工"
    MUST_ASK = [
        "患者基本信息（性别、年龄、诊断详情）",
        "当前用药方案及住院时长",
        "出院时的量表评估结果（PHQ-9、AUDIT等）及当前临床状态",
        "患者的社会支持系统（家庭、就业、社区接收机构等）",
        "用药依从性及近期行为事件（饮酒、睡眠等）",
        "既往自伤/自杀史",
    ]

    CLARIFICATION_RUBRIC = """评估助手在对话中的信息收集质量（0.0-1.0）。
不仅看第一轮的提问，也看整个对话过程中助手是否逐步深入收集了制定社区转介方案所需的信息。

## 基础信息（必须收集，缺失任意一项不超过0.7）
  - 患者基本信息（性别、年龄、诊断详情——尤其是共病类型）
  - 当前用药方案及住院时长
  - 出院时的量表评估结果（PHQ-9、AUDIT等）及当前临床状态
  - 患者的社会支持系统（家庭、就业、社区接收机构等）

## 深入信息（好的社工顾问会进一步追问，每覆盖一项加分）
  - 用药依从性情况（尤其是锂盐依从性，这对安全监测至关重要）
  - 近期行为事件（住院期间是否有饮酒、情绪波动等）
  - 既往自伤/自杀史（对危机预警方案设计至关重要）
  - 患者本人对出院的态度和意愿
  - 社区接收方的具体能力（有无686项目随访团队、精防人员配置等）
  - 近期血锂浓度及检查时间（判断值的时效性）

评分标准：
- 1.0：基础信息全部收集 + 主动追问了3项以上深入信息（特别是自伤史和用药依从性）
- 0.8-0.9：基础信息全部收集 + 追问了1-2项深入信息
- 0.7：基础信息全部收集，但未追问任何深入信息
- 0.4-0.6：基础信息缺失1-2项
- 0.1-0.3：几乎没有主动提问，直接基于不完整信息给出回答
- 0.0：完全没有任何澄清行为

注意：
- 如果用户主动提供了部分信息，助手只需询问缺失的部分即可
- 对于精神科社区转介，追问自伤/自杀史和用药依从性是专业素养的体现，应给予加分
- 深入信息不要求在第一轮就问完，可以在后续对话中自然追问"""

    TRAJECTORY_RUBRIC = """请评估整个对话过程中，助手对用户意图的理解和响应质量（0.0-1.0）。
不要只看最终回答，而是审视每一轮对话中助手的表现。

## 评估维度

### 1. 信息缺失识别（用户没给的关键信息，助手是否察觉并追问）
- 用户的初始 query 只说了"共病患者社区转介"，缺少具体诊断、用药、量表、社会支持等关键参数
- 助手是否在第一轮就识别出缺失并主动询问，而非先给笼统回答再补问

### 2. 信息修正/补充捕捉
- 用户在对话中逐步补充信息（如从基本诊断到透露近期饮酒事件、自伤史等）
- 助手是否准确捕捉到新增信息的临床意义并调整方案
- 特别注意：当用户透露近期饮酒事件和两天未睡时，助手是否意识到这改变了风险分层

### 3. 需求演变跟踪
- 用户的需求可能从"社区随访规范"演变为"具体转介方案制定"再到"血锂值可靠性咨询"
- 助手是否跟上了需求的自然演变，还是机械地回答最初的问题

### 4. 工具使用合理性
- **计算工具**：是否在需要验算量表分值或计算风险评分时使用工具
- **搜索工具**：是否搜索了最新的临床指南和专家共识
  - 一次通过最优，自我修正次优（扣 0.1-0.2），错误未发现最差（扣 0.3-0.5）

### 5. 对话节奏控制
- 是否在收集到足够信息后及时给出方案，而非一直追问不给结论
- 用户追问新问题时（如血锂值可靠性），是否流畅衔接

### 6. 搜索工具使用质量
本任务涉及时效性专业信息（最新临床指南、686项目政策、专家共识），好的助手应主动搜索验证而非凭记忆回答。

**搜索必要性判断：**
- 用户问"国内社区随访规范或专家共识"——助手是否搜索了最新的相关指南？
- 双相障碍合并物质依赖的社区管理——是否有专门的共识或指南？
- 686项目（严重精神障碍管理治疗项目）的最新政策——是否搜索确认？

**搜索质量评估：**
- 优秀(不扣分)：搜索查询精准，1-3次搜索覆盖关键信息（临床指南+政策规范），搜索结果被正确整合到回答中
- 良好(扣0.05)：搜索了但查询不够精准，需要4-5次才找到关键信息
- 一般(扣0.1)：过度搜索（6次以上）或重复搜索相同内容
- 较差(扣0.15)：搜索了但结果没有被使用，或搜到了错误信息却未辨别
- 未搜索(扣0.1)：完全没有使用搜索工具，直接凭记忆给出指南和政策信息

## 评分标准
- 1.0：每一轮都精准理解用户意图，信息补充零遗漏，需求演变完美跟踪，工具使用高效恰当
- 0.7-0.9：整体理解准确，工具使用基本合理，偶有一轮响应不够精准
- 0.4-0.6：部分轮次理解偏差明显（如忽略了近期饮酒事件的临床意义），或工具使用不当
- 0.1-0.3：多轮对话中反复出现意图误解或信息遗漏
- 0.0：完全无法跟踪用户意图"""

    NUMERICAL_RUBRIC = """请只评估助手回答中涉及量表评分解读和数值判断的准确性（0.0-1.0）。不要考虑内容质量、建议好坏等因素，只关注数值相关判断对不对。

## 话题一致性（前置检查）
原始问题是关于「精神障碍共病患者的社区转介和随访规范，特别是危机预警指标和量表」。
如果助手的最终回答完全偏离了这个主题，数值准确性直接判0。

## 用户提供的量表与数值参数
  - PHQ-9：8分
  - AUDIT：14分
  - GAF：住院时45分，出院前58分（第三批信息）
  - 血锂浓度：0.6mmol/L（两周前）
  - 碳酸锂剂量：0.9g/d
  - 拉莫三嗪剂量：100mg/d
  - 住院天数：68天
  - 既往自伤史：3年前割腕（重度抑郁发作期间）

## 正确参考值与解读标准

### 量表分值解读：

| 检查项 | 正确解读 | 关键判断 |
|--------|----------|----------|
| PHQ-9 = 8分 | 轻度抑郁（5-9分为轻度） | 但结合近期情绪波动和自伤史，实际风险可能被低估 |
| AUDIT = 14分 | 危险饮酒（8-15分为危险饮酒） | 但患者住院期间仍在饮酒、请假大量饮酒，实际严重程度可能高于此分值 |
| GAF 45→58分 | 从严重功能损害改善到中度（住院有效） | 58分仍属中度功能障碍，社区生活能力有限 |
| 血锂 0.6mmol/L | 处于治疗浓度低限（维持期0.6-0.8mmol/L） | 两周前的值+近期饮酒→需复查 |

### 风险分层判断：

| 检查项 | 正确判断 | 允许表述 |
|--------|----------|----------|
| 整体风险等级 | 中高风险 | "中高风险""较高风险""高风险"均可接受 |
| 自杀风险评估 | 需特别关注（有自伤史+残留抑郁+近期波动） | 不能因为PHQ-9只有8分就判定低风险 |
| 复发风险 | 高（共病+依从性差+社会支持薄弱） | 应明确指出共病增加复发风险 |

### 关键矛盾识别（高区分度）：

| 矛盾点 | 正确识别 |
|--------|----------|
| AUDIT 14分 vs 实际饮酒行为 | AUDIT可能低估——住院期间仍饮酒、请假大量饮酒的行为模式更接近AUDIT≥20（酒精依赖级别），14分可能是入院时评的或患者低报 |
| 血锂0.6 vs 近期饮酒 | 酒精导致脱水可使血锂浓度波动（升高风险），两周前的值可能已不准确，应出院前复查 |
| PHQ-9=8 vs 近期两天未睡+情绪波动 | 8分可能低估当前状态，且两天未睡需排除轻躁狂转相可能 |

## 评分规则（严格执行）
- 1.0：正确解读所有量表分值含义 + 识别出至少2个矛盾点 + 风险分层准确（中高风险）
- 0.7-0.9：正确解读主要量表 + 识别出至少1个矛盾点 + 风险分层基本准确
- 0.5-0.6：正确解读量表分值但未识别任何矛盾，或风险分层偏低（如判定为低风险）
- 0.3-0.4：部分量表解读有误（如将AUDIT 14分解读为"低风险"或将PHQ-9 8分解读为"无抑郁"）
- 0.1-0.2：多项量表解读有明显错误
- 0.0：完全没有对量表数值进行解读，或解读全部错误"""

    CONTENT_RUBRIC = """请评估助手回答的内容质量（0.0-1.0）。不要考虑数值是否准确，只关注回答的完整性、专业性、实用性。

## 话题一致性（前置检查）
原始问题是关于「精神障碍共病患者的社区转介和随访规范」。
如果助手的最终回答完全偏离了这个主题，内容质量直接判0。

## 用户完整情况（对话中逐步透露）
  - 男，34岁，无业，诊断双相情感障碍II型合并酒精依赖，住院68天
  - 用药：碳酸锂0.9g/d + 拉莫三嗪100mg/d，锂盐依从性不太好
  - 出院评估：PHQ-9=8，AUDIT=14，GAF 45→58
  - 血锂0.6mmol/L（两周前），近期有饮酒事件
  - 三年前有一次割腕自伤史（重度抑郁发作期间）
  - 社会支持极薄弱：无业、父母外地、姐姐关系一般
  - 社区接收方有686项目随访团队
  - 患者本人对出院有抗拒（"出去了没人管我怕自己又喝"）

## 关键矛盾（高质量回答应发现并分析）
1. AUDIT 14分与实际饮酒行为模式不匹配——住院期间仍在饮酒说明依赖程度被低估
2. 血锂0.6mmol/L（两周前）+ 近期大量饮酒→血锂值时效性存疑，建议出院前复查
3. PHQ-9=8（轻度抑郁）但近期有情绪波动+两天未睡+自伤史→风险可能被低估

## 评估标准：完整决策链路

### Step 1: 基础方案框架（必备，缺失则不超过0.4）
- 提供了结构化的社区转介方案（包含患者摘要、诊断信息、风险评估等）
- 列出了社区随访计划（频次、内容、复评量表）
- 推荐了适合共病患者的危机预警指标和量表

### Step 2: 信息验证与矛盾处理（重要加分项，+0.15）
这是区分普通助手和优秀助手的关键维度：
- **AUDIT分值与行为矛盾**：是否注意到AUDIT 14分与患者实际饮酒行为（住院期间仍饮酒、请假大量饮酒）不匹配，建议重新评估或使用更详细的评估工具 (+0.05)
- **血锂值时效性问题**：是否指出两周前的血锂值在患者近期饮酒后可能不准确，建议出院前复查血锂 (+0.05)
- **PHQ-9与实际状态不符**：是否注意到PHQ-9=8可能低估风险（结合情绪波动、失眠、自伤史），建议关注而非仅凭分数判断 (+0.05)
- 如果助手完全没有做任何交叉验证，直接采信所有数值，此项得0

### Step 3: 个性化风险分层（必备，缺失则不超过0.6）
- 结合患者具体情况进行风险分层（而非泛泛而谈）
- 识别出该患者的高风险因素：共病、依从性差、社会支持薄弱、自伤史、持续饮酒
- 据此调整随访频次和监测强度

### Step 4: 领域知识应用（加分项，每项 +0.04）
- **686项目/严重精神障碍管理**：提到国家严重精神障碍管理治疗项目（686项目）的社区随访要求，如分级分类管理、随访频次规定 (+0.04)
- **锂盐安全监测规范**：详细说明锂盐在社区管理中的监测要求（血锂浓度定期检查、甲状腺功能、肾功能等），特别是合并饮酒时的风险 (+0.04)
- **双相合并物质依赖的特殊管理**：提到共病管理的特殊性，如双重诊断整合治疗模式（Integrated Dual Disorder Treatment）、动机性访谈在戒酒中的应用 (+0.04)
- **自杀风险动态评估**：推荐了适合该患者的自杀风险评估工具（如C-SSRS）和评估频次，强调不能仅依赖PHQ-9第9题 (+0.04)
- **社区康复资源衔接**：提到具体的社区康复资源（如精神障碍社区康复服务规范、庇护性就业、日间照料等）(+0.04)

### Step 5: 综合建议与临床判断（加分项，+0.05）
- 对用户提出的血锂值可靠性问题给出专业判断
- 建议是否应在出院前重新评估AUDIT和复查血锂
- 综合建议考虑了患者的具体约束（社会支持薄弱、本人抗拒出院等）

### Step 6: 可操作的转介方案（加分项，+0.04）
- 给出了具体的转介交接清单（转出方需准备什么、接收方需确认什么）
- 包含应急联系方式和危机处理流程
- 使用了结构化格式，方便用户直接参照执行

## 评分汇总
- Step 1 + Step 3 都满足：基础分 0.5
- Step 2（矛盾处理）：最高 +0.15（拉开差距的关键维度）
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

        # 3. Numerical accuracy (25%)
        numerical_score = 0.0
        try:
            result = judge.evaluate(prompt_text, full_conversation, "",
                                    self.NUMERICAL_RUBRIC)
            numerical_score = result.score
            print(f"[grader] numerical score: {numerical_score:.2f} — {result.reasoning[:200]}")
        except Exception as exc:
            print(f"[grader] numerical judge failed: {exc}")

        # 4. Content quality (40%)
        content_score = 0.0
        try:
            result = judge.evaluate(prompt_text, full_conversation, "",
                                    self.CONTENT_RUBRIC)
            content_score = result.score
            print(f"[grader] content score: {content_score:.2f} — {result.reasoning[:200]}")
        except Exception as exc:
            print(f"[grader] content judge failed: {exc}")

        # Combine: 15% clarify + 20% trajectory + 25% numerical + 40% content
        scores.completion = round(
            0.15 * clarify_score +
            0.20 * trajectory_score +
            0.25 * numerical_score +
            0.40 * content_score,
            4
        )
        print(f"[grader] completion: {scores.completion:.4f} "
              f"(clarify={clarify_score:.2f}*0.15 + trajectory={trajectory_score:.2f}*0.20 "
              f"+ numerical={numerical_score:.2f}*0.25 + content={content_score:.2f}*0.40)")

        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
