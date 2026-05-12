"""C23zh_academic_writing grader — multi-turn user-agent consultation: 学术写作."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA209Grader(UserAgentClarifyGraderBase):
    """学术写作 — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.20 * numerical + 0.45 * content
    """

    DOMAIN = "学术写作"
    MUST_ASK = [
        "文章的研究主题和方法是什么",
        "核心实验发现/结果有哪些",
        "使用的数据集和对比基线是什么",
        "是否有出乎预期的发现或需要特别解释的结果",
        "具体的统计数据和效果量",
        "方法的局限性和审稿人可能关注的问题",
    ]

    CLARIFICATION_RUBRIC = """评估助手在对话中的信息收集质量（0.0-1.0）。
不仅看第一轮的提问，也看整个对话过程中助手是否逐步深入收集了给出高质量Discussion建议所需的信息。

## 基础信息（必须收集，缺失任意一项不超过0.7）
  - 研究主题和具体方法（SciBERT embedding、时间衰减因子、co-citation对比等）
  - 核心实验发现（三个findings的具体内容）
  - 数据集来源（ACL Anthology + iSchool期刊）
  - 对比基线（传统co-citation analysis）

## 深入信息（好的顾问会进一步追问，每覆盖一项加分）
  - 意外发现的具体效果（情感极性F1提升8个百分点）
  - 方法局限性（SciBERT对非英语文献效果差、时间衰减参数选择依据不足）
  - 审稿人可能关心的问题（中文论文被排除、半衰期参数敏感性）
  - 导师的意见和用户自己的偏好（导师推Finding 2，用户想重点写Finding 1）
  - 用户自己没想通的学术问题（交叉学科差异的两种可能解释）

评分标准：
- 1.0：基础信息全部收集 + 主动追问了3项以上深入信息，特别是问到了具体统计效果、局限性、导师意见
- 0.8-0.9：基础信息全部收集 + 追问了1-2项深入信息
- 0.7：基础信息全部收集，但未追问任何深入信息
- 0.4-0.6：基础信息缺失1-2项
- 0.1-0.3：几乎没有主动提问，直接基于不完整信息给出回答
- 0.0：完全没有任何澄清行为

注意：
- 如果用户主动提供了部分信息，助手只需询问缺失的部分即可
- 深入信息不要求在第一轮就问完，可以在后续对话中自然追问
- 特别关注助手是否追问了"统计效果量""审稿人可能的concern""方法参数选择依据"等高级问题——这些是区分普通助手和优秀学术顾问的关键"""

    TRAJECTORY_RUBRIC = """请评估整个对话过程中，助手对用户意图的理解和响应质量（0.0-1.0）。
不要只看最终回答，而是审视每一轮对话中助手的表现。

## 评估维度

### 1. 信息缺失识别（用户没给的关键信息，助手是否察觉并追问）
- 用户初始query只说了"投JASIST""Discussion部分没动笔""实验结果跑完了"，没有给出任何具体的研究内容和发现
- 助手是否在第一轮就识别出需要了解具体的研究方法和发现，而非先给泛泛的Discussion写作模板

### 2. 信息修正与补充捕捉
- 用户在对话中会逐步补充越来越具体的信息（从方法概要到具体统计数据到局限性）
- 助手是否随着信息增加动态调整和深化自己的建议，而非只给一个静态框架
- 当用户透露导师意见与自己偏好不同时，助手是否敏锐捕捉并处理这个张力

### 3. 需求演变跟踪
- 用户的需求从"brainstorm Discussion方向"可能演变为"具体某个finding怎么展开"或"导师意见怎么平衡"
- 助手是否跟上了需求的自然演变，而非机械重复最初的框架

### 4. 工具使用合理性（如果助手使用了搜索工具）
本任务涉及学术文献引用和理论框架，好的助手可以通过搜索来：
- 搜索相关方法论文（如SciBERT原始论文、Teufel的citation function分类）来验证建议的合理性
- 搜索JASIST近期发表的similar scope论文来了解Discussion的写法惯例
- 搜索citation sentiment analysis的最新进展来丰富建议

**搜索质量评估：**
- 优秀(不扣分)：搜索查询精准，1-3次搜索覆盖关键学术信息，搜索结果被正确整合到建议中
- 良好(扣0.05)：搜索了但查询不够精准，需要4-5次才找到关键信息
- 一般(扣0.1)：过度搜索（6次以上）或搜索了无关内容
- 未搜索(不额外扣分)：对于学术写作建议，不搜索也可以给出好的建议，但搜索了相关文献可作为加分项(+0.05)

### 5. 对话节奏控制
- 是否在收集足够信息后给出结构化建议，而非一直追问不给答案
- 对于用户的情绪（导师批评后的挫败感），是否有适当回应而非完全忽略

