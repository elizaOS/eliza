"""C34zh_product_design grader — multi-turn user-agent consultation: 产品设计."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA247Grader(UserAgentClarifyGraderBase):
    """产品设计 — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.25 * numerical + 0.40 * content
    """

    DOMAIN = "产品设计"
    MUST_ASK = [
        "产品类型（ToB SaaS还是C端，具体品类）",
        "输出形式（知识总结还是PRD文档初稿）",
        "覆盖模块范围（仅消息通知还是包含其他模块）",
        "交付时间和完整度要求",
        "当前产品规模（DAU/MAU）",
        "现有通知系统的现状和痛点",
        "团队资源和工期约束",
    ]

    CLARIFICATION_RUBRIC = """评估助手在对话中的信息收集质量（0.0-1.0）。
不仅看第一轮的提问，也看整个对话过程中助手是否逐步深入收集了做决策所需的信息。

## 基础信息（必须收集，缺失任意一项不超过0.7）
  - 产品类型（C端社区产品，不是ToB SaaS）
  - 输出形式（PRD文档初稿，不是知识总结）
  - 覆盖模块范围（消息通知 + 用户反馈）
  - 交付时间和完整度要求（周一交，功能点+异常case全覆盖）

## 深入信息（好的顾问会进一步追问，每覆盖一项加分）
  - 当前产品规模（DAU 80万、MAU 350万）
  - 当前通知系统现状和痛点（Push点击率2.1%、无消息分级）
  - 业务方的诉求（提升点击率到5%、增加Push频次）
  - 用户平台分布（Android 70%、iOS 30%）和通知授权率（45%）
  - 卸载率和卸载原因（月卸载率8%、60%因通知太烦）
  - 团队资源和工期约束（2后端+1客户端、一个半月）
  - 创作者私信被淹没的问题

评分标准：
- 1.0：基础信息全部收集 + 主动追问了3项以上深入信息（特别是追问到了数据现状和团队约束）
- 0.8-0.9：基础信息全部收集 + 追问了1-2项深入信息
- 0.7：基础信息全部收集，但未追问任何深入信息
- 0.4-0.6：基础信息缺失1-2项
- 0.1-0.3：几乎没有主动提问，直接基于不完整信息给出回答
- 0.0：完全没有任何澄清行为

注意：
- 如果用户主动提供了部分信息，助手只需询问缺失的部分即可
- 深入信息不要求在第一轮就问完，可以在后续对话中自然追问
- 特别关注助手是否追问了量化数据（DAU、点击率、卸载率等）——这些对PRD设计至关重要"""

    TRAJECTORY_RUBRIC = """请评估整个对话过程中，助手对用户意图的理解和响应质量（0.0-1.0）。
不要只看最终回答，而是审视每一轮对话中助手的表现。

## 评估维度

### 1. 信息缺失识别
- 用户的初始 query 只说了"想了解消息通知机制"，缺少产品类型、输出形式、具体场景等关键参数
- 助手是否在第一轮就识别出缺失并主动询问，而非先给一大段泛泛的知识科普

### 2. 需求本质理解
- 用户表面在问"消息通知最佳实践"，实际需要的是一份可交付的PRD文档
- 助手是否在得知输出形式后，及时调整回答策略（从知识分享模式切换为PRD撰写模式）

### 3. 矛盾信息捕捉
- 用户会透露业务方要求"增加Push频次拉DAU"，同时卸载率高且卸载原因是"通知太烦"
- 助手是否捕捉到了这个核心矛盾并主动指出，而非机械地按业务方要求设计方案
- 用户提到Android占70%但通知授权率只有45%——助手是否注意到这个数据异常

### 4. 工具使用合理性

#### 搜索工具（web_search / web_fetch）
本任务涉及产品设计行业最佳实践和最新趋势，好的助手应适当搜索：
- 优秀(不扣分)：搜索了消息通知最佳实践、Push频控策略、行业基准数据（如平均点击率、授权率），1-3次精准搜索
- 良好(扣0.05)：搜索了但查询不够精准，需要4-5次
- 一般(扣0.1)：过度搜索（6次以上）或重复搜索相同内容
- 未搜索(扣0.05)：没有使用搜索工具。产品设计类任务不强制要求搜索，但搜索行业数据可以加强方案说服力

#### 计算工具（Bash）
如果助手基于用户提供的数据做了量化推算（如预估提频后的卸载影响、计算Push频控阈值等），应使用计算工具确保准确：
- 一次调用就得到正确结果 = 最优
- 调用出错但自行发现并修正 = 次优，扣0.1
- 调用出错且未发现 = 严重问题，扣0.3

