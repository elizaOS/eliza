"""C30zh_data_troubleshooting grader — multi-turn user-agent consultation: 数据排查."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA236Grader(UserAgentClarifyGraderBase):
    """数据排查 — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.25 * numerical + 0.40 * content
    """

    DOMAIN = "数据排查"
    MUST_ASK = [
        "时间戳偏差的量级是多少（秒级、分钟级还是天/周级）",
        "SQL查询的WHERE条件和时间范围",
        "埋点数据源和Jira灰度发布时间线的对齐方式",
        "灰度发布是否分批次，各批次的时间和覆盖范围",
        "SQL使用的时间字段是哪个（client_time vs server_time）",
        "时区处理方式（数据库存储时区 vs 查询时区）",
    ]

    CLARIFICATION_RUBRIC = """评估助手在对话中的信息收集质量（0.0-1.0）。
不仅看第一轮的提问，也看整个对话过程中助手是否逐步深入收集了做诊断所需的信息。

## 基础信息（必须收集，缺失任意一项不超过0.7）
  - 时间戳偏差的量级（秒级/分钟级/天级/周级）
  - SQL查询的WHERE条件具体怎么写的
  - 埋点数据与Jira时间线的对齐方式（手动还是自动）
  - 灰度发布是否分批次

## 深入信息（好的诊断者会进一步追问，每覆盖一项加分）
  - SQL用的是哪个时间字段（client_time vs server_time）
  - 数据库时区与查询时区是否一致
  - 各灰度批次的具体时间和用户覆盖比例
  - 灰度期间埋点SDK版本是否一致
  - Kibana里异常记录的具体表现（哪些字段异常、多少条）

评分标准：
- 1.0：基础信息全部收集 + 主动追问了3项以上深入信息
- 0.8-0.9：基础信息全部收集 + 追问了1-2项深入信息
- 0.7：基础信息全部收集，但未追问任何深入信息
- 0.4-0.6：基础信息缺失1-2项
- 0.1-0.3：几乎没有主动提问，直接基于不完整信息给出排查方案
- 0.0：完全没有任何澄清行为

注意：
- 如果用户主动提供了部分信息，助手只需询问缺失的部分即可
- 深入信息不要求在第一轮就问完，可以在后续对话中自然追问
- 提问应该自然、专业，体现出排查经验"""

    TRAJECTORY_RUBRIC = """请评估整个对话过程中，助手对用户意图的理解和响应质量（0.0-1.0）。
不要只看最终回答，而是审视每一轮对话中助手的表现。

## 评估维度

### 1. 信息缺失识别（用户没给的关键信息，助手是否察觉并追问）
- 用户初始query只说"时间戳对不上"，缺少偏差量级、SQL具体条件、灰度批次等关键参数
- 助手是否在第一轮就识别出需要区分偏差量级（秒级 vs 天/周级），而非先按webhook延迟给出通用排查方案

### 2. 假设修正能力
- 用户一开始暗示可能是webhook延迟或SDK问题
- 得知偏差是两周级别后，助手是否及时放弃webhook/SDK假设，转向数据口径排查
- 如果助手在得知两周偏差后仍花大量篇幅讨论webhook延迟，说明假设修正能力差

### 3. 信息整合与交叉验证
- 用户透露了灰度4月18日开始、SQL只查5月、数据库存UTC但SQL用北京时间等多条信息
- 助手是否能将这些零散信息整合起来，发现它们之间的因果关系
- 是否注意到Kibana"异常记录"其实是正常入库延迟的表现

### 4. 工具使用合理性（如果助手使用了工具）
- 是否在需要精确计算时间线时使用计算工具（如推算4月18日到4月30日的天数、UTC偏移量等）
- 是否搜索了相关技术信息（如Jira webhook机制、常见埋点SDK时间戳问题）
- **错误与修正的评判标准（严格执行）**：
  - 一次调用就得到正确结果 = 最优，不扣分
  - 调用出错但能自行发现并修正 = 次优，扣0.1-0.2
  - 调用出错且未发现 = 严重问题，扣0.3-0.5

