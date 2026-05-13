"""C29zh_pediatric_medication grader — multi-turn user-agent consultation: 儿童用药."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA228Grader(UserAgentClarifyGraderBase):
    """儿童用药 — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.35 * numerical + 0.30 * content
    """

    DOMAIN = "儿童用药"
    MUST_ASK = [
        "布洛芬的具体剂型和浓度（滴剂还是混悬液）",
        "孩子的月龄/年龄",
        "孩子的体重（按体重计算剂量是关键）",
        "当前的具体体温",
        "除发烧外是否有其他异常症状",
]

    CLARIFICATION_RUBRIC = """评估助手在对话中的信息收集质量（0.0-1.0）。
不仅看第一轮的提问，也看整个对话过程中助手是否逐步深入收集了做剂量计算和用药判断所需的信息。

## 基础信息（必须收集，缺失任意一项不超过0.7）
  - 布洛芬的具体剂型和浓度（滴剂还是混悬液，浓度多少）
  - 孩子的月龄/年龄
  - 孩子的体重（这是计算剂量的核心参数）
  - 当前的具体体温

## 深入信息（好的助手会进一步追问，每覆盖一项加分）
  - 除发烧外是否有其他症状（精神状态、皮疹、哭闹等）
  - 疫苗接种的具体时间（判断发热是否在正常反应窗口内）
  - 孩子既往用药史/过敏史

评分标准：
- 1.0：基础信息全部收集 + 主动追问了2项以上深入信息
- 0.8-0.9：基础信息全部收集 + 追问了1项深入信息
- 0.7：基础信息全部收集，但未追问任何深入信息
- 0.4-0.6：基础信息缺失1-2项（特别是缺失体重则不超过0.5）
- 0.1-0.3：几乎没有主动提问，直接基于不完整信息给出回答
- 0.0：完全没有任何澄清行为

注意：
- 如果用户主动提供了部分信息，助手只需询问缺失的部分即可
- **体重是最关键的参数**——如果没有问体重就给剂量，说明专业素养不足"""

    TRAJECTORY_RUBRIC = """请评估整个对话过程中，助手对用户意图的理解和响应质量（0.0-1.0）。
不要只看最终回答，而是审视每一轮对话中助手的表现。

## 评估维度

### 1. 信息缺失识别（用户没给的关键信息，助手是否察觉并追问）
- 用户的初始 query 缺少体重、具体浓度、当前体温等关键参数
- 助手是否在第一轮就识别出缺失并主动询问，而非先给模糊回答再补问
- 特别注意：体重是计算布洛芬剂量的核心参数，必须追问

### 2. 信息异常识别
- 用户透露孩子19个月但只有8公斤——这是严重偏低的体重
- 助手是否察觉到这个异常并追问确认，或至少提醒家长关注
- 如果助手对此毫无反应直接计算，说明缺乏临床敏感性

### 3. 需求演变跟踪
- 用户的核心需求是"该不该给布洛芬+怎么吃"
- 但好的助手应该看到更深层的问题（体重异常、物理降温争议）
- 是否在回答用药问题的同时，自然地引导到更重要的健康关注

### 4. 工具使用合理性
- **计算工具**：剂量计算是否用工具精确计算（而非心算近似）
  - 一次调用正确 = 最优，不扣分
  - 调用出错但自行修正 = 次优，扣0.1-0.2
  - 调用出错且未发现 = 严重问题，扣0.3-0.5

### 5. 搜索工具使用质量（助手可使用 web_search 和 web_fetch）
本任务涉及医学指南的时效性信息，好的助手应主动搜索而非凭记忆回答。

**搜索必要性判断：**
- 用户提到崔玉涛的"38.5℃以下物理降温"说法——助手是否搜索了最新AAP/WHO退热指南来验证？
- 疫苗后发热的处理是否有特殊注意事项——助手是否搜索了相关指南？
- 布洛芬滴剂的给药剂量——助手是否搜索了药品说明书或权威用药指南？