### 5. 对话节奏控制
- 是否在收集到足够信息后及时给出方案，而非一直追问不给答案
- 面对用户透露的矛盾信息，是否适时给出专业判断而非回避

## 评分标准
- 1.0：每一轮都精准理解用户意图，矛盾捕捉敏锐，需求转换及时，工具使用高效
- 0.7-0.9：整体理解准确，捕捉到了主要矛盾，偶有一轮响应不够精准
- 0.4-0.6：部分轮次理解偏差（如未发现业务方诉求与卸载数据的矛盾），或输出形式判断错误
- 0.1-0.3：多轮对话中反复出现意图误解
- 0.0：完全无法跟踪用户意图"""

    NUMERICAL_RUBRIC = """请只评估助手回答中的量化指标和数值推算准确性（0.0-1.0）。不要考虑内容质量、建议好坏等因素，只关注数字和量化推理是否合理。

## 话题一致性（前置检查）
原始问题是关于「消息通知机制设计——PRD初稿」。
如果助手的最终回答完全偏离了这个主题，直接判0。

## 用户提供的关键数据
  - DAU: 80万，MAU: 350万
  - 当前Push点击率: 2.1%，业务方目标: 5%+
  - 当前日均Push: 3条/活跃用户，业务方想提到6-8条
  - 用户平台分布: Android 70%, iOS 30%
  - 通知权限授予率: 45%
  - 月卸载率: 8%，其中60%因通知烦扰卸载
  - 团队: 2后端+1客户端，工期一个半月

## 需要检查的量化推算（助手可能做、也可能不做，做了则检查准确性）

### 1. Push实际触达率计算
- 授权率45%意味着：80万DAU中只有约36万用户能收到Push
- 当前日均Push 3条 × 36万可触达用户 = 日均约108万条Push
- 点击率2.1%意味着：日均约2.27万次Push点击
- 如果助手做了这类计算，检查乘除法是否正确，允许误差±10%

### 2. 提频影响预估
- 如果日均Push从3条提到6-8条，在授权率不变的情况下：
  - 日均Push量翻倍至216-288万条
  - 假设卸载率与Push频次正相关，月卸载率可能从8%上升——具体数字取决于模型假设
  - 合理的推算应该指出：60%卸载因通知烦扰 → 提频很可能加剧卸载
- 不要求精确数字，但推理链条应合理

### 3. 分级后的频控参数设计
PRD中如果设计了消息分级和频控规则，检查参数是否自洽：
- P0强提醒实时推送：合理（互动类消息时效性高）
- P1中提醒聚合推送：聚合窗口和条数阈值是否合理（如同类≥3条/15分钟合并）
- P2弱提醒定时批量：频次上限是否合理（如每日≤2次）
- 全局频控：单用户每日Push总上限是否合理（行业一般6-10条，考虑到用户已经因通知烦扰大量卸载，应偏保守）
- 各级别的频控参数加总后不应自相矛盾（如P0不限+P1每小时1条+P2每日2条 → 总量应该在合理范围内）

### 4. 通知授权率异常分析
- Android 13之前通知默认开启，Android占70%但总授权率只有45%——如果助手分析了这个异常：
  - 可能的推算：假设iOS授权率约40%（行业平均），则Android授权率 = (45% - 30%×40%) / 70% ≈ 47%
  - Android默认开启却只有47%，说明大量用户主动关闭了通知，这佐证了通知烦扰问题严重
  - 检查助手的分拆计算是否正确，允许误差±5%

## 评分规则（严格执行）
- 1.0：做了2项以上量化推算且计算正确，频控参数设计自洽合理
- 0.7-0.9：做了量化推算但有小偏差，或频控参数基本合理但有1处不自洽
- 0.5-0.6：PRD中有频控数字但未做推算验证，数字看起来是拍脑袋但不离谱
- 0.3-0.4：频控参数有明显矛盾（如全局上限8条但各级加总远超8条），或关键计算错误
- 0.1-0.2：几乎没有量化分析，PRD中的数字缺乏依据
- 0.0：完全没有涉及任何量化内容，或数字严重离谱"""

    CONTENT_RUBRIC = """请评估助手回答的内容质量（0.0-1.0）。不要考虑数值是否准确，只关注回答的完整性、专业性、实用性。

## 话题一致性（前置检查）
原始问题是关于「消息通知机制设计」，用户需要的是一份C端社区产品的PRD初稿。
如果助手的最终回答完全偏离了这个主题，内容质量直接判0。

