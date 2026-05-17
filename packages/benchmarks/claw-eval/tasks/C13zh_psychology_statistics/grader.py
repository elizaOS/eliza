"""C13zh_psychology_statistics grader — multi-turn user-agent consultation: 心理统计."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA22Grader(UserAgentClarifyGraderBase):
    """心理统计 — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.35 * numerical + 0.30 * content
    """

    DOMAIN = "心理统计"
    MUST_ASK = [
        "实验设计的具体变量结构（被试间/被试内因素及水平数）",
        "先验知识的测量方式（连续变量还是分类变量）",
        "研究假设的核心关注点（主效应、交互作用、还是调节效应）",
        "因变量的数量及类型（单变量还是多变量）",
        "样本量（每组人数和总人数）",
        "是否已做过球形检验及结果",
    ]

    CLARIFICATION_RUBRIC = """评估助手在对话中的信息收集质量（0.0-1.0）。
不仅看第一轮的提问，也看整个对话过程中助手是否逐步深入收集了做统计建议所需的信息。

## 基础信息（必须收集，缺失任意一项不超过0.7）
  - 实验设计结构（混合设计的被试间/被试内因素及水平数）
  - 先验知识的测量方式（连续变量还是分类变量）
  - 研究假设的核心关注（是要控制先验知识还是检验其调节效应）
  - 因变量的数量和类型

## 深入信息（好的顾问会进一步追问，每覆盖一项加分）
  - 样本量（每组人数、总人数），以便评估统计检验力
  - 球形检验结果或是否了解球形性假设
  - 目前使用的统计工具（SPSS/R/其他），以便给出可操作的建议
  - 是否有多个因变量的整体检验需求（MANOVA）

评分标准：
- 1.0：基础信息全部收集 + 主动追问了2项以上深入信息
- 0.8-0.9：基础信息全部收集 + 追问了1项深入信息
- 0.7：基础信息全部收集，但未追问任何深入信息
- 0.4-0.6：基础信息缺失1-2项
- 0.1-0.3：几乎没有主动提问，直接基于不完整信息给出建议
- 0.0：完全没有任何澄清行为

注意：
- 如果用户主动提供了部分信息，助手只需询问缺失的部分即可
- 深入信息不要求在第一轮就问完，可以在后续对话中自然追问"""

    TRAJECTORY_RUBRIC = """请评估整个对话过程中，助手对用户意图的理解和响应质量（0.0-1.0）。
不要只看最终回答，而是审视每一轮对话中助手的表现。

## 评估维度

### 1. 信息缺失识别（用户没给的关键信息，助手是否察觉并追问）
- 用户的初始query只问了ANCOVA vs 调节变量，但未提供设计细节
- 助手是否在第一轮就识别出需要了解具体设计结构、变量类型等信息
- 是否在第一轮就主动询问，而非先给模糊的通用回答再补问

### 2. 矛盾识别与处理
- 用户说"2x3混合设计做ANOVA"但又要加协变量——助手是否指出这已经不是普通ANOVA而是ANCOVA/LMM
- 用户说关注"先验知识的调节效应"但同时想把它当协变量——助手是否发现这两个目标相互矛盾（ANCOVA控制变量 vs 调节分析检验交互）
- 用户有3个因变量但没考虑MANOVA——助手是否指出多重比较问题

### 3. 需求演变跟踪
- 用户的需求可能从"ANCOVA假设"演变为"用什么方法"再到"样本量够不够"再到"球形检验怎么处理"
- 助手是否跟上了需求的自然演变

### 4. 工具使用合理性（如果助手使用了计算工具）
- 是否在需要精确计算power时主动调用工具
- **错误与修正的评判标准（严格执行）**：
  - 一次调用就得到正确结果 = 最优，不扣分
  - 调用出错但能自行发现并修正 = 次优，扣0.1-0.2
  - 调用出错且未发现，将错误结果呈现给用户 = 严重问题，扣0.3-0.5

### 5. 对话节奏控制
- 是否在合适的时机给出阶段性结论
- 统计方法选择的建议是否在收集足够信息后才给出

### 6. 搜索工具使用质量（助手可使用 web_search 和 web_fetch）
本任务涉及专业统计方法的最新讨论（如LMM vs ANOVA的争论、APA第七版报告规范）。

**搜索质量评估：**
- 优秀(不扣分)：搜索了相关文献或权威资源来支撑建议
- 良好(扣0.05)：搜索了但查询不够精准
- 一般(扣0.1)：过度搜索（6次以上）或重复搜索相同内容
- 未搜索(不扣分或扣0.05)：此任务搜索非必需，但如果助手凭记忆给出了过时或错误的信息则额外扣分

