"""C12zh_ecommerce_operations grader — multi-turn user-agent consultation: 电商运营."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA15Grader(UserAgentClarifyGraderBase):
    """电商运营 — multi-turn user-agent evaluation.

    Scoring: 3 independent judge calls, code-weighted (no numerical dimension):
      completion = 0.15 * clarify + 0.25 * trajectory + 0.60 * content
    """

    DOMAIN = "电商运营"
    MUST_ASK = [
        "具体经营的商品类目（如创意摆件、收纳用品等）",
        "是否考虑参与试运营/0元入驻计划",
        "目前的月销售额规模",
        "是否有特定的违规历史或关注的特定违规场景",
]

    CLARIFICATION_RUBRIC = """评估助手在对话中的信息收集质量（0.0-1.0）。
不仅看第一轮的提问，也看整个对话过程中助手是否逐步深入收集了给出精准建议所需的信息。

## 基础信息（必须收集，缺失任意一项不超过0.7）
  - 具体经营的商品类目（不同细分类目保证金标准差异大）
  - 目前的月销售额规模（影响入驻模式选择和资金周转建议）

## 深入信息（好的顾问会进一步追问，每覆盖一项加分）
  - 是否考虑参与试运营/0元入驻计划（影响保证金缴纳策略）
  - 店铺类型（个体店/企业店，影响保证金标准）
  - 是否有特定的违规历史或关注的特定违规场景
  - 已有的平台运营经验（淘宝、拼多多等，影响建议的深度）
  - 供应链情况（自有仓库还是一件代发，影响发货合规建议）

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
- 用户说"家居类目"但没给具体细分（创意摆件 vs 收纳用品的保证金差异大）
- 用户没说入驻模式和月销规模
- 助手是否在第一轮就识别出缺失并主动询问

### 2. 信息修正捕捉
- 用户在对话中逐步透露信息（具体类目、选择了500元试运营、月销过1万）
- 助手是否准确捕捉到每轮新增的信息，并调整建议

### 3. 需求演变跟踪
- 用户可能从"保证金标准查询"演变为"试运营补缴规则"再到"违规红线"甚至"直通车投放"
- 助手是否跟上了需求的自然演变和话题切换

### 4. 工具使用合理性
- 是否在需要查询最新政策时调用工具
- **错误与修正的评判标准（严格执行）**：
  - 一次调用就得到正确结果 = 最优，不扣分
  - 调用出错但能自行发现并修正 = 次优，扣0.1-0.2
  - 调用出错且未发现，将错误结果呈现给用户 = 严重问题，扣0.3-0.5

### 5. 对话节奏控制
- 是否在合适的时机给出阶段性答案，而非一直追问不给信息
- 用户话题跳转时（如突然问直通车），是否流畅衔接
- 注意：用户是电商老手，习惯话题跳跃，助手应能适应

### 6. 搜索工具使用质量（助手可使用 web_search 和 web_fetch）
本任务涉及高度时效性信息（抖音小店保证金标准、扣分规则、入驻政策），这些政策经常更新。

**搜索必要性判断：**
- 用户明确提到"保证金和扣分规则最近好像有变动"——助手是否搜索了最新标准？
- 不同类目的保证金金额——是否通过搜索确认了最新数字？
- 试运营/0元入驻的补缴规则——是否搜索了最新政策细节？

**搜索质量评估：**
- 优秀(不扣分)：搜索查询精准，1-3次搜索覆盖关键政策信息
- 良好(扣0.05)：搜索了但查询不够精准
- 一般(扣0.1)：过度搜索或重复搜索
- 较差(扣0.15)：搜索了但结果没有被正确使用
- 未搜索(扣0.1)：完全没搜索就给出了保证金金额和政策细节——在用户明确提到"最近有变动"的情况下，不搜索是严重疏忽。但如果给出的金额恰好正确，可减轻至0.05

## 评分标准
- 1.0：每一轮都精准理解用户意图，信息捕捉零遗漏，话题切换流畅衔接，工具使用高效
- 0.7-0.9：整体理解准确，偶有一轮响应不够精准
- 0.4-0.6：部分轮次理解偏差，或未跟上用户话题切换
- 0.1-0.3：多轮对话中反复出现意图误解
- 0.0：完全无法跟踪用户意图"""

    CONTENT_RUBRIC = """请评估助手回答的内容质量（0.0-1.0）。关注回答的准确性、完整性、实操性。

## 话题一致性（前置检查）
原始问题是关于「抖音小店保证金标准 + 违规红线」。
如果助手的最终回答完全偏离了这个主题，内容质量直接判0。

## 用户完整情况（对话中逐步透露）
  - 具体类目：创意摆件和收纳用品（两个品类混着卖）
  - 不确定在抖音算"家居日用"还是"家装饰品"
  - 之前看到说有0元入驻的政策
  - 月销约1万多（淘宝+拼多多），抖音刚起步
  - 营业执照经营范围："工艺品及收藏品批发零售"
  - 试运营500元门槛更好，备货资金压力大
  - 回款周期关注（淘系T+15，抖音不清楚）
  - 有一款树脂摆件想主推到抖音
  - 商品图直接从淘宝搬过去的，不确定有没有违规风险
  - 有几款9.9包邮引流款收纳用品

