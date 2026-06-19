"""C10zh_labor_law grader — multi-turn user-agent consultation: 劳动法务."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA13Grader(UserAgentClarifyGraderBase):
    """劳动法务 — multi-turn user-agent evaluation.

    Scoring: 3 independent judge calls, code-weighted (no numerical dimension):
      completion = 0.15 * clarify + 0.25 * trajectory + 0.60 * content
    """

    DOMAIN = "劳动法务"
    MUST_ASK = [
        "公司所在地（不同省份司法实践差异大）",
        "辞退的具体法定理由（如严重违纪、不胜任等）",
        "公司规章制度是否经过民主程序并公示",
        "是否履行了通知工会等法定程序",
]

    CLARIFICATION_RUBRIC = """评估助手在对话中的信息收集质量（0.0-1.0）。
不仅看第一轮的提问，也看整个对话过程中助手是否逐步深入收集了分析案情所需的信息。

## 基础信息（必须收集，缺失任意一项不超过0.7）
  - 辞退的具体法定理由（严重违纪、不胜任工作、客观情况变化等）
  - 公司规章制度是否经过民主程序并公示
  - 是否履行了通知工会等法定程序

## 深入信息（好的法律顾问会进一步追问，每覆盖一项加分）
  - 公司所在地（不同省份司法实践差异大，如补正工会程序的规则）
  - 证据材料的具体情况（监控录像保存时限、检讨书是否自愿等）
  - 劳动者的工龄和薪资水平（影响赔偿金额计算）
  - 劳动合同签订情况（是否有违约金条款等）
  - 公司是否有工会（是否存在通知工会的前提条件）

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
- 用户的初始 query 问的是一般性的举证责任倒置，但真正需要的是针对具体案情的分析
- 助手是否在回答一般性问题后主动追问具体情况

### 2. 信息修正捕捉
- 用户在对话中逐步透露信息（辞退理由、规章制度签收、工会程序不确定）
- 助手是否准确捕捉到每轮新增的信息，并不断更新分析

### 3. 需求演变跟踪
- 用户可能从"一般性的法律问题"演变为"具体案情分析"再到"应对策略建议"
- 注意用户身份——用户是安保公司合规主管，问的是公司下属被辞退的情况（代表用人单位立场）
- 助手是否跟上了需求的自然演变和角色定位

### 4. 工具使用合理性（如果助手使用了计算工具或搜索工具）
- 是否在需要查询法条时主动调用工具
- **错误与修正的评判标准（严格执行）**：
  - 一次调用就得到正确结果 = 最优，不扣分
  - 调用出错但能自行发现并修正 = 次优，扣0.1-0.2
  - 调用出错且未发现，将错误结果呈现给用户 = 严重问题，扣0.3-0.5

### 5. 对话节奏控制
- 是否在合适的时机给出阶段性分析，而非一直追问不给答案
- 用户追问新问题时，是否流畅衔接而非生硬打断
- 注意：用户是新手（第一次用OpenClaw），对话初期可能不太流畅，助手是否有耐心引导

### 6. 搜索工具使用质量（助手可使用 web_search 和 web_fetch）
本任务涉及时效性信息（最新司法解释、地方司法实践动态），好的助手应主动搜索验证而非凭记忆回答。

**搜索必要性判断：**
- 用户问到举证责任倒置——助手是否搜索了最新的相关司法解释和案例？
- 涉及工会通知程序——是否搜索了相关法条和地方实践差异？
- 如果助手完全没搜索就给出了法律分析，需要考虑引用的法条是否准确

**搜索质量评估：**
- 优秀(不扣分)：搜索查询精准，1-3次搜索覆盖关键法律信息，结果被正确整合
- 良好(扣0.05)：搜索了但查询不够精准，需要4-5次才找到关键法条
- 一般(扣0.1)：过度搜索（6次以上）或重复搜索相同内容
- 较差(扣0.15)：搜索了但结果没有被使用，或搜到了错误信息却未辨别
- 未搜索(扣0.1)：完全没有使用搜索工具，直接凭记忆引用法条。但如果引用准确，可减轻扣分至0.05

## 评分标准
- 1.0：每一轮都精准理解用户意图，信息捕捉零遗漏，需求演变完美跟踪，工具使用高效
- 0.7-0.9：整体理解准确，偶有一轮响应不够精准
- 0.4-0.6：部分轮次理解偏差明显，或未注意到用户身份立场
- 0.1-0.3：多轮对话中反复出现意图误解或信息遗漏
- 0.0：完全无法跟踪用户意图"""

    CONTENT_RUBRIC = """请评估助手回答的内容质量（0.0-1.0）。关注回答的法律准确性、完整性、专业性和实操性。

