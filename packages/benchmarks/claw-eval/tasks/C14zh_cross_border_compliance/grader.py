"""C14zh_cross_border_compliance grader — multi-turn user-agent consultation: 跨境合规."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA25Grader(UserAgentClarifyGraderBase):
    """跨境合规 — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.30 * numerical + 0.35 * content
    """

    DOMAIN = "跨境合规"
    MUST_ASK = [
        "涉及的具体欧盟成员国",
        "传输数据的具体类型（是否包含健康/医疗数据）",
        "数据处理目的",
        "是否存在员工委员会（Betriebsrat）",
        "公司在欧盟的法人实体结构（Controller/Processor角色）",
        "DPO（数据保护官）在岗情况",
    ]

    CLARIFICATION_RUBRIC = """评估助手在对话中的信息收集质量（0.0-1.0）。
不仅看第一轮的提问，也看整个对话过程中助手是否逐步深入收集了做合规方案所需的信息。

## 基础信息（必须收集，缺失任意一项不超过0.7）
  - 涉及的具体欧盟成员国（不同国家有不同的数据保护附加法）
  - 传输数据的具体类型（是否包含Art.9特殊类别数据如健康/医疗信息）
  - 数据处理的目的和后续用途
  - 是否存在员工代表机构（如德国Betriebsrat）

## 深入信息（好的顾问会进一步追问，每覆盖一项加分）
  - 公司在欧盟的法人结构（独立法人还是分支机构，影响Controller/Processor认定）
  - 现有SCC版本及签署时间（判断是否需要更新）
  - 数据存储和传输的技术架构（源端/目的端服务器位置）
  - DPO是否在岗（影响合规流程推进能力）
  - 公司全球营收规模（关系到罚款上限计算）
  - 病假记录是否包含医疗诊断详情（影响Art.9分析深度）

评分标准：
- 1.0：基础信息全部收集 + 主动追问了3项以上深入信息
- 0.8-0.9：基础信息全部收集 + 追问了1-2项深入信息
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
- 用户的初始query只提到"欧洲""GDPR""SCC"，缺少具体国家、数据类型、法人结构等关键参数
- 助手是否在第一轮就识别出缺失并主动询问，而非先给泛泛的GDPR介绍再补问

### 2. 信息修正与矛盾捕捉
- 用户提到2020年签过SCC——助手是否识别出旧版SCC已失效并主动指出
- 用户说"病假记录"后又透露含医疗诊断摘要——助手是否捕捉到数据敏感度升级并调整建议
- 用户描述的德国GmbH法人结构与总部统一管理之间的Controller/Processor角色矛盾——助手是否察觉并分析

### 3. 需求演变跟踪
- 用户的需求可能从"SCC流程"演变为"完整合规方案"再到"风险评估和时间规划"
- 助手是否跟上了需求的自然演变

### 4. 工具使用合理性（如果助手使用了计算或搜索工具）
- 是否在需要精确计算（如罚款上限）时主动调用计算工具
- 工具调用的时机是否恰当（收集到营收数据后再计算罚款上限）
- **错误与修正的评判标准（严格执行）**：
  - 一次调用就得到正确结果 = 最优，不扣分
  - 调用出错但能自行发现并修正 = 次优，扣0.1-0.2
  - 调用出错且未发现，将错误结果呈现给用户 = 严重问题，扣0.3-0.5

### 5. 对话节奏控制
- 是否在合适的时机给出阶段性结论，而非一直追问不给答案
- 用户追问新问题时，是否流畅衔接

### 6. 搜索工具使用质量（助手可使用 web_search 和 web_fetch）
本任务涉及时效性信息（GDPR执法动态、最新SCC要求、各国数据保护局执法案例），好的助手应主动搜索验证。

**搜索必要性判断：**
- 用户提到2020年签的SCC——助手是否搜索确认了新旧SCC的过渡时间节点？
- 用户提到荷兰AP对中国公司的罚款——助手是否搜索验证了该执法案例？
- GDPR罚款的最新执法趋势——助手是否有搜索了解？

**搜索质量评估：**
- 优秀(不扣分)：搜索查询精准，1-3次搜索覆盖关键信息，搜索结果被正确整合到回答中
- 良好(扣0.05)：搜索了但查询不够精准，需要4-5次才找到关键信息
- 一般(扣0.1)：过度搜索（6次以上）或重复搜索相同内容
- 较差(扣0.15)：搜索了但结果没有被使用，或搜到错误信息未辨别
- 未搜索(扣0.1)：完全没有使用搜索工具，直接凭记忆给出时效性信息。但如果凭记忆给出的信息恰好正确，可减轻扣分至0.05

