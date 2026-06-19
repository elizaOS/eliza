"""C09zh_ai_video_creation grader — multi-turn user-agent consultation: AI视频创作."""

from claw_eval.graders.user_agent_clarify_base import UserAgentClarifyGraderBase


class CbA12Grader(UserAgentClarifyGraderBase):
    """AI视频创作 — multi-turn user-agent evaluation.

    Scoring: 4 independent judge calls, code-weighted:
      completion = 0.15 * clarify + 0.20 * trajectory + 0.30 * numerical + 0.35 * content
    """

    DOMAIN = "AI视频创作"
    MUST_ASK = [
        "明确具体的游戏类型或画面风格（决定Image-to-Video的参考权重）",
        "预期的批量产出总量（决定Credits消耗估算）",
        "对最终成片的分辨率和帧率硬性指标（决定是否必须引入Topaz等超分流程）",
        "当前使用的Runway订阅等级或预算范围",
]

    CLARIFICATION_RUBRIC = """评估助手在对话中的信息收集质量（0.0-1.0）。
不仅看第一轮的提问，也看整个对话过程中助手是否逐步深入收集了给出完整方案所需的信息。

## 基础信息（必须收集，缺失任意一项不超过0.7）
  - 对最终成片的分辨率和帧率要求（决定是否需要后期超分/插帧流程）
  - 当前使用的Runway订阅等级或预算范围（决定Credits预算上限）

## 深入信息（好的顾问会进一步追问，每覆盖一项加分）
  - 具体的游戏类型或画面风格（类魂暗调 vs 明亮卡通影响提示策略和超分参数）
  - 预期的批量产出总量（决定套餐是否够用、是否需要升级）
  - 当前的后期工具链（是否已有Topaz、DaVinci等）
  - 素材用途（混剪、转场、独立短视频等影响时长需求）

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
- 用户的初始 query 提到了"批量出"但没给具体数量和订阅等级
- 用户问了画质但没提具体分辨率/帧率硬性指标
- 助手是否在第一轮就识别出缺失并主动询问

### 2. 信息修正捕捉
- 用户可能在对话中修正信息（如从"4K"改为"1080p就够"）
- 助手是否准确捕捉到修正，并在后续分析中使用修正后的值

### 3. 需求演变跟踪
- 用户可能从"Gen-3能到多少秒"演变为"成本预算够不够"再到"整个工作流怎么搭"
- 助手是否跟上了需求的自然演变，还是机械地回答最初的问题

### 4. 工具使用合理性（如果助手使用了计算工具）
- 是否在需要精确计算时主动调用工具（如Credits消耗、时间效率对比）
- **错误与修正的评判标准（严格执行）**：
  - 一次调用就得到正确结果 = 最优，不扣分
  - 调用出错但能自行发现并修正 = 次优，扣0.1-0.2
  - 调用出错且未发现，将错误结果呈现给用户 = 严重问题，扣0.3-0.5

### 5. 对话节奏控制
- 是否在合适的时机给出阶段性结论，而非一直追问不给答案
- 用户追问新问题时，是否流畅衔接而非生硬打断

### 6. 搜索工具使用质量（助手可使用 web_search 和 web_fetch）
本任务涉及时效性信息（Runway Gen-3的最新规格、定价、功能更新），好的助手应主动搜索验证而非凭记忆回答。

**搜索必要性判断：**
- 用户问到Gen-3 Alpha Turbo的最新规格——助手是否搜索了最新的官方信息？
- Runway的套餐定价和Credits消耗率——这些数字经常变动，是否做了验证？
- 如果助手完全没搜索就给出了具体的技术参数和价格，需要考虑信息可能过时

**搜索质量评估：**
- 优秀(不扣分)：搜索查询精准，1-3次搜索覆盖关键信息，结果被正确整合到回答中
- 良好(扣0.05)：搜索了但查询不够精准，需要4-5次才找到关键信息
- 一般(扣0.1)：过度搜索（6次以上）或重复搜索相同内容
- 较差(扣0.15)：搜索了但结果没有被使用，或搜到了错误信息却未辨别
- 未搜索(扣0.1)：完全没有使用搜索工具，直接凭记忆给出技术规格和价格。但如果凭记忆给出的信息恰好正确，可减轻扣分至0.05

## 评分标准
- 1.0：每一轮都精准理解用户意图，信息修正零遗漏，需求演变完美跟踪，工具使用高效恰当
- 0.7-0.9：整体理解准确，工具使用基本合理，偶有一轮响应不够精准
- 0.4-0.6：部分轮次理解偏差明显，或工具使用不当
- 0.1-0.3：多轮对话中反复出现意图误解或信息遗漏
- 0.0：完全无法跟踪用户意图"""

    NUMERICAL_RUBRIC = """请只评估助手回答中的数值和技术规格准确性（0.0-1.0）。不要考虑内容质量、建议好坏等因素，只关注数字和规格对不对。

## 话题一致性（前置检查）
原始问题是关于「Runway Gen-3 Alpha Turbo的视频规格 + 批量生产成本估算」。
如果助手的最终回答完全偏离了这个主题，数值准确性直接判0。

## 核心技术规格（必须准确）

| 检查项 | 正确值 | 允许误差 |
|--------|--------|----------|
| Gen-3 Alpha Turbo 单次最长生成时长 | 10秒 | 精确 |
| 原生输出帧率 | 24fps | 精确 |
| 原生输出分辨率 | ~768×1344（约720p级别） | 720p-768p范围 |
| 是否支持原生60fps | 不支持 | 必须明确否定 |
| Credits消耗率 | 5 Credits/秒 | ±1 Credit |

## 成本估算（基于Standard套餐）

| 检查项 | 正确值 | 允许误差 |
|--------|--------|----------|
| Standard套餐月Credits | 625 Credits | ±50 |
| 每条10s视频消耗 | 50 Credits | ±10 |
| 每月最多生成条数 | 约12条 | ±3条 |
| 每月原始素材总秒数 | 约120秒 | ±30秒 |

## 后处理规格（如果提到了Topaz等工具）

| 检查项 | 正确值 | 允许误差 |
|--------|--------|----------|
| 后处理单条时间 | 2-5分钟 | 量级正确即可 |

## 评分规则（对定价/规格类数值宽容度适中）
- 1.0：核心规格全部正确（10s、24fps、不支持60fps），成本估算在误差范围内
- 0.7-0.9：核心规格正确，成本估算有小偏差但量级正确
- 0.4-0.6：核心规格大部分正确但有1项错误（如帧率说错），或成本估算偏差较大
- 0.2-0.3：关键规格有误（如说支持60fps），或成本估算完全错误
- 0.0-0.1：多项核心规格错误，或完全没有数值信息"""

    CONTENT_RUBRIC = """请评估助手回答的内容质量（0.0-1.0）。不要考虑数值是否准确，只关注回答的完整性、专业性、实用性。

## 话题一致性（前置检查）
原始问题是关于「Runway Gen-3视频生成规格 + 批量生产工作流方案」。
如果助手的最终回答完全偏离了这个主题，内容质量直接判0。

## 用户完整情况（对话中可能逐步透露）
  - 游戏类型：类魂游戏（暗调氛围空镜）
  - 产出规模：批量30-50条5-10秒素材
  - 硬性指标：1080p 60fps（B站高画质要求）
  - 订阅等级：Standard套餐（$12/月，625 credits）
  - 后期工具链：有Topaz Video AI，熟悉Premiere Pro、DaVinci Resolve、AE
  - 目前AE手搓一个氛围转场需1-2小时
  - 已有Midjourney风格词（"cinematic dark souls aesthetic, foggy ruins, volumetric lighting"）
  - 偶尔有temporal consistency（画面跳变）问题

## 评估标准：完整决策链路（7个步骤）

### Step 1: 规格说明（必备，缺失则不超过0.4）
- 清楚说明Gen-3 Alpha Turbo的生成时长限制、分辨率、帧率
- 与Gen-2的画质提升做了对比或说明

### Step 2: 信息验证与矛盾处理（重要加分项，+0.15）
这是区分普通助手和优秀助手的关键维度：
- **分辨率/帧率矛盾**：用户要求1080p 60fps，但Gen-3 Alpha Turbo原生输出是768p/24fps（或10s clips），根本不可能直接输出1080p 60fps。好的助手应明确指出这一点，说明必须通过后期超分（如Topaz Video AI）+插帧才能达到目标规格，而不是让用户误以为Gen-3能直接输出 (+0.05)
- **Credits消耗缺口**：Standard套餐625 credits/月，Gen-3每条10s clip消耗约50 credits，一个月最多跑约12条——远不够用户说的30-50条。好的助手应算出这个缺口并主动提出升级方案或分批策略 (+0.05)
- **废片率影响**：AI生成视频存在不满意需重跑的情况，实际可用产出更少于理论上限12条，应考虑废片率对产能的进一步压缩 (+0.05)
- 如果助手没有指出以上任何矛盾，直接按用户预期回答，此项得0

### Step 3: 后期流程方案（必备，缺失则不超过0.5）
- 给出超分+插帧的完整后处理流程（如推荐Topaz Video AI）
- 针对类魂暗调风格给出超分参数建议

### Step 4: 领域知识应用（加分项，每项 +0.04）
- **Gen-3 vs Gen-2规格差异**：准确说明Gen-3相比Gen-2在画质、时长、分辨率上的具体提升幅度，而非笼统说"好了很多" (+0.04)
- **Topaz Video AI超分+插帧工作流**：说明具体的Topaz操作流程（先超分到1080p再插帧到60fps，还是反过来），以及针对AI生成素材的推荐参数 (+0.04)
- **Credits消耗率计算**：准确说明不同分辨率/模式下的credits消耗差异（如Standard vs Turbo模式），给出精确的成本估算 (+0.04)
- **Image-to-Video vs Text-to-Video选择**：分析两种模式在游戏氛围空镜场景下的适用性差异，建议用游戏截图或Midjourney图作为参考帧以提升风格一致性 (+0.04)
- **Temporal consistency控制方法**：说明如何通过prompt技巧、参考帧、seed固定等方式减少画面跳变问题 (+0.04)

### Step 5: 综合建议（加分项，+0.05）
- 结合用户的具体场景（类魂氛围空镜 + Standard套餐 + 30-50条需求）给出个性化建议
- 明确指出主要瓶颈（Credits限制）及解决路径（升级Pro/分月跑/优化prompt减少废片）

### Step 6: 可操作方案（加分项，+0.04）
- 给出从prompt到成片的完整工作流步骤或建议的测试流程
- 使用结构化格式（表格或清单），方便用户直接参照

## 评分汇总
- Step 1 + Step 3 都满足：基础分 0.5
- Step 2（信息验证与矛盾处理）：最高 +0.15（这是拉开差距的关键维度）
- Step 4 每个知识点 +0.04（最高 +0.20）
- Step 5: +0.05
- Step 6: +0.04
- 理论满分路径：0.5 + 0.15 + 0.20 + 0.05 + 0.04 = 0.94（实际封顶0.90）
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