## 评分标准
- 1.0：每一轮都精准理解用户意图，信息补充零遗漏，需求演变完美跟踪，如使用搜索则高效精准
- 0.7-0.9：整体理解准确，偶有一轮响应不够精准，但主线把握良好
- 0.4-0.6：部分轮次理解偏差明显（如忽略了导师意见的张力、没有随新信息更新建议）
- 0.1-0.3：多轮对话中反复出现意图误解或信息遗漏
- 0.0：完全无法跟踪用户意图"""

    NUMERICAL_RUBRIC = """请评估助手给出的Discussion框架的学术规范性和结构合理性（0.0-1.0）。
本题无数值计算，此维度聚焦于Discussion部分的学术写作规范。

## 话题一致性（前置检查）
原始问题是关于「JASIST投稿论文Discussion部分的写作方向」。
如果助手的回答完全偏离了这个主题（如讨论如何写Introduction或做实验），直接判0。

## 用户的研究背景
  - 方法：SciBERT embedding + 时间衰减因子聚类 vs 传统co-citation analysis
  - 三个核心发现：(1)语义聚类提前1-2年捕捉emerging topics (2)情感极性有显著区分度（意外发现）(3)成熟vs交叉学科领域差异
  - 数据集：ACL Anthology + iSchool期刊近十年
  - 情感极性F1比baseline高8个百分点，但可能存在domain bias

## 结构规范性检查项

### 1. Discussion整体架构（必备，缺失则不超过0.4）
- 是否按照findings逐条展开（而非笼统讨论）
- 是否包含了与现有文献的对话/对比（不只是自说自话）
- 是否包含了limitations和future work（Discussion标配）

### 2. Finding-to-Discussion的映射逻辑（+0.15）
- 每个finding是否有明确的讨论方向：为什么出现这个结果、和已有文献一致还是矛盾、理论意义是什么
- 三个findings之间的讨论是否有逻辑连贯性（而非三段互不相关的讨论）
- 意外发现（情感极性）是否被特别标记为需要更深入解释的点

### 3. 可引用的具体文献/理论框架建议（+0.15）
- 是否建议了具体的文献对话对象（如Price的research front概念、Teufel的citation function分类、Klavans & Boyack的co-citation方法等）
- 建议引用的文献是否与用户的研究方法和发现真正相关（而非泛泛列举名人名作）
- 是否提到了citation sentiment/citation context analysis领域的具体先行研究

### 4. JASIST期刊级别的适配性（+0.10）
- Discussion建议是否符合信息科学领域的写作惯例（重视方法论贡献和实践意义）
- 是否避免了过度技术化（JASIST不是纯CS会议）或过于宽泛（缺乏技术深度）
- 是否建议了implications for practice或implications for future research等JASIST常见的Discussion子节

### 5. Limitations讨论的具体性（+0.10）
- 是否针对用户的具体方法指出了可讨论的limitation（如SciBERT语言限制、半衰期参数敏感性、数据集领域局限）
- 而非给出通用的limitation模板（如"样本量有限""未来可扩大数据集"）

## 评分汇总
- 架构完整：基础分 0.4
- Finding映射逻辑：+0.15
- 具体文献建议：+0.15
- 期刊适配性：+0.10
- Limitations具体性：+0.10
- 理论最高 0.90，特别出色可酌情给到 1.0"""

    CONTENT_RUBRIC = """请评估助手回答的内容质量（0.0-1.0）。不要考虑结构形式，只关注回答的完整性、专业性、洞察深度。

## 话题一致性（前置检查）
原始问题是关于「JASIST投稿论文Discussion部分的写作方向」。
如果助手的回答完全偏离了这个主题，内容质量直接判0。

## 用户完整情况（对话中逐步透露）
  - 方法：SciBERT embedding + 时间衰减因子聚类 vs co-citation analysis
  - Finding 1：语义聚类比co-citation早1-2年捕捉emerging topics
  - Finding 2：citation context的情感极性对前沿识别有显著区分度（意外发现，F1高8个百分点）
  - Finding 3：成熟领域两种方法差异不大，交叉学科领域差异明显
  - 数据集：ACL Anthology + iSchool期刊近十年
  - 局限：SciBERT对非英语文献效果差（中文论文被排除）、时间衰减半衰期参数2年选择无强理论依据
  - 导师意见：导师觉得Finding 2最有novelty建议重点展开，但用户自己更想重点写Finding 1
  - 未解之惑：交叉学科差异是引用行为多样性导致还是co-citation网络稀疏导致baseline本身就弱

## 关键矛盾与张力（高质量回答应发现并处理）

### 矛盾1：情感极性效果可能存在domain bias
- 用户提到F1高了8个百分点，但自己不确定是不是因为ACL领域本身争论较多导致的
- 好的助手应该：(a)指出这确实是Discussion中必须讨论的threat to validity (b)建议如何在Discussion中处理这个问题（如对比不同领域子集的效果、引用ACL vs 其他领域的citation行为研究）
- 如果助手搜索了citation sentiment analysis在不同领域的研究，可以给出更有依据的分析