## 评分标准
- 1.0：每一轮都精准理解用户意图，矛盾信息零遗漏，需求演变完美跟踪，工具使用高效恰当
- 0.7-0.9：整体理解准确，工具使用基本合理，偶有一轮响应不够精准
- 0.4-0.6：部分轮次理解偏差明显（如忽略了SCC版本问题、数据敏感度升级），或工具使用不当
- 0.1-0.3：多轮对话中反复出现意图误解或信息遗漏
- 0.0：完全无法跟踪用户意图"""

    NUMERICAL_RUBRIC = """请只评估助手回答中的数值与合规阈值准确性（0.0-1.0）。不要考虑内容质量、建议好坏等因素，只关注数字和关键时间节点对不对。

## 话题一致性（前置检查）
原始问题是关于「GDPR跨境数据传输合规流程，特别是SCC相关要求」。
如果助手的最终回答完全偏离了这个主题，数值准确性直接判0。

## 用户提供的参数
  - 欧盟成员国：德国、荷兰
  - 员工人数：德国35人 + 荷兰18人 = 53人
  - 公司全球年营收：约8500万欧元
  - 旧版SCC签署时间：2020年
  - 数据类型：含病假记录和医疗诊断摘要（Art.9特殊类别数据）

## 正确参考值（程序化计算与法规条文核实）

**GDPR罚款上限计算：**

| 检查项 | 正确值 | 允许误差 |
|--------|--------|----------|
| Art.83(5)严重违规罚款上限（全球营收4%或2000万欧，取高者） | **340万欧元**（8500万 × 4% = 340万） | ±10万欧元 |
| Art.83(4)一般违规罚款上限（全球营收2%或1000万欧，取高者） | **170万欧元**（8500万 × 2% = 170万） | ±5万欧元 |
| 确认340万 > 2000万？否，2000万 > 340万，因此严重违规实际上限为 | **2000万欧元** | 精确值 |
| 确认170万 > 1000万？否，1000万 > 170万，因此一般违规实际上限为 | **1000万欧元** | 精确值 |

注意：GDPR罚款是取"固定金额"和"营收百分比"中的**较高者**。对于8500万欧营收的公司：
- 严重违规：max(2000万, 340万) = **2000万欧元**
- 一般违规：max(1000万, 170万) = **1000万欧元**
如果助手只算了营收百分比而没有与固定门槛比较，或者错误地使用了较低值，应扣分。

**关键时间节点：**

| 检查项 | 正确值 | 允许误差 |
|--------|--------|----------|
| 新版SCC发布时间 | **2021年6月4日** | 月份级别（2021年6月） |
| 旧版SCC失效截止日 | **2022年12月27日** | ±1个月 |
| 用户说2020年签的SCC → 是否已失效 | **是，已失效** | 必须明确指出 |

**DPO任命义务相关（Art.37）：**

| 检查项 | 正确值 | 说明 |
|--------|--------|------|
| 大规模处理特殊类别数据是否需要指定DPO | **是** | Art.37(1)(c) |
| 53人的健康数据是否构成"大规模" | **存在争议，需具体分析** | EDPB指南未给出硬性人数阈值，但倾向于即使人数不多，如涉及敏感数据也应审慎评估 |

## 评分规则（严格执行）
- 1.0：所有数字和时间节点在误差范围内，罚款上限取值逻辑正确（取较高者）
- 0.7-0.9：关键时间节点正确，罚款计算逻辑基本正确但有小误差（如只算了百分比没比较固定门槛）
- 0.4-0.6：部分时间节点正确，但罚款计算有明显错误或遗漏关键时间节点
- 0.2-0.3：仅提到了笼统的"最高可罚全球营收4%"但未结合用户营收做具体计算
- 0.0-0.1：时间节点和数值全部错误或缺失，或未指出旧版SCC已失效
- 如果助手算出的罚款上限偏差超过50%，或错误地认为旧版SCC仍然有效，直接扣到0.2以下"""

    CONTENT_RUBRIC = """请评估助手回答的内容质量（0.0-1.0）。不要考虑数值是否准确，只关注回答的完整性、专业性、实用性。