## 评分标准
- 1.0：每一轮都精准理解用户意图，矛盾识别到位，需求演变完美跟踪，工具使用高效恰当
- 0.7-0.9：整体理解准确，偶有一轮响应不够精准，矛盾识别了但分析不够深入
- 0.4-0.6：部分轮次理解偏差明显（如忽略了ANCOVA与调节分析的矛盾），或未能跟上需求演变
- 0.1-0.3：多轮对话中反复出现意图误解或信息遗漏
- 0.0：完全无法跟踪用户意图"""

    NUMERICAL_RUBRIC = """请只评估助手回答中的数值计算和统计参数准确性（0.0-1.0）。不要考虑内容质量、建议好坏等因素，只关注数字和统计参数对不对。

## 话题一致性（前置检查）
原始问题是关于「2x3混合设计中先验知识作为协变量/调节变量的统计方法选择」。
如果助手的最终回答完全偏离了这个主题，数值准确性直接判0。

## 正确参考值（程序化计算）

### 1. 自由度计算（2x3混合设计，a=2被试间，b=3被试内，每组n=30，总N=60）

| 检查项 | 正确值 | 允许误差 |
|--------|--------|----------|
| df_A（认知负荷策略主效应） | **1** | 精确 |
| df_B（内容呈现方式主效应） | **2** | 精确 |
| df_AB（交互效应） | **2** | 精确 |
| df_S(A)（被试间误差） | **58** | 精确 |
| df_BxS(A)（被试内误差） | **116** | 精确 |
| df_total | **179** | 精确 |
| 加入1个协变量后被试间误差df | **57** | 精确 |

### 2. Power分析（Cohen's f=0.25中等效应，alpha=0.05，power=0.80，rho=0.5）

| 检查项 | 正确值 | 允许误差 |
|--------|--------|----------|
| 每组n=30时被试间效应power | **约0.65** | ±0.10 |
| 每组n=30时被试内效应power | **约0.94** | ±0.05 |
| 被试间效应达power=0.80所需每组n | **约43人（总N约86）** | ±10人 |
| 被试内效应达power=0.80所需每组n | **约21人（总N约42）** | ±5人 |

### 3. 效应量换算

| 检查项 | 正确值 | 允许误差 |
|--------|--------|----------|
| Cohen's f=0.25 对应 partial eta-squared | **0.0588** | ±0.005 |
| Cohen's f=0.10（小效应）对应 eta-squared | **0.0099** | ±0.002 |
| Cohen's f=0.40（大效应）对应 eta-squared | **0.1379** | ±0.01 |
| partial eta-squared 到 f 的公式 | f = sqrt(peta2/(1-peta2)) | 公式正确即可 |

### 4. 球形检验与校正

| 检查项 | 正确值 | 允许误差 |
|--------|--------|----------|
| epsilon下界（b=3时） | **0.50** | 精确 |
| GG校正使用条件 | epsilon_GG < 0.75 | 阈值0.70-0.75均可 |
| HF校正使用条件 | epsilon_GG >= 0.75 | 与GG互补即可 |
| GG校正后df_B（假设epsilon=0.80） | **1.6** | ±0.1 |
| GG校正后df_error（假设epsilon=0.80） | **92.8** | ±2 |

## 评分规则（严格执行，不要被内容质量影响）
- 1.0：自由度、power分析、效应量换算、球形校正参数全部正确
- 0.7-0.9：自由度正确，power分析方向正确（指出被试间效应power不足），效应量或校正参数有小偏差
- 0.4-0.6：自由度基本正确，但power分析结论错误（如认为每组30人完全够用）或效应量换算有明显错误
- 0.2-0.3：自由度计算有错误，或未提供任何数值分析
- 0.0-0.1：数值全面错误或完全没有涉及任何数值计算

注意：
- 助手不一定需要给出所有参考值，但提到的数值必须正确
- power分析的关键结论是「每组30人对被试间效应power不足（约0.65），需要约每组43人」
- 如果助手未使用计算工具但给出了合理的近似值（如"每组需要40-50人"），可以接受"""

    CONTENT_RUBRIC = """请评估助手回答的内容质量（0.0-1.0）。不要考虑数值是否准确，只关注回答的完整性、专业性、实用性。

## 话题一致性（前置检查）
原始问题是关于「2x3混合设计中先验知识作为协变量/调节变量的统计方法选择」。
如果助手的最终回答完全偏离了这个主题，内容质量直接判0。