### 矛盾2：导师偏好与用户偏好的张力
- 导师推Finding 2（情感极性，novelty），用户想重点写Finding 1（时间优势，原始研究问题）
- 好的助手应该：(a)不简单地站边 (b)给出平衡方案（如将Finding 1作为主线但在Finding 2上花更多Discussion篇幅来满足导师期望）(c)从策略角度分析——JASIST审稿人更看重novelty还是对原始研究问题的回答

### 矛盾3：交叉学科差异的两种解释难以区分
- 用户自己提出了两种可能的解释但没想通
- 好的助手应该：(a)不假装知道答案 (b)建议在Discussion中如何诚实地呈现这个开放问题 (c)建议可能的supplementary analysis来部分区分两种解释

## 评估标准：完整决策链路（6个步骤）

### Step 1: 针对三个Findings的Discussion方向（必备，缺失则不超过0.4）
- 为Finding 1（时间优势）提出了与bibliometrics文献对话的方向
- 为Finding 2（情感极性）提出了理论解释方向（如citation function/motivation理论）
- 为Finding 3（领域差异）提出了解释框架（如知识结构理论、引用行为理论）

### Step 2: 矛盾处理与深层洞察（重要加分项，+0.15）
- **domain bias处理**：是否指出情感极性效果可能受ACL领域特性影响，并建议如何在Discussion中讨论这个threat (+0.05)
- **导师vs用户偏好平衡**：是否给出了既尊重导师意见又满足用户学术诉求的平衡方案 (+0.05)
- **交叉学科差异的开放讨论**：是否帮用户分析了两种解释各自的证据和局限，或建议了区分方法 (+0.05)

### Step 3: 方法局限性的具体讨论建议（必备，缺失则不超过0.6）
- SciBERT的语言局限性（排除中文论文的影响）
- 时间衰减参数的敏感性和选择依据不足
- 数据集覆盖范围的局限（ACL + iSchool不代表所有领域）

### Step 4: 领域知识应用（加分项，每项+0.04）
- **citation function/sentiment理论**：提到了Teufel、Hernández-Álvarez等人的citation分类工作，或类似的理论框架 (+0.04)
- **research front理论**：引用了Price、Small等人的经典概念来定位用户的贡献 (+0.04)
- **SciBERT/BERT在学术文本中的应用文献**：了解预训练模型在scientific text mining中的位置 (+0.04)
- **co-citation analysis的经典文献**：提到了Marshakova-Shaikevich或Small的原始工作、Klavans & Boyack的方法比较等 (+0.04)

### Step 5: 综合建议（加分项，+0.05）
- 综合以上所有分析给出Discussion各节的优先级和篇幅分配建议
- 考虑了JASIST审稿人的期望和用户的时间约束（下周要交初稿）

### Step 6: 可操作的写作指导（加分项，+0.04）
- 给出了具体的Discussion小节标题建议或段落结构
- 建议了哪些地方需要制作对比表格或图表来支撑Discussion

## 评分汇总
- Step 1 + Step 3 都满足：基础分 0.5
- Step 2（矛盾处理）：最高 +0.15（这是拉开差距的关键维度）
- Step 4 每个知识点 +0.04（最高 +0.16）
- Step 5: +0.05
- Step 6: +0.04
- 理论满分路径：0.5 + 0.15 + 0.16 + 0.05 + 0.04 = 0.90
- 如果在以上基础上回答特别出色（如搜索了最新相关文献并整合到建议中），可酌情给到 1.0"""

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

        # 3. Structural/academic rigor (20%) — replaces numerical for non-calculation tasks
        numerical_score = 0.0
        try:
            result = judge.evaluate(prompt_text, full_conversation, "",
                                    self.NUMERICAL_RUBRIC)
            numerical_score = result.score
            print(f"[grader] structural score: {numerical_score:.2f} — {result.reasoning[:200]}")
        except Exception as exc:
            print(f"[grader] structural judge failed: {exc}")

        # 4. Content quality (45%)
        content_score = 0.0
        try:
            result = judge.evaluate(prompt_text, full_conversation, "",
                                    self.CONTENT_RUBRIC)
            content_score = result.score
            print(f"[grader] content score: {content_score:.2f} — {result.reasoning[:200]}")
        except Exception as exc:
            print(f"[grader] content judge failed: {exc}")

        # Combine: 15% clarify + 20% trajectory + 20% structural + 45% content
        scores.completion = round(
            0.15 * clarify_score +
            0.20 * trajectory_score +
            0.20 * numerical_score +
            0.45 * content_score,
            4
        )
        print(f"[grader] completion: {scores.completion:.4f} "
              f"(clarify={clarify_score:.2f}*0.15 + trajectory={trajectory_score:.2f}*0.20 "
              f"+ structural={numerical_score:.2f}*0.20 + content={content_score:.2f}*0.45)")

        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
