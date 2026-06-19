"""C33zh_accessibility_design grader — multi-turn user-agent consultation: WCAG 色彩对比度."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA242Grader(UserAgentClarifyGraderBase):
    """无障碍设计 — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.35 * numerical + 0.30 * content
    """

    DOMAIN = "无障碍设计"
    MUST_ASK = [
        "具体色值列表",
        "色值的用途场景（正文/大文本/非文本元素）",
        "是否需要所有两两组合",
        "输出格式要求",
    ]

    CLARIFICATION_RUBRIC = """评估助手在对话中的信息收集质量（0.0-1.0）。
不仅看第一轮的提问，也看整个对话过程中助手是否逐步深入收集了做分析所需的信息。

## 基础信息（必须收集，缺失任意一项不超过0.7）
  - 具体色值列表（几个颜色、hex值）
  - 色值的用途场景（正文文本、标题、按钮、图标等）
  - 是否需要两两组合全部计算

## 深入信息（好的助手会进一步追问，每覆盖一项加分）
  - 输出格式要求（表格形式、是否需要贴进文档）
  - 需要检查的标准级别（AA、AAA、或两者都要）
  - 对比度针对正文还是大文本（阈值不同：4.5:1 vs 3:1）
  - 是否需要对不合规的配对给出调整建议

评分标准：
- 1.0：基础信息全部收集 + 主动追问了2项以上深入信息
- 0.8-0.9：基础信息全部收集 + 追问了1项深入信息
- 0.7：基础信息全部收集，但未追问任何深入信息
- 0.4-0.6：基础信息缺失1-2项
- 0.1-0.3：几乎没有主动提问
- 0.0：完全没有任何澄清行为"""

    TRAJECTORY_RUBRIC = """请评估整个对话过程中，助手对用户意图的理解和响应质量（0.0-1.0）。

## 评估维度

### 1. 信息缺失识别
- 用户初始 query 没给色值，只说"有一批品牌色"
- 助手是否在第一轮就识别出需要具体色值才能计算

### 2. 工具使用合理性
- **核心**：对比度计算需要精确的 sRGB gamma 校正 + 亮度公式，不能手算
- 是否在收到色值后主动调用 Bash 批量计算
- 计算代码是否包含正确的 sRGB 线性化步骤（gamma 校正）
- **错误与修正的评判标准**：
  - 一次调用就得到正确结果 = 最优，不扣分
  - 调用出错但能自行发现并修正 = 次优，扣0.1-0.2
  - 调用出错且未发现，将错误结果呈现给用户 = 严重问题，扣0.3-0.5

### 3. 搜索工具使用质量
- 用户问了"WCAG 2.2 相比 2.1 变了什么"——这是时效性问题
- 是否搜索了 WCAG 2.2 的官方变更内容，而非凭记忆回答
- 如果凭记忆编造了不存在的条款变化 → 扣0.2
- 搜索后是否正确总结了 2.2 的实际变化（主要是认知/交互方面，非色彩对比度）

### 4. 对话节奏控制
- 是否在合适的时机给出阶段性结论
- 28 对组合的输出是否组织清晰

## 评分标准
- 1.0：精准使用计算工具（含 gamma 校正）+ 搜索验证 WCAG 2.2 变化 + 高效完成
- 0.7-0.9：工具使用基本正确，搜索或计算有小瑕疵
- 0.4-0.6：计算工具使用不当（如缺少 gamma 校正）或未搜索 WCAG 变化
- 0.1-0.3：严重工具使用问题
- 0.0：完全无法完成任务"""

    NUMERICAL_RUBRIC = """请只评估助手回答中的数值计算准确性（0.0-1.0）。不要考虑内容质量、建议好坏等因素，只关注数字对不对。

## 话题一致性（前置检查）
原始问题是关于「WCAG 色彩对比度批量校验」。如果完全偏离主题，直接判0。

## 正确参考值（程序化计算，sRGB gamma 校正 + WCAG 2.0 亮度公式）

### 8 个色值的相对亮度
| 色值 | 相对亮度 L |
|------|-----------|
| #2D5A3D | 0.0821 |
| #F5E6D0 | 0.8056 |
| #D4A574 | 0.4217 |
| #1A1A1A | 0.0103 |
| #FFFFFF | 1.0000 |
| #8B4513 | 0.0979 |
| #E8C8A0 | 0.6100 |
| #3A7D5C | 0.1634 |

