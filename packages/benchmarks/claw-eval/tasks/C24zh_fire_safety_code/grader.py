"""C24zh_fire_safety_code grader — multi-turn user-agent consultation: 消防疏散通道宽度."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA210Grader(UserAgentClarifyGraderBase):
    """消防规范 — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.35 * numerical + 0.30 * content
    """

    DOMAIN = "消防规范"
    MUST_ASK = [
        "建筑面积",
        "所在楼层（地上/地下及层数）",
        "建筑使用功能/业态类型",
        "安全出口数量",
        "耐火等级",
    ]

    CLARIFICATION_RUBRIC = """评估助手在对话中的信息收集质量（0.0-1.0）。

## 基础信息（必须收集，缺失任意一项不超过0.7）
  - 建筑面积
  - 所在楼层（地上几层）
  - 业态类型（商业/餐饮/办公等）
  - 耐火等级或结构类型

## 深入信息（好的助手会进一步追问，每覆盖一项加分）
  - 安全出口数量和位置
  - 疏散通道是否经过特殊区域（如厨房、仓库）
  - 现有设计图的通道布局
  - 是否有消防审图意见

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
- 用户初始query只说了"商业空间"和"1.2米"，缺少面积、楼层、业态等关键参数
- 助手是否在第一轮就识别出缺失并主动追问

### 2. 规范引用准确性
- 是否正确引用了GB50016-2014（2018年版）的相关条文
- 条文编号是否准确（5.5.18疏散走道宽度下限、5.5.21百人宽度和人员密度）
- 是否区分了"疏散走道最小净宽"和"按人数计算的总宽度"两个概念

### 3. 搜索工具使用质量
- 是否搜索了GB50016最新版本确认条文内容
- 是否搜索了商业营业厅人员密度指标的最新规定
- 搜索是否精准高效

### 4. 工具使用合理性
- 是否用Bash计算疏散人数和所需宽度
- 计算过程是否正确

### 5. 关键判断的专业度
- 用户认为"1.2米肯定不合规"——但实际计算后1.2m满足最低标准
- 助手是否能在纠正用户判断的同时给出专业风险提示（净宽余量小、装饰侵占等）
- 这是区分好助手和普通助手的关键——简单说"合规"或"不合规"都不够

## 评分标准
- 1.0：精准引用条文+正确计算+给出"数值合规但余量不足"的专业判断+风险提示
- 0.7-0.9：条文引用和计算基本正确，判断有专业度
- 0.4-0.6：条文引用有误或计算有偏差，判断过于简单
- 0.1-0.3：严重的规范引用错误或计算错误
- 0.0：完全无法回答"""

    NUMERICAL_RUBRIC = """请只评估助手回答中的数值计算准确性（0.0-1.0）。

## 话题一致性（前置检查）
原始问题是关于「商业空间疏散通道最小宽度」。如果完全偏离主题，直接判0。

## 正确参考值（基于GB50016-2014(2018版)程序化计算）

| 检查项 | 正确值 | 允许误差 | 依据 |
|--------|--------|----------|------|
| 人员密度（地上二层商业） | **0.43 人/㎡** | 精确匹配 | 表5.5.21-2 |
| 疏散人数 | **163人**（380×0.43=163.4，取整） | ±10人 | |
| 百人宽度指标（地上二层，一二级耐火） | **0.65 m/百人** | 精确匹配 | 表5.5.21-1 |
| 按人数计算的疏散总宽度 | **1.06 m**（163/100×0.65） | ±0.1m | |
| 疏散走道最小净宽下限 | **1.10 m** | 精确匹配 | 5.5.18条 |
| 最终判断：1.2m是否满足最低标准 | **满足**（1.2>1.10且>1.06） | | |

## 评分规则（严格执行）
- 1.0：所有6项参考值都在允许误差内，且最终判断正确
- 0.7-0.9：人员密度和百人宽度指标正确，计算有小偏差
- 0.5-0.6：核心指标正确但遗漏了部分计算步骤
- 0.3-0.4：人员密度或百人宽度指标引用错误
- 0.1-0.2：使用了完全错误的规范条文或计算方法
- 0.0：没有任何数值计算

## 硬性规则
- 如果人员密度用错（如用了地下层的0.77或地上一层的0.60）→ 后续计算全错 → 最高0.3
- 如果最终判断1.2m"不合规"（实际上数值满足最低标准）→ 最高0.5（结论错误但计算可能部分正确）
- 如果判断"合规"但没有给出计算过程 → 最高0.4"""

    CONTENT_RUBRIC = """请评估助手回答的内容质量（0.0-1.0）。不要考虑数值是否准确，只关注回答的完整性、专业性、实用性。

## 话题一致性（前置检查）
原始问题是关于「商业空间疏散通道最小宽度」。如果完全偏离主题，直接判0。

## 评估标准

### Step 1: 基础计算与规范引用（必备，缺失则 ≤0.4）
- 引用了GB50016相关条文（5.5.18、5.5.21等）
- 计算了疏散人数和所需疏散宽度
- 给出了1.2m是否满足最低标准的明确判断

### Step 2: 专业风险评估（重要加分项，+0.15）
这是区分专业助手和普通助手的关键维度：
- **净宽vs毛宽区分**：1.2m是图纸标注还是施工后净宽？墙面装饰、管线、消火栓箱等会侵占通道宽度（+0.05）
- **余量不足风险**：1.2m仅比1.10m下限多0.1m，建议预留至少1.4-1.5m（+0.05）
- **纠正用户认知**：用户认为"肯定不合规"，助手应基于计算客观纠正，同时指出虽然数值合规但实践风险高（+0.05）

### Step 3: 后厨疏散通道问题（加分项，+0.05）
- 如果用户提到疏散通道经过后厨，助手是否指出有明火区域的额外消防要求
- 防火分隔、门的开启方向等

### Step 4: 领域知识（加分项，每项 +0.04）
- **条文版本说明**：GB50016-2014(2018修订版)是现行有效版本（+0.04）
- **安全出口数量**：380㎡商业需要几个安全出口（≥2个）（+0.04）
- **疏散距离**：除了宽度还有疏散距离要求（直线距离和行走距离）（+0.04）
- **消防验收流程**：说明"双随机"不代表可以不合规，一旦出事故追责不以是否抽查为准（+0.04）

### Step 5: 综合建议（加分项，+0.05）
- 给出了具体的建议宽度（如1.4-1.5m）
- 提供了与甲方沟通的专业论据

### Step 6: 行动方案（加分项，+0.04）
- 建议请消防设计单位出具正式意见
- 建议保留沟通记录作为免责依据

## 评分汇总
- Step 1: 基础分 0.4
- Step 2: +0.15 / Step 3: +0.05 / Step 4: +0.16 / Step 5: +0.05 / Step 6: +0.04
- 理论满分路径：0.4 + 0.15 + 0.05 + 0.16 + 0.05 + 0.04 = 0.85
- 特别出色可酌情给到 1.0"""

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