### 5. 对话节奏控制
- 是否在收集到足够信息后给出阶段性诊断结论，而非一直追问不给方向
- 是否在合适时机从"收集信息"切换到"给出诊断"

### 6. 搜索工具使用质量
本任务涉及技术排查，搜索可辅助确认技术细节但并非必须。
- 优秀(不扣分)：搜索查询精准，1-3次搜索覆盖关键技术信息
- 良好(扣0.05)：搜索了但查询不够精准
- 一般(扣0.1)：过度搜索（6次以上）或重复搜索
- 未搜索(不扣分或扣0.05)：技术排查类问题不搜索也可接受，但如果给出了过时或错误的技术信息则需扣分

## 评分标准
- 1.0：每一轮都精准理解用户意图，假设修正及时，信息整合到位，工具使用高效
- 0.7-0.9：整体理解准确，偶有一轮响应不够精准或假设修正略慢
- 0.4-0.6：部分轮次理解偏差明显（如得知两周偏差后仍坚持webhook假设）
- 0.1-0.3：多轮对话中反复出现意图误解或信息遗漏
- 0.0：完全无法跟踪用户意图"""

    NUMERICAL_RUBRIC = """请只评估助手回答中的时间线推算和数据一致性分析的准确性（0.0-1.0）。不要考虑内容质量、建议好坏等因素，只关注时间线和数据推理对不对。

## 话题一致性（前置检查）
原始问题是关于「Jira灰度发布时间戳与埋点数据时间不一致的排查」。
如果助手的最终回答完全偏离了这个主题，直接判0。

## 用户逐步提供的关键时间线参数
  - 灰度发布：4月18日第一批5%，4月28日第二批30%，5月8日全量100%
  - SQL WHERE条件：server_time >= '2024-05-01' AND server_time < '2024-06-01'
  - 数据库 server_time 字段存储 UTC 时间
  - SQL查询直接用北京时间日期，未做时区转换
  - 偏差量级：约两周

## 正确参考值（程序化推算）

| 检查项 | 正确值 | 允许误差 |
|--------|--------|----------|
| 灰度开始日期与SQL起始日期的差距 | **12-13天**（4月18日→5月1日） | ±2天 |
| 第一批灰度（5%）完全未被SQL覆盖的天数 | **10天**（4月18日→4月28日） | ±2天 |
| 第一、二批灰度在SQL范围外的总天数 | **12-13天**（4月18日→4月30日/5月1日） | ±2天 |
| UTC vs 北京时间偏差 | **8小时** | 精确值，无误差 |
| UTC偏差导致的SQL实际起始时间（北京时间） | **5月1日08:00 北京时间**（即SQL漏掉5月1日0:00-8:00的数据） | 精确推算 |
| 第一批灰度5%用户的数据在SQL结果中 | **完全缺失**（全部在4月，不在SQL查询范围内） | 逻辑判断 |

## 评分规则（严格执行）
- 1.0：正确推算出灰度开始日期与SQL范围的12-13天差距，识别出UTC/北京时间8小时偏差，两个问题的影响量级判断清晰
- 0.7-0.9：正确识别出主要差距（~2周源于SQL范围不覆盖4月灰度数据），时区偏差分析有小偏差或未提及
- 0.4-0.6：识别出SQL时间范围问题但天数推算有明显偏差（>3天），或未区分主要原因（12天）和次要原因（8小时）
- 0.2-0.3：仅笼统说"时间范围不对"但未给出具体天数推算
- 0.0-0.1：未能识别SQL时间范围与灰度时间线的错位，或将根因归结为webhook延迟/SDK问题
- 如果助手从未被告知灰度批次的具体日期（用户未透露第二三批信息），则按已收集到的信息评估，不因信息不完整而扣分"""

    CONTENT_RUBRIC = """请评估助手回答的内容质量（0.0-1.0）。不要考虑时间线数值是否精确，只关注回答的完整性、专业性、根因定位准确度。

## 话题一致性（前置检查）
原始问题是关于「Jira灰度发布时间戳与埋点数据时间不一致的排查」。
如果助手的最终回答完全偏离了这个主题，内容质量直接判0。