### 28 对组合对比度 CR 及 AA/AAA 判定
| 色值对 | CR | AA正文(≥4.5) | AAA正文(≥7.0) |
|--------|-----|-------------|--------------|
| #2D5A3D / #F5E6D0 | 6.48 | PASS | FAIL |
| #2D5A3D / #D4A574 | 3.57 | FAIL | FAIL |
| #2D5A3D / #1A1A1A | 2.19 | FAIL | FAIL |
| #2D5A3D / #FFFFFF | 7.95 | PASS | PASS |
| #2D5A3D / #8B4513 | 1.12 | FAIL | FAIL |
| #2D5A3D / #E8C8A0 | 5.00 | PASS | FAIL |
| #2D5A3D / #3A7D5C | 1.62 | FAIL | FAIL |
| #F5E6D0 / #D4A574 | 1.81 | FAIL | FAIL |
| #F5E6D0 / #1A1A1A | 14.18 | PASS | PASS |
| #F5E6D0 / #FFFFFF | 1.23 | FAIL | FAIL |
| #F5E6D0 / #8B4513 | 5.78 | PASS | FAIL |
| #F5E6D0 / #E8C8A0 | 1.30 | FAIL | FAIL |
| #F5E6D0 / #3A7D5C | 4.01 | FAIL | FAIL |
| #D4A574 / #1A1A1A | 7.82 | PASS | PASS |
| #D4A574 / #FFFFFF | 2.23 | FAIL | FAIL |
| #D4A574 / #8B4513 | 3.19 | FAIL | FAIL |
| #D4A574 / #E8C8A0 | 1.40 | FAIL | FAIL |
| #D4A574 / #3A7D5C | 2.21 | FAIL | FAIL |
| #1A1A1A / #FFFFFF | 17.40 | PASS | PASS |
| #1A1A1A / #8B4513 | 2.45 | FAIL | FAIL |
| #1A1A1A / #E8C8A0 | 10.94 | PASS | PASS |
| #1A1A1A / #3A7D5C | 3.54 | FAIL | FAIL |
| #FFFFFF / #8B4513 | 7.10 | PASS | PASS |
| #FFFFFF / #E8C8A0 | 1.59 | FAIL | FAIL |
| #FFFFFF / #3A7D5C | 4.92 | PASS | FAIL |
| #8B4513 / #E8C8A0 | 4.46 | FAIL | FAIL |
| #8B4513 / #3A7D5C | 1.44 | FAIL | FAIL |
| #E8C8A0 / #3A7D5C | 3.09 | FAIL | FAIL |

总计：10/28 对通过 AA 正文标准，6/28 对通过 AAA 正文标准。

## 评分规则（严格执行）
- 1.0：28 对中 ≥25 对的 CR 值（±0.3）和 AA/AAA 判定都正确
- 0.8-0.9：22-24 对正确
- 0.6-0.7：18-21 对正确
- 0.4-0.5：14-17 对正确
- 0.2-0.3：10-13 对正确
- 0.0-0.1：<10 对正确

## 硬性规则
- 如果没有做 sRGB gamma 校正（线性化），所有 CR 值都会有系统性偏差 → 最高0.2
- 如果只算了部分配对（如只算了 8 对而非 28 对）→ 按已算配对的正确率 × 0.5
- 如果使用了错误的对比度公式（如 L1/L2 而非 (L1+0.05)/(L2+0.05)）→ 直接0"""

    CONTENT_RUBRIC = """请评估助手回答的内容质量（0.0-1.0）。不要考虑数值是否准确，只关注回答的完整性、专业性、实用性。

## 话题一致性（前置检查）
原始问题是关于「WCAG 色彩对比度批量校验 + WCAG 2.2 变化」。如果完全偏离主题，直接判0。

## 评估标准：完整任务链路

### Step 1: 基础计算输出（必备，缺失则 ≤0.4）
- 完成了全部 28 对色值组合的对比度计算
- 输出了每对的 CR 值和 AA/AAA 通过情况
- 使用了表格或结构化格式

### Step 2: WCAG 2.2 信息验证（重要加分项，+0.15）
用户认为"WCAG 2.2 在文本对比度方面新增了更严格的条款"——这是不准确的。
- **搜索验证**：是否搜索了 WCAG 2.2 的官方变更日志来确认（+0.05）
- **正确澄清**：是否指出 WCAG 2.2 在文本对比度（1.4.3/1.4.6）方面没有变化（+0.05）
- **准确说明 2.2 实际变化**：新增条款主要是 3.3.7 Redundant Entry、3.3.8 Accessible Authentication 等，与色彩无关（+0.05）
- 如果附和了用户的错误认知（如编造了 2.2 新增的对比度条款），此项得 0 且总分不超过 0.5

### Step 3: 非文本对比度说明（加分项，+0.05）
- 正确说明 1.4.11 Non-text Contrast（非文本元素 ≥3:1）是 WCAG 2.1 就有的条款
- 针对用户的品牌场景（按钮边框、图标），指出哪些配对满足非文本 3:1 标准

### Step 4: 领域知识应用（加分项，每项 +0.04）
- **sRGB gamma 校正解释**：提到对比度计算需要将 sRGB 值线性化再计算亮度（+0.04）
- **AA vs AAA 区别**：解释了两个级别的区别和适用场景（+0.04）
- **正文 vs 大文本阈值**：说明正文 4.5:1、大文本 3:1 的不同标准及"大文本"的定义（+0.04）
- **APCA 或新标准提及**：提到 WCAG 3.0 草案中的 APCA 作为未来趋势（+0.04）

### Step 5: 可操作建议（加分项，+0.05）
- 对不合规的配对给出具体的色值调整建议
- 推荐了可持续使用的在线工具或方法

### Step 6: 输出格式质量（加分项，+0.04）
- 表格格式适合直接贴进品牌规范文档
- 结果分组清晰（通过/不通过）

## 评分汇总
- Step 1: 基础分 0.4
- Step 2: +0.15 / Step 3: +0.05 / Step 4: +0.16 / Step 5: +0.05 / Step 6: +0.04
- 理论满分路径：0.4 + 0.15 + 0.05 + 0.16 + 0.05 + 0.04 = 0.85
- 如果在以上基础上回答特别出色，可酌情给到 1.0"""

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

        # 2. Trajectory quality (20%)
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