**搜索质量评估：**
- 优秀(不扣分)：搜索查询精准，1-3次搜索覆盖关键信息，搜索结果被正确整合到回答中
- 良好(扣0.05)：搜索了但查询不够精准，需要4-5次才找到关键信息
- 一般(扣0.1)：过度搜索（6次以上）或重复搜索相同内容
- 较差(扣0.15)：搜索了但结果没有被使用，或搜到了错误信息却未辨别
- 未搜索(扣0.1)：完全没有使用搜索工具，直接凭记忆给出医学信息。但如果凭记忆给出的信息恰好正确，可减轻扣分至0.05

### 6. 对话节奏控制
- 是否在合适的时机给出阶段性结论，而非一直追问不给答案
- 家长在焦虑中，助手是否兼顾了信息收集和安抚情绪

## 评分标准
- 1.0：每一轮都精准理解用户意图，异常信息敏锐捕捉，工具使用高效恰当
- 0.7-0.9：整体理解准确，工具使用基本合理，偶有一轮响应不够精准
- 0.4-0.6：部分轮次理解偏差明显（如忽略体重异常、未搜索指南），或工具使用不当
- 0.1-0.3：多轮对话中反复出现意图误解或信息遗漏
- 0.0：完全无法跟踪用户意图"""

    NUMERICAL_RUBRIC = """请只评估助手回答中的数值计算准确性（0.0-1.0）。

## 正确参考值
- 布洛芬滴剂浓度: 50mg/1.25ml = 40 mg/ml（注意不是混悬液的20mg/ml）
- 单次剂量: 5-10 mg/kg × 8kg = 40-80 mg
- 单次用量: 1.0-2.0 ml（典型1.5ml=60mg）
- 给药间隔: 每6-8小时，24小时不超过4次
- 19月龄8kg低于WHO P3百分位（男P3=8.9kg，女P3=8.2kg）

## 严格分4档（按子项加权）

### Sub-A: 浓度识别与剂量计算（40%权重）
- 1.0：正确识别滴剂浓度40mg/ml，按8kg体重算出40-80mg/1.0-2.0ml
- 0.5：剂量范围基本对但浓度换算过程不清晰
- 0.0：混淆了滴剂(40mg/ml)和混悬液(20mg/ml)浓度，或未按体重计算

### Sub-B: 体重合理性质疑（35%权重）——核心区分点
19个月8公斤严重偏低（低于WHO P3）。
- 1.0：明确指出8kg对于19月龄偏低/异常，建议确认体重或关注发育
- 0.5：提到了体重偏轻但没有给出具体参考范围
- 0.0：直接用8kg算剂量，完全没有质疑体重的合理性

### Sub-C: 给药方案完整性（25%权重）
- 1.0：给出了剂量范围+给药间隔(6-8h)+每日上限(不超过4次)+起效时间(30-60min)
- 0.5：给了剂量和间隔但缺少每日上限或起效时间
- 0.0：只给了单次剂量没有其他信息

## 硬性规则
- 混淆滴剂和混悬液浓度 → 最高0.2（剂量差2倍是危险错误）
- 没有按体重计算给了固定剂量 → 最高0.4
- 体重异常未质疑 → Sub-B得0，总分上限约0.65"""

    CONTENT_RUBRIC = """请评估助手回答的内容质量（0.0-1.0）。不要考虑数值是否准确，只关注回答的完整性、专业性、实用性。

## 话题一致性（前置检查）
原始问题是关于「疫苗后发烧是否给布洛芬 + 剂量计算」。
如果助手的最终回答完全偏离了这个主题，内容质量直接判0。

## 用户完整情况（对话中逐步透露）
  - 孩子19个月大（女孩），打了手足口疫苗后发烧37.8℃
  - 家里有布洛芬滴剂（50mg/1.25ml即40mg/ml）
  - 孩子体重8公斤（19个月仅8公斤，严重偏低）
  - 除发烧外精神还行，比平时黏人一点
  - 疫苗上午十点打的，下午两点发现发烧
  - 用户引用了崔玉涛"38.5℃以下物理降温"的说法