## 用户完整情况（对话中逐步透露）
  - 偏差量级：约两周，不是秒级
  - SQL用server_time字段，WHERE条件只查5月
  - 灰度4月18日开始（5%），4月28日扩到30%，5月8日全量
  - 手动对比SQL结果和Jira灰度时间线
  - 数据库存UTC，SQL用北京时间未转换
  - Kibana有少量client_time在4月但server_time在5月的记录
  - 第一批灰度的埋点SDK版本可能和后续批次不同
  - 有event_type为null的异常记录

## 关键矛盾（高质量回答应发现并分析）

### 矛盾1：用户说"时间戳对不上"但本质不是时间戳问题
用户的直觉是"时间戳异常"，但根因是SQL查询范围（5月）不覆盖灰度早期数据（4月18日起）。好的助手应该帮用户重新定义问题——这不是"时间戳对不上"，而是"查询范围遗漏了灰度初期数据"。

### 矛盾2：Kibana"异常记录"其实是正常现象
用户认为client_time在4月但server_time在5月的记录是"异常"的，但这其实是正常的入库延迟。助手应该解释这种client_time < server_time的情况在分布式系统中很常见，不是bug。

### 矛盾3：UTC vs 北京时间的隐性偏差
用户没意识到数据库存UTC但SQL用北京时间会导致8小时偏差。虽然这不是导致两周差距的主因，但会导致5月1日0:00-8:00（北京时间）的数据被漏掉，是一个需要修复的隐患。

## 评估标准：完整诊断链路（6个步骤）

### Step 1: 正确定位根因（必备，缺失则不超过0.4）
- 明确指出两周偏差的根因是SQL查询范围（5月）不覆盖灰度早期数据（4月中旬起）
- 明确排除webhook延迟和SDK时钟漂移作为两周偏差的原因（这两者量级在秒到分钟级）

### Step 2: 矛盾发现与分析（重要加分项，+0.15）
- **重新定义问题**：帮用户认识到这不是"时间戳异常"而是"数据查询范围不匹配" (+0.05)
- **解释Kibana"异常"**：指出client_time < server_time在分布式系统中是正常现象，入库延迟不等于数据异常 (+0.05)
- **发现UTC/北京时间隐患**：指出数据库存UTC但SQL用北京时间的问题，虽非主因但需修复 (+0.05)

### Step 3: 分层排查思路（必备，缺失则不超过0.6）
- 展示了从高到低的排查优先级：数据口径 > 时区 > SDK版本 > 入库延迟
- 能区分主要原因（~12天查询范围遗漏）和次要原因（8小时时区偏差、SDK版本差异）

### Step 4: 领域知识应用（加分项，每项 +0.04）
- **client_time vs server_time 语义差异**：解释了两个时间字段的含义和适用场景，建议在不同分析场景下选用不同字段 (+0.04)
- **灰度分批放量的数据影响**：分析了5%/30%/100%各阶段数据量差异对统计结果的影响（早期数据量本身就少，更容易被忽略） (+0.04)
- **分布式系统时钟一致性**：提到分布式系统中客户端时钟不可靠、服务端时间可能因队列积压延迟的常见问题 (+0.04)
- **埋点SDK版本管理**：提到SDK版本差异可能导致事件上报格式不同（如event_type为null），建议核查SDK changelog (+0.04)
- **数据回补/补录方案**：针对已缺失的4月数据，建议用client_time字段做回补查询或从原始日志恢复 (+0.04)

### Step 5: 综合诊断结论（加分项，+0.05）
- 综合所有收集到的信息，给出清晰的根因分析结论
- 区分了"确定的问题"和"需要进一步验证的问题"

### Step 6: 可操作的验证和修复方案（加分项，+0.04）
- 给出具体的SQL修改建议（扩展时间范围、加入时区转换）
- 提供分步验证方案（如先扩展时间范围重跑、再按天聚合对比灰度批次）
- 建议长期改进措施（如SQL模板规范、时区统一处理等）

## 评分汇总
- Step 1 + Step 3 都满足：基础分 0.5
- Step 2（矛盾发现）：最高 +0.15
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

        # 3. Numerical accuracy (25%) — timeline and data consistency
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
