"""C38zh_inventory_management grader — multi-turn user-agent consultation: 库存管理."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA288Grader(UserAgentClarifyGraderBase):
    """库存管理 — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.35 * numerical + 0.30 * content
    """

    DOMAIN = "库存管理"
    MUST_ASK = [
        "最近三个月各月的具体销量数据",
        "哪个月做了活动、活动类型（用于判断是否为异常值）",
        "当前库存剩余量",
        "下个月是否有计划做活动或促销",
        "补货前置期（供应商下单到收货时间）",
        "仓库容量限制",
]

    CLARIFICATION_RUBRIC = """评估助手在对话中的信息收集质量（0.0-1.0）。
不仅看第一轮的提问，也看整个对话过程中助手是否逐步深入收集了做决策所需的信息。

## 第一批基础信息（必须收集，缺失任意一项不超过0.7）
  - 最近各月的具体销量数据（不能只问总数或平均数，要逐月数据）
  - 哪个月做了活动、活动类型（判断是否为异常值）
  - 当前库存剩余量

## 第二批深入信息（好的顾问会进一步追问，每覆盖一项加分）
  - 下个月是否有计划做活动或促销（直接影响订货量预测）
  - 产品是否有保质期约束
  - 当前库存剩余量（如果第一批没问到）

## 第三批关键约束（优秀顾问才会追问）
  - 供应商下单到收货的前置期（Lead Time）
  - 仓库容量上限
  - 是否有季节性波动趋势

评分标准：
- 1.0：第一批信息全部收集 + 主动追问了第二批2项以上 + 追问了第三批至少1项
- 0.8-0.9：第一批信息全部收集 + 追问了第二批1-2项
- 0.7：第一批信息全部收集，但未追问任何深入信息
- 0.4-0.6：第一批信息缺失1-2项
- 0.1-0.3：几乎没有主动提问，直接基于不完整信息给出回答
- 0.0：完全没有任何澄清行为

注意：
- 如果用户主动提供了部分信息，助手只需询问缺失的部分即可
- 深入信息不要求在第一轮就问完，可以在后续对话中自然追问"""

    TRAJECTORY_RUBRIC = """请评估整个对话过程中，助手对用户意图的理解和响应质量（0.0-1.0）。
不要只看最终回答，而是审视每一轮对话中助手的表现。

## 评估维度

### 1. 信息缺失识别（用户没给的关键信息，助手是否察觉并追问）
- 用户的初始 query 只说"有几个月销量数据"和"有一个月做了活动"，缺少具体数字、库存、约束条件等
- 助手是否在第一轮就识别出缺失并主动询问，而非先给模糊回答再补问

### 2. 异常值识别与处理
- 用户提供了三个月数据（620、580、1130）后，助手是否主动识别出1130明显偏高
- 是否追问了该月偏高的原因（活动/促销/季节性等），而非直接把三个月一起平均
- 如果用户说了2月做了活动，助手是否将其作为异常值排除或降权处理

### 3. 需求演变跟踪
- 用户可能从"算一个订货量"逐步深入到"考虑安全库存""考虑仓库限制"等
- 助手是否跟上了需求的自然演变

### 4. 工具使用合理性（如果助手使用了计算工具）
- 是否在需要精确计算时主动调用工具（如计算标准差、安全库存）
- **错误与修正的评判标准（严格执行）**：
  - 一次调用就得到正确结果 = 最优，不扣分
  - 调用出错但能自行发现并修正 = 次优，扣0.1-0.2
  - 调用出错且未发现，将错误结果呈现给用户 = 严重问题，扣0.3-0.5

### 5. 对话节奏控制
- 是否在合适的时机给出阶段性结论，而非一直追问不给答案
- 用户追问新问题时，是否流畅衔接

### 6. 搜索工具使用质量（助手可使用 web_search 和 web_fetch）
本任务不强制要求搜索（库存管理方法是通用知识），但如果助手搜索了安全库存公式、EOQ模型等并正确应用，可视为加分。
- 优秀(不扣分)：搜索查询精准，结果被正确整合到回答中
- 一般(扣0.05)：过度搜索（6次以上）或搜索结果未被使用
- 不搜索也不扣分：本任务的核心知识（均值、异常值处理、安全库存）不依赖时效性信息

## 评分标准
- 1.0：每一轮都精准理解用户意图，主动识别异常值，工具使用高效恰当
- 0.7-0.9：整体理解准确，识别了异常值，偶有一轮响应不够精准
- 0.4-0.6：未能识别异常值问题，或工具使用不当
- 0.1-0.3：多轮对话中反复出现意图误解或信息遗漏
- 0.0：完全无法跟踪用户意图"""

    NUMERICAL_RUBRIC = """请只评估助手回答中的数值计算准确性（0.0-1.0）。不要考虑内容质量、建议好坏等因素，只关注数字对不对。

## 话题一致性（前置检查）
原始问题是关于「根据历史销量数据计算下月订货量」。
如果助手的最终回答完全偏离了这个主题，数值准确性直接判0。

## 用户提供的参数
  - 最近三个月销量：12月620瓶，1月580瓶，2月1130瓶
  - 2月做了满减活动（异常高值）
  - 当前库存：约150瓶
  - 下个月不做活动
  - 仓库最多再放800瓶

## 正确参考值（程序化计算）