## 用户完整情况（对话中可能逐步透露）
  - 2x3混合设计：认知负荷策略（2水平，被试间）x 内容呈现方式（3水平，被试内）
  - 先验知识：前测量表测量，连续变量，关注其调节效应
  - 因变量：学习成绩、认知负荷评分、学习满意度（3个）
  - 每组30人，共60人
  - Mauchly球形检验有一个因变量显著（p=0.03）
  - 导师建议用MANOVA但用户不理解为什么
  - 用户主要用SPSS，偶尔用R

## 关键矛盾（高质量回答应发现并分析）
1. 用户说想把先验知识"当协变量做ANCOVA"，但研究假设关注的是先验知识的"调节效应"——ANCOVA是控制变量（把其影响去掉），调节分析是检验交互效应（看它如何改变自变量的效果），二者目标相反。好的助手应该明确指出这个矛盾。
2. 用户有3个因变量但打算分别做分析——需要先用MANOVA做整体检验来控制族错误率。
3. 每组30人对于被试间效应的power可能不足——好的助手应该提醒并建议做power analysis。

## 评估标准：完整决策链路（6个步骤）

### Step 1: ANCOVA vs 调节分析的核心区分（必备，缺失则不超过0.4）
- 明确指出ANCOVA是"控制"协变量的影响（将其方差从误差中剔除），目的是提高检验力
- 调节分析（moderator analysis）是检验自变量与调节变量的交互效应，目的是看效果是否因调节变量水平不同而不同
- 基于用户的研究假设（先验知识的调节作用），应该建议调节分析而非ANCOVA
- 如果用ANCOVA，回归斜率同质性假设会被违反（因为交互效应正是你要检验的）

### Step 2: 矛盾发现与统计方法推荐（重要加分项，+0.15）
- **指出ANCOVA与调节目标矛盾**：用户想检验调节效应但又想用ANCOVA，这是矛盾的 (+0.05)
- **推荐更合适的方法**：建议使用线性混合模型（LMM）而非传统混合ANOVA/ANCOVA，因为LMM能更灵活地处理混合设计+连续调节变量+重复测量结构 (+0.05)
- **MANOVA的必要性**：指出3个因变量需要先做MANOVA整体检验，再做后续单变量分析 (+0.05)

### Step 3: 样本量与power分析（必备，缺失则不超过0.6）
- 评估每组30人（总60人）是否足够
- 指出被试间效应的power可能不足（中等效应量下约0.65）
- 给出达到power=0.80所需的样本量建议
- 如果无法增加样本量，建议如何应对（如聚焦被试内效应、增大效应量、放宽alpha等）

### Step 4: 领域知识应用（加分项，每项 +0.04）
- **球形检验与校正**：解释Mauchly检验的含义，说明GG校正和HF校正的选择标准（epsilon < 0.75用GG，>= 0.75用HF），以及多变量方法（Pillai's trace）不需要球形假设 (+0.04)
- **ANCOVA前提假设**：系统列出ANCOVA的假设条件——正态性、方差齐性、回归斜率同质性（homogeneity of regression slopes）、协变量与自变量独立、协变量测量无误差 (+0.04)
- **认知负荷作为DV的循环论证风险**：认知负荷策略是自变量、认知负荷评分是因变量，存在概念重叠，可能引发审稿人质疑 (+0.04)
- **效应量报告规范**：提到应报告partial eta-squared而非eta-squared（在多因素设计中），以及APA第七版要求报告效应量和置信区间 (+0.04)
- **多重比较校正**：3个因变量分别分析时需要Bonferroni或FDR校正来控制族错误率 (+0.04)

### Step 5: 综合分析方案建议（加分项，+0.05）
- 给出完整的分析流程：数据清洗 -> 假设检验 -> MANOVA -> 单变量分析 -> 事后比较
- 针对用户的具体设计给出推荐的统计模型（如LMM的固定效应和随机效应设置）
- 建议考虑了用户的实际约束（用SPSS为主、不太会写代码）

### Step 6: 可操作的工具指引（加分项，+0.04）
- 给出SPSS或R中的具体操作路径或代码示例
- 如用R的lme4包：lmer(DV ~ A*B*Prior_Knowledge + (1|Subject), data=...)
- 如用SPSS的MIXED过程的菜单路径

## 评分汇总
- Step 1 + Step 3 都满足：基础分 0.5
- Step 2（矛盾处理）：最高 +0.15（这是拉开差距的关键维度）
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