## 评估标准：完整决策链路（5个步骤）

### Step 1: 剂量计算（必备，缺失则不超过0.4）
- 明确区分了滴剂和混悬液的浓度差异
- 按体重计算了布洛芬的用量范围
- 说明了给药间隔和24小时最大次数

### Step 2: 体重异常识别（重要加分项，+0.15，核心区分点）
这是区分普通助手和优秀助手的关键维度：
- **发现体重异常**：19个月8公斤严重偏低，低于WHO P3百分位（女孩P3=8.2kg, P50=10.2kg） (+0.05)
- **追问或提醒**：主动追问体重是否准确，或提醒家长这个体重需要关注 (+0.05)
- **建议关注生长发育**：建议家长带孩子做生长发育评估，排除营养不良等问题 (+0.05)
- 如果助手对19个月8公斤毫无反应，直接计算剂量 → 此项得0

### Step 3: 疫苗后发热处理指南（加分项，+0.10）
- **搜索最新指南**：是否搜索了AAP或WHO关于儿童退热的最新建议 (+0.03)
- **指出物理降温争议**：最新指南不再推荐物理降温作为主要退热手段，酒精擦浴已明确禁止 (+0.04)
- **纠正38.5℃教条**：国际指南更强调孩子的舒适度而非死守温度线，孩子不舒服就可以用退烧药 (+0.03)
- 如果只是简单复述崔玉涛的说法而无任何补充或更新 → 此项得0

### Step 4: 领域知识（加分项，每项+0.04）
- **滴剂vs混悬液区别**：明确说明两种剂型的浓度差异（40mg/ml vs 20mg/ml），强调不可混淆的危险性 (+0.04)
- **退热药使用时机**：不仅看温度，更要看孩子精神状态和舒适度来决定是否用药 (+0.04)
- **布洛芬vs对乙酰氨基酚**：提到6个月以上可用布洛芬，两种退热药的区别和选择 (+0.04)
- **疫苗后发热特点**：说明疫苗后发热通常是自限性的（24-48小时内消退），属于正常免疫反应 (+0.04)

### Step 5: 安全提醒与就医指征（加分项，+0.05）
- 列出了需要立即就医的情况：
  - 体温持续超过39℃超过24小时
  - 发热超过48小时不退
  - 精神萎靡、嗜睡、持续哭闹
  - 出现皮疹、抽搐、呕吐
  - 接种部位严重红肿或化脓

## 评分汇总
- Step 1 满足：基础分 0.4
- Step 2（体重异常识别）：最高 +0.15（核心区分点）
- Step 3（指南更新）：最高 +0.10
- Step 4 每个知识点 +0.04（最高 +0.16）
- Step 5: +0.05
- 理论满分路径：0.4 + 0.15 + 0.10 + 0.16 + 0.05 = 0.86
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

        # 3. Numerical accuracy (35%) — hybrid: programmatic weight check + judge
        import re as _re
        weight_questioned = False
        for m in messages:
            if m.message.role == "assistant":
                text = m.message.text or ""
                if any(kw in text for kw in ["偏低", "偏轻", "体重.*低", "低于.*百分位",
                    "生长", "发育", "确认.*体重", "核实.*体重", "underweight",
                    "below.*percentile", "体重.*异常", "P3", "正常.*体重"]):
                    weight_questioned = True
                    break

        numerical_score = 0.0
        try:
            result = judge.evaluate(prompt_text, full_conversation, "",
                                    self.NUMERICAL_RUBRIC)
            judge_num = result.score
            print(f"[grader] numerical judge: {judge_num:.2f}")
            # Programmatic cap: if weight not questioned, cap at 0.65
            if not weight_questioned:
                numerical_score = min(judge_num, 0.65)
                print(f"[grader] weight NOT questioned -> capped at 0.65, final={numerical_score:.2f}")
            else:
                numerical_score = judge_num
                print(f"[grader] weight questioned -> no cap, final={numerical_score:.2f}")
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