| 检查项 | 正确值 | 允许误差 |
|--------|--------|----------|
| 正常月均值（排除2月活动月，仅12月+1月） | **600瓶** | ±20 |
| 全部三个月均值（含活动月） | **776.67瓶** | ±20 |
| 正常月标准差（12月620, 1月580） | **约20瓶** (准确值28.28) | ±10 |
| 安全库存（1.65σ，95%服务水平） | **约33瓶** (准确值46.67) | ±15 |
| 推荐订货量-简单法（正常月均 - 库存） | **450瓶** (600-150) | ±30 |
| 推荐订货量-含安全库存（正常月均 + 安全库存 - 库存） | **483瓶** (600+33-150) | ±30 |

## 评分规则（严格执行，核心区分点：是否排除了活动月异常值）

### 硬性上限规则
- **如果没有排除2月活动月异常值，直接用三个月均值777瓶来计算 → 最高0.4**
  这是本题最核心的考点。把活动月数据当正常数据处理，无论后续计算多精确都说明缺乏数据分析能力。
- **如果计算了安全库存但使用了含异常值的标准差 → 最高0.5**
  标准差应基于正常月份数据计算，含异常值会严重高估波动性。
- **如果给出的订货量超过仓库上限800瓶 → 在最终得分基础上扣0.1**
  用户明确说了仓库最多再放800瓶，超出说明未考虑实际约束。

### 正常评分区间（已排除异常值的情况）
- 1.0：正常月均值600±20，订货量在420-510瓶范围内（考虑了库存扣减和安全库存）
- 0.7-0.9：基本正确排除异常值，均值接近600，但安全库存或最终订货量有小偏差
- 0.5-0.6：排除了异常值但计算有明显偏差（如均值正确但忘记扣库存）

### 未排除异常值的评分
- 0.3-0.4：用了三个月均值777但后续计算逻辑正确（扣了库存等）
- 0.1-0.2：用了三个月均值且后续计算也有错误
- 0.0：完全没有给出任何数字，或数字与用户提供的参数完全无关

## 额外注意
- 如果助手用了加权平均（给活动月低权重），结果在580-620范围内也可接受，按正常区间评分
- 如果助手给出了区间而非单一数字（如"建议订450-520瓶"），只要区间合理也算正确
- 如果助手回答中引用的参数与用户提供的不一致（如把620记成720），酌情扣分"""

    CONTENT_RUBRIC = """请评估助手回答的内容质量（0.0-1.0）。不要考虑数值是否准确，只关注回答的完整性、专业性、实用性。

## 话题一致性（前置检查）
原始问题是关于「根据历史销量数据计算下月订货量，用Excel可操作的方法」。
如果助手的最终回答完全偏离了这个主题，内容质量直接判0。

## 用户完整情况（对话中可能逐步透露）
  - 最近三个月销量：12月620瓶，1月580瓶，2月1130瓶
  - 2月做了满减活动，冲到1130瓶，属于异常高值
  - 当前库存约150瓶
  - 产品是护肤品，有保质期（开封后12个月）
  - 下个月没有计划做活动
  - 供应商下单到收货需要7-10天
  - 仓库空间有限，最多再放800瓶
  - 用户不会Python，"就Excel水平"

## 评估标准：完整决策链路（6个步骤）

### Step 1: 基础计算与订货量建议（必备，缺失则不超过0.4）
- 计算了月均销量（应基于正常月份）
- 扣除了现有库存
- 给出了具体的订货数量建议（而非泛泛方法论）

### Step 2: 异常值识别与处理（核心区分点，+0.15）
这是区分普通助手和优秀助手的关键维度：
- **主动识别异常值**：是否主动指出2月数据（1130瓶）明显偏高，建议排除或降权处理 (+0.05)
- **追问异常原因**：是否询问该月为何偏高（促销？季节性？一次性大单？），而非直接假设 (+0.05)
- **确认下月计划**：是否询问下个月是否有促销计划，以决定订货量基准 (+0.05)
- 如果助手直接把三个月一起平均，未提任何异常值问题，此项得0

### Step 3: 安全库存与服务水平概念（加分项，+0.05）
- 提到了安全库存的概念（防止断货的缓冲量）
- 提到了服务水平（如95%不缺货概率）或简化版（备多10%-15%余量）

### Step 4: 领域知识应用（加分项，每项+0.04）
- **保质期管理**：提到护肤品有保质期，过多备货有过期风险，订货量不宜过多 (+0.04)
- **补货前置期**：考虑了7-10天的补货周期，建议在库存降到某个水平时就下单（再订货点） (+0.04)
- **仓库容量约束**：考虑了仓库最多放800瓶的限制，确保订货量不超此上限 (+0.04)
- **季节性趋势**：提到了应关注是否有季节性波动（如护肤品可能有淡旺季），建议积累更多月份数据来判断 (+0.04)

### Step 5: Excel操作指南（重要加分项，+0.05）
用户明确说了"就Excel水平"，方案必须是Excel可执行的：
- 给出了具体的Excel公式或表格结构（如AVERAGE、IF、STDEV等函数的用法）
- 操作步骤清晰，不涉及任何编程知识
- 最好给出一个可以每月复用的模板

### Step 6: 建立长期订货模型建议（加分项，+0.04）
- 建议持续记录每月销量数据，积累更多数据提高预测准确性
- 建议区分活动月和正常月，分别标记
- 提到了更多数据后可以用移动平均、指数平滑等简单方法（但要用Excel可操作的方式解释）

## 评分汇总
- Step 1 满足：基础分 0.4
- Step 2（异常值处理）：最高 +0.15（核心区分点）
- Step 3（安全库存）：+0.05
- Step 4 每个知识点 +0.04（最高 +0.16）
- Step 5（Excel指南）：+0.05
- Step 6（长期模型）：+0.04
- 理论满分路径：0.4 + 0.15 + 0.05 + 0.16 + 0.05 + 0.04 = 0.85
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