## 话题一致性（前置检查）
原始问题是关于「劳动仲裁中举证责任倒置 + 具体辞退案情分析」。
如果助手的最终回答完全偏离了这个主题，内容质量直接判0。

## 用户完整情况（对话中逐步透露）
  - 身份：安保公司合规主管（代表用人单位立场）
  - 辞退理由：值班期间多次脱岗（客户投诉了两次）
  - 规章制度：有签收记录（但未确认是否经过民主程序）
  - 工会：公司有工会，但辞退时不确定有没有走工会通知程序
  - 安保员在公司干了快三年，月均工资约4800
  - 监控录像：系统只存30天，最近一次脱岗是22天前（仅剩8天窗口）
  - 检讨书：第一次脱岗写过，但不确定人事有原件
  - 客户投诉函：两封，第二封是口头投诉内部记录无客户签字
  - 考勤记录：指纹打卡，但脱岗期间未离楼（去同楼层休息室50米外）
  - 规章制度定义"脱岗"为"未经批准离开工作岗位超过30分钟"
  - 仲裁要求违法解除赔偿金2N

## 评估标准：完整决策链路（7个步骤）

### Step 1: 举证责任倒置法条梳理（必备，缺失则不超过0.3）
- 准确引用《劳动争议调解仲裁法》第6条
- 引用《最高人民法院关于审理劳动争议案件适用法律问题的解释（一）》相关条款
- 明确列举用人单位承担举证责任的法定情形（解除合法性、考勤记录、工资记录、规章制度等）

### Step 2: 信息验证与矛盾处理（重要加分项，+0.15）
这是区分普通助手和优秀助手的关键维度：
- **工会通知程序缺失风险**：《劳动合同法》第43条规定用人单位单方解除劳动合同应事先通知工会。公司有工会但不确定是否走了通知程序——好的助手应明确指出这是关键程序风险，即使实体理由成立（确实脱岗），未通知工会属程序违法，可能导致解除行为被认定违法 (+0.05)
- **监控证据8天窗口**：监控仅存30天、最近一次脱岗22天前，意味着仅剩8天保存窗口。好的助手应立即提醒紧急固定监控证据，否则关键证据将永久灭失，整个"多次脱岗"的举证将严重受损 (+0.05)
- **"脱岗"定义模糊性**：规章制度写"离开工作岗位超过30分钟"，但安保员仅去了同楼层休息室（50米），是否算"离开工作岗位"存在争议；且时间是否超过30分钟"说不准"。好的助手应提醒这个定义在仲裁中可能被对方律师挑战 (+0.05)
- 如果助手完全没有识别以上矛盾，只做一般性法律分析，此项得0

### Step 3: 案情具体分析（必备，缺失则不超过0.5）
- 分析证据链完整性（监控+检讨书+考勤+投诉函各自的证据效力）
- 区分"签收"和"民主程序制定+公示"的区别

### Step 4: 领域知识应用（加分项，每项 +0.04）
- **举证责任倒置法定情形**：不仅列举法条，还能结合本案具体分析哪些证据由用人单位承担举证责任，哪些不适用倒置 (+0.04)
- **第43条工会通知程序**：详细说明通知工会的具体操作要求（事先通知、听取意见、补正程序的地方实践差异） (+0.04)
- **证据链完整性分析**：逐一分析四类证据（监控、检讨书、考勤、投诉函）的证据效力和瑕疵点，给出加固建议 (+0.04)
- **违法解除2N赔偿金计算**：准确说明2N计算方式（月均工资4800×工龄3年×2=28800），并说明N的计算规则（满半年按一年算） (+0.04)
- **"严重违反"认定标准**：说明司法实践中对"严重违反规章制度"的认定标准（合理性审查、比例原则），而非仅看规章制度字面规定 (+0.04)

### Step 5: 综合建议（加分项，+0.05）
- 综合以上分析（包括矛盾处理结论）给出明确的应对策略
- 区分紧急事项（固定监控证据）和中期事项（补正工会程序、证据加固）
- 评估当前证据链下仲裁胜败风险，给出和解vs应诉的利弊分析

### Step 6: 可操作建议清单（加分项，+0.04）
- 给出具体的仲裁准备步骤或举证建议清单
- 使用结构化格式，方便用户直接参照执行

## 评分汇总
- Step 1 + Step 3 都满足：基础分 0.5
- Step 2（信息验证与矛盾处理）：最高 +0.15（这是拉开差距的关键维度）
- Step 4 每个知识点 +0.04（最高 +0.20）
- Step 5: +0.05
- Step 6: +0.04
- 理论满分路径：0.5 + 0.15 + 0.20 + 0.05 + 0.04 = 0.94（实际封顶0.90）
- 如果法律分析特别深入（如引用了地方典型案例、考虑了地域差异），可酌情给到 1.0"""

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