## 用户完整情况（对话中逐步透露）
  - C端兴趣社区产品，DAU 80万
  - 需要PRD文档初稿，周一交
  - 覆盖消息通知 + 用户反馈两个模块
  - 当前Push点击率2.1%，业务方要求提到5%+并增加频次到每天6-8条
  - 月卸载率8%，60%因通知烦扰
  - Android 70%/iOS 30%，通知授权率仅45%
  - 创作者私信被普通通知淹没
  - 团队2后端+1客户端，工期一个半月

## 关键矛盾（高质量回答应发现并分析）

### 矛盾1：业务方"提频拉DAU" vs 用户"因通知卸载"
- 业务方要求日均Push从3条提到6-8条以拉DAU
- 但60%的卸载用户明确表示卸载原因是"通知太烦"
- 好的助手应指出：盲目提频不仅不能拉DAU，反而会加速用户流失
- 应该用数据论证（如量化提频后的预期卸载影响），而非仅凭直觉反对

### 矛盾2：Android通知授权率异常
- Android 13之前通知默认开启，但总授权率只有45%
- 说明大量Android用户主动关闭了通知——这比"从未授权"更严重，意味着用户体验已经很差
- 好的助手应建议先修复授权率（通过改善通知质量争取用户重新开启），而非在45%的基础上加大频次

### 矛盾3：营销Push集中发送 vs 用户体验
- 业务方要求所有营销Push在晚8-10点集中发送
- 在这个2小时窗口内，如果按业务方要求的6-8条/天，用户可能短时间收到大量推送
- 好的助手应指出洪峰问题，建议基于用户个人活跃时段做智能分发

## 评估标准：完整决策链路（6个步骤）

### Step 1: 输出格式正确——PRD文档结构（必备，缺失则不超过0.4）
- 输出必须是PRD文档格式（含功能概述、功能清单、流程说明、异常case等标准PRD模块）
- 如果只给了知识科普或要点罗列而非PRD结构，最高0.4
- PRD应面向C端社区场景定制（如互动通知、内容推荐通知），而非泛泛的通用方案

### Step 2: 消息分级与触发策略设计（必备，缺失则不超过0.5）
- 设计了清晰的消息分级体系（至少3级，最好4级：强提醒/中提醒/弱提醒/静默）
- 每个级别的站内信和Push触发条件明确
- 免打扰策略完整（含夜间勿扰时段、频控规则、用户自定义偏好）
- 异常case覆盖（如消息风暴、服务端故障降级、通知权限被收回后的降级方案）

### Step 3: 矛盾识别与数据驱动反驳（重要加分项，+0.15）
这是区分普通助手和优秀助手的关键维度：
- **识别"提频vs卸载"矛盾**：指出业务方的提频需求与卸载数据直接冲突 (+0.05)
- **数据驱动反驳**：用量化分析论证为什么不应该盲目提频（如预估提频后的卸载率变化） (+0.05)
- **提出替代方案**：不是简单说"不行"，而是给出"提升Push质量和精准度"的替代路径来同时满足业务目标和用户体验 (+0.05)
- 如果助手完全没有发现任何矛盾，直接按业务方要求设计了6-8条/天的方案，此项得0

### Step 4: 领域知识应用（加分项，每项+0.04）
- **创作者消息通道隔离**：为创作者设计独立的消息通道或优先级提升机制，解决私信被淹没问题 (+0.04)
- **通知授权率修复策略**：分析授权率低的原因，设计权限引导策略（如在用户首次触发需通知的场景时做场景化引导，而非App启动时弹窗） (+0.04)
- **Push A/B测试框架**：建议通过A/B测试逐步验证新的Push策略效果，而非一次性全量上线 (+0.04)
- **智能推送时段**：基于用户个人活跃时段做个性化推送，而非统一时间窗口 (+0.04)
- **渐进式上线与灰度策略**：考虑团队资源有限（2后端+1客户端、一个半月），给出分阶段交付计划 (+0.04)

### Step 5: 用户反馈模块（必备组成部分，缺失扣0.05）
- PRD应包含用户反馈模块的功能设计（用户已明确说需要覆盖）
- 至少包含反馈入口、反馈分类、处理流程、状态通知

### Step 6: 可操作性（加分项，+0.04）
- 考虑了团队资源约束，方案在一个半月内可落地
- 给出了优先级排序或分阶段交付建议
- 使用了结构化格式（表格或清单），方便直接作为PRD使用

## 评分汇总
- Step 1 + Step 2 都满足：基础分 0.5
- Step 3（矛盾处理）：最高 +0.15
- Step 4 每个知识点 +0.04（最高 +0.20）
- Step 5: 缺失扣0.05
- Step 6: +0.04
- 理论满分路径：0.5 + 0.15 + 0.20 + 0.04 = 0.89
- 如果在以上基础上回答特别出色（如给出了超出预期的洞察），可酌情给到 1.0"""

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