## 评估标准：完整决策链路（7个步骤）

### Step 1: 保证金标准说明（必备，缺失则不超过0.3）
- 准确说明家居相关类目的保证金标准
- 说明个体店和企业店的保证金区别

### Step 2: 信息验证与矛盾处理（重要加分项，+0.15）
这是区分普通助手和优秀助手的关键维度：
- **类目保证金差异化**："创意摆件"在抖音可能归属"工艺礼品"类目（保证金2000-5000元），而"收纳用品"归属"家居日用"类目（保证金500-2000元）。两个品混在一个店里，保证金按最高类目收取。好的助手应指出这一点，建议用户确认具体类目归属再决定入驻方案，而非笼统按"家居"一个标准报价 (+0.05)
- **0元入驻≠试运营**：抖音的0元入驻政策和试运营是两种不同机制——0元入驻是针对特定类目的保证金减免政策，试运营是新商家的考核期（有订单量限制和货款冻结）。好的助手应明确区分这两个概念，而不是混为一谈 (+0.05)
- **淘宝搬图违规风险**：用户从淘宝直接搬商品图到抖音，可能触发平台的"搬运检测"——如果图片含淘宝水印或非原创素材，可能面临扣分甚至商品下架。好的助手应主动警示这个风险，建议重新拍摄或至少去除水印 (+0.05)
- 如果助手完全没有识别以上矛盾，只给出通用政策介绍，此项得0

### Step 3: 入驻规则说明（必备，缺失则不超过0.5）
- 说明试运营机制的具体规则（订单量限制、货款冻结、考核期时长）
- 说明保证金补缴规则和转正式店铺的条件

### Step 4: 领域知识应用（加分项，每项 +0.04）
- **抖音类目保证金差异化标准**：不仅给出一个数字，还能说明不同细分类目（工艺礼品vs家居日用vs家装饰品）的保证金差异，以及多类目经营按最高标准的规则 (+0.04)
- **试运营机制vs0元入驻区别**：详细对比两种机制的适用条件、权益限制、退出规则，帮用户判断哪种更适合当前情况 (+0.04)
- **商品图搬运检测规则**：说明抖音的图片原创检测机制（MD5比对、AI识别等），以及被判定搬运后的具体处罚（扣分、下架、限制流量），给出合规建议 (+0.04)
- **低价引流品监管红线**：说明抖音对9.9包邮等低价引流品的监管规则（可能被限制推荐、触发品质抽检、影响店铺评分），以及合规操作方式 (+0.04)
- **抖音回款周期**：准确说明抖音小店的回款周期规则（如确认收货后多少天、不同信用等级的差异），与用户已知的淘系T+15做对比 (+0.04)

### Step 5: 综合建议（加分项，+0.05）
- 结合用户的具体情况（多品类经营、资金压力、刚起步）给出个性化建议
- 建议考虑类目归属确认、保证金缴纳策略、合规风险防范的优先级

### Step 6: 可操作清单（加分项，+0.04）
- 给出具体的操作步骤（在哪里查保证金、如何确认类目归属、如何补缴等）
- 使用结构化格式，方便用户直接参照执行

## 评分汇总
- Step 1 + Step 3 都满足：基础分 0.5
- Step 2（信息验证与矛盾处理）：最高 +0.15（这是拉开差距的关键维度）
- Step 4 每个知识点 +0.04（最高 +0.20）
- Step 5: +0.05
- Step 6: +0.04
- 理论满分路径：0.5 + 0.15 + 0.20 + 0.05 + 0.04 = 0.94（实际封顶0.90）
- 如果在以上基础上提供了额外洞察（如季节性运营策略、竞品分析），可酌情给到 1.0"""

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

        # 2. Trajectory quality (25%) — full conversation intent understanding
        trajectory_score = 0.0
        try:
            result = judge.evaluate(prompt_text, full_conversation, "",
                                    self.TRAJECTORY_RUBRIC)
            trajectory_score = result.score
            print(f"[grader] trajectory score: {trajectory_score:.2f} — {result.reasoning[:200]}")
        except Exception as exc:
            print(f"[grader] trajectory judge failed: {exc}")

        # 3. Content quality (60%)
        content_score = 0.0
        try:
            result = judge.evaluate(prompt_text, full_conversation, "",
                                    self.CONTENT_RUBRIC)
            content_score = result.score
            print(f"[grader] content score: {content_score:.2f} — {result.reasoning[:200]}")
        except Exception as exc:
            print(f"[grader] content judge failed: {exc}")

        # Combine: 15% clarify + 25% trajectory + 60% content
        scores.completion = round(
            0.15 * clarify_score +
            0.25 * trajectory_score +
            0.60 * content_score,
            4
        )
        print(f"[grader] completion: {scores.completion:.4f} "
              f"(clarify={clarify_score:.2f}*0.15 + trajectory={trajectory_score:.2f}*0.25 "
              f"+ content={content_score:.2f}*0.60)")

        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