## 话题一致性（前置检查）
原始问题是关于「GDPR跨境数据传输合规流程及SCC要求」。
如果助手的最终回答完全偏离了这个主题，内容质量直接判0。

## 用户完整情况（对话中逐步透露）
  - 德国35人+荷兰18人的员工数据要回传中国
  - 数据含病假记录和医疗诊断摘要（Art.9特殊类别数据）
  - 目的是人力分析与决策
  - 德国有Betriebsrat
  - 公司全球营收约8500万欧
  - 2020年签过旧版SCC（已失效）
  - 数据从法兰克福AWS传到杭州阿里云
  - DPO刚离职，岗位空缺
  - 德国有独立GmbH法人但人事系统和薪资由总部统一管理
  - 荷兰AP去年对中国公司开过80万欧罚款

## 关键矛盾（高质量回答应发现并分析）

矛盾1——旧版SCC失效：
  - 用户说2020年签过SCC，但新版SCC 2021年6月才发布，旧版2022年12月27日已到期
  - 好的助手应明确指出旧版已失效，当前数据传输处于无有效SCC保障的状态，存在合规敞口

矛盾2——数据敏感度与处理目的不匹配：
  - 用户说目的是"人力分析决策"，但数据含医疗诊断摘要
  - "人力分析决策"是否构成处理医疗诊断信息的充分合法基础存在争议
  - 好的助手应指出这一问题并建议重新评估处理目的的必要性和合法基础

矛盾3——Controller/Processor角色模糊：
  - 德国GmbH是独立法人（看似独立Controller），但人事系统和薪资由中国总部统一管理（实质上像Processor）
  - 这直接影响SCC应选Module 1（C2C）还是Module 2（C2P）
  - 好的助手应分析两种角色认定的利弊并给出建议

## 评估标准：完整决策链路（6个步骤）

### Step 1: SCC框架与TIA评估（必备，缺失则不超过0.4）
- 明确指出必须使用2021年6月新版SCC，旧版已失效
- 说明TIA（传输影响评估）的必要性和核心评估内容
- 分析中国未获欧盟充分性认定对TIA结论的影响
- 说明需要的补充技术措施（加密、假名化、访问控制等）

### Step 2: 信息验证与矛盾处理（重要加分项，+0.15）
- **旧版SCC失效识别**：是否主动指出2020年签的SCC已失效，并说明合规敞口风险 (+0.05)
- **处理目的与数据敏感度矛盾**：是否指出"人力分析决策"目的与医疗诊断数据之间的合法基础争议 (+0.05)
- **Controller/Processor角色分析**：是否分析了GmbH独立法人与总部统一管理之间的角色认定问题，并给出SCC Module选择建议 (+0.05)

### Step 3: Art.9特殊类别数据合规（必备，缺失则不超过0.6）
- 识别病假记录+医疗诊断摘要属于Art.9健康数据
- 分析合法处理基础（Art.9(2)(b)雇佣法律义务 vs Art.9(2)(a)明确同意）
- 建议数据最小化措施（聚合/脱敏/假名化）

### Step 4: 领域知识应用（加分项，每项+0.04）
- **BDSG §26合规**：说明德国联邦数据保护法对员工数据处理的特殊要求 (+0.04)
- **Betriebsrat协商义务**：指出引入新数据处理系统或跨境传输需要与Betriebsrat协商，并说明BetrVG §87相关条款 (+0.04)
- **DPO任命义务**：指出DPO空缺的合规风险，分析GDPR Art.37下公司是否有DPO指定义务 (+0.04)
- **DPIA必要性**：说明对Art.9数据的跨境传输很可能触发DPIA（数据保护影响评估）要求，引用Art.35 (+0.04)
- **荷兰AP执法风险**：结合用户提到的荷兰AP对中国公司罚款案例，分析该监管环境下的执法风险 (+0.04)

### Step 5: 综合建议（加分项，+0.05）
- 综合以上所有分析给出个性化的合规优先级建议
- 建议考虑了用户的具体约束（DPO空缺、旧版SCC失效、Betriebsrat存在等）
- 给出风险等级评估

### Step 6: 可操作的行动方案与时间线（加分项，+0.04）
- 给出具体的合规实施步骤和优先级排序
- 估算各步骤的时间周期
- 使用结构化格式（表格或清单），方便用户直接参照执行

## 评分汇总
- Step 1 + Step 3 都满足：基础分 0.5
- Step 2（矛盾处理）：最高 +0.15
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
